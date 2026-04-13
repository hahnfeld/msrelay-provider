# Azure Relay Hybrid Connections Provider — Implementation Plan

## Motivation

Alaska Airlines IT requires that the Teams bot endpoint not be exposed to the public internet via anonymous devtunnels. Azure Relay Hybrid Connections solves this by routing all traffic through Azure's private backbone, reachable via the organization's existing ExpressRoute connection. No inbound connections are required — the local machine opens an outbound WebSocket to the Relay service.

This plugin replaces `@hahnfeld/devtunnel-provider` for environments where IT policy prohibits anonymous public tunnels.

## Architecture

```
Teams → Bot Framework → Azure Relay HTTPS endpoint
                              ↕ Azure backbone
                        Azure Relay service
                              ↕ ExpressRoute (private)
                     Local machine (outbound WebSocket listener)
                              ↓ localhost forward
                        Bot / OpenACP API server
```

### Key Design Decisions

1. **`hyco-https` package** — Microsoft's official Node.js library for Hybrid Connections. Provides `createRelayedServer()` as a drop-in for `https.createServer()`. This is the listener side.
2. **Client Authorization OFF** — The Hybrid Connection's "Requires Client Authorization" setting must be disabled. Bot Framework cannot send `ServiceBusAuthorization` headers. App-layer JWT validation remains the security boundary (identical to devtunnel anonymous approach, but network path is private).
3. **SAS key for listener auth** — The listener (this plugin) authenticates to the Relay using a SAS (Shared Access Signature) key with `Listen` permission. This is stored in plugin settings.
4. **HTTP forwarding, not WebSocket tunneling** — We receive HTTP requests via the Relay and forward them to `localhost:<port>`. This is simpler than a full TCP tunnel and matches the Bot Framework's HTTP POST pattern.

## OpenACP Plugin Conventions

Follow these exactly (from CONTRIBUTING.md and the plugin template scaffold):

### Code Style
- TypeScript strict mode, ESM with `.js` extensions in imports
- kebab-case filenames
- Zod for config validation (optional but recommended)
- Pino for logging via `@openacp/plugin-sdk` — **no `console.log`**
- Comments: explain why/how, not what. JSDoc for all public APIs.

### Package Structure
```
msrelay-connector/
├── package.json
├── tsconfig.json
├── src/
│   ├── index.ts              # Plugin factory + default export
│   ├── plugin.ts             # OpenACPPlugin implementation (lifecycle hooks)
│   ├── provider.ts           # AzureRelayProvider implements TunnelProvider
│   ├── types.ts              # AzureRelayConfig type + DEFAULT_CONFIG
│   └── __tests__/
│       ├── provider.test.ts  # Provider unit tests
│       └── plugin.test.ts    # Plugin lifecycle tests
├── .gitignore
└── .npmignore
```

### Naming & Distribution

- **Package name:** `@hahnfeld/msrelay-connector`
- **npm:** Published to npmjs.org under the `@hahnfeld` scope (public access), same as `@hahnfeld/devtunnel-provider`
- **GitHub:** `github.com/hahnfeld/msrelay-connector` — same org/user as the devtunnel-provider repo
- **Author:** Matt Hahnfeld
- **License:** MIT

### package.json Shape
```json
{
  "name": "@hahnfeld/msrelay-connector",
  "version": "0.1.0",
  "description": "Azure Relay Hybrid Connections provider plugin for OpenACP",
  "type": "module",
  "main": "dist/index.js",
  "types": "dist/index.d.ts",
  "exports": {
    ".": {
      "types": "./dist/index.d.ts",
      "import": "./dist/index.js"
    }
  },
  "keywords": ["openacp", "openacp-plugin", "azure-relay", "hybrid-connections", "tunnel", "teams"],
  "author": "Matt Hahnfeld",
  "license": "MIT",
  "repository": {
    "type": "git",
    "url": "git+https://github.com/hahnfeld/msrelay-connector.git"
  },
  "homepage": "https://github.com/hahnfeld/msrelay-connector#readme",
  "bugs": {
    "url": "https://github.com/hahnfeld/msrelay-connector/issues"
  },
  "engines": {
    "openacp": ">=2026.0.0"
  },
  "peerDependencies": {
    "@openacp/cli": ">=2026.0.0"
  },
  "dependencies": {
    "hyco-https": "^1.0.0"
  },
  "devDependencies": {
    "@openacp/plugin-sdk": "^2026.331.1",
    "typescript": "^5.4.0",
    "vitest": "^3.0.0"
  },
  "publishConfig": {
    "registry": "https://registry.npmjs.org",
    "access": "public"
  },
  "files": ["dist", "!dist/__tests__"],
  "packageManager": "pnpm@9.15.0"
}
```

