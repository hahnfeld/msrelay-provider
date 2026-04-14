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

/** Test connectivity by opening a real WebSocket to Azure Relay. */
function testRelayConnection(
  namespace: string, connectionName: string, keyName: string, keyValue: string, timeoutMs = 10_000,
): Promise<{ ok: true } | { ok: false; error: string }> {
  return new Promise((resolve) => {
    try {
      const hycoHttps = require("hyco-https");
      const uri = hycoHttps.createRelayListenUri(namespace, connectionName);
      const server = hycoHttps.createRelayedServer(
        { server: uri, token: () => hycoHttps.createRelayToken(uri, keyName, keyValue) },
        () => { /* no-op request handler for test */ },
      );

      let settled = false;
      const settle = (result: { ok: true } | { ok: false; error: string }) => {
        if (!settled) {
          settled = true;
          try { server.close(); } catch { /* ignore */ }
          resolve(result);
        }
      };

      const timer = setTimeout(() => {
        settle({ ok: false, error: "Connection timed out — check namespace, connection name, and network access" });
      }, timeoutMs);

      server.on("listening", () => {
        clearTimeout(timer);
        settle({ ok: true });
      });

      server.on("error", (err: Error) => {
        clearTimeout(timer);
        settle({ ok: false, error: `Connection failed: ${err.message}` });
      });

      server.listen();
    } catch (err) {
      resolve({ ok: false, error: `Setup failed: ${(err as Error).message}` });
    }
  });
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
    name: "@hahnfeld/msrelay-provider",
    version: "0.1.6",
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

      // Load existing config for pre-filling on reinstall
      const existing = await settings.getAll() as Partial<AzureRelayConfig>;

      terminal.note(
        "Azure Relay Hybrid Connections exposes a local port via a stable\n" +
        "HTTPS endpoint on Azure's private backbone — no public internet\n" +
        "exposure, no inbound ports required.\n" +
        "\n" +
        "This wizard collects a few names, then gives you the exact Azure\n" +
        "CLI commands to run. You'll need the az CLI installed.",
        "Azure Relay Setup",
      );

      // ── Step 1: Collect names ──

      const resourceGroup = await terminal.text({
        message: "Azure resource group:",
        defaultValue: existing.resourceGroup ?? undefined,
        validate: (v) => {
          if (!v.trim()) return "Resource group is required";
          return undefined;
        },
      });
      const rg = resourceGroup.trim();

      const namespaceInput = await terminal.text({
        message: "Relay namespace name (becomes <name>.servicebus.windows.net):",
        defaultValue: existing.relayNamespace?.replace(".servicebus.windows.net", "") ?? undefined,
        validate: (v) => {
          if (!v.trim()) return "Namespace is required";
          return undefined;
        },
      });
      const nsName = namespaceInput.trim().replace(".servicebus.windows.net", "");
      const ns = `${nsName}.servicebus.windows.net`;
      if (!isValidNamespace(ns)) {
        terminal.log.warning(`"${ns}" doesn't look like a valid namespace — continuing anyway`);
      }

      const connectionName = await terminal.text({
        message: "Hybrid Connection name:",
        defaultValue: existing.hybridConnectionName ?? `${nsName}-hybrid`,
        validate: (v) => {
          const trimmed = v.trim();
          if (!trimmed) return "Connection name is required";
          if (!isValidConnectionName(trimmed)) return "Must be alphanumeric with dots/hyphens/underscores";
          return undefined;
        },
      });
      const hc = connectionName.trim();

      const keyName = await terminal.text({
        message: "SAS policy name (listen-only auth rule):",
        defaultValue: existing.sasKeyName ?? `${nsName}-hybrid-policy`,
        validate: (v) => {
          if (!v.trim()) return "Policy name is required";
          return undefined;
        },
      });
      const sasName = keyName.trim();

      // ── Step 2: Show the public URL and exact az commands ──

      terminal.log.step("Your public endpoint will be:");
      terminal.log.info(`https://${ns}/${hc}/api/messages`);
      terminal.log.info("");

      terminal.log.step("Run these commands to create the Azure resources:");
      terminal.log.info("");
      terminal.log.info(`az relay namespace create --resource-group ${rg} --name ${nsName} --location westus2`);
      terminal.log.info("");
      terminal.log.info(`az relay hyco create --resource-group ${rg} --namespace-name ${nsName} --name ${hc} --requires-client-authorization false`);
      terminal.log.info("");
      terminal.log.info(`az relay hyco authorization-rule create --resource-group ${rg} --namespace-name ${nsName} --hybrid-connection-name ${hc} --name ${sasName} --rights Listen`);
      terminal.log.info("");
      terminal.log.warning("--requires-client-authorization cannot be changed after creation.");
      terminal.log.warning("If you need to change it, delete and recreate the connection.");
      terminal.log.info("");

      // ── Step 3: SAS Key ──

      terminal.log.step("Retrieve the SAS key:");
      terminal.log.info("");
      terminal.log.info(`az relay hyco authorization-rule keys list --resource-group ${rg} --namespace-name ${nsName} --hybrid-connection-name ${hc} --name ${sasName} --query primaryKey -o tsv`);
      terminal.log.info("");

      const hasExistingKey = !!(existing.sasKeyValue);
      let keyValue = await terminal.password({
        message: hasExistingKey
          ? "SAS key value — press Enter to keep current:"
          : "SAS key value (paste the primaryKey):",
        validate: (v) => {
          if (!(v ?? "").trim() && !hasExistingKey) return "Key value is required";
          return undefined;
        },
      });
      if (!(keyValue ?? "").trim() && hasExistingKey) {
        keyValue = existing.sasKeyValue!;
      }

      // ── Step 4: Port ──

      const existingPort = existing.port;
      const envPort = process.env.PORT ? Number(process.env.PORT) : null;
      const portChoice = await terminal.select({
        message: "Which local port should the tunnel forward to?",
        options: [
          ...(existingPort && existingPort !== 3978 && existingPort !== 21420
            ? [{ value: String(existingPort), label: `${existingPort} (current config)`, hint: "Previously configured" }]
            : []),
          ...(envPort && envPort !== existingPort
            ? [{ value: String(envPort), label: `${envPort} (from PORT env var)`, hint: "Current environment" }]
            : []),
          { value: "3978", label: "3978", hint: "Teams adapter (Bot Framework default)" },
          { value: "21420", label: "21420", hint: "OpenACP API server" },
          { value: "custom", label: "Other port" },
        ],
      });

      let port: number;
      if (portChoice === "custom") {
        const portStr = await terminal.text({
          message: "Local port to expose:",
          defaultValue: existingPort ? String(existingPort) : undefined,
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

      // ── Step 5: Connectivity Test ──

      const wantTest = await terminal.confirm({
        message: "Test connectivity now? (connects to Azure Relay for up to 10s)",
        initialValue: true,
      });

      if (wantTest) {
        const spin = terminal.spinner();
        spin.start("Connecting to Azure Relay...");
        const result = await testRelayConnection(ns, hc, sasName, keyValue.trim());
        if (result.ok) {
          spin.stop("Connected to Azure Relay successfully");
        } else {
          spin.fail(result.error);
          terminal.log.warning("Installation will continue — you can test connectivity later with /relay auth");
        }
      }

      // ── Step 6: Save ──

      await settings.setAll({
        enabled: true,
        port,
        resourceGroup: rg,
        relayNamespace: ns,
        hybridConnectionName: hc,
        sasKeyName: sasName,
        sasKeyValue: keyValue.trim(),
      });

      terminal.log.success("Azure Relay provider configured!");
      terminal.log.info("");
      terminal.note(
        `Namespace:  ${ns}\n` +
        `Connection: ${hc}\n` +
        `SAS policy: ${sasName}\n` +
        `Port:       ${port}\n` +
        "\n" +
        "Set your Bot Framework messaging endpoint to:\n" +
        `  https://${ns}/${hc}/api/messages`,
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
            const val = await terminal.password({
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
            spin.start("Connecting to Azure Relay...");
            const result = await testRelayConnection(
              current.relayNamespace as string,
              current.hybridConnectionName as string,
              current.sasKeyName as string,
              current.sasKeyValue as string,
            );
            if (result.ok) {
              spin.stop("Connected to Azure Relay successfully");
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
        ctx.log.warn(`Migrated config is invalid — user should re-run: openacp plugin configure @hahnfeld/msrelay-provider`);
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
        ctx.log.warn(`Azure Relay config invalid: ${parsed.error.message}. Run: openacp plugin configure @hahnfeld/msrelay-provider`);
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
        ctx.emit("msrelay-provider:disconnected", {});
        provider = null;
      });

      ctx.registerService("tunnel-provider:azure-relay", provider);

      ctx.on("api-server:started", async (data: unknown) => {
        const port = config.port ?? (data as { port: number }).port;
        try {
          const publicUrl = await provider!.start(port);
          ctx.log.info(`Azure Relay ready: ${publicUrl}`);
          ctx.emit("msrelay-provider:started", { publicUrl, port });
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
            const result = await testRelayConnection(cfg.relayNamespace, cfg.hybridConnectionName, cfg.sasKeyName, cfg.sasKeyValue);
            if (result.ok) {
              return { type: "text", text: "Azure Relay connectivity: OK" };
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
