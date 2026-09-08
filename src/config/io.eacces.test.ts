import fsNode from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { ConfigWriteUnreadableBaseError, createConfigIO } from "./io.js";
import type { OpenClawConfig } from "./types.openclaw.js";

function makeEaccesFs(configPath: string) {
  const eaccesErr = Object.assign(new Error(`EACCES: permission denied, open '${configPath}'`), {
    code: "EACCES",
  });
  return {
    existsSync: (p: string) => p === configPath,
    readFileSync: (p: string): string => {
      if (p === configPath) {
        throw eaccesErr;
      }
      throw new Error(`unexpected readFileSync: ${p}`);
    },
    promises: {
      readFile: () => Promise.reject(eaccesErr),
      mkdir: () => Promise.resolve(),
      writeFile: () => Promise.resolve(),
      appendFile: () => Promise.resolve(),
    },
  } as unknown as typeof import("node:fs");
}

describe("config io EACCES handling", () => {
  it("returns a helpful error message when config file is not readable (EACCES)", async () => {
    const configPath = "/data/.openclaw/openclaw.json";
    const errors: string[] = [];
    const io = createConfigIO({
      configPath,
      fs: makeEaccesFs(configPath),
      logger: {
        error: (msg: unknown) => errors.push(String(msg)),
        warn: () => {},
      },
    });

    const snapshot = await io.readConfigFileSnapshot();
    expect(snapshot.valid).toBe(false);
    expect(snapshot.issues).toHaveLength(1);
    expect(snapshot.issues[0].message).toContain("EACCES");
    expect(snapshot.issues[0].message).toContain("chown");
    expect(snapshot.issues[0].message).toContain(configPath);
    // Should also emit to the logger
    expect(errors.some((e) => e.includes("chown"))).toBe(true);
  });

  it("includes configPath in the chown hint for the correct remediation command", async () => {
    const configPath = "/home/myuser/.openclaw/openclaw.json";
    const io = createConfigIO({
      configPath,
      fs: makeEaccesFs(configPath),
      logger: { error: () => {}, warn: () => {} },
    });

    const snapshot = await io.readConfigFileSnapshot();
    expect(snapshot.issues[0].message).toContain(configPath);
    expect(snapshot.issues[0].message).toContain("container");
  });

  it("marks the snapshot with the underlying read error code", async () => {
    const configPath = "/data/.openclaw/openclaw.json";
    const io = createConfigIO({
      configPath,
      fs: makeEaccesFs(configPath),
      logger: { error: () => {}, warn: () => {} },
    });

    const snapshot = await io.readConfigFileSnapshot();
    expect(snapshot.readError).toEqual({ code: "EACCES" });
  });
});

/**
 * Wraps real `node:fs` so every read of `configPath` fails with EACCES while
 * everything else (writes, stats, directory ops used to verify the file
 * afterward) goes through the real filesystem inside a scratch tmp dir. This
 * lets the write-guard tests prove the *actual on-disk bytes* are untouched,
 * not just that a mock's writeFile spy wasn't called.
 */
function makeUnreadableConfigFs(configPath: string): typeof fsNode {
  const eacces = Object.assign(new Error(`EACCES: permission denied, open '${configPath}'`), {
    code: "EACCES",
  });
  const readFileSync = ((target: fsNode.PathOrFileDescriptor, options?: unknown) => {
    if (target === configPath) {
      throw eacces;
    }
    return fsNode.readFileSync(target, options as never);
  }) as typeof fsNode.readFileSync;
  const readFile = ((target: unknown, options?: unknown) => {
    if (target === configPath) {
      return Promise.reject(eacces);
    }
    return fsNode.promises.readFile(target as never, options as never);
  }) as typeof fsNode.promises.readFile;
  return {
    ...fsNode,
    readFileSync,
    promises: { ...fsNode.promises, readFile },
  } as typeof fsNode;
}

