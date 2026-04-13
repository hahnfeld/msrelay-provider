import { createRequire } from "node:module";
import { request as httpRequest, type IncomingMessage, type ServerResponse } from "node:http";
import type { RelayedServer } from "hyco-https";
import type { AzureRelayConfig } from "./types.js";

const require = createRequire(import.meta.url);
const hycoHttps = require("hyco-https") as typeof import("hyco-https");

const START_TIMEOUT_MS = 30_000;
const LOCAL_FORWARD_TIMEOUT_MS = 30_000;
const MAX_BODY_BYTES = 10 * 1024 * 1024; // 10 MB

/** Maximum number of reconnect attempts before escalating to TunnelRegistry. */
const MAX_RECONNECT_ATTEMPTS = 5;
/** Base delay for exponential backoff (ms). Actual delay: base * 2^attempt + jitter. */
const RECONNECT_BASE_DELAY_MS = 1_000;
/** Maximum backoff delay cap (ms). */
const RECONNECT_MAX_DELAY_MS = 30_000;

/**
 * HTTP hop-by-hop headers that must not be forwarded by a proxy (RFC 7230).
 * Forwarding these can cause request smuggling and framing inconsistencies.
 */
const HOP_BY_HOP_HEADERS = new Set([
  "connection", "keep-alive", "proxy-authenticate", "proxy-authorization",
  "te", "trailer", "transfer-encoding", "upgrade",
]);

/** Strip hop-by-hop headers from a header object before forwarding. */
function stripHopByHop(headers: Record<string, string | string[] | undefined>): Record<string, string | string[] | undefined> {
  const result: Record<string, string | string[] | undefined> = {};
  for (const [key, value] of Object.entries(headers)) {
    if (!HOP_BY_HOP_HEADERS.has(key.toLowerCase())) {
      result[key] = value;
    }
  }
  return result;
}

/** Internal metrics for the /relay status command. */
export interface RelayMetrics {
  requestCount: number;
  errorCount: number;
  startedAt: Date | null;
  lastError: string | null;
  lastErrorAt: Date | null;
  reconnectAttempts: number;
  reconnectsSucceeded: number;
}

/**
 * Azure Relay Hybrid Connections tunnel provider.
 *
 * Listens on an Azure Relay endpoint via an outbound WebSocket and forwards
 * incoming HTTP requests to a local port. Implements the TunnelProvider
 * interface from @openacp/plugin-sdk.
 *
 * Reconnection: When the WebSocket drops unexpectedly, the provider retries
 * up to MAX_RECONNECT_ATTEMPTS times with exponential backoff and jitter.
 * Only after exhausting retries does it invoke the onExit callback to
 * escalate to TunnelRegistry for higher-level retry coordination.
 *
 * Security: No inbound connections required. The local machine opens an
 * outbound WebSocket (wss://) to the Azure Relay service. In ExpressRoute
 * environments, traffic traverses the Microsoft private backbone.
 */
export class AzureRelayProvider {
  private server: RelayedServer | null = null;
  private publicUrl = "";
  private exitCallback: ((code: number | null) => void) | null = null;
  private config: AzureRelayConfig;
  private localPort = 0;
  private stopping = false;
  private reconnecting = false;
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  private metrics: RelayMetrics = {
    requestCount: 0,
    errorCount: 0,
    startedAt: null,
    lastError: null,
    lastErrorAt: null,
    reconnectAttempts: 0,
    reconnectsSucceeded: 0,
  };

  constructor(config: AzureRelayConfig) {
    this.config = config;
  }

  onExit(callback: (code: number | null) => void): void {
    this.exitCallback = callback;
  }

  /** Returns a snapshot of current provider metrics. */
  getMetrics(): Readonly<RelayMetrics> {
    return { ...this.metrics };
  }

