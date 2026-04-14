import { describe, it, expect, vi, beforeEach } from "vitest";
import type { AzureRelayConfig } from "../types.js";

// ─── Mock hyco-https (same as provider tests) ───────────────────────────────

// Mock createRequire so provider.ts gets our fake hyco-https
vi.mock("node:module", () => ({
  createRequire: () => (id: string) => {
    if (id === "hyco-https") {
      const { EventEmitter } = require("node:events");
      return {
        createRelayListenUri: (namespace: string, path: string) =>
          `sb://${namespace}/${path}`,
        createRelayToken: () => "SharedAccessSignature mock",
        createRelayedServer: (_options: unknown, _listener: unknown) => {
          const server = new EventEmitter();
          server.listen = () => process.nextTick(() => server.emit("listening"));
          server.close = (cb?: () => void) => { if (cb) process.nextTick(cb); };
          return server;
        },
      };
    }
    throw new Error(`Unexpected require: ${id}`);
  },
}));

vi.mock("node:http", async () => {
  const actual = await vi.importActual<typeof import("node:http")>("node:http");
  const { EventEmitter } = require("node:events");
  return {
    ...actual,
    request: vi.fn(() => {
      const req = new EventEmitter();
      req.destroy = vi.fn();
      req.end = vi.fn();
      req.write = vi.fn();
      return req;
    }),
  };
});

// ─── Test Config ─────────────────────────────────────────────────────────────

const VALID_CONFIG: AzureRelayConfig = {
  enabled: true,
  port: 3978,
  relayNamespace: "myrelay.servicebus.windows.net",
  hybridConnectionName: "bot-endpoint",
  sasKeyName: "ListenOnly",
  sasKeyValue: "dGVzdGtleQ==",
};

// ─── Mock Plugin Context ─────────────────────────────────────────────────────

function createMockSetupContext(config: Partial<AzureRelayConfig> = VALID_CONFIG) {
  const events = new Map<string, ((...args: unknown[]) => void)[]>();
  return {
    pluginConfig: config,
    log: {
      info: vi.fn(),
      warn: vi.fn(),
      error: vi.fn(),
    },
    registerEditableFields: vi.fn(),
    registerService: vi.fn(),
    registerCommand: vi.fn(),
    on: vi.fn((event: string, handler: (...args: unknown[]) => void) => {
      if (!events.has(event)) events.set(event, []);
      events.get(event)!.push(handler);
    }),
    emit: vi.fn(),
    _events: events,
    _fireEvent(name: string, data: unknown) {
      for (const handler of events.get(name) ?? []) {
        handler(data);
      }
    },
  };
}

function createMockInstallContext(opts: {
  textResponses?: string[];
  passwordResponse?: string;
  selectResponse?: string;
  confirmResponse?: boolean;
  existingConfig?: Partial<AzureRelayConfig>;
} = {}) {
  const {
    textResponses = [
      "my-resource-group",                           // resource group
      "myrelay",                                     // namespace
      "myrelay-hybrid",                              // hybrid connection (default from namespace)
      "myrelay-hybrid-policy",                       // SAS policy name (default from namespace)
    ],
    passwordResponse = "dGVzdGtleQ==",
    selectResponse = "3978",
    confirmResponse = false,
    existingConfig = {},
  } = opts;

  let textIndex = 0;
  const storedSettings: Record<string, unknown> = {};

  return {
    terminal: {
      note: vi.fn(),
      text: vi.fn(async () => {
        if (textIndex < textResponses.length) {
          return textResponses[textIndex++];
        }
        return "test-value";
      }),
      password: vi.fn(async () => passwordResponse),
      select: vi.fn(async () => selectResponse),
      confirm: vi.fn(async () => confirmResponse),
      spinner: vi.fn(() => ({
        start: vi.fn(),
        stop: vi.fn(),
        fail: vi.fn(),
      })),
      log: {
        info: vi.fn(),
        warn: vi.fn(),
        warning: vi.fn(),
        error: vi.fn(),
        success: vi.fn(),
        step: vi.fn(),
      },
      cancel: vi.fn(),
    },
    settings: {
      setAll: vi.fn(async (vals: Record<string, unknown>) => {
        Object.assign(storedSettings, vals);
      }),
      set: vi.fn(async (key: string, value: unknown) => {
        storedSettings[key] = value;
      }),
      getAll: vi.fn(async () => ({ ...existingConfig, ...storedSettings })),
      clear: vi.fn(),
    },
    _storedSettings: storedSettings,
  };
}

