import { EventEmitter } from "node:events";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const spawnMock = vi.hoisted(() => vi.fn());

vi.mock("node:child_process", async () => {
  const actual = await vi.importActual<typeof import("node:child_process")>("node:child_process");
  return {
    ...actual,
    spawn: spawnMock,
  };
});

import {
  checkQmdBinaryAvailability,
  resolveCliSpawnInvocation,
  runCliCommand,
} from "./qmd-process.js";

function createMockChild() {
  const child = new EventEmitter() as EventEmitter & {
    kill: ReturnType<typeof vi.fn>;
    stdout: EventEmitter;
    stderr: EventEmitter;
  };
  child.kill = vi.fn();
  child.stdout = new EventEmitter();
  child.stderr = new EventEmitter();
  return child;
}

let tempDir = "";
let platformSpy: { mockRestore(): void } | null = null;
const originalPath = process.env.PATH;
const originalPathExt = process.env.PATHEXT;

beforeEach(async () => {
  tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-qmd-win-spawn-"));
  platformSpy = vi.spyOn(process, "platform", "get").mockReturnValue("win32");
});

afterEach(async () => {
  platformSpy?.mockRestore();
  process.env.PATH = originalPath;
  process.env.PATHEXT = originalPathExt;
  spawnMock.mockReset();
  if (tempDir) {
    await fs.rm(tempDir, { recursive: true, force: true });
    tempDir = "";
  }
});

describe("resolveCliSpawnInvocation", () => {
  it("unwraps npm cmd shims to a direct node entrypoint", async () => {
    const binDir = path.join(tempDir, "node_modules", ".bin");
    const packageDir = path.join(tempDir, "node_modules", "qmd");
    const scriptPath = path.join(packageDir, "dist", "cli.js");
    await fs.mkdir(path.dirname(scriptPath), { recursive: true });
    await fs.mkdir(binDir, { recursive: true });
    await fs.writeFile(path.join(binDir, "qmd.cmd"), "@echo off\r\n", "utf8");
    await fs.writeFile(
      path.join(packageDir, "package.json"),
      JSON.stringify({ name: "qmd", version: "0.0.0", bin: { qmd: "dist/cli.js" } }),
      "utf8",
    );
    await fs.writeFile(scriptPath, "module.exports = {};\n", "utf8");

    process.env.PATH = `${binDir};${originalPath ?? ""}`;
    process.env.PATHEXT = ".CMD;.EXE";

    const invocation = resolveCliSpawnInvocation({
      command: "qmd",
      args: ["query", "hello"],
      env: process.env,
      packageName: "qmd",
    });

    expect(invocation.command).toBe(process.execPath);
    expect(invocation.argv).toEqual([scriptPath, "query", "hello"]);
    expect(invocation.shell).not.toBe(true);
    expect(invocation.windowsHide).toBe(true);
  });

  it("fails closed when a Windows cmd shim cannot be resolved without shell execution", async () => {
    const binDir = path.join(tempDir, "bad-bin");
    await fs.mkdir(binDir, { recursive: true });
    await fs.writeFile(path.join(binDir, "qmd.cmd"), "@echo off\r\nREM no entrypoint\r\n", "utf8");

    process.env.PATH = `${binDir};${originalPath ?? ""}`;
    process.env.PATHEXT = ".CMD;.EXE";

    expect(() =>
      resolveCliSpawnInvocation({
        command: "qmd",
        args: ["query", "hello"],
        env: process.env,
        packageName: "qmd",
      }),
    ).toThrow(/without shell execution/);
  });

  it("keeps bare commands bare when no Windows wrapper exists on PATH", () => {
    process.env.PATH = originalPath ?? "";
    process.env.PATHEXT = ".CMD;.EXE";

    const invocation = resolveCliSpawnInvocation({
      command: "qmd",
      args: ["query", "hello"],
      env: process.env,
      packageName: "qmd",
    });

    expect(invocation.command).toBe("qmd");
    expect(invocation.argv).toEqual(["query", "hello"]);
    expect(invocation.shell).not.toBe(true);
  });
});

describe("checkQmdBinaryAvailability", () => {
  it("returns available when the qmd process spawns successfully", async () => {
    const child = createMockChild();
    spawnMock.mockImplementationOnce(() => {
      queueMicrotask(() => child.emit("spawn"));
      return child;
    });

    await expect(
      checkQmdBinaryAvailability({ command: "qmd", env: process.env, cwd: tempDir }),
    ).resolves.toEqual({ available: true });
    expect(child.kill).toHaveBeenCalled();
  });

  it("returns unavailable when the qmd process cannot be spawned", async () => {
    const child = createMockChild();
    const err = Object.assign(new Error("spawn qmd ENOENT"), { code: "ENOENT" });
    spawnMock.mockImplementationOnce(() => {
      queueMicrotask(() => child.emit("error", err));
      return child;
    });

    await expect(
      checkQmdBinaryAvailability({ command: "qmd", env: process.env, cwd: tempDir }),
    ).resolves.toEqual({ available: false, error: "spawn qmd ENOENT" });
  });

  it("does not treat close-before-spawn as a successful availability probe", async () => {
    const child = createMockChild();
    const err = Object.assign(new Error("spawn qmd ENOENT"), { code: "ENOENT" });
    spawnMock.mockImplementationOnce(() => {
      queueMicrotask(() => child.emit("close"));
      queueMicrotask(() => child.emit("error", err));
      return child;
    });

    await expect(
      checkQmdBinaryAvailability({ command: "qmd", env: process.env, cwd: tempDir }),
    ).resolves.toEqual({ available: false, error: "spawn qmd ENOENT" });
  });
});

