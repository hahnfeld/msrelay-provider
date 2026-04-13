import type { OpenACPPlugin, InstallContext } from "@openacp/plugin-sdk";
import { createRequire } from "node:module";
import { AzureRelayProvider } from "./provider.js";
import { DEFAULT_CONFIG, AzureRelayConfigSchema, type AzureRelayConfig } from "./types.js";

const require = createRequire(import.meta.url);

/** Validate that a string looks like an Azure Relay namespace. */
function isValidNamespace(v: string): boolean {
  return /^[a-zA-Z0-9-]+\.servicebus\.windows\.net$/.test(v);
}

/** Validate Hybrid Connection name format. */
function isValidConnectionName(v: string): boolean {
  return /^[a-zA-Z0-9._-]+$/.test(v);
}

/** Test SAS key by generating a token. No network call — just validates the key format. */
function testSasToken(namespace: string, connectionName: string, keyName: string, keyValue: string): { ok: true } | { ok: false; error: string } {
  try {
    const hycoHttps = require("hyco-https");
    const uri = hycoHttps.createRelayListenUri(namespace, connectionName);
    const token = hycoHttps.createRelayToken(uri, keyName, keyValue);
    if (token && typeof token === "string") {
      return { ok: true };
    }
    return { ok: false, error: "Token generation returned empty result" };
  } catch (err) {
    return { ok: false, error: `Token generation failed: ${(err as Error).message}` };
  }
}

/** Format elapsed time as human-readable duration. */
function formatUptime(startedAt: Date | null): string {
  if (!startedAt) return "N/A";
  const elapsed = Date.now() - startedAt.getTime();
  const seconds = Math.floor(elapsed / 1000);
  const minutes = Math.floor(seconds / 60);
  const hours = Math.floor(minutes / 60);
  if (hours > 0) return `${hours}h ${minutes % 60}m`;
  if (minutes > 0) return `${minutes}m ${seconds % 60}s`;
  return `${seconds}s`;
}

/** Format relative time (e.g., "12m ago"). */
function formatAgo(date: Date | null): string {
  if (!date) return "";
  const elapsed = Date.now() - date.getTime();
  const seconds = Math.floor(elapsed / 1000);
  const minutes = Math.floor(seconds / 60);
  const hours = Math.floor(minutes / 60);
  if (hours > 0) return `${hours}h ago`;
  if (minutes > 0) return `${minutes}m ago`;
  return `${seconds}s ago`;
}

/**
 * Factory for the Azure Relay Hybrid Connections provider plugin.
 *
 * Registers an `AzureRelayProvider` as a tunnel-provider service and
 * automatically starts it when the API server is ready. Unlike Dev Tunnels,
 * the public URL is deterministic and does not change across restarts.
 */
