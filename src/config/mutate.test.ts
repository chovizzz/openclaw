import fs from "node:fs/promises";
import path from "node:path";
import { describe, expect, it, vi } from "vitest";
import {
  ConfigMutationConflictError,
  mutateConfigFile,
  readSourceConfigSnapshot,
  replaceConfigFile,
} from "./config.js";
import { withTempHome } from "./home-env.test-harness.js";

// Partial mock that defaults to the real writer; individual tests override it to inject
// a specific errno so the config-directory diagnosis can be exercised without chmod games.
const ioMocks = vi.hoisted(() => ({
  writeConfigFile: vi.fn<typeof import("./io.js").writeConfigFile>(),
}));
vi.mock("./io.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./io.js")>();
  ioMocks.writeConfigFile.mockImplementation(actual.writeConfigFile);
  return { ...actual, writeConfigFile: ioMocks.writeConfigFile };
});

describe("config mutate helpers", () => {
  it("mutates source config with optimistic hash protection", async () => {
    await withTempHome("openclaw-config-mutate-source-", async (home) => {
      const configPath = path.join(home, ".openclaw", "openclaw.json");
      await fs.mkdir(path.dirname(configPath), { recursive: true });
      await fs.writeFile(configPath, `${JSON.stringify({ gateway: { port: 18789 } }, null, 2)}\n`);

      const snapshot = await readSourceConfigSnapshot();
      await mutateConfigFile({
        baseHash: snapshot.hash,
        base: "source",
        mutate(draft) {
          draft.gateway = {
            ...draft.gateway,
            auth: { mode: "token" },
          };
        },
      });

      const persisted = JSON.parse(await fs.readFile(configPath, "utf8")) as {
        gateway?: { port?: number; auth?: unknown };
      };
      expect(persisted.gateway).toEqual({
        port: 18789,
        auth: { mode: "token" },
      });
    });
  });

  it("rejects stale replace attempts when the base hash changed", async () => {
    await withTempHome("openclaw-config-replace-conflict-", async (home) => {
      const configPath = path.join(home, ".openclaw", "openclaw.json");
      await fs.mkdir(path.dirname(configPath), { recursive: true });
      await fs.writeFile(configPath, `${JSON.stringify({ gateway: { port: 18789 } }, null, 2)}\n`);

      const snapshot = await readSourceConfigSnapshot();
      await fs.writeFile(configPath, `${JSON.stringify({ gateway: { port: 19001 } }, null, 2)}\n`);

      await expect(
        replaceConfigFile({
          baseHash: snapshot.hash,
          nextConfig: { gateway: { port: 19002 } },
        }),
      ).rejects.toBeInstanceOf(ConfigMutationConflictError);
    });
  });

  it("diagnoses an unwritable config directory instead of leaking a bare errno", async () => {
    await withTempHome("openclaw-config-unwritable-dir-", async (home) => {
      const configDir = path.join(home, ".openclaw");
      const configPath = path.join(configDir, "openclaw.json");
      await fs.mkdir(configDir, { recursive: true });
      await fs.writeFile(configPath, `${JSON.stringify({ gateway: { port: 18789 } }, null, 2)}\n`);

      // A real write into a read-only directory fails on the temp/backup sidecar, not on
      // openclaw.json itself, which is exactly the misdirection this diagnosis fixes.
      await fs.chmod(configDir, 0o500);
      try {
        await expect(
          replaceConfigFile({ nextConfig: { gateway: { port: 19002 } } }),
        ).rejects.toThrow(
          `OpenClaw cannot write to the config directory ${configDir}. Fix its ownership or permissions, then try again.`,
        );
      } finally {
        await fs.chmod(configDir, 0o700);
      }
    });
  });

  it.each(["EACCES", "EPERM", "EROFS"] as const)(
    "diagnoses a %s failure reported inside the config directory",
    async (code) => {
      await withTempHome(`openclaw-config-errno-${code.toLowerCase()}-`, async (home) => {
        const configDir = path.join(home, ".openclaw");
        const configPath = path.join(configDir, "openclaw.json");
        await fs.mkdir(configDir, { recursive: true });
        await fs.writeFile(configPath, "{}\n");

        const failedPath = `${configPath}.tmp`;
        const failure = Object.assign(
          new Error(`${code}: permission denied, open '${failedPath}'`),
          { code, path: failedPath },
        );
        ioMocks.writeConfigFile.mockRejectedValueOnce(failure);

        await expect(replaceConfigFile({ nextConfig: {} })).rejects.toMatchObject({
          message: `OpenClaw cannot write to the config directory ${configDir}. Fix its ownership or permissions, then try again. Underlying error: ${failure.message}`,
          cause: failure,
        });
      });
    },
  );

  it("preserves a permission failure reported outside the config directory", async () => {
    await withTempHome("openclaw-config-unrelated-errno-", async (home) => {
      const configDir = path.join(home, ".openclaw");
      await fs.mkdir(configDir, { recursive: true });
      await fs.writeFile(path.join(configDir, "openclaw.json"), "{}\n");

      const failure = Object.assign(new Error("EACCES: permission denied, open '/elsewhere/x'"), {
        code: "EACCES",
        path: "/elsewhere/x",
      });
      ioMocks.writeConfigFile.mockRejectedValueOnce(failure);

      await expect(replaceConfigFile({ nextConfig: {} })).rejects.toBe(failure);
    });
  });

  it("preserves a non-permission failure unchanged", async () => {
    await withTempHome("openclaw-config-non-permission-errno-", async (home) => {
      const configDir = path.join(home, ".openclaw");
      await fs.mkdir(configDir, { recursive: true });
      const configPath = path.join(configDir, "openclaw.json");
      await fs.writeFile(configPath, "{}\n");

      const failure = Object.assign(new Error("ENOSPC: no space left on device"), {
        code: "ENOSPC",
        path: `${configPath}.tmp`,
      });
      ioMocks.writeConfigFile.mockRejectedValueOnce(failure);

      await expect(replaceConfigFile({ nextConfig: {} })).rejects.toBe(failure);
    });
  });
});