Note: `hyco-https` is a runtime dependency (not dev), since it provides the Relay WebSocket listener.

### tsconfig.json
```json
{
  "compilerOptions": {
    "target": "ES2022",
    "module": "NodeNext",
    "moduleResolution": "NodeNext",
    "outDir": "dist",
    "rootDir": "src",
    "declaration": true,
    "strict": true,
    "esModuleInterop": true,
    "skipLibCheck": true
  },
  "include": ["src"],
  "exclude": ["src/**/__tests__"]
}
```

### Plugin Permissions
```typescript
permissions: [
  "services:register",   // Register as tunnel-provider
  "services:use",        // Access other services
  "events:read",         // Listen for api-server:started
  "events:emit",         // Emit relay:started, relay:url-changed
  "commands:register",   // /relay status command
]
```

### Default Export Pattern
```typescript
// src/index.ts — matches devtunnel-provider pattern
import { createRelayPlugin } from "./plugin.js";
export { createRelayPlugin };
export default createRelayPlugin();
export { AzureRelayProvider } from "./provider.js";
export type { AzureRelayConfig } from "./types.js";
```

## Implementation Steps

### Step 1: types.ts — Config Shape

```typescript
export interface AzureRelayConfig {
  enabled: boolean;
  /** Local port to forward to. Default: PORT env or 3978. */
  port: number | null;
  /** Azure Relay namespace (e.g., 'myrelay.servicebus.windows.net'). */
  relayNamespace: string;
  /** Hybrid Connection name (e.g., 'bot-endpoint'). */
  hybridConnectionName: string;
  /** SAS key name (e.g., 'RootManageSharedAccessKey' or a custom listen-only policy). */
  sasKeyName: string;
  /** SAS key value. Stored in plugin settings (encrypted at rest by OpenACP). */
  sasKeyValue: string;
}
```

### Step 2: provider.ts — AzureRelayProvider

Implements the `TunnelProvider` interface:

```typescript
interface TunnelProvider {
  start(localPort: number): Promise<string>
  stop(force?: boolean, preserveState?: boolean): Promise<void>
  getPublicUrl(): string
  onExit(callback: (code: number | null) => void): void
}
```

Key implementation details:

- **`start(localPort)`**: 
  1. Create a `hyco-https` relayed server via `createRelayedServer()`
  2. In the request handler, forward each incoming HTTP request to `http://localhost:<localPort>` using Node's `http.request()`
  3. Pipe the response back through the Relay
  4. Resolve with the public URL: `https://<namespace>/<hybridConnectionName>`
  5. Set a startup timeout (30s) — if the WebSocket doesn't connect, reject

- **`stop(force?)`**: Close the relayed server. The WebSocket disconnects cleanly.

- **`getPublicUrl()`**: Return `https://<namespace>/<hybridConnectionName>`

- **`onExit(callback)`**: The Relay WebSocket can drop (network issues, token expiry). Listen for the server `close` / `error` events and invoke the callback so TunnelRegistry can retry.

- **HTTP forwarding logic**: For each request received via the Relay:
  1. Create an `http.request()` to `localhost:<port>` with the same method, path, and headers
  2. Pipe the request body through
  3. Pipe the response (status, headers, body) back to the Relay response
  4. Handle errors (local server down, timeout) with 502/504 responses

- **Token renewal**: `hyco-https` handles SAS token refresh automatically via the `token` factory function passed to `createRelayedServer()`.

### Step 3: plugin.ts — OpenACPPlugin Lifecycle

Follow the exact pattern from `@hahnfeld/devtunnel-provider/src/plugin.ts`:

- **`install(ctx)`**: Interactive wizard that:
  1. Shows prerequisites (Azure Relay namespace, Hybrid Connection, SAS key)
  2. Prompts for relay namespace
  3. Prompts for hybrid connection name
  4. Prompts for SAS key name and value
  5. Prompts for port (3978 / 21420 / custom — same as devtunnel plugin)
  6. Optionally validates connectivity by attempting a test listen
  7. Saves config via `ctx.settings.setAll()`

