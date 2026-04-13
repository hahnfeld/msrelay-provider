import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { EventEmitter } from "node:events";
import type { IncomingMessage, ServerResponse } from "node:http";
import type { AzureRelayConfig } from "../types.js";

// ─── Mock hyco-https via createRequire interception ──────────────────────────

let mockServer: MockRelayedServer;
let capturedRequestHandler: ((req: IncomingMessage, res: ServerResponse) => void) | null = null;

class MockRelayedServer extends EventEmitter {
  closed = false;

  listen(): void {
    // Match real hyco-https: readiness is signaled via 'listening' event
    process.nextTick(() => this.emit("listening"));
  }

  close(callback?: () => void): void {
    this.closed = true;
    if (callback) process.nextTick(callback);
  }
}

const mockHycoHttps = {
  createRelayListenUri: (namespace: string, path: string) =>
    `sb://${namespace}/${path}`,
  createRelayToken: (_uri: string, _keyName: string, _key: string) =>
    "SharedAccessSignature sr=mock&sig=mock&se=9999999999&skn=mock",
  createRelayedServer: (
    _options: unknown,
    requestListener: (req: IncomingMessage, res: ServerResponse) => void,
  ) => {
    mockServer = new MockRelayedServer();
    capturedRequestHandler = requestListener;
    return mockServer;
  },
};

// Mock createRequire so provider.ts gets our fake hyco-https
vi.mock("node:module", () => ({
  createRequire: () => (id: string) => {
    if (id === "hyco-https") return mockHycoHttps;
    throw new Error(`Unexpected require: ${id}`);
  },
}));

// ─── Mock http.request ───────────────────────────────────────────────────────

let mockLocalRequest: EventEmitter & { destroy: ReturnType<typeof vi.fn>; end: ReturnType<typeof vi.fn>; write: ReturnType<typeof vi.fn> };
let httpRequestCallback: ((res: unknown) => void) | null = null;

vi.mock("node:http", async () => {
  const actual = await vi.importActual<typeof import("node:http")>("node:http");
  return {
    ...actual,
    request: vi.fn((_opts: unknown, callback: (res: unknown) => void) => {
      httpRequestCallback = callback;
      mockLocalRequest = Object.assign(new EventEmitter(), {
        destroy: vi.fn(),
        end: vi.fn(),
        write: vi.fn(),
      });
      return mockLocalRequest;
    }),
  };
});

// ─── Test Config ─────────────────────────────────────────────────────────────

const TEST_CONFIG: AzureRelayConfig = {
  enabled: true,
  port: 3978,
  relayNamespace: "myrelay.servicebus.windows.net",
  hybridConnectionName: "bot-endpoint",
  sasKeyName: "ListenOnly",
  sasKeyValue: "dGVzdGtleQ==",
};

// ─── Tests ───────────────────────────────────────────────────────────────────