// ─── Tests ───────────────────────────────────────────────────────────────────

describe("createRelayPlugin", () => {
  let createRelayPlugin: typeof import("../plugin.js").createRelayPlugin;

  beforeEach(async () => {
    vi.clearAllMocks();
    const mod = await import("../plugin.js");
    createRelayPlugin = mod.createRelayPlugin;
  });

  describe("metadata", () => {
    it("has correct name and version", () => {
      const plugin = createRelayPlugin();
      expect(plugin.name).toBe("@hahnfeld/msrelay-provider");
      expect(plugin.version).toBe("0.1.5");
    });

    it("declares required permissions", () => {
      const plugin = createRelayPlugin();
      expect(plugin.permissions).toContain("services:register");
      expect(plugin.permissions).toContain("events:read");
      expect(plugin.permissions).toContain("commands:register");
    });
  });

  describe("setup", () => {
    it("registers editable fields", async () => {
      const plugin = createRelayPlugin();
      const ctx = createMockSetupContext();
      await plugin.setup!(ctx as never);

      expect(ctx.registerEditableFields).toHaveBeenCalledWith(
        expect.arrayContaining([
          expect.objectContaining({ key: "enabled" }),
          expect.objectContaining({ key: "relayNamespace" }),
          expect.objectContaining({ key: "port" }),
        ]),
      );
    });

    it("registers tunnel-provider:azure-relay service", async () => {
      const plugin = createRelayPlugin();
      const ctx = createMockSetupContext();
      await plugin.setup!(ctx as never);

      expect(ctx.registerService).toHaveBeenCalledWith(
        "tunnel-provider:azure-relay",
        expect.anything(),
      );
    });

    it("listens for api-server:started event", async () => {
      const plugin = createRelayPlugin();
      const ctx = createMockSetupContext();
      await plugin.setup!(ctx as never);

      expect(ctx.on).toHaveBeenCalledWith("api-server:started", expect.any(Function));
    });

    it("registers /relay command", async () => {
      const plugin = createRelayPlugin();
      const ctx = createMockSetupContext();
      await plugin.setup!(ctx as never);

      expect(ctx.registerCommand).toHaveBeenCalledWith(
        expect.objectContaining({
          name: "relay",
          category: "plugin",
        }),
      );
    });

    it("skips when disabled", async () => {
      const plugin = createRelayPlugin();
      const ctx = createMockSetupContext({ ...VALID_CONFIG, enabled: false });
      await plugin.setup!(ctx as never);

      expect(ctx.log.info).toHaveBeenCalledWith("Azure Relay provider disabled");
      expect(ctx.registerService).not.toHaveBeenCalled();
    });

    it("warns on invalid config", async () => {
      const plugin = createRelayPlugin();
      const ctx = createMockSetupContext({ enabled: true, relayNamespace: "" });
      await plugin.setup!(ctx as never);

      expect(ctx.log.warn).toHaveBeenCalledWith(
        expect.stringContaining("config invalid"),
      );
      expect(ctx.registerService).not.toHaveBeenCalled();
    });

    it("starts provider on api-server:started", async () => {
      const plugin = createRelayPlugin();
      const ctx = createMockSetupContext();
      await plugin.setup!(ctx as never);

      // Fire the api-server:started event
      await ctx._fireEvent("api-server:started", { port: 3978 });

      // Give the async start time to resolve
      await new Promise((r) => setTimeout(r, 50));

      const infoCalls = ctx.log.info.mock.calls.map((c: unknown[]) => c[0]);
      expect(infoCalls).toContainEqual(
        expect.stringContaining("Azure Relay ready"),
      );
      expect(ctx.emit).toHaveBeenCalledWith(
        "msrelay-provider:started",
        expect.objectContaining({ publicUrl: expect.stringContaining("myrelay") }),
      );
    });
  });

  describe("teardown", () => {
    it("stops provider on teardown", async () => {
      const plugin = createRelayPlugin();
      const ctx = createMockSetupContext();
      await plugin.setup!(ctx as never);

      // Start the provider
      await ctx._fireEvent("api-server:started", { port: 3978 });
      await new Promise((r) => setTimeout(r, 50));

      await plugin.teardown!();
      // No error thrown = success
    });

    it("teardown is safe when provider not started", async () => {
      const plugin = createRelayPlugin();
      await plugin.teardown!();
      // No error thrown
    });
  });

  describe("uninstall", () => {
    it("clears settings on purge", async () => {
      const plugin = createRelayPlugin();
      const ctx = createMockInstallContext();
      await plugin.uninstall!(ctx as never, { purge: true });

      expect(ctx.settings.clear).toHaveBeenCalled();
    });

    it("does not clear settings without purge", async () => {
      const plugin = createRelayPlugin();
      const ctx = createMockInstallContext();
      await plugin.uninstall!(ctx as never, { purge: false });

      expect(ctx.settings.clear).not.toHaveBeenCalled();
    });
  });

  describe("install", () => {
    it("saves config from wizard inputs", async () => {
      const plugin = createRelayPlugin();
      const ctx = createMockInstallContext();
      await plugin.install!(ctx as never);

      expect(ctx.settings.setAll).toHaveBeenCalledWith(
        expect.objectContaining({
          enabled: true,
          port: 3978,
          resourceGroup: "my-resource-group",
          relayNamespace: "myrelay.servicebus.windows.net",
          hybridConnectionName: "myrelay-hybrid",
          sasKeyName: "myrelay-hybrid-policy",
          sasKeyValue: "dGVzdGtleQ==",
        }),
      );
    });

    it("loads existing config for pre-filling on reinstall", async () => {
      const plugin = createRelayPlugin();
      const ctx = createMockInstallContext({
        existingConfig: VALID_CONFIG,
      });
      await plugin.install!(ctx as never);

      // settings.getAll should be called to load existing config
      expect(ctx.settings.getAll).toHaveBeenCalled();
    });

    it("shows exact az CLI commands as plain text (not in note boxes)", async () => {
      const plugin = createRelayPlugin();
      const ctx = createMockInstallContext();
      await plugin.install!(ctx as never);

      const infoCalls = ctx.terminal.log.info.mock.calls.map((c: unknown[]) => c[0] as string);
      const allInfo = infoCalls.join("\n");
      // Commands output as log.info (copyable), not terminal.note (boxed)
      expect(allInfo).toContain("az relay namespace create");
      expect(allInfo).toContain("--resource-group my-resource-group");
      expect(allInfo).toContain("--name myrelay");
      expect(allInfo).toContain("--name myrelay-hybrid");
      expect(allInfo).toContain("--name myrelay-hybrid-policy");
      expect(allInfo).toContain("authorization-rule keys list");
      // No angle-bracket placeholders
      expect(allInfo).not.toContain("<resource-group>");
      expect(allInfo).not.toContain("<choose-a-name>");
    });

    it("runs SAS token test when confirmed", async () => {
      const plugin = createRelayPlugin();
      const ctx = createMockInstallContext({ confirmResponse: true });
      await plugin.install!(ctx as never);

      const spinner = ctx.terminal.spinner.mock.results[0]?.value;
      expect(spinner.start).toHaveBeenCalledWith("Connecting to Azure Relay...");
    });
  });

  describe("migrate", () => {
    it("returns settings unchanged", async () => {
      const plugin = createRelayPlugin();
      const mockCtx = { log: { info: vi.fn() } };
      const result = await plugin.migrate!(mockCtx as never, VALID_CONFIG, "0.0.1");
      expect(result).toEqual(VALID_CONFIG);
    });
  });
});