- **`configure(ctx)`**: Loop menu for changing individual settings (same pattern as devtunnel)

- **`setup(ctx)`**: 
  1. Register editable fields
  2. Create `AzureRelayProvider` instance
  3. Register as `"tunnel-provider:azure-relay"` service
  4. Listen for `"api-server:started"` event, then call `provider.start(port)`
  5. Register `/relay` command for status checks

- **`teardown()`**: Call `provider.stop()`

- **`uninstall(ctx, opts)`**: Clear settings if purge, show cleanup notes

- **`migrate(ctx, oldSettings, oldVersion)`**: Future-proof migration hook

### Step 4: Tests

**provider.test.ts:**
- Mock `hyco-https` — verify `createRelayedServer()` is called with correct namespace/path/token
- Test HTTP forwarding: mock incoming request → verify it's forwarded to localhost
- Test stop/teardown: verify server is closed
- Test error handling: relay connection failure, local server down
- Test `onExit` callback fires on unexpected WebSocket close

**plugin.test.ts:**
- Use `createTestContext` and `createTestInstallContext` from `@openacp/plugin-sdk/testing`
- Test install wizard stores correct config
- Test setup registers the service and listens for events
- Test teardown calls provider.stop()

### Step 5: index.ts — Exports

Clean public API matching the devtunnel-provider pattern.

## Commit Strategy

Use Conventional Commits, branch from main:

1. `feat: scaffold project with package.json, tsconfig, types`
2. `feat: implement AzureRelayProvider with HTTP forwarding`
3. `feat: implement plugin lifecycle (install, setup, teardown)`
4. `test: add provider and plugin unit tests`
5. `docs: add README with setup instructions`

## Azure Setup Prerequisites (for the user/IT)

Before the plugin can work, the following Azure resources must exist:

1. **Azure Relay namespace** — create in the Alaska Airlines Azure subscription
   ```
   az relay namespace create --resource-group <rg> --name <namespace> --location westus2
   ```

2. **Hybrid Connection** — create within the namespace
   ```
   az relay hyco create --resource-group <rg> --namespace-name <namespace> --name bot-endpoint
   ```

3. **Disable "Requires Client Authorization"** — so Bot Framework can send without SAS tokens
   ```
   az relay hyco update --resource-group <rg> --namespace-name <namespace> \
     --name bot-endpoint --requires-client-authorization false
   ```

4. **Create a listen-only SAS policy** (better than using RootManageSharedAccessKey):
   ```
   az relay hyco authorization-rule create --resource-group <rg> \
     --namespace-name <namespace> --hybrid-connection-name bot-endpoint \
     --name ListenOnly --rights Listen
   ```

5. **Set Bot Framework messaging endpoint** to:
   ```
   https://<namespace>.servicebus.windows.net/bot-endpoint
   ```

## hyco-https API Reference

```javascript
const https = require('hyco-https');

// Build the listener URI
const uri = https.createRelayListenUri(namespace, path);

// Create relayed server (drop-in for https.createServer)
const server = https.createRelayedServer(
  {
    server: uri,
    token: () => https.createRelayToken(uri, sasKeyName, sasKeyValue)
  },
  (req, res) => {
    // Standard Node.js HTTP request handler
    // req.method, req.url, req.headers all work normally
    // res.writeHead(), res.end() all work normally
  }
);

server.listen((err) => { /* ready */ });
server.on('error', (err) => { /* relay connection error */ });
```

## Open Questions

1. **hyco-https ESM compatibility** — The package may be CJS-only. If so, use `createRequire()` to import it (same pattern used elsewhere in the Node.js ecosystem). Test this early.

2. **Large request bodies** — Hybrid Connections auto-upgrade to rendezvous WebSocket for requests >64KB. Verify that `hyco-https` handles this transparently (it should — it's Microsoft's official lib).

3. **Reconnection** — If the Relay WebSocket drops, does `hyco-https` auto-reconnect? If not, the `onExit` callback triggers TunnelRegistry retry. Investigate the library's reconnect behavior.

4. **Bot Framework path routing** — Bot Framework sends to `/api/messages` on the messaging endpoint. Verify that path is preserved through the Relay (the protocol docs say it is — `requestTarget` includes the full path).
