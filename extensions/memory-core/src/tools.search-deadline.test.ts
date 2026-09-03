import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { runCliCommand } from "openclaw/plugin-sdk/memory-core-host-engine-qmd";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createMemorySearchToolOrThrow } from "./tools.test-helpers.js";

/**
 * These tests exist to prove the abort seam is actually wired end to end, not
 * merely typed. The memory_search deadline is only worth anything if the work
 * it abandons really stops, so the QMD case asserts on the OS process table
 * rather than on "kill was called".
 */

type SearchOpts = { signal?: AbortSignal } | undefined;
type SearchImpl = (query: string, opts: SearchOpts) => Promise<unknown[]>;

let searchImpl: SearchImpl = async () => [];

const stubManager = {
  search: vi.fn(async (query: string, opts: SearchOpts) => await searchImpl(query, opts)),
  readFile: vi.fn(async (params: { relPath: string }) => ({ text: "", path: params.relPath })),
  status: () => ({
    backend: "qmd" as const,
    files: 1,
    chunks: 1,
    dirty: false,
    workspaceDir: "/workspace",
    dbPath: "/workspace/.memory/index.sqlite",
    provider: "builtin",
    model: "builtin",
    requestedProvider: "builtin",
    sources: ["memory" as const],
    sourceCounts: [{ source: "memory" as const, files: 1, chunks: 1 }],
  }),
  sync: vi.fn(),
  probeEmbeddingAvailability: vi.fn(async () => ({ ok: true })),
  probeVectorAvailability: vi.fn(async () => true),
  close: vi.fn(),
};

vi.mock("./tools.runtime.js", () => ({
  resolveMemoryBackendConfig: () => ({ backend: "qmd", qmd: undefined }),
  getMemorySearchManager: vi.fn(async () => ({ manager: stubManager })),
  readAgentMemoryFile: vi.fn(async (params: { relPath: string }) => ({
    text: "",
    path: params.relPath,
  })),
}));

// Recall tracking writes to disk in the background; keep it out of the way.
vi.mock("./short-term-promotion.js", () => ({
  recordShortTermRecalls: vi.fn(async () => {}),
}));

let tempDir = "";

beforeEach(async () => {
  searchImpl = async () => [];
  vi.clearAllMocks();
  tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "memory-search-deadline-"));
});

afterEach(async () => {
  vi.useRealTimers();
  await fs.rm(tempDir, { recursive: true, force: true });
});

/** Poll a file without timers so the loop still progresses under fake timers. */
async function waitForPidFile(pidFile: string): Promise<number> {
  for (let attempt = 0; attempt < 20_000; attempt += 1) {
    try {
      const raw = (await fs.readFile(pidFile, "utf-8")).trim();
      const pid = Number.parseInt(raw, 10);
      if (Number.isInteger(pid) && pid > 0) {
        return pid;
      }
    } catch {
      // Not written yet; fs IO itself yields to the event loop each iteration.
    }
  }
  throw new Error(`child never reported its pid to ${pidFile}`);
}

/**
 * "Dead" must mean ESRCH specifically. Any other error (EPERM, EINVAL) would
 * otherwise read as "reaped" and let a still-running child pass the test.
 */
function isAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    const code = (error as NodeJS.ErrnoException | undefined)?.code;
    if (code === "ESRCH") {
      return false;
    }
    throw error;
  }
}

