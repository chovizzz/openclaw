import { EventEmitter } from "node:events";
import { afterEach, describe, expect, it, vi } from "vitest";
import { parseSshTarget, startSshPortForward } from "./ssh-tunnel.js";

const mocks = vi.hoisted(() => ({ spawn: vi.fn() }));

// Partial-real: sibling infra modules loaded by this file still need the real execFile.
vi.mock("node:child_process", async (importOriginal) => ({
  ...(await importOriginal<typeof import("node:child_process")>()),
  spawn: mocks.spawn,
}));

describe("parseSshTarget", () => {
  it("parses user@host:port targets", () => {
    expect(parseSshTarget("me@example.com:2222")).toEqual({
      user: "me",
      host: "example.com",
      port: 2222,
    });
  });

  it("strips an ssh prefix and keeps the default port when missing", () => {
    expect(parseSshTarget(" ssh alice@example.com ")).toEqual({
      user: "alice",
      host: "example.com",
      port: 22,
    });
  });

  it("rejects invalid hosts and ports", () => {
    expect(parseSshTarget("")).toBeNull();
    expect(parseSshTarget("me@example.com:0")).toBeNull();
    expect(parseSshTarget("me@example.com:not-a-port")).toBeNull();
    expect(parseSshTarget("-V")).toBeNull();
    expect(parseSshTarget("me@-badhost")).toBeNull();
    expect(parseSshTarget("-oProxyCommand=echo")).toBeNull();
  });
});

describe("startSshPortForward", () => {
  afterEach(() => {
    mocks.spawn.mockReset();
  });

  it("rejects with the spawn error instead of leaving it unhandled", async () => {
    const spawnError = Object.assign(
      new Error("spawn /usr/bin/ssh ENOENT"),
    ) as NodeJS.ErrnoException;
    spawnError.code = "ENOENT";
    // kill() returns false for a process that never spawned; stop() must not wait on "exit".
    const kill = vi.fn(() => false);
    mocks.spawn.mockImplementation(() => {
      const child = new EventEmitter() as EventEmitter & {
        killed: boolean;
        pid?: number;
        stderr: EventEmitter & { setEncoding: (enc: string) => void };
        kill: (signal?: string) => boolean;
      };
      child.killed = false;
      const stderr = new EventEmitter() as EventEmitter & { setEncoding: (enc: string) => void };
      stderr.setEncoding = () => {};
      child.stderr = stderr;
      child.kill = kill;
      queueMicrotask(() => {
        child.emit("error", spawnError);
      });
      return child;
    });

    const startedAt = Date.now();
    await expect(
      startSshPortForward({
        target: "me@example.com:2222",
        localPortPreferred: 0,
        remotePort: 18789,
        timeoutMs: 500,
      }),
    ).rejects.toMatchObject({
      message: expect.stringContaining("ENOENT"),
      cause: spawnError,
    });
    expect(kill).toHaveBeenCalledWith("SIGTERM");
    // stop() must not wait on an "exit" that never comes for a failed spawn
    // (the old path burned its full 1500ms SIGKILL grace period here).
    expect(Date.now() - startedAt).toBeLessThan(1_000);
  });
});
