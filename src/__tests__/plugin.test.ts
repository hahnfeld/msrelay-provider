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

function createMockInstallContext(responses: Record<string, unknown> = {}) {
  let responseIndex = 0;
  const storedSettings: Record<string, unknown> = {};

  return {
    terminal: {
      note: vi.fn(),
      text: vi.fn(async () => {
        const keys = Object.keys(responses);
        if (responseIndex < keys.length) {
          return responses[keys[responseIndex++]] as string;
        }
        return "test-value";
      }),
      select: vi.fn(async () => "3978"),
      confirm: vi.fn(async () => false),
      spinner: vi.fn(() => ({
        start: vi.fn(),
        stop: vi.fn(),
        fail: vi.fn(),
      })),
      log: {
        info: vi.fn(),
        warn: vi.fn(),
        error: vi.fn(),
        success: vi.fn(),
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
      getAll: vi.fn(async () => ({ ...VALID_CONFIG, ...storedSettings })),
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
      expect(plugin.version).toBe("0.1.1");
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

  describe("migrate", () => {
    it("returns settings unchanged", async () => {
      const plugin = createRelayPlugin();
      const mockCtx = { log: { info: vi.fn() } };
      const result = await plugin.migrate!(mockCtx as never, VALID_CONFIG, "0.0.1");
      expect(result).toEqual(VALID_CONFIG);
    });
  });
});