describe("config write guard after unreadable config", () => {
  const tempRoots: string[] = [];
  afterEach(() => {
    while (tempRoots.length > 0) {
      const root = tempRoots.pop();
      if (root) {
        fsNode.rmSync(root, { recursive: true, force: true });
      }
    }
  });

  function setupUnreadableConfig(liveConfig: unknown) {
    const home = fsNode.mkdtempSync(path.join(os.tmpdir(), "openclaw-unreadable-"));
    tempRoots.push(home);
    const stateDir = path.join(home, ".openclaw");
    fsNode.mkdirSync(stateDir, { recursive: true, mode: 0o700 });
    const configPath = path.join(stateDir, "openclaw.json");
    const liveBytes = `${JSON.stringify(liveConfig, null, 2)}\n`;
    fsNode.writeFileSync(configPath, liveBytes, { mode: 0o600 });
    const io = createConfigIO({
      configPath,
      fs: makeUnreadableConfigFs(configPath),
      homedir: () => home,
      env: {},
      logger: { error: () => {}, warn: () => {} },
    });
    return { configPath, liveBytes, io };
  }

  it("never writes to disk when the existing config cannot be read (data-loss guard)", async () => {
    const { configPath, liveBytes, io } = setupUnreadableConfig({
      gateway: { mode: "local", port: 18789, auth: { mode: "token" } },
      channels: { telegram: { enabled: true } },
      agents: { list: [{ id: "main" }] },
      meta: { lastTouchedVersion: "2026.5.3-1" },
    });

    const snapshot = await io.readConfigFileSnapshot();
    expect(snapshot.readError).toEqual({ code: "EACCES" });

    // A skeletal config is exactly what a caller building from an empty
    // fallback snapshot (missing gateway.mode etc) would try to persist.
    const skeletal = { channels: { telegram: { enabled: true } } } as OpenClawConfig;
    let thrown: unknown;
    try {
      await io.writeConfigFile(skeletal);
    } catch (err) {
      thrown = err;
    }

    expect(thrown).toBeInstanceOf(ConfigWriteUnreadableBaseError);
    expect((thrown as ConfigWriteUnreadableBaseError).code).toBe("CONFIG_WRITE_UNREADABLE_BASE");
    expect((thrown as ConfigWriteUnreadableBaseError).reason).toBe(
      "unreadable-config-before-write",
    );
    // The live file on disk (read directly via real fs, bypassing the io's
    // wrapped read) must be byte-for-byte unchanged - no partial writes, no
    // temp-file rename, nothing.
    expect(fsNode.readFileSync(configPath, "utf-8")).toBe(liveBytes);
    // No stray *.tmp or *.rejected.* artifacts should have been left behind either.
    const stateDir = path.dirname(configPath);
    const siblings = fsNode.readdirSync(stateDir).filter((name) => name !== "openclaw.json");
    expect(siblings).toHaveLength(0);
  });

  it("still refuses the write for a minimal live config with no gateway.mode to drop", async () => {
    // Regression guard: the block must not depend on comparing before/after
    // byte sizes or gateway.mode presence (those heuristics can both fail to
    // fire against an empty fallback snapshot - see commit message). It must
    // fire purely off snapshot.readError.
    const { io, configPath, liveBytes } = setupUnreadableConfig({
      meta: { lastTouchedVersion: "2026.5.3-1" },
    });

    await expect(io.writeConfigFile({} as OpenClawConfig)).rejects.toThrow(
      ConfigWriteUnreadableBaseError,
    );
    expect(fsNode.readFileSync(configPath, "utf-8")).toBe(liveBytes);
  });

  it("still writes normally when the config is readable (no false-positive block)", async () => {
    const home = fsNode.mkdtempSync(path.join(os.tmpdir(), "openclaw-readable-"));
    tempRoots.push(home);
    const stateDir = path.join(home, ".openclaw");
    fsNode.mkdirSync(stateDir, { recursive: true, mode: 0o700 });
    const configPath = path.join(stateDir, "openclaw.json");
    const liveConfig = { gateway: { mode: "local", port: 18789 } };
    fsNode.writeFileSync(configPath, `${JSON.stringify(liveConfig, null, 2)}\n`, { mode: 0o600 });

    const io = createConfigIO({
      configPath,
      homedir: () => home,
      env: {},
      logger: { error: () => {}, warn: () => {} },
    });

    const snapshot = await io.readConfigFileSnapshot();
    expect(snapshot.readError).toBeUndefined();

    const nextConfig = {
      gateway: { mode: "local", port: 18790 },
    } as OpenClawConfig;
    await expect(io.writeConfigFile(nextConfig)).resolves.toEqual(
      expect.objectContaining({ persistedHash: expect.any(String) }),
    );

    const written = JSON.parse(fsNode.readFileSync(configPath, "utf-8"));
    expect(written.gateway.port).toBe(18790);
  });
});
