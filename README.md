# @hahnfeld/msrelay-provider

Azure Relay Hybrid Connections tunnel provider plugin for [OpenACP](https://github.com/Open-ACP/openacp). Exposes local HTTP services through Azure's private backbone — no public internet exposure, no inbound ports.

## Why

Public tunnel providers (Dev Tunnels, ngrok, Cloudflare Tunnel) create internet-accessible URLs. Organizations with strict network security policies may prohibit this. Azure Relay Hybrid Connections solves the problem by keeping all traffic on Microsoft's backbone, reachable via ExpressRoute or VPN with no inbound connections required.

This plugin is a drop-in replacement for [`@hahnfeld/devtunnel-provider`](https://github.com/hahnfeld/devtunnel-provider) and other OpenACP tunnel providers. It implements the standard `TunnelProvider` interface, so swapping providers requires no changes to other plugins or adapters.

## How It Works

```
External caller (webhook, API client, bot framework, etc.)
      |
      v  HTTPS request
Azure Relay endpoint
  https://<namespace>.servicebus.windows.net/<connection>
      |
      |  Azure private backbone / ExpressRoute
      v
Azure Relay service
      ^
      |  Outbound WebSocket (wss://)
      |
Local machine (no inbound ports)
      |
      v  HTTP forward to localhost
OpenACP (or any local HTTP server)
```

The local machine opens an **outbound** WebSocket to the Azure Relay service. Incoming HTTP requests are forwarded to `localhost:<port>` and responses are piped back through the Relay. The public URL is deterministic and stable across restarts.

### Use With Other Plugins

This plugin provides a tunnel — it makes a local port reachable via a stable HTTPS URL. Any OpenACP plugin or adapter that needs an externally reachable endpoint can use it:

- **Teams adapter** — Set the Bot Framework messaging endpoint to the Relay URL. The Teams adapter and this plugin work hand-in-hand but are independently installable. You can use the Teams adapter with a different tunnel provider, or use this plugin without the Teams adapter.
- **Webhook receivers** — Any service that delivers events via HTTP POST (Slack, GitHub, Stripe, etc.) can target the Relay URL.
- **API exposure** — Expose the OpenACP API server or any local service to authorized callers without opening inbound ports.

## Install

```bash
openacp plugin install @hahnfeld/msrelay-provider
```

The install wizard prompts for:

1. Azure Relay namespace (e.g., `myrelay.servicebus.windows.net`)
2. Hybrid Connection name (e.g., `bot-endpoint`)
3. SAS policy name and key (with `Listen` permission)
4. Local port to forward to (3978 for Bot Framework, 21420 for OpenACP API server, or any custom port)

## Azure Setup

Before installing the plugin, provision these Azure resources:

```bash
# 1. Create Relay namespace
az relay namespace create \
  --resource-group <rg> --name <namespace> --location westus2

# 2. Create Hybrid Connection with client authorization disabled
#    (required if callers can't send SAS headers — Bot Framework, webhooks, etc.)
#    NOTE: --requires-client-authorization cannot be changed after creation.
#    If you need to change it, delete and recreate the Hybrid Connection.
az relay hyco create \
  --resource-group <rg> --namespace-name <namespace> --name my-connection \
  --requires-client-authorization false

# 4. Create listen-only SAS policy (least privilege)
az relay hyco authorization-rule create \
  --resource-group <rg> --namespace-name <namespace> \
  --hybrid-connection-name my-connection \
  --name ListenOnly --rights Listen

# 5. Retrieve the key
az relay hyco authorization-rule keys list \
  --resource-group <rg> --namespace-name <namespace> \
  --hybrid-connection-name my-connection --name ListenOnly
```

The resulting endpoint URL is:

```
https://<namespace>.servicebus.windows.net/my-connection
```

Point your external callers (Bot Framework messaging endpoint, webhook URLs, etc.) at this URL.

## Configuration

After install, reconfigure any setting:

```bash
openacp plugin configure @hahnfeld/msrelay-provider
```

| Setting | Description | Default |
|---------|-------------|---------|
| `enabled` | Whether the provider is active | `true` |
| `port` | Local port to forward to | `PORT` env or `3978` |
| `relayNamespace` | Azure Relay namespace | — |
| `hybridConnectionName` | Hybrid Connection name | — |
| `sasKeyName` | SAS policy name | — |
| `sasKeyValue` | SAS key (encrypted at rest) | — |

## Commands

| Command | Description |
|---------|-------------|
| `/relay` | Show connection status, uptime, request/error counts |
| `/relay auth` | Validate SAS key by generating a test token |

## Development

```bash
pnpm install
pnpm test          # Run tests (28 tests)
pnpm build         # Compile TypeScript
pnpm dev           # Watch mode
pnpm lint          # Type-check without emitting
```

## Known Issues

- **`hyco-https` is CJS-only.** The library has no ESM exports and no TypeScript type declarations. This plugin uses `createRequire()` for the import and ships a custom `hyco-https.d.ts` covering only the API surface consumed. If Microsoft publishes an ESM version, this workaround can be removed.

- **`hyco-https` does not auto-reconnect.** If the WebSocket connection to the Relay drops (network disruption, token expiry edge case, Azure maintenance), the library does not attempt to re-establish the connection. This plugin handles reconnection internally with exponential backoff and jitter (up to 5 attempts). Only after exhausting retries does it escalate to OpenACP's `TunnelRegistry`. During the reconnection window (typically a few seconds for transient failures), requests to the Relay endpoint will fail.

- **`hyco-https` depends on `ws@^6` and `moment@^2`.** These are transitive dependencies pulled in by the library. `ws@6` is outdated (current is v8) and `moment` is in maintenance mode. Neither is directly used by this plugin. If these dependencies cause conflicts, they would need to be resolved upstream in `hyco-https`.

- **Large request bodies (>64 KB) not verified.** Azure Relay auto-upgrades to a rendezvous WebSocket for payloads exceeding 64 KB. The `hyco-https` library is expected to handle this transparently, but this has not been tested under load. Typical webhook and bot payloads are well under this limit.

## Security Notes

- **Client authorization** on the Hybrid Connection can be enabled or disabled depending on your use case. Disable it when callers cannot send `ServiceBusAuthorization` headers (Bot Framework, external webhooks, third-party services). Enable it when all callers are internal and can authenticate with SAS tokens. When client auth is disabled, application-layer authentication (e.g., OpenACP's JWT middleware) is the security boundary — the same model used by anonymous tunnel providers.

- **Use a listen-only SAS policy.** The plugin only needs `Listen` permission. Do not use `RootManageSharedAccessKey`, which grants full management access to the namespace. If the key is compromised, a listen-only policy limits the blast radius to eavesdropping on the Hybrid Connection, not managing or deleting Azure resources.

- **SAS key rotation** requires reconfiguring the plugin (`openacp plugin configure`) and restarting. The `hyco-https` token factory generates short-lived tokens from the key, so the key itself is not sent over the wire after initial token generation.

- **No inbound ports.** The local machine only opens outbound WebSocket connections. No firewall rules or port forwarding are needed. In ExpressRoute environments, traffic never touches the public internet.

## License

MIT
