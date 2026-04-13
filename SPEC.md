# Technical Specification: @hahnfeld/msrelay-provider

**Version:** 0.1.0
**Date:** 2026-04-13
**Author:** Matt Hahnfeld
**Status:** Draft

---

## Table of Contents

1. [Overview](#1-overview)
2. [Architecture](#2-architecture)
3. [Package Identity](#3-package-identity)
4. [Dependencies and Compatibility](#4-dependencies-and-compatibility)
5. [Configuration Schema](#5-configuration-schema)
6. [Provider Implementation](#6-provider-implementation)
7. [Plugin Lifecycle](#7-plugin-lifecycle)
8. [Commands](#8-commands)
9. [Security Considerations](#9-security-considerations)
10. [File Structure](#10-file-structure)
11. [Build and Scripts](#11-build-and-scripts)
12. [Azure Prerequisites](#12-azure-prerequisites)
13. [Testing Strategy](#13-testing-strategy)

---

## 1. Overview

### Problem

Public tunnel providers (Dev Tunnels, ngrok, Cloudflare Tunnel) create internet-accessible URLs. Organizations with strict network security policies may prohibit this exposure. Any OpenACP deployment that needs an externally reachable endpoint — for webhook delivery, bot frameworks, API exposure, or other integrations — requires an alternative that keeps traffic off the public internet.

### Solution

`@hahnfeld/msrelay-provider` is a general-purpose OpenACP tunnel provider plugin that routes HTTP traffic through Azure Relay Hybrid Connections. Azure Relay operates on Microsoft's private backbone, reachable via ExpressRoute or VPN. No inbound connections are required: the local machine opens an outbound WebSocket to the Azure Relay service, and all HTTP requests are forwarded through this private channel to a local port.

This plugin is a drop-in replacement for `@hahnfeld/devtunnel-provider` and other OpenACP tunnel providers. It implements the standard `TunnelProvider` interface and follows identical OpenACP plugin conventions, allowing operators to swap providers without changes to other plugins or adapters. It works with any HTTP caller — Bot Framework, webhook services (Slack, GitHub, Stripe), REST API clients, or custom integrations.

### Key Properties

| Property | Value |
|----------|-------|
| Network path | Azure private backbone via ExpressRoute |
| Public URL | Deterministic: `https://<namespace>.servicebus.windows.net/<connection>` |
| Inbound connections | None (outbound WebSocket only) |
| Authentication | SAS key for listener; client auth disabled for Bot Framework |
| Protocol | HTTP forwarding (not TCP tunneling) |

---

## 2. Architecture

```
External caller (webhook, API client, bot framework, etc.)
      |
      v  HTTPS request
Azure Relay HTTPS Endpoint
  https://<namespace>.servicebus.windows.net/<hybridConnectionName>
      |
      |  Azure private backbone
      |
      v
Azure Relay Service
      ^
      |  Outbound WebSocket (wss://)
      |  Authenticated with SAS token (Listen permission)
      |
Local Machine (ExpressRoute / VPN / internet)
      |
      v  http.request() to localhost
OpenACP (or any local HTTP server on the configured port)
```

### Data Flow

1. An external caller sends an HTTPS request to the Azure Relay endpoint.
2. Azure Relay accepts the request and holds it pending a listener.
3. The local `hyco-https` relayed server (this plugin) maintains an outbound WebSocket to the Relay service.
4. The Relay service forwards the HTTP request through the WebSocket to the local listener.
5. The plugin receives the request as a standard Node.js `IncomingMessage` and forwards it to `http://localhost:<port>` via `http.request()`.
6. The response from the local server is piped back through the Relay to the original caller.

For request bodies exceeding 64 KB, Azure Relay transparently upgrades to a rendezvous WebSocket connection. The `hyco-https` library handles this upgrade internally; no special handling is required in this plugin.

### Compatibility With Other Plugins

This plugin provides a tunnel — it makes a local port reachable via a stable HTTPS URL. Any OpenACP plugin or adapter that needs an externally reachable endpoint can use it. For example, the Teams adapter can use this plugin as its tunnel provider, but the two are independently installable and neither requires the other.

---

## 3. Package Identity

| Field | Value |
|-------|-------|
| Package name | `@hahnfeld/msrelay-provider` |
| Registry | npmjs.org (public access, `@hahnfeld` scope) |
| License | MIT |
| Module system | ESM (`"type": "module"`) |
| TypeScript | Strict mode, ES2022 target, NodeNext module resolution |
| Conventions | OpenACP plugin conventions: kebab-case filenames, Pino logging via `@openacp/plugin-sdk`, Zod config validation |

---

## 4. Dependencies and Compatibility

### Runtime Dependencies

| Package | Version | Notes |
|---------|---------|-------|
| `hyco-https` | `^1.4.5` | Microsoft's official Hybrid Connections library. **CJS-only** (no ESM exports, no TypeScript declarations). See [CJS interop](#cjs-interop) below. |

### Peer Dependencies

| Package | Version |
|---------|---------|
| `@openacp/cli` | `>=2026.0.0` |

### Dev Dependencies

| Package | Version |
|---------|---------|
| `@openacp/plugin-sdk` | `^2026.331.1` |
| `typescript` | `^5.4.0` |
| `vitest` | `^3.0.0` |
| `zod` | `^3.23.0` |

### Platform Requirements

- Node.js >= 18
- OpenACP >= 2026.0.0

### CJS Interop

`hyco-https` is a CommonJS package (`main: index.js`, no `"type": "module"`, uses `require()` internally). Since this plugin is ESM, the library must be imported using `createRequire`:

```typescript
import { createRequire } from "node:module";
const require = createRequire(import.meta.url);
const hycoHttps = require("hyco-https");
```

A custom type declaration file (`src/hyco-https.d.ts`) must be provided to give TypeScript visibility into the API surface used by this plugin. Only the functions actually consumed are declared:

```typescript
declare module "hyco-https" {
  import type { IncomingMessage, ServerResponse } from "node:http";
  import type { Server } from "node:events";

  interface RelayedServerOptions {
    server: string;
    token: () => string;
  }

  type RequestListener = (req: IncomingMessage, res: ServerResponse) => void;

  function createRelayedServer(
    options: RelayedServerOptions,
    requestListener: RequestListener,
  ): RelayedServer;

  function createRelayListenUri(namespace: string, path: string): string;

  function createRelayToken(uri: string, keyName: string, key: string, expirationSeconds?: number): string;

  interface RelayedServer extends Server {
    listen(callback?: (err?: Error) => void): void;
    close(callback?: () => void): void;
  }
}
```

---

## 5. Configuration Schema

### TypeScript Interface

```typescript
export interface AzureRelayConfig {
  /** Whether the provider is active. Default: true. */
  enabled: boolean;
  /** Local port to forward requests to. Default: PORT env var or 3978. */
  port: number | null;
  /** Azure Relay namespace (e.g., "myrelay.servicebus.windows.net"). */
  relayNamespace: string;
  /** Hybrid Connection name (e.g., "bot-endpoint"). */
  hybridConnectionName: string;
  /** SAS policy name (e.g., "ListenOnly" or "RootManageSharedAccessKey"). */
  sasKeyName: string;
  /** SAS key value. Stored encrypted at rest by OpenACP settings. */
  sasKeyValue: string;
}
```

### Zod Validation Schema

```typescript
import { z } from "zod";

export const AzureRelayConfigSchema = z.object({
  enabled: z.boolean().default(true),
  port: z.number().int().min(1).max(65535).nullable().default(null),
  relayNamespace: z.string().min(1).regex(
    /^[a-zA-Z0-9-]+\.servicebus\.windows\.net$/,
    "Must be a valid Azure Relay namespace (e.g., myrelay.servicebus.windows.net)",
  ),
  hybridConnectionName: z.string().min(1).regex(
    /^[a-zA-Z0-9._-]+$/,
    "Must contain only alphanumeric characters, dots, underscores, and hyphens",
  ),
  sasKeyName: z.string().min(1),
  sasKeyValue: z.string().min(1),
});
```

### Default Values

```typescript
export const DEFAULT_CONFIG: AzureRelayConfig = {
  enabled: true,
  port: Number(process.env.PORT) || 3978,
  relayNamespace: "",
  hybridConnectionName: "",
  sasKeyName: "",
  sasKeyValue: "",
};
```

---

## 6. Provider Implementation

### Class: `AzureRelayProvider`

Implements the `TunnelProvider` interface defined in `@openacp/plugin-sdk`:

```typescript
interface TunnelProvider {
  start(localPort: number): Promise<string>
  stop(force?: boolean, preserveState?: boolean): Promise<void>
  getPublicUrl(): string
  onExit(callback: (code: number | null) => void): void
}
```

### 6.1 Construction

The provider is instantiated with a validated `AzureRelayConfig` object. No network connections are made at construction time.

### 6.2 `start(localPort: number): Promise<string>`

1. Build the listener URI using `hycoHttps.createRelayListenUri(namespace, connectionName)`.
2. Create a relayed server via `hycoHttps.createRelayedServer()` with:
   - `server`: the listener URI
   - `token`: a factory function that returns a fresh SAS token via `hycoHttps.createRelayToken()`
3. In the request handler, forward each incoming request to `http://localhost:<localPort>`:
   - Preserve method, path (`req.url`), and headers
   - Pipe the request body through
   - Pipe the response (status code, headers, body) back to the Relay response
   - On local server errors: respond with 502 (connection refused) or 504 (timeout)
4. Call `server.listen()` and await the callback.
5. Set a startup timeout of **30 seconds**. If the listener callback does not fire within this window, reject the promise and close the server.
6. Resolve with the public URL: `https://<relayNamespace>/<hybridConnectionName>`.

**URL determinism:** Unlike Dev Tunnels, the Azure Relay public URL is fully deterministic from the configuration values. There is no need to parse stdout or monitor for URL changes. The URL is known before `start()` is called.

### 6.3 HTTP Forwarding

For each request received via the Relay:

```
Relay Request                    Local Forward
─────────────                    ─────────────
method: POST                  →  method: POST
url: /api/messages            →  path: /api/messages
headers: { ... }              →  headers: { ... } (host header rewritten to localhost)
body: <stream>                →  body: <piped stream>

Local Response                   Relay Response
──────────────                   ──────────────
statusCode: 200               →  statusCode: 200
headers: { ... }              →  headers: { ... }
body: <stream>                →  body: <piped stream>
```

**Error responses from the proxy layer:**

| Condition | Status | Body |
|-----------|--------|------|
| Local server not listening (ECONNREFUSED) | 502 Bad Gateway | `{"error": "Local server not reachable on port <port>"}` |
| Local server timeout (> 30 seconds) | 504 Gateway Timeout | `{"error": "Local server did not respond within 30s"}` |
| Unexpected proxy error | 502 Bad Gateway | `{"error": "Proxy error: <message>"}` |

The `Content-Type` header on error responses is set to `application/json`.

The **local forward timeout** of 30 seconds is defined as a constant (`LOCAL_FORWARD_TIMEOUT_MS`). This is separate from the startup timeout.

### 6.4 `stop(force?: boolean, preserveState?: boolean): Promise<void>`

1. Close the relayed server via `server.close()`.
2. The underlying WebSocket disconnects cleanly.
3. If `force` is true, skip graceful shutdown and destroy the server immediately.
4. `preserveState` is accepted for interface compatibility but has no effect (the Relay endpoint remains available in Azure regardless of listener state).
5. Clear internal state (server reference, public URL, exit callback).

### 6.5 `getPublicUrl(): string`

Returns the deterministic URL `https://<relayNamespace>/<hybridConnectionName>`, or an empty string if the provider has not been started or has been stopped.

### 6.6 `onExit(callback: (code: number | null) => void): void`

Registers a callback invoked when the Relay WebSocket connection drops unexpectedly after successful establishment.

**Reconnection strategy:** `hyco-https` does **not** auto-reconnect. This plugin implements its own reconnection logic:

1. When the underlying WebSocket emits `close` or `error` after establishment, the provider enters reconnect mode.
2. It retries with **exponential backoff and jitter**: delay = min(1s * 2^attempt + random(0-1s), 30s).
3. Up to **5 attempts** are made. Each attempt creates a fresh `createRelayedServer()` and calls `listen()`.
4. On successful reconnect, the provider resumes normal operation. The public URL remains the same (deterministic).
5. After exhausting all 5 attempts, the provider invokes the `onExit` callback to escalate to OpenACP's `TunnelRegistry` for higher-level retry coordination.

This two-tier approach means transient failures (brief network blips, Azure maintenance windows) recover in seconds without involving the registry, while persistent failures are properly escalated.

| Constant | Value | Description |
|----------|-------|-------------|
| `MAX_RECONNECT_ATTEMPTS` | 5 | Retries before escalating to TunnelRegistry |
| `RECONNECT_BASE_DELAY_MS` | 1,000 | Base delay for exponential backoff |
| `RECONNECT_MAX_DELAY_MS` | 30,000 | Maximum delay cap |

Events that trigger reconnect:
- WebSocket `close` event after establishment
- WebSocket `error` event after establishment
- Server `error` event (e.g., SAS token renewal failure)

Events that do **not** trigger reconnect:
- Errors during initial `start()` (these reject the start promise instead)
- Explicit calls to `stop()` (intentional shutdown — reconnect timers are cancelled)

### 6.7 Metrics (Internal)

The provider tracks the following counters for the `/relay status` command:

| Metric | Type | Description |
|--------|------|-------------|
| `requestCount` | counter | Total HTTP requests forwarded since start |
| `errorCount` | counter | Total proxy errors (502/504) since start |
| `startedAt` | timestamp | When the listener was first established |
| `lastError` | string \| null | Most recent error message |
| `lastErrorAt` | timestamp \| null | When the most recent error occurred |
| `reconnectAttempts` | counter | Total reconnect attempts since start |
| `reconnectsSucceeded` | counter | Successful reconnections since start |

These are held in memory only. They reset on each `start()` call.

---

## 7. Plugin Lifecycle

The plugin follows the exact pattern established by `@hahnfeld/devtunnel-provider`.

### 7.1 `install(ctx: InstallContext)`

Interactive wizard:

1. **Prerequisites note** — Display required Azure resources (Relay namespace, Hybrid Connection, SAS key).
2. **Relay namespace** — Text prompt with validation (must match `*.servicebus.windows.net`).
3. **Hybrid Connection name** — Text prompt with validation (alphanumeric, dots, hyphens).
4. **SAS key name** — Text prompt (default: `ListenOnly`).
5. **SAS key value** — Text prompt (masked input).
6. **Port** — Select prompt: PORT env var / 3978 (Bot Framework) / 21420 (OpenACP) / custom.
7. **Connectivity test** — Optional. Attempt `createRelayedServer()` + `listen()` with a 10-second timeout. Report success or failure. Do not block installation on failure.
8. **Save** — Persist all values via `ctx.settings.setAll()`.
9. **Summary** — Display configuration summary.

### 7.2 `configure(ctx: InstallContext)`

Loop menu allowing changes to individual settings:

- Relay namespace
- Hybrid Connection name
- SAS key name
- SAS key value (re-enter)
- Port
- Enable/disable provider
- Test connectivity
- Done

### 7.3 `setup(ctx)`

1. Register editable fields for the OpenACP settings UI.
2. Validate configuration with the Zod schema. If invalid, log a warning and return (do not crash).
3. Create an `AzureRelayProvider` instance.
4. Register the provider as service `"tunnel-provider:azure-relay"`.
5. Listen for the `"api-server:started"` event. On receipt, call `provider.start(port)`.
6. Register the `/relay` command (see [Commands](#8-commands)).
7. Log: `"Azure Relay provider registered — waiting for API server"`.

### 7.4 `teardown()`

Call `provider.stop()` and set the provider reference to null.

### 7.5 `uninstall(ctx, opts)`

If `opts.purge` is true, clear all settings. Display a note about Azure-side cleanup:

```
The Azure Relay namespace and Hybrid Connection remain in your Azure subscription.
To clean up:
  1. az relay hyco delete --resource-group <rg> --namespace-name <ns> --name <connection>
  2. az relay namespace delete --resource-group <rg> --name <ns>  (if no longer needed)
```

### 7.6 `migrate(ctx, oldSettings, oldVersion)`

Future-proof hook. Initial version performs no migrations.

---

## 8. Commands

### `/relay` (default: status)

Displays current provider state:

```
Azure Relay: Connected
  URL:       https://myrelay.servicebus.windows.net/bot-endpoint
  Uptime:    2h 14m
  Requests:  847
  Errors:    3
  Last error: 502 — Local server not reachable on port 3978 (12m ago)
```

When the provider is not active:

```
Azure Relay: Not active
```

### `/relay auth`

Validates the configured SAS key by generating a test token via `hycoHttps.createRelayToken()`. Does not make a network connection. Reports whether the token was generated successfully (valid key format) or failed.

---

## 9. Security Considerations

### Network Security

Azure Relay Hybrid Connections requires no inbound ports. The local machine establishes an **outbound** WebSocket connection (wss://) to the Azure Relay service. In environments with ExpressRoute, this traffic traverses the Microsoft private backbone and never touches the public internet.

### Client Authorization

The Hybrid Connection's "Requires Client Authorization" setting can be enabled or disabled depending on the use case:

- **Disabled** — Required when callers cannot send `ServiceBusAuthorization` headers (Bot Framework, external webhook providers, third-party services). Any HTTPS client can send requests to the Relay endpoint.
- **Enabled** — Appropriate when all callers are internal and can authenticate with SAS tokens at the transport layer.

When client authorization is disabled, this is equivalent to the security model of anonymous Dev Tunnels: the transport layer is open, and the application layer (OpenACP's JWT middleware) is responsible for request authentication and authorization.

### Listener Authentication

The listener (this plugin) authenticates to the Azure Relay service using a SAS (Shared Access Signature) key with the `Listen` permission. This key:

- Is stored in OpenACP plugin settings (encrypted at rest by the OpenACP settings system).
- Should use a dedicated **listen-only SAS policy** rather than `RootManageSharedAccessKey` (principle of least privilege).
- Is refreshed automatically by the `hyco-https` token factory.

### SAS Key Rotation

When IT rotates the SAS key, the plugin must be reconfigured via `openacp plugin configure @hahnfeld/msrelay-provider` and restarted. The `hyco-https` token factory generates short-lived tokens from the key, so key rotation does not require Relay-level changes.

---

## 10. File Structure

```
msrelay-provider/
  package.json
  tsconfig.json
  SPEC.md
  PLAN.md
  .gitignore
  .npmignore
  src/
    index.ts                  Plugin factory + default export
    plugin.ts                 OpenACPPlugin implementation (lifecycle hooks)
    provider.ts               AzureRelayProvider implements TunnelProvider
    types.ts                  AzureRelayConfig, Zod schema, DEFAULT_CONFIG
    hyco-https.d.ts           Custom type declarations for hyco-https (CJS)
    __tests__/
      provider.test.ts        Provider unit tests
      plugin.test.ts          Plugin lifecycle tests
```

---

## 11. Build and Scripts

```json
{
  "scripts": {
    "build": "tsc",
    "dev": "tsc --watch",
    "test": "vitest run",
    "test:watch": "vitest",
    "prepublishOnly": "pnpm build",
    "lint": "tsc --noEmit"
  }
}
```

Full `package.json` shape is defined in PLAN.md with the following additions:

- `"scripts"` block as above
- `zod` added to `dependencies` (runtime config validation)

---

## 12. Azure Prerequisites

Before the plugin can operate, the following Azure resources must be provisioned by IT:

### Step 1: Create Azure Relay Namespace

```bash
az relay namespace create \
  --resource-group <resource-group> \
  --name <namespace> \
  --location westus2
```

### Step 2: Create Hybrid Connection

```bash
az relay hyco create \
  --resource-group <resource-group> \
  --namespace-name <namespace> \
  --name bot-endpoint
```

### Step 3: Disable Client Authorization

Required because Bot Framework cannot send SAS headers.

```bash
az relay hyco update \
  --resource-group <resource-group> \
  --namespace-name <namespace> \
  --name bot-endpoint \
  --requires-client-authorization false
```

### Step 4: Create Listen-Only SAS Policy

Principle of least privilege: the plugin only needs `Listen` permission.

```bash
az relay hyco authorization-rule create \
  --resource-group <resource-group> \
  --namespace-name <namespace> \
  --hybrid-connection-name bot-endpoint \
  --name ListenOnly \
  --rights Listen
```

Retrieve the key:

```bash
az relay hyco authorization-rule keys list \
  --resource-group <resource-group> \
  --namespace-name <namespace> \
  --hybrid-connection-name bot-endpoint \
  --name ListenOnly
```

### Step 5: Configure Bot Framework Messaging Endpoint

In the Azure Bot resource (or Bot Framework registration), set the messaging endpoint to:

```
https://<namespace>.servicebus.windows.net/bot-endpoint
```

---

## 13. Testing Strategy

### Unit Tests: `provider.test.ts`

| Test Case | Description |
|-----------|-------------|
| Creates relayed server with correct parameters | Verify `createRelayedServer()` receives the expected listener URI and token factory |
| Resolves with deterministic URL | `start()` resolves with `https://<namespace>/<connection>` |
| Forwards HTTP requests to localhost | Mock incoming request, verify `http.request()` is called with correct method, path, headers |
| Pipes request and response bodies | Verify bidirectional streaming works |
| Returns 502 on ECONNREFUSED | Local server not running, verify 502 response |
| Returns 504 on timeout | Local server hangs, verify 504 after 30s |
| Rejects on startup timeout | `server.listen()` callback never fires within 30s |
| Stop closes the server | `stop()` calls `server.close()` |
| Force stop destroys immediately | `stop(true)` bypasses graceful shutdown |
| Fires onExit on unexpected WebSocket close | Server emits `close` after establishment, verify callback fires |
| Does not fire onExit on explicit stop | `stop()` should not trigger the exit callback |
| Tracks request and error counts | Verify metrics after forwarding requests |

### Unit Tests: `plugin.test.ts`

| Test Case | Description |
|-----------|-------------|
| Install stores valid config | Use `createTestInstallContext`, verify `settings.setAll()` receives correct shape |
| Setup registers service | Verify `ctx.registerService("tunnel-provider:azure-relay", provider)` is called |
| Setup listens for api-server:started | Verify event listener is registered |
| Setup skips when disabled | Config `enabled: false`, verify no service registration |
| Setup validates config with Zod | Invalid config logs warning and returns without crashing |
| Teardown stops provider | Verify `provider.stop()` is called |
| Uninstall with purge clears settings | Verify `settings.clear()` is called |
| Migrate returns settings unchanged | v0.1.0 settings pass through unmodified |

### Test Utilities

- `@openacp/plugin-sdk/testing` — `createTestContext`, `createTestInstallContext`
- `vitest` mocks for `hyco-https` (via `vi.mock` with factory)
- `vitest` mocks for `node:http` (`http.request`) to verify forwarding behavior