describe("memory_search deadline aborts orphaned work", () => {
  it("SIGKILLs the real qmd subprocess when the 15s deadline fires", async () => {
    const pidFile = path.join(tempDir, "child.pid");
    let childPid: number | undefined;
    let cliRejection: unknown;
    searchImpl = async (_query, opts) => {
      await runCliCommand({
        commandSummary: "qmd query slow",
        spawnInvocation: {
          command: process.execPath,
          argv: [
            "-e",
            // Report the real pid, then never exit on our own: only a kill ends this.
            `require("node:fs").writeFileSync(${JSON.stringify(pidFile)}, String(process.pid)); setInterval(() => {}, 1000);`,
          ],
        },
        env: process.env,
        cwd: tempDir,
        // Far beyond the tool deadline, so anything that ends this process must
        // be the abort and not runCliCommand's own timeout.
        timeoutMs: 600_000,
        maxOutputChars: 1_000,
        signal: opts?.signal,
      }).catch((err: unknown) => {
        cliRejection = err;
        throw err;
      });
      return [];
    };

    vi.useFakeTimers();
    try {
      const tool = createMemorySearchToolOrThrow();
      const pending = tool.execute("deadline-kill", { query: "hello" });

      childPid = await waitForPidFile(pidFile);
      expect(isAlive(childPid)).toBe(true);

      await vi.advanceTimersByTimeAsync(15_000);
      const result = await pending;
      expect(result.details).toMatchObject({
        disabled: true,
        unavailable: true,
        error: "memory_search timed out after 15s",
      });

      // The signal actually reached the backend.
      const opts = stubManager.search.mock.calls[0]?.[1];
      expect(opts?.signal?.aborted).toBe(true);

      vi.useRealTimers();
      const pid = childPid;
      // The abort listener inside runCliCommand fired; that same listener is
      // what issues SIGKILL, and it carries the deadline reason through.
      await vi.waitFor(() => {
        expect(cliRejection).toBeInstanceOf(Error);
      });
      expect((cliRejection as Error).message).toBe("memory_search timed out after 15s");
      // The OS really reaped the child: its pid is gone from the process table.
      await vi.waitFor(
        () => {
          expect(isAlive(pid)).toBe(false);
        },
        { timeout: 5_000 },
      );
    } finally {
      vi.useRealTimers();
      if (childPid !== undefined && isAlive(childPid)) {
        try {
          process.kill(childPid, "SIGKILL");
        } catch {
          // Already gone.
        }
      }
    }
  }, 30_000);

  it("never spawns a subprocess at all once the deadline already aborted", async () => {
    const pidFile = path.join(tempDir, "never.pid");
    // Everything the abandoned task observes is recorded here and asserted from
    // the main test body: assertions thrown inside that task are swallowed by
    // the deadline helper's `task.catch`, so they could never fail the test.
    let sawAbortedSignal: boolean | undefined;
    let lateRejection: unknown;
    let lateResolved = false;
    searchImpl = async (_query, opts) => {
      // Simulate a second backend hop started after the deadline already fired.
      await new Promise<void>((resolve) => {
        opts?.signal?.addEventListener("abort", () => resolve(), { once: true });
      });
      sawAbortedSignal = opts?.signal?.aborted === true;
      try {
        await runCliCommand({
          commandSummary: "qmd query late",
          spawnInvocation: {
            command: process.execPath,
            argv: [
              "-e",
              `require("node:fs").writeFileSync(${JSON.stringify(pidFile)}, String(process.pid)); setInterval(() => {}, 1000);`,
            ],
          },
          env: process.env,
          cwd: tempDir,
          timeoutMs: 600_000,
          maxOutputChars: 1_000,
          signal: opts?.signal,
        });
        lateResolved = true;
      } catch (err) {
        lateRejection = err;
      }
      return [];
    };

    vi.useFakeTimers();
    const tool = createMemorySearchToolOrThrow();
    const pending = tool.execute("deadline-no-spawn", { query: "hello" });
    await vi.advanceTimersByTimeAsync(15_000);
    const result = await pending;
    vi.useRealTimers();

    expect(result.details).toMatchObject({ error: "memory_search timed out after 15s" });
    await vi.waitFor(() => {
      expect(lateRejection).toBeDefined();
    });
    expect(sawAbortedSignal).toBe(true);
    expect(lateResolved).toBe(false);
    expect((lateRejection as Error).message).toBe("memory_search timed out after 15s");
    // Nothing was ever spawned, so no child could have written the pid file.
    // Give a would-be child a real window to prove that rather than racing it.
    await new Promise((resolve) => setTimeout(resolve, 250));
    let strayPid: number | undefined;
    try {
      strayPid = Number.parseInt((await fs.readFile(pidFile, "utf-8")).trim(), 10);
    } catch {
      // Expected: the file must not exist.
    }
    if (strayPid !== undefined && Number.isInteger(strayPid)) {
      try {
        process.kill(strayPid, "SIGKILL");
      } catch {
        // Already gone.
      }
    }
    expect(strayPid).toBeUndefined();
  }, 30_000);

  it("returns results normally when the search finishes inside the deadline", async () => {
    searchImpl = async () => [
      {
        source: "memory" as const,
        path: "MEMORY.md",
        startLine: 1,
        endLine: 2,
        score: 0.9,
        snippet: "remembered detail",
      },
    ];
    const tool = createMemorySearchToolOrThrow();
    const result = await tool.execute("fast", { query: "hello" });
    const details = result.details as {
      results: Array<{ path: string }>;
      disabled?: boolean;
      error?: string;
    };
    expect(details.error).toBeUndefined();
    expect(details.disabled).toBeUndefined();
    expect(details.results.map((entry) => entry.path)).toEqual(["MEMORY.md"]);
  });
});
