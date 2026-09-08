// Regression test: session-cost readline stream errors are swallowed instead of
// crashing the caller's async iteration, but only when the failure is a
// transient/mid-stream one. Deterministic failures (missing file, unreadable
// permissions) must still surface to the caller.
import nodeFs from "node:fs";
import fs from "node:fs/promises";
import path from "node:path";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { createSuiteTempRootTracker } from "../test-helpers/temp-dir.js";
import { loadSessionLogs } from "./session-cost-usage.js";

const tempDirs = createSuiteTempRootTracker({ prefix: "openclaw-session-cost-stream-" });

describe("session cost usage stream errors", () => {
  beforeAll(async () => {
    await tempDirs.setup();
  });

  afterAll(async () => {
    await tempDirs.cleanup();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  async function writeSessionFile(dir: string): Promise<string> {
    const sessionsDir = path.join(dir, "agents", "main", "sessions");
    await fs.mkdir(sessionsDir, { recursive: true });
    const sessionFile = path.join(sessionsDir, "sess-stream-error.jsonl");
    await fs.writeFile(
      sessionFile,
      [
        JSON.stringify({ type: "session", version: 1, id: "sess-stream-error" }),
        JSON.stringify({
          type: "message",
          timestamp: new Date().toISOString(),
          message: { role: "user", content: "hello" },
        }),
        "",
      ].join("\n"),
      "utf-8",
    );
    return sessionFile;
  }

  it("does not crash when the transcript stream emits a generic mid-stream error", async () => {
    const tempDir = await tempDirs.make("generic-error");
    const sessionFile = await writeSessionFile(tempDir);

    const originalCreateReadStream = nodeFs.createReadStream;
    vi.spyOn(nodeFs, "createReadStream").mockImplementationOnce((...args: unknown[]) => {
      const stream = originalCreateReadStream.apply(nodeFs, args as never);
      process.nextTick(() => {
        stream.emit("error", new Error("stream read failed"));
      });
      return stream;
    });

    const logs = await loadSessionLogs({ sessionFile });

    expect(logs).toEqual([]);
  });

  it("does not crash when the transcript stream emits EISDIR (session file is a directory)", async () => {
    const tempDir = await tempDirs.make("eisdir");
    const sessionsDir = path.join(tempDir, "agents", "main", "sessions");
    await fs.mkdir(sessionsDir, { recursive: true });
    const sessionFile = path.join(sessionsDir, "sess-eisdir.jsonl");
    // Make the session file a directory. createReadStream on a directory emits
    // EISDIR, which exercises the best-effort error handler in loadSessionLogs.
    await fs.mkdir(sessionFile);

    const logs = await loadSessionLogs({ sessionFile });

    expect(logs).toEqual([]);
  });

  it("still surfaces ENOENT (file removed after existence check) instead of swallowing it", async () => {
    const tempDir = await tempDirs.make("enoent");
    const sessionFile = await writeSessionFile(tempDir);

    const originalCreateReadStream = nodeFs.createReadStream;
    vi.spyOn(nodeFs, "createReadStream").mockImplementationOnce((...args: unknown[]) => {
      const stream = originalCreateReadStream.apply(nodeFs, args as never);
      process.nextTick(() => {
        const err = Object.assign(new Error("ENOENT: no such file or directory"), {
          code: "ENOENT",
        });
        stream.emit("error", err);
      });
      return stream;
    });

    await expect(loadSessionLogs({ sessionFile })).rejects.toThrow(/ENOENT/);
  });

  it("still surfaces EACCES (permission denied) instead of swallowing it", async () => {
    const tempDir = await tempDirs.make("eacces");
    const sessionFile = await writeSessionFile(tempDir);

    const originalCreateReadStream = nodeFs.createReadStream;
    vi.spyOn(nodeFs, "createReadStream").mockImplementationOnce((...args: unknown[]) => {
      const stream = originalCreateReadStream.apply(nodeFs, args as never);
      process.nextTick(() => {
        const err = Object.assign(new Error("EACCES: permission denied"), {
          code: "EACCES",
        });
        stream.emit("error", err);
      });
      return stream;
    });

    await expect(loadSessionLogs({ sessionFile })).rejects.toThrow(/EACCES/);
  });
});