  async start(localPort: number): Promise<string> {
    if (this.server) {
      await this.stop(true);
    }

    if (!Number.isInteger(localPort) || localPort < 1 || localPort > 65535) {
      throw new Error(`Invalid port: ${localPort}. Must be 1-65535.`);
    }

    this.localPort = localPort;
    this.stopping = false;
    this.metrics = {
      requestCount: 0,
      errorCount: 0,
      startedAt: null,
      lastError: null,
      lastErrorAt: null,
      reconnectAttempts: 0,
      reconnectsSucceeded: 0,
    };

    return this.connectListener();
  }

  /**
   * Stop the relay listener.
   * @param force - Skip graceful shutdown and close immediately.
   * @param _preserveState - Accepted for TunnelProvider compat; no effect.
   */
  async stop(force = false, _preserveState = false): Promise<void> {
    this.stopping = true;
    this.reconnecting = false;

    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }

    const server = this.server;
    if (!server) return;

    this.server = null;
    this.exitCallback = null;
    this.publicUrl = "";

    return new Promise<void>((resolve) => {
      if (force) {
        server.close();
        resolve();
        return;
      }
      server.close(() => resolve());
    });
  }

  getPublicUrl(): string {
    return this.publicUrl;
  }

  /**
   * Create the relayed server and connect to Azure Relay.
   * Used by both initial start() and reconnect attempts.
   */
  private connectListener(): Promise<string> {
    const { relayNamespace, hybridConnectionName, sasKeyName, sasKeyValue } = this.config;
    const listenUri = hycoHttps.createRelayListenUri(relayNamespace, hybridConnectionName);

    this.server = hycoHttps.createRelayedServer(
      {
        server: listenUri,
        token: () => hycoHttps.createRelayToken(listenUri, sasKeyName, sasKeyValue),
      },
      (req, res) => this.handleRequest(req, res),
    );

    const server = this.server;

    return new Promise<string>((resolve, reject) => {
      let settled = false;
      const settle = (fn: () => void) => {
        if (!settled) {
          settled = true;
          fn();
        }
      };

      const timeout = setTimeout(() => {
        if (server) {
          server.close();
        }
        this.server = null;
        this.publicUrl = "";
        settle(() => reject(new Error(`Azure Relay listener timed out after ${START_TIMEOUT_MS / 1000}s`)));
      }, START_TIMEOUT_MS);

      // Guard: only reconnect if the close event comes from the current live server
      const onUnexpectedClose = () => {
        if (settled && server === this.server && !this.stopping) {
          this.server = null;
          this.publicUrl = "";
          this.attemptReconnect();
        }
      };

      server.on("close", onUnexpectedClose);
      server.on("error", (err: Error) => {
        if (!settled) {
          clearTimeout(timeout);
          this.server = null;
          settle(() => reject(new Error(`Azure Relay connection failed: ${err.message}`)));
        } else if (!this.stopping) {
          this.recordError(`Relay error: ${err.message}`);
          onUnexpectedClose();
        }
      });

      // hyco-https listen() takes no arguments — readiness is signaled
      // via the 'listening' event when the control channel WebSocket opens.
      server.on("listening", () => {
        clearTimeout(timeout);
        this.publicUrl = `https://${relayNamespace}/${hybridConnectionName}`;
        if (!this.metrics.startedAt) {
          this.metrics.startedAt = new Date();
        }
        settle(() => resolve(this.publicUrl));
      });

      server.listen();
    });
  }

  /**
   * Attempt to reconnect after an unexpected disconnect.
   *
   * Uses exponential backoff with jitter: delay = min(base * 2^attempt + jitter, max).
   * After MAX_RECONNECT_ATTEMPTS failures, escalates to TunnelRegistry via onExit.
   */
  private attemptReconnect(attempt = 0): void {
    if (this.stopping || this.reconnecting) return;

    if (attempt >= MAX_RECONNECT_ATTEMPTS) {
      this.recordError(`Reconnect failed after ${MAX_RECONNECT_ATTEMPTS} attempts — escalating to TunnelRegistry`);
      this.reconnecting = false;
      this.exitCallback?.(null);
      return;
    }

    this.reconnecting = true;
    this.metrics.reconnectAttempts++;

    const delay = Math.min(
      RECONNECT_BASE_DELAY_MS * Math.pow(2, attempt) + Math.random() * 1_000,
      RECONNECT_MAX_DELAY_MS,
    );

    this.reconnectTimer = setTimeout(async () => {
      this.reconnectTimer = null;
      if (this.stopping) {
        this.reconnecting = false;
        return;
      }

      try {
        await this.connectListener();
        this.reconnecting = false;
        this.metrics.reconnectsSucceeded++;
      } catch {
        this.reconnecting = false;
        this.attemptReconnect(attempt + 1);
      }
    }, delay);
  }

  /**
   * Forward an incoming Relay request to the local server.
   *
   * Preserves method, path, and headers (with hop-by-hop headers stripped).
   * Pipes request and response bodies bidirectionally with a 10 MB size limit.
   * Returns 502 on connection failure, 504 on timeout, 413 on oversized body.
   */
  private handleRequest(relayReq: IncomingMessage, relayRes: ServerResponse): void {
    this.metrics.requestCount++;

    // Validate URL: must be an origin-form path
    const rawUrl = relayReq.url;
    if (!rawUrl || !rawUrl.startsWith("/")) {
      this.sendError(relayRes, 400, "Bad Request", `Invalid request URL: ${rawUrl}`);
      return;
    }

    const forwardHeaders = stripHopByHop(relayReq.headers);
    forwardHeaders["host"] = `localhost:${this.localPort}`;

    const localReq = httpRequest(
      {
        hostname: "localhost",
        port: this.localPort,
        path: rawUrl,
        method: relayReq.method,
        headers: forwardHeaders as Record<string, string>,
        timeout: LOCAL_FORWARD_TIMEOUT_MS,
      },
      (localRes) => {
        const responseHeaders = stripHopByHop(localRes.headers);
        relayRes.writeHead(localRes.statusCode ?? 200, responseHeaders);
        localRes.pipe(relayRes);
      },
    );

    localReq.on("timeout", () => {
      relayReq.unpipe(localReq);
      localReq.destroy();
      this.sendError(relayRes, 504, "Gateway Timeout", `Local server did not respond within ${LOCAL_FORWARD_TIMEOUT_MS / 1000}s`);
    });

    localReq.on("error", (err: NodeJS.ErrnoException) => {
      relayReq.unpipe(localReq);
      if (err.code === "ECONNREFUSED") {
        this.sendError(relayRes, 502, "Bad Gateway", `Local server not reachable on port ${this.localPort}`);
      } else {
        this.sendError(relayRes, 502, "Bad Gateway", `Proxy error: ${err.message}`);
      }
    });

    // Enforce body size limit to prevent memory exhaustion
    let bodyBytes = 0;
    relayReq.on("data", (chunk: Buffer) => {
      bodyBytes += chunk.length;
      if (bodyBytes > MAX_BODY_BYTES) {
        relayReq.unpipe(localReq);
        localReq.destroy();
        this.sendError(relayRes, 413, "Request Entity Too Large", `Body exceeded ${MAX_BODY_BYTES / (1024 * 1024)} MB limit`);
      }
    });

    relayReq.pipe(localReq);
  }

  /**
   * Send an error response to the relay caller.
   * External callers see only the generic message; detail is logged internally.
   * If headers were already sent (mid-stream error), destroys the response instead.
   */
  private sendError(res: ServerResponse, statusCode: number, message: string, detail?: string): void {
    this.recordError(detail ?? message);
    if (res.headersSent) {
      res.destroy();
      return;
    }
    res.writeHead(statusCode, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ error: message }));
  }

  private recordError(message: string): void {
    this.metrics.errorCount++;
    this.metrics.lastError = message;
    this.metrics.lastErrorAt = new Date();
  }
}