describe("runCliCommand abort", () => {
  /**
   * The point of the abort path is process reclamation, so this asserts on the
   * real OS process: spawn a child that would otherwise run forever, abort, and
   * require that the child actually exited via SIGKILL and that its pid is gone
   * from the process table. Asserting "kill was called" would not prove that.
   *
   * Scope: this covers the directly spawned child only. runCliCommand does not
   * create a process group, so a child that forks its own descendants can still
   * leave those behind on abort (same as on the pre-existing timeout path).
   */
  it("kills the real spawned child process when the caller aborts", async () => {
    platformSpy?.mockRestore();
    platformSpy = null;
    const { spawn: realSpawn } =
      await vi.importActual<typeof import("node:child_process")>("node:child_process");
    let spawned: import("node:child_process").ChildProcess | null = null;
    spawnMock.mockImplementation((command: string, argv: string[], options: object) => {
      spawned = realSpawn(command, argv, options);
      return spawned;
    });

    const controller = new AbortController();
    const pending = runCliCommand({
      commandSummary: "qmd query slow",
      spawnInvocation: {
        command: process.execPath,
        // Never exits on its own; only an actual kill can end this process.
        argv: ["-e", "setInterval(() => {}, 1000)"],
      },
      env: process.env,
      cwd: tempDir,
      timeoutMs: 600_000,
      maxOutputChars: 1_000,
      signal: controller.signal,
    });

    // Wait for the child to really exist before aborting.
    await vi.waitFor(() => {
      expect(spawned?.pid).toBeGreaterThan(0);
    });
    const child = spawned as unknown as import("node:child_process").ChildProcess;
    const pid = child.pid as number;
    expect(() => process.kill(pid, 0)).not.toThrow();

    const exited = new Promise<NodeJS.Signals | null>((resolve) => {
      child.once("exit", (_code, exitSignal) => resolve(exitSignal));
    });
    controller.abort(new Error("memory_search timed out after 15s"));

    await expect(pending).rejects.toThrow("memory_search timed out after 15s");
    // The OS actually delivered SIGKILL and the child is gone.
    await expect(exited).resolves.toBe("SIGKILL");
    await vi.waitFor(() => {
      expect(() => process.kill(pid, 0)).toThrow(
        expect.objectContaining({ code: "ESRCH" }) as unknown as Error,
      );
    });
  }, 20_000);

  it("never spawns at all when the signal is already aborted", async () => {
    const controller = new AbortController();
    controller.abort(new Error("memory_search timed out after 15s"));

    await expect(
      runCliCommand({
        commandSummary: "qmd query already-aborted",
        spawnInvocation: { command: process.execPath, argv: ["-e", "setInterval(() => {}, 1000)"] },
        env: process.env,
        cwd: tempDir,
        timeoutMs: 600_000,
        maxOutputChars: 1_000,
        signal: controller.signal,
      }),
    ).rejects.toThrow("memory_search timed out after 15s");
    expect(spawnMock).not.toHaveBeenCalled();
  });

  it("SIGKILLs the child and surfaces the default abort reason", async () => {
    const child = createMockChild();
    spawnMock.mockImplementationOnce(() => child);
    const controller = new AbortController();
    const pending = runCliCommand({
      commandSummary: "qmd query no-reason",
      spawnInvocation: { command: "qmd", argv: ["query"] },
      env: process.env,
      cwd: tempDir,
      maxOutputChars: 1_000,
      signal: controller.signal,
    });
    // A bare abort() sets a DOMException reason, which is already an Error.
    controller.abort();

    await expect(pending).rejects.toThrow("This operation was aborted");
    expect(child.kill).toHaveBeenCalledWith("SIGKILL");
  });

  it("falls back to a stable abort error when the reason is not an error or string", async () => {
    const child = createMockChild();
    spawnMock.mockImplementationOnce(() => child);
    const controller = new AbortController();
    const pending = runCliCommand({
      commandSummary: "qmd query odd-reason",
      spawnInvocation: { command: "qmd", argv: ["query"] },
      env: process.env,
      cwd: tempDir,
      maxOutputChars: 1_000,
      signal: controller.signal,
    });
    controller.abort({ notAnError: true });

    await expect(pending).rejects.toThrow("qmd query odd-reason aborted");
    expect(child.kill).toHaveBeenCalledWith("SIGKILL");
  });

  it("does not let a late abort re-settle a command that already resolved", async () => {
    const child = createMockChild();
    spawnMock.mockImplementationOnce(() => {
      queueMicrotask(() => {
        child.stdout.emit("data", Buffer.from("[]", "utf8"));
        child.emit("close", 0);
      });
      return child;
    });
    const controller = new AbortController();
    const result = await runCliCommand({
      commandSummary: "qmd query fast",
      spawnInvocation: { command: "qmd", argv: ["query"] },
      env: process.env,
      cwd: tempDir,
      maxOutputChars: 1_000,
      signal: controller.signal,
    });
    expect(result.stdout).toBe("[]");

    // Aborting after the fact must not throw an unhandled rejection or kill an
    // unrelated process; the abort listener is detached on settle.
    controller.abort(new Error("late"));
    expect(child.kill).not.toHaveBeenCalled();
  });
});