export function createRelayPlugin(): OpenACPPlugin {
  let provider: AzureRelayProvider | null = null;

  return {
    name: "@hahnfeld/msrelay-connector",
    version: "0.1.0",
    description: "Azure Relay Hybrid Connections tunnel provider — private HTTP tunneling via Azure backbone",
    essential: false,
    permissions: [
      "services:register",
      "services:use",
      "events:read",
      "events:emit",
      "commands:register",
    ],

    // ─── Interactive Install Wizard ──────────────────────────────────────

    async install(ctx: InstallContext) {
      const { terminal, settings } = ctx;

      terminal.note(
        "This plugin uses Azure Relay Hybrid Connections to expose local ports\n" +
        "through Azure's private backbone (ExpressRoute). No public internet exposure.\n" +
        "\n" +
        "Prerequisites:\n" +
        "  1. Azure Relay namespace (e.g., myrelay.servicebus.windows.net)\n" +
        "  2. Hybrid Connection with client authorization DISABLED\n" +
        "  3. SAS key with Listen permission\n" +
        "\n" +
        "See SPEC.md Section 12 for Azure CLI setup commands.",
        "Azure Relay Setup",
      );

      // ── Step 1: Relay Namespace ──

      const namespace = await terminal.text({
        message: "Azure Relay namespace (e.g., myrelay.servicebus.windows.net):",
        validate: (v) => {
          const trimmed = v.trim();
          if (!trimmed) return "Namespace is required";
          if (!isValidNamespace(trimmed)) return "Must be <name>.servicebus.windows.net";
          return undefined;
        },
      });

      // ── Step 2: Hybrid Connection Name ──

      const connectionName = await terminal.text({
        message: "Hybrid Connection name (e.g., bot-endpoint):",
        validate: (v) => {
          const trimmed = v.trim();
          if (!trimmed) return "Connection name is required";
          if (!isValidConnectionName(trimmed)) return "Must be alphanumeric with dots/hyphens/underscores";
          return undefined;
        },
      });

      // ── Step 3: SAS Key Name ──

      const keyName = await terminal.text({
        message: "SAS policy name:",
        defaultValue: "ListenOnly",
        validate: (v) => {
          if (!v.trim()) return "Key name is required";
          return undefined;
        },
      });

      // ── Step 4: SAS Key Value ──

      const keyValue = await terminal.text({
        message: "SAS key value:",
        validate: (v) => {
          if (!v.trim()) return "Key value is required";
          return undefined;
        },
      });

      // ── Step 5: Port ──

      terminal.log.info("");
      terminal.note(
        "This tunnel can point to any local port. Common choices:\n" +
        "\n" +
        "  3978  — Teams adapter (Microsoft Bot Framework default)\n" +
        "  21420 — OpenACP API server\n" +
        "\n" +
        "You can change this later with: openacp plugin configure @hahnfeld/msrelay-connector",
        "Port Selection",
      );

      const envPort = process.env.PORT ? Number(process.env.PORT) : null;
      const portChoice = await terminal.select({
        message: "Which port should the tunnel expose?",
        options: [
          ...(envPort ? [{ value: String(envPort), label: `${envPort} (from PORT env var)`, hint: "Current environment" }] : []),
          { value: "3978", label: "3978", hint: "Teams adapter (Bot Framework default)" },
          { value: "21420", label: "21420", hint: "OpenACP API server" },
          { value: "custom", label: "Other port" },
        ],
      });

      let port: number;
      if (portChoice === "custom") {
        const portStr = await terminal.text({
          message: "Local port to expose:",
          validate: (v) => {
            const trimmed = v.trim();
            if (!trimmed) return "Port is required";
            const n = Number(trimmed);
            if (isNaN(n) || !Number.isInteger(n) || n < 1 || n > 65535) return "Port must be 1-65535";
            return undefined;
          },
        });
        port = Number(portStr.trim());
      } else {
        port = Number(portChoice);
      }

      // ── Step 6: Connectivity Test (optional) ──

      const wantTest = await terminal.confirm({
        message: "Test connectivity now? (Attempts to connect to the Relay for 10s)",
        initialValue: false,
      });

      if (wantTest) {
        const spin = terminal.spinner();
        spin.start("Testing SAS token generation...");
        const tokenResult = testSasToken(namespace.trim(), connectionName.trim(), keyName.trim(), keyValue.trim());
        if (tokenResult.ok) {
          spin.stop("SAS token generated successfully");
        } else {
          spin.fail(tokenResult.error);
          terminal.log.warning("Installation will continue — you can test connectivity later with /relay auth");
        }
      }

      // ── Step 7: Save ──

      await settings.setAll({
        enabled: true,
        port,
        relayNamespace: namespace.trim(),
        hybridConnectionName: connectionName.trim(),
        sasKeyName: keyName.trim(),
        sasKeyValue: keyValue.trim(),
      } satisfies AzureRelayConfig);

      terminal.log.success("Azure Relay provider configured!");
      terminal.log.info("");
      terminal.note(
        `Namespace:  ${namespace.trim()}\n` +
        `Connection: ${connectionName.trim()}\n` +
        `SAS policy: ${keyName.trim()}\n` +
        `Port:       ${port}\n` +
        `Public URL: https://${namespace.trim()}/${connectionName.trim()}`,
        "Configuration Summary",
      );
    },

    // ─── Configure (post-install changes) ────────────────────────────────

    async configure(ctx: InstallContext) {
      const { terminal, settings } = ctx;

      while (true) {
        const current = await settings.getAll();

        const choice = await terminal.select({
          message: "What to configure?",
          options: [
            { value: "namespace", label: `Relay namespace (current: ${current.relayNamespace || "not set"})` },
            { value: "connection", label: `Hybrid Connection (current: ${current.hybridConnectionName || "not set"})` },
            { value: "sasKeyName", label: `SAS policy name (current: ${current.sasKeyName || "not set"})` },
            { value: "sasKeyValue", label: "SAS key value (re-enter)" },
            { value: "port", label: `Port (current: ${current.port ?? 3978})` },
            { value: "toggle", label: `${current.enabled ? "Disable" : "Enable"} provider` },
            { value: "auth", label: "Test SAS token generation" },
            { value: "done", label: "Done" },
          ],
        });

        if (choice === "done") break;

        switch (choice) {
          case "namespace": {
            const val = await terminal.text({
              message: "Azure Relay namespace:",
              defaultValue: (current.relayNamespace as string) ?? "",
              validate: (v) => {
                const trimmed = v.trim();
                if (!trimmed) return "Required";
                if (!isValidNamespace(trimmed)) return "Must be <name>.servicebus.windows.net";
                return undefined;
              },
            });
            await settings.set("relayNamespace", val.trim());
            terminal.log.success(`Namespace set to ${val.trim()}`);
            break;
          }
          case "connection": {
            const val = await terminal.text({
              message: "Hybrid Connection name:",
              defaultValue: (current.hybridConnectionName as string) ?? "",
              validate: (v) => {
                const trimmed = v.trim();
                if (!trimmed) return "Required";
                if (!isValidConnectionName(trimmed)) return "Invalid format";
                return undefined;
              },
            });
            await settings.set("hybridConnectionName", val.trim());
            terminal.log.success(`Connection set to ${val.trim()}`);
            break;
          }
          case "sasKeyName": {
            const val = await terminal.text({
              message: "SAS policy name:",
              defaultValue: (current.sasKeyName as string) ?? "ListenOnly",
              validate: (v) => {
                if (!v.trim()) return "Required";
                return undefined;
              },
            });
            await settings.set("sasKeyName", val.trim());
            terminal.log.success(`SAS policy name set to ${val.trim()}`);
            break;
          }
          case "sasKeyValue": {
            const val = await terminal.text({
              message: "SAS key value:",
              validate: (v) => {
                if (!v.trim()) return "Required";
                return undefined;
              },
            });
            await settings.set("sasKeyValue", val.trim());
            terminal.log.success("SAS key value updated");
            break;
          }
          case "port": {
            const val = await terminal.text({
              message: "Port:",
              defaultValue: current.port != null ? String(current.port) : "3978",
              validate: (v) => {
                const trimmed = v.trim();
                if (!trimmed) return "Required";
                const n = Number(trimmed);
                if (isNaN(n) || !Number.isInteger(n) || n < 1 || n > 65535) return "Port must be 1-65535";
                return undefined;
              },
            });
            await settings.set("port", Number(val.trim()));
            terminal.log.success(`Port set to ${val.trim()}`);
            break;
          }
          case "toggle": {
            const newState = !current.enabled;
            await settings.set("enabled", newState);
            terminal.log.success(`Azure Relay provider ${newState ? "enabled" : "disabled"}`);
            break;
          }
          case "auth": {
            const spin = terminal.spinner();
            spin.start("Testing SAS token generation...");
            const result = testSasToken(
              current.relayNamespace as string,
              current.hybridConnectionName as string,
              current.sasKeyName as string,
              current.sasKeyValue as string,
            );
            if (result.ok) {
              spin.stop("SAS token generated successfully");
            } else {
              spin.fail(result.error);
            }
            break;
          }
        }
      }
    },

    // ─── Uninstall ───────────────────────────────────────────────────────

    async uninstall(ctx: InstallContext, opts: { purge: boolean }) {
      if (opts.purge) {
        await ctx.settings.clear();
        ctx.terminal.log.success("Azure Relay provider settings cleared");
      }
      ctx.terminal.note(
        "The Azure Relay namespace and Hybrid Connection remain in your Azure subscription.\n" +
        "To clean up:\n" +
        "  1. az relay hyco delete --resource-group <rg> --namespace-name <ns> --name <connection>\n" +
        "  2. az relay namespace delete --resource-group <rg> --name <ns>  (if no longer needed)",
        "Cleanup Reminder",
      );
    },

    // ─── Migrate (future-proofing) ───────────────────────────────────────

    async migrate(ctx, oldSettings: unknown, oldVersion: string) {
      ctx.log.info(`Migrating from v${oldVersion}`);
      const parsed = AzureRelayConfigSchema.safeParse(oldSettings);
      if (!parsed.success) {
        ctx.log.warn(`Migrated config is invalid — user should re-run: openacp plugin configure @hahnfeld/msrelay-connector`);
      }
      return oldSettings;
    },

    // ─── Runtime Setup ───────────────────────────────────────────────────

    async setup(ctx) {
      ctx.registerEditableFields([
        { key: "enabled", displayName: "Enabled", type: "toggle", scope: "safe", hotReload: false },
        { key: "relayNamespace", displayName: "Relay Namespace", type: "string", scope: "safe", hotReload: false },
        { key: "hybridConnectionName", displayName: "Hybrid Connection", type: "string", scope: "safe", hotReload: false },
        { key: "sasKeyName", displayName: "SAS Policy Name", type: "string", scope: "safe", hotReload: false },
        { key: "sasKeyValue", displayName: "SAS Key Value", type: "string", scope: "sensitive", hotReload: false },
        { key: "port", displayName: "Port", type: "number", scope: "safe", hotReload: false },
      ]);

      const raw = ctx.pluginConfig as unknown;
      const parsed = AzureRelayConfigSchema.safeParse(raw);
      if (!parsed.success) {
        ctx.log.warn(`Azure Relay config invalid: ${parsed.error.message}. Run: openacp plugin configure @hahnfeld/msrelay-connector`);
        return;
      }

      const config = parsed.data as AzureRelayConfig;
      if (!config.enabled) {
        ctx.log.info("Azure Relay provider disabled");
        return;
      }

      if (provider) {
        ctx.log.warn("Azure Relay provider setup() called again — skipping (already running)");
        return;
      }

      provider = new AzureRelayProvider(config);

      provider.onExit(() => {
        ctx.log.warn("Azure Relay WebSocket disconnected unexpectedly — TunnelRegistry will retry");
        ctx.emit("msrelay-connector:disconnected", {});
        provider = null;
      });

      ctx.registerService("tunnel-provider:azure-relay", provider);

      ctx.on("api-server:started", async (data: unknown) => {
        const port = config.port ?? (data as { port: number }).port;
        try {
          const publicUrl = await provider!.start(port);
          ctx.log.info(`Azure Relay ready: ${publicUrl}`);
          ctx.emit("msrelay-connector:started", { publicUrl, port });
        } catch (err) {
          ctx.log.error(`Azure Relay failed to start: ${(err as Error).message}`);
        }
      });

      ctx.log.info("Azure Relay provider registered — waiting for API server");

      // Register /relay command for status checks
      ctx.registerCommand({
        name: "relay",
        description: "Show Azure Relay status",
        category: "plugin",
        async handler(args) {
          const raw = args.raw.trim();

          if (raw === "auth") {
            const cfg = config;
            const result = testSasToken(cfg.relayNamespace, cfg.hybridConnectionName, cfg.sasKeyName, cfg.sasKeyValue);
            if (result.ok) {
              return { type: "text", text: "SAS token generation: OK" };
            }
            return { type: "error", message: result.error };
          }

          // Default: status
          if (!provider) {
            return { type: "text", text: "Azure Relay: Not active" };
          }

          const url = provider.getPublicUrl();
          if (!url) {
            return { type: "text", text: "Azure Relay: Not connected" };
          }

          const metrics = provider.getMetrics();
          const lastErrorLine = metrics.lastError
            ? `  Last error: ${metrics.lastError} (${formatAgo(metrics.lastErrorAt)})\n`
            : "";
          const reconnectLine = metrics.reconnectAttempts > 0
            ? `  Reconnects: ${metrics.reconnectsSucceeded}/${metrics.reconnectAttempts} succeeded\n`
            : "";

          return {
            type: "text",
            text:
              `Azure Relay: Connected\n` +
              `  URL:       ${url}\n` +
              `  Uptime:    ${formatUptime(metrics.startedAt)}\n` +
              `  Requests:  ${metrics.requestCount}\n` +
              `  Errors:    ${metrics.errorCount}\n` +
              reconnectLine +
              lastErrorLine,
          };
        },
      });
    },

    async teardown() {
      if (provider) {
        await provider.stop();
        provider = null;
      }
    },
  };
}
