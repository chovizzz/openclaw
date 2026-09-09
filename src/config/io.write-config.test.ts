import fs from "node:fs/promises";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import type { PluginManifestRegistry } from "../plugins/manifest-registry.js";
import { createSuiteTempRootTracker } from "../test-helpers/temp-dir.js";
import { createConfigIO } from "./io.js";

// Mock the plugin manifest registry so we can register a fake channel whose
// AJV JSON Schema carries a `default` value.  This lets the #56772 regression
// test exercise the exact code path that caused the bug: AJV injecting
// defaults during the write-back validation pass.
const mockLoadPluginManifestRegistry = vi.hoisted(() =>
  vi.fn(
    (): PluginManifestRegistry => ({
      diagnostics: [],
      plugins: [],
    }),
  ),
);
const mockMaintainConfigBackups = vi.hoisted(() =>
  vi.fn<typeof import("./backup-rotation.js").maintainConfigBackups>(async () => {}),
);

vi.mock("../plugins/manifest-registry.js", () => ({
  loadPluginManifestRegistry: mockLoadPluginManifestRegistry,
}));

vi.mock("./backup-rotation.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./backup-rotation.js")>();
  return {
    ...actual,
    maintainConfigBackups: mockMaintainConfigBackups,
  };
});

describe("config io write", () => {
  const suiteRootTracker = createSuiteTempRootTracker({ prefix: "openclaw-config-io-" });
  const silentLogger = {
    warn: () => {},
    error: () => {},
  };

  async function withSuiteHome<T>(fn: (home: string) => Promise<T>): Promise<T> {
    const home = await suiteRootTracker.make("case");
    return fn(home);
  }

  beforeAll(async () => {
    await suiteRootTracker.setup();

    // Default: return an empty plugin list so existing tests that don't need
    // plugin-owned channel schemas keep working unchanged.
    mockLoadPluginManifestRegistry.mockReturnValue({
      diagnostics: [],
      plugins: [],
    } satisfies PluginManifestRegistry);
  });

  afterAll(async () => {
    await suiteRootTracker.cleanup();
  });

  describe("clobber guard", () => {
    // Reproduces the shape of a production incident: a 51KB / 17-key config
    // became a 408 byte file with only `browser` and `meta`, after which the
    // gateway refused to start for want of gateway.mode. That write bypassed
    // this code entirely (an operator script wrote the file directly), but the
    // same shape can arrive from any caller passing an object it did not derive
    // from disk, and the write path already computed size-drop and
    // gateway-mode-removed and only warned.
    const buildLiveConfig = () => ({
      gateway: { mode: "local" as const },
      // Bulk that a clobbering write would discard. Uses browser profiles
      // because that is both schema-valid at any size and what the real
      // incident was carrying: 100 profiles went down to 3.
      commands: { ownerDisplay: "hash" as const },
      browser: {
        enabled: true,
        profiles: Object.fromEntries(
          Array.from({ length: 100 }, (_, i) => [
            `profile-${i}`,
            { cdpPort: 18800 + i, color: "#2f5d8c" },
          ]),
        ),
      },
    });

    it("refuses a write that drops most of the file and removes gateway.mode", async () => {
      await withSuiteHome(async (home) => {
        const io = createConfigIO({
          env: {} as NodeJS.ProcessEnv,
          homedir: () => home,
          logger: silentLogger,
        });
        const configPath = path.join(home, ".openclaw", "openclaw.json");

        await io.writeConfigFile(buildLiveConfig());
        const before = await fs.readFile(configPath, "utf-8");

        await expect(
          io.writeConfigFile({
            browser: {
              enabled: true,
              profiles: { "hubstudio-1": { cdpPort: 53851, color: "#a8620d" } },
            },
          } as never),
        ).rejects.toMatchObject({ code: "CONFIG_WRITE_CLOBBER" });

        // The bytes on disk must be untouched, not merely restored afterwards.
        expect(await fs.readFile(configPath, "utf-8")).toBe(before);
      });
    });

    it("still allows an ordinary edit that keeps the config intact", async () => {
      await withSuiteHome(async (home) => {
        const io = createConfigIO({
          env: {} as NodeJS.ProcessEnv,
          homedir: () => home,
          logger: silentLogger,
        });
        const configPath = path.join(home, ".openclaw", "openclaw.json");

        const live = buildLiveConfig();
        await io.writeConfigFile(live);
        await io.writeConfigFile({
          ...live,
          browser: {
            enabled: true,
            profiles: {
              ...live.browser.profiles,
              "hubstudio-1": { cdpPort: 53851, color: "#a8620d" },
            },
          },
        });

        const persisted = JSON.parse(await fs.readFile(configPath, "utf-8")) as Record<
          string,
          unknown
        >;
        expect((persisted.gateway as { mode?: string }).mode).toBe("local");
        expect(Object.keys((persisted.browser as { profiles: object }).profiles)).toHaveLength(101);
      });
    });

    it("lets an intentional shrink through when explicitly allowed", async () => {
      await withSuiteHome(async (home) => {
        const io = createConfigIO({
          env: { OPENCLAW_ALLOW_CONFIG_SHRINK: "1" } as NodeJS.ProcessEnv,
          homedir: () => home,
          logger: silentLogger,
        });
        const configPath = path.join(home, ".openclaw", "openclaw.json");

        await io.writeConfigFile(buildLiveConfig());
        await io.writeConfigFile({ gateway: { mode: "local" } });

        const persisted = JSON.parse(await fs.readFile(configPath, "utf-8")) as Record<
          string,
          unknown
        >;
        expect(persisted.commands).toBeUndefined();
      });
    });
  });

  const expectInputOwnerDisplayUnchanged = (input: Record<string, unknown>) => {
    expect((input.commands as Record<string, unknown>).ownerDisplay).toBe("hash");
  };

  const readPersistedCommands = async (configPath: string) => {
    const persisted = JSON.parse(await fs.readFile(configPath, "utf-8")) as {
      commands?: Record<string, unknown>;
    };
    return persisted.commands;
  };

  it.runIf(process.platform !== "win32")(
    "tightens world-writable state dir when writing the default config",
    async () => {
      await withSuiteHome(async (home) => {
        const stateDir = path.join(home, ".openclaw");
        await fs.mkdir(stateDir, { recursive: true, mode: 0o777 });
        await fs.chmod(stateDir, 0o777);

        const io = createConfigIO({
          env: {} as NodeJS.ProcessEnv,
          homedir: () => home,
          logger: silentLogger,
        });

        await io.writeConfigFile({ gateway: { mode: "local" } });

        const stat = await fs.stat(stateDir);
        expect(stat.mode & 0o777).toBe(0o700);
      });
    },
  );

  it("keeps writes inside an OPENCLAW_STATE_DIR override even when the real home config exists", async () => {
    await withSuiteHome(async (home) => {
      const liveConfigPath = path.join(home, ".openclaw", "openclaw.json");
      await fs.mkdir(path.dirname(liveConfigPath), { recursive: true });
      await fs.writeFile(
        liveConfigPath,
        `${JSON.stringify({ gateway: { mode: "local", port: 18789 } }, null, 2)}\n`,
        "utf-8",
      );

      const overrideDir = path.join(home, "isolated-state");
      const env = { OPENCLAW_STATE_DIR: overrideDir } as NodeJS.ProcessEnv;
      const io = createConfigIO({
        env,
        homedir: () => home,
        logger: silentLogger,
      });

      expect(io.configPath).toBe(path.join(overrideDir, "openclaw.json"));

      await io.writeConfigFile({
        agents: { list: [{ id: "main", default: true }] },
        gateway: { mode: "local" },
        session: { mainKey: "main", store: path.join(overrideDir, "sessions.json") },
      });

      const livePersisted = JSON.parse(await fs.readFile(liveConfigPath, "utf-8")) as {
        gateway?: { mode?: unknown; port?: unknown };
      };
      expect(livePersisted.gateway).toEqual({ mode: "local", port: 18789 });

      const overridePersisted = JSON.parse(
        await fs.readFile(path.join(overrideDir, "openclaw.json"), "utf-8"),
      ) as {
        session?: { store?: unknown };
      };
      expect(overridePersisted.session?.store).toBe(path.join(overrideDir, "sessions.json"));
    });
  });

  it("does not mutate caller config when unsetPaths is applied on first write", async () => {
    await withSuiteHome(async (home) => {
      const configPath = path.join(home, ".openclaw", "openclaw.json");
      const io = createConfigIO({
        env: {} as NodeJS.ProcessEnv,
        homedir: () => home,
        logger: silentLogger,
      });

      const input: Record<string, unknown> = {
        gateway: { mode: "local" },
        commands: { ownerDisplay: "hash" },
      };

      await io.writeConfigFile(input, { unsetPaths: [["commands", "ownerDisplay"]] });

      expect(input).toEqual({
        gateway: { mode: "local" },
        commands: { ownerDisplay: "hash" },
      });
      expectInputOwnerDisplayUnchanged(input);
      expect((await readPersistedCommands(configPath)) ?? {}).not.toHaveProperty("ownerDisplay");
    });
  });

  it("does not log an overwrite audit entry when creating config for the first time", async () => {
    await withSuiteHome(async (home) => {
      const warn = vi.fn();
      const io = createConfigIO({
        env: {} as NodeJS.ProcessEnv,
        homedir: () => home,
        logger: {
          warn,
          error: vi.fn(),
        },
      });

      await io.writeConfigFile({
        gateway: { mode: "local" },
      });

      const overwriteLogs = warn.mock.calls.filter(
        (call) => typeof call[0] === "string" && call[0].startsWith("Config overwrite:"),
      );
      expect(overwriteLogs).toHaveLength(0);
    });
  });
});