describe("AzureRelayProvider", () => {
  let AzureRelayProvider: typeof import("../provider.js").AzureRelayProvider;

  beforeEach(async () => {
    vi.clearAllMocks();
    capturedRequestHandler = null;
    httpRequestCallback = null;
    const mod = await import("../provider.js");
    AzureRelayProvider = mod.AzureRelayProvider;
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("resolves with deterministic public URL", async () => {
    const provider = new AzureRelayProvider(TEST_CONFIG);
    const url = await provider.start(3978);
    expect(url).toBe("https://myrelay.servicebus.windows.net/bot-endpoint");
  });

  it("returns public URL from getPublicUrl() after start", async () => {
    const provider = new AzureRelayProvider(TEST_CONFIG);
    expect(provider.getPublicUrl()).toBe("");
    await provider.start(3978);
    expect(provider.getPublicUrl()).toBe("https://myrelay.servicebus.windows.net/bot-endpoint");
  });

  it("rejects on invalid port", async () => {
    const provider = new AzureRelayProvider(TEST_CONFIG);
    await expect(provider.start(0)).rejects.toThrow("Invalid port");
    await expect(provider.start(99999)).rejects.toThrow("Invalid port");
  });

  it("stops and clears state", async () => {
    const provider = new AzureRelayProvider(TEST_CONFIG);
    await provider.start(3978);
    await provider.stop();
    expect(provider.getPublicUrl()).toBe("");
    expect(mockServer.closed).toBe(true);
  });

  it("force stop closes immediately", async () => {
    const provider = new AzureRelayProvider(TEST_CONFIG);
    await provider.start(3978);
    await provider.stop(true);
    expect(mockServer.closed).toBe(true);
  });

  it("stop is a no-op when not started", async () => {
    const provider = new AzureRelayProvider(TEST_CONFIG);
    await expect(provider.stop()).resolves.toBeUndefined();
  });

  it("attempts reconnect on unexpected server close (not immediate onExit)", async () => {
    vi.useFakeTimers();
    const provider = new AzureRelayProvider(TEST_CONFIG);
    const exitCb = vi.fn();
    provider.onExit(exitCb);
    await provider.start(3978);

    mockServer.emit("close");

    // With reconnect logic, onExit is NOT called immediately
    expect(exitCb).not.toHaveBeenCalled();
    // URL is cleared during reconnect
    expect(provider.getPublicUrl()).toBe("");

    vi.useRealTimers();
    await provider.stop(true);
  });

  it("does not fire onExit on explicit stop", async () => {
    const provider = new AzureRelayProvider(TEST_CONFIG);
    const exitCb = vi.fn();
    provider.onExit(exitCb);
    await provider.start(3978);
    await provider.stop();

    expect(exitCb).not.toHaveBeenCalled();
  });

  it("initializes metrics on start", async () => {
    const provider = new AzureRelayProvider(TEST_CONFIG);
    await provider.start(3978);
    const metrics = provider.getMetrics();
    expect(metrics.requestCount).toBe(0);
    expect(metrics.errorCount).toBe(0);
    expect(metrics.startedAt).toBeInstanceOf(Date);
    expect(metrics.lastError).toBeNull();
  });

  it("forwards HTTP requests to localhost", async () => {
    const { request: mockHttpRequest } = await import("node:http");
    const provider = new AzureRelayProvider(TEST_CONFIG);
    await provider.start(3978);

    expect(capturedRequestHandler).not.toBeNull();

    const fakeReq = Object.assign(new EventEmitter(), {
      method: "POST",
      url: "/api/messages",
      headers: { "content-type": "application/json" },
      pipe: vi.fn(),
      unpipe: vi.fn(),
    }) as unknown as IncomingMessage;

    const fakeRes = {
      writeHead: vi.fn(),
      end: vi.fn(),
      headersSent: false,
    } as unknown as ServerResponse;

    capturedRequestHandler!(fakeReq, fakeRes);

    expect(mockHttpRequest).toHaveBeenCalledWith(
      expect.objectContaining({
        hostname: "localhost",
        port: 3978,
        path: "/api/messages",
        method: "POST",
      }),
      expect.any(Function),
    );

    // Simulate successful local response
    const mockLocalRes = Object.assign(new EventEmitter(), {
      statusCode: 200,
      headers: { "content-type": "application/json" },
      pipe: vi.fn(),
    });
    httpRequestCallback!(mockLocalRes);
    expect(fakeRes.writeHead).toHaveBeenCalledWith(200, mockLocalRes.headers);
  });

  it("strips Hybrid Connection name prefix from forwarded path", async () => {
    const { request: mockHttpRequest } = await import("node:http");
    const provider = new AzureRelayProvider(TEST_CONFIG);
    await provider.start(3978);

    const fakeReq = Object.assign(new EventEmitter(), {
      method: "POST",
      url: "/bot-endpoint/api/messages",
      headers: { "content-type": "application/json" },
      pipe: vi.fn(),
      unpipe: vi.fn(),
    }) as unknown as IncomingMessage;

    const fakeRes = {
      writeHead: vi.fn(),
      end: vi.fn(),
      headersSent: false,
    } as unknown as ServerResponse;

    capturedRequestHandler!(fakeReq, fakeRes);

    expect(mockHttpRequest).toHaveBeenCalledWith(
      expect.objectContaining({
        path: "/api/messages",
      }),
      expect.any(Function),
    );
  });

  it("maps bare Hybrid Connection path to /", async () => {
    const { request: mockHttpRequest } = await import("node:http");
    const provider = new AzureRelayProvider(TEST_CONFIG);
    await provider.start(3978);

    const fakeReq = Object.assign(new EventEmitter(), {
      method: "GET",
      url: "/bot-endpoint",
      headers: {},
      pipe: vi.fn(),
      unpipe: vi.fn(),
    }) as unknown as IncomingMessage;

    const fakeRes = {
      writeHead: vi.fn(),
      end: vi.fn(),
      headersSent: false,
    } as unknown as ServerResponse;

    capturedRequestHandler!(fakeReq, fakeRes);

    expect(mockHttpRequest).toHaveBeenCalledWith(
      expect.objectContaining({
        path: "/",
      }),
      expect.any(Function),
    );
  });

  it("returns 502 when local server is down", async () => {
    const provider = new AzureRelayProvider(TEST_CONFIG);
    await provider.start(3978);

    const fakeReq = Object.assign(new EventEmitter(), {
      method: "POST",
      url: "/api/messages",
      headers: {},
      pipe: vi.fn(),
      unpipe: vi.fn(),
    }) as unknown as IncomingMessage;

    const fakeRes = {
      writeHead: vi.fn(),
      end: vi.fn(),
      headersSent: false,
    } as unknown as ServerResponse;

    capturedRequestHandler!(fakeReq, fakeRes);

    const err = new Error("connect ECONNREFUSED") as NodeJS.ErrnoException;
    err.code = "ECONNREFUSED";
    mockLocalRequest.emit("error", err);

    expect(fakeRes.writeHead).toHaveBeenCalledWith(502, { "Content-Type": "application/json" });
    // External response has generic message; detail is internal only
    expect(fakeRes.end).toHaveBeenCalledWith(
      expect.stringContaining("Bad Gateway"),
    );

    const metrics = provider.getMetrics();
    expect(metrics.errorCount).toBe(1);
    // Internal metrics record the detailed error
    expect(metrics.lastError).toContain("Local server not reachable");
  });

  it("returns 504 on local server timeout", async () => {
    const provider = new AzureRelayProvider(TEST_CONFIG);
    await provider.start(3978);

    const fakeReq = Object.assign(new EventEmitter(), {
      method: "POST",
      url: "/api/messages",
      headers: {},
      pipe: vi.fn(),
      unpipe: vi.fn(),
    }) as unknown as IncomingMessage;

    const fakeRes = {
      writeHead: vi.fn(),
      end: vi.fn(),
      headersSent: false,
    } as unknown as ServerResponse;

    capturedRequestHandler!(fakeReq, fakeRes);

    mockLocalRequest.emit("timeout");

    expect(mockLocalRequest.destroy).toHaveBeenCalled();
    expect(fakeRes.writeHead).toHaveBeenCalledWith(504, { "Content-Type": "application/json" });
    expect(fakeRes.end).toHaveBeenCalledWith(
      expect.stringContaining("Gateway Timeout"),
    );
  });

  it("increments request count on each forwarded request", async () => {
    const provider = new AzureRelayProvider(TEST_CONFIG);
    await provider.start(3978);

    for (let i = 0; i < 3; i++) {
      const fakeReq = Object.assign(new EventEmitter(), {
        method: "POST",
        url: "/api/messages",
        headers: {},
        pipe: vi.fn(),
      }) as unknown as IncomingMessage;

      const fakeRes = {
        writeHead: vi.fn(),
        end: vi.fn(),
        headersSent: false,
      } as unknown as ServerResponse;

      capturedRequestHandler!(fakeReq, fakeRes);
    }

    expect(provider.getMetrics().requestCount).toBe(3);
  });

  it("rejects when server emits error before establishment", async () => {
    // Override createRelayedServer to emit error instead of calling listen callback
    const origCreate = mockHycoHttps.createRelayedServer;
    mockHycoHttps.createRelayedServer = (_opts: unknown, listener: unknown) => {
      mockServer = new MockRelayedServer();
      mockServer.listen = () => {
        // Simulate connection error instead of emitting 'listening'
        process.nextTick(() => mockServer.emit("error", new Error("Connection refused")));
      };
      capturedRequestHandler = listener as typeof capturedRequestHandler;
      return mockServer;
    };

    const provider = new AzureRelayProvider(TEST_CONFIG);
    await expect(provider.start(3978)).rejects.toThrow("Azure Relay connection failed: Connection refused");

    // Restore
    mockHycoHttps.createRelayedServer = origCreate;
  });

  describe("security", () => {
    it("rejects requests with non-origin-form URLs", async () => {
      const provider = new AzureRelayProvider(TEST_CONFIG);
      await provider.start(3978);

      const fakeReq = Object.assign(new EventEmitter(), {
        method: "GET",
        url: undefined, // undefined URL
        headers: {},
        pipe: vi.fn(),
      }) as unknown as IncomingMessage;

      const fakeRes = {
        writeHead: vi.fn(),
        end: vi.fn(),
        destroy: vi.fn(),
        headersSent: false,
      } as unknown as ServerResponse;

      capturedRequestHandler!(fakeReq, fakeRes);

      expect(fakeRes.writeHead).toHaveBeenCalledWith(400, { "Content-Type": "application/json" });
      expect(fakeRes.end).toHaveBeenCalledWith(expect.stringContaining("Bad Request"));
    });

    it("destroys response instead of writing when headers already sent", async () => {
      const provider = new AzureRelayProvider(TEST_CONFIG);
      await provider.start(3978);

      const fakeReq = Object.assign(new EventEmitter(), {
        method: "GET",
        url: "/api",
        headers: {},
        pipe: vi.fn(),
        unpipe: vi.fn(),
      }) as unknown as IncomingMessage;

      const fakeRes = {
        writeHead: vi.fn(),
        end: vi.fn(),
        destroy: vi.fn(),
        headersSent: true, // headers already sent mid-stream
      } as unknown as ServerResponse;

      capturedRequestHandler!(fakeReq, fakeRes);
      mockLocalRequest.emit("timeout");

      // Should destroy instead of writing
      expect(fakeRes.destroy).toHaveBeenCalled();
      expect(fakeRes.writeHead).not.toHaveBeenCalled();
      expect(fakeRes.end).not.toHaveBeenCalled();
    });

    it("returns generic error messages to external callers", async () => {
      const provider = new AzureRelayProvider(TEST_CONFIG);
      await provider.start(3978);

      const fakeReq = Object.assign(new EventEmitter(), {
        method: "POST",
        url: "/api/messages",
        headers: {},
        pipe: vi.fn(),
        unpipe: vi.fn(),
      }) as unknown as IncomingMessage;

      const fakeRes = {
        writeHead: vi.fn(),
        end: vi.fn(),
        headersSent: false,
      } as unknown as ServerResponse;

      capturedRequestHandler!(fakeReq, fakeRes);

      const err = new Error("connect ECONNREFUSED") as NodeJS.ErrnoException;
      err.code = "ECONNREFUSED";
      mockLocalRequest.emit("error", err);

      // External response should NOT contain port numbers or internal details
      const body = JSON.parse(fakeRes.end.mock.calls[0][0] as string);
      expect(body.error).toBe("Bad Gateway");
      expect(body.error).not.toContain("3978");
    });
  });

  describe("reconnect", () => {
    it("attempts reconnect on unexpected close instead of immediately calling onExit", async () => {
      vi.useFakeTimers();
      const provider = new AzureRelayProvider(TEST_CONFIG);
      const exitCb = vi.fn();
      provider.onExit(exitCb);
      await provider.start(3978);

      // Simulate unexpected disconnect
      mockServer.emit("close");

      // onExit should NOT be called immediately — reconnect should be attempted first
      expect(exitCb).not.toHaveBeenCalled();
      expect(provider.getMetrics().reconnectAttempts).toBe(1);

      vi.useRealTimers();
      await provider.stop(true);
    });

    it("recovers after a successful reconnect", async () => {
      vi.useFakeTimers();
      const provider = new AzureRelayProvider(TEST_CONFIG);
      const exitCb = vi.fn();
      provider.onExit(exitCb);
      await provider.start(3978);

      // Simulate unexpected disconnect
      mockServer.emit("close");

      // Advance past the first reconnect delay (base 1s + up to 1s jitter)
      await vi.advanceTimersByTimeAsync(2_500);

      // Should have reconnected successfully
      expect(provider.getPublicUrl()).toBe("https://myrelay.servicebus.windows.net/bot-endpoint");
      expect(provider.getMetrics().reconnectsSucceeded).toBe(1);
      expect(exitCb).not.toHaveBeenCalled();

      vi.useRealTimers();
      await provider.stop(true);
    });

    it("escalates to onExit after exhausting all reconnect attempts", async () => {
      vi.useFakeTimers();

      // Make every reconnect attempt fail
      let callCount = 0;
      const origCreate = mockHycoHttps.createRelayedServer;
      mockHycoHttps.createRelayedServer = (_opts: unknown, listener: unknown) => {
        callCount++;
        mockServer = new MockRelayedServer();
        if (callCount > 1) {
          // All reconnect attempts fail — emit error instead of 'listening'
          mockServer.listen = () => {
            process.nextTick(() => mockServer.emit("error", new Error("Connection refused")));
          };
        }
        capturedRequestHandler = listener as typeof capturedRequestHandler;
        return mockServer;
      };

      const provider = new AzureRelayProvider(TEST_CONFIG);
      const exitCb = vi.fn();
      provider.onExit(exitCb);
      await provider.start(3978);

      // Simulate unexpected disconnect
      mockServer.emit("close");

      // Advance through all 5 retry attempts (exponential backoff: ~1s, ~2s, ~4s, ~8s, ~16s + jitter)
      for (let i = 0; i < 5; i++) {
        await vi.advanceTimersByTimeAsync(35_000);
      }

      // After 5 failed attempts, onExit should be called
      expect(exitCb).toHaveBeenCalledWith(null);
      expect(provider.getMetrics().reconnectAttempts).toBe(5);
      expect(provider.getMetrics().reconnectsSucceeded).toBe(0);

      vi.useRealTimers();
      mockHycoHttps.createRelayedServer = origCreate;
    });

    it("does not reconnect after explicit stop", async () => {
      vi.useFakeTimers();
      const provider = new AzureRelayProvider(TEST_CONFIG);
      const exitCb = vi.fn();
      provider.onExit(exitCb);
      await provider.start(3978);

      // Stop explicitly, then simulate close event
      await provider.stop();

      expect(exitCb).not.toHaveBeenCalled();
      expect(provider.getMetrics().reconnectAttempts).toBe(0);

      vi.useRealTimers();
    });

    it("cancels pending reconnect on stop", async () => {
      vi.useFakeTimers();
      const provider = new AzureRelayProvider(TEST_CONFIG);
      const exitCb = vi.fn();
      provider.onExit(exitCb);
      await provider.start(3978);

      // Trigger reconnect
      mockServer.emit("close");
      expect(provider.getMetrics().reconnectAttempts).toBe(1);

      // Stop before reconnect timer fires
      await provider.stop(true);

      // Advance past the reconnect delay
      await vi.advanceTimersByTimeAsync(5_000);

      // Should not have reconnected or called onExit
      expect(exitCb).not.toHaveBeenCalled();
      expect(provider.getPublicUrl()).toBe("");

      vi.useRealTimers();
    });
  });
});
