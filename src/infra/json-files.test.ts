import fs from "node:fs/promises";
import path from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import { afterEach, describe, expect, it, vi } from "vitest";
import { withTempDir } from "../test-helpers/temp-dir.js";
import { createAsyncLock, readJsonFile, writeJsonAtomic, writeTextAtomic } from "./json-files.js";

const originalPlatformDescriptor = Object.getOwnPropertyDescriptor(process, "platform");

afterEach(() => {
  vi.restoreAllMocks();
  if (originalPlatformDescriptor) {
    Object.defineProperty(process, "platform", originalPlatformDescriptor);
  }
});

describe("json file helpers", () => {
  it.each([
    {
      name: "reads valid json",
      setup: async (base: string) => {
        const filePath = path.join(base, "valid.json");
        await fs.writeFile(filePath, '{"ok":true}', "utf8");
        return filePath;
      },
      expected: { ok: true },
    },
    {
      name: "returns null for invalid files",
      setup: async (base: string) => {
        const filePath = path.join(base, "invalid.json");
        await fs.writeFile(filePath, "{not-json}", "utf8");
        return filePath;
      },
      expected: null,
    },
    {
      name: "returns null for missing files",
      setup: async (base: string) => path.join(base, "missing.json"),
      expected: null,
    },
  ])("$name", async ({ setup, expected }) => {
    await withTempDir({ prefix: "openclaw-json-files-" }, async (base) => {
      await expect(readJsonFile(await setup(base))).resolves.toEqual(expected);
    });
  });

  describe("bounded retry on transient read races", () => {
    const errnoError = (code: string) => Object.assign(new Error(code), { code });

    it("retries a transient errno failure and then succeeds", async () => {
      await withTempDir({ prefix: "openclaw-json-files-retry-" }, async (base) => {
        const filePath = path.join(base, "state.json");
        await fs.writeFile(filePath, '{"ok":true}', "utf8");

        const readSpy = vi.spyOn(fs, "readFile");
        readSpy.mockRejectedValueOnce(errnoError("EBUSY"));

        await expect(readJsonFile(filePath)).resolves.toEqual({ ok: true });
        expect(readSpy).toHaveBeenCalledTimes(2);
      });
    });

    it("gives up after the attempt cap and returns null, never looping forever", async () => {
      await withTempDir({ prefix: "openclaw-json-files-exhaust-" }, async (base) => {
        const filePath = path.join(base, "state.json");
        await fs.writeFile(filePath, '{"ok":true}', "utf8");

        // Always transient. The cap is what stops this, not the file.
        const readSpy = vi.spyOn(fs, "readFile").mockRejectedValue(errnoError("EBUSY"));

        await expect(readJsonFile(filePath)).resolves.toBeNull();
        expect(readSpy).toHaveBeenCalledTimes(3);
      });
    });

    it("retries a torn read observed as a parse failure and then succeeds", async () => {
      await withTempDir({ prefix: "openclaw-json-files-torn-" }, async (base) => {
        const filePath = path.join(base, "state.json");
        await fs.writeFile(filePath, '{"ok":true}', "utf8");

        // First read observes a half-written file (the non-atomic Windows copy
        // fallback), the second sees the completed write.
        const readSpy = vi.spyOn(fs, "readFile");
        readSpy.mockResolvedValueOnce('{"ok":tr');

        await expect(readJsonFile(filePath)).resolves.toEqual({ ok: true });
        expect(readSpy).toHaveBeenCalledTimes(2);
      });
    });

    it("stops retrying a genuinely corrupt file after the smaller parse budget", async () => {
      await withTempDir({ prefix: "openclaw-json-files-corrupt-" }, async (base) => {
        const filePath = path.join(base, "invalid.json");
        await fs.writeFile(filePath, "{not-json}", "utf8");

        const readSpy = vi.spyOn(fs, "readFile");

        await expect(readJsonFile(filePath)).resolves.toBeNull();
        // Parse budget is 2, deliberately smaller than the errno budget of 3.
        expect(readSpy).toHaveBeenCalledTimes(2);
      });
    });

    it("does not retry a missing file", async () => {
      await withTempDir({ prefix: "openclaw-json-files-missing-" }, async (base) => {
        const readSpy = vi.spyOn(fs, "readFile");

        await expect(readJsonFile(path.join(base, "missing.json"))).resolves.toBeNull();
        // ENOENT is the expected hot path; stalling 150ms on it would be a bug.
        expect(readSpy).toHaveBeenCalledTimes(1);
      });
    });

    it("does not retry a permanent error", async () => {
      await withTempDir({ prefix: "openclaw-json-files-perm-" }, async (base) => {
        const filePath = path.join(base, "state.json");
        await fs.writeFile(filePath, '{"ok":true}', "utf8");

        const readSpy = vi.spyOn(fs, "readFile").mockRejectedValue(errnoError("EISDIR"));

        await expect(readJsonFile(filePath)).resolves.toBeNull();
        expect(readSpy).toHaveBeenCalledTimes(1);
      });
    });

    it("keeps one shared budget when errno and parse failures interleave", async () => {
      await withTempDir({ prefix: "openclaw-json-files-mixed-" }, async (base) => {
        const filePath = path.join(base, "state.json");
        await fs.writeFile(filePath, '{"ok":true}', "utf8");

        const readSpy = vi.spyOn(fs, "readFile");
        readSpy.mockRejectedValueOnce(errnoError("EBUSY"));
        readSpy.mockResolvedValueOnce('{"ok":tr');

        await expect(readJsonFile(filePath)).resolves.toBeNull();
        // One errno attempt + one parse attempt exhausts the shared budget; it
        // must not add up to errno-budget plus parse-budget.
        expect(readSpy).toHaveBeenCalledTimes(2);
      });
    });

    it("stays bounded in wall-clock time when every attempt fails", async () => {
      await withTempDir({ prefix: "openclaw-json-files-bounded-" }, async (base) => {
        const filePath = path.join(base, "state.json");
        await fs.writeFile(filePath, '{"ok":true}', "utf8");
        vi.spyOn(fs, "readFile").mockRejectedValue(errnoError("EBUSY"));

        const started = Date.now();
        await expect(readJsonFile(filePath)).resolves.toBeNull();
        const elapsed = Date.now() - started;
        // Backoff is 50ms then 100ms, so the two retries really did sleep...
        expect(elapsed).toBeGreaterThanOrEqual(140);
        // ...and the total stays close to that 150ms budget rather than growing
        // with the number of failures. A removed bound fails this loudly.
        expect(elapsed).toBeLessThan(600);
      });
    });
  });

  it("writes json atomically with pretty formatting and optional trailing newline", async () => {
    await withTempDir({ prefix: "openclaw-json-files-" }, async (base) => {
      const filePath = path.join(base, "nested", "config.json");

      await writeJsonAtomic(
        filePath,
        { ok: true, nested: { value: 1 } },
        { trailingNewline: true, ensureDirMode: 0o755 },
      );

      await expect(fs.readFile(filePath, "utf8")).resolves.toBe(
        '{\n  "ok": true,\n  "nested": {\n    "value": 1\n  }\n}\n',
      );
    });
  });

  it.each([
    { input: "hello", expected: "hello\n" },
    { input: "hello\n", expected: "hello\n" },
  ])("writes text atomically for %j", async ({ input, expected }) => {
    await withTempDir({ prefix: "openclaw-json-files-" }, async (base) => {
      const filePath = path.join(base, "nested", "note.txt");
      await writeTextAtomic(filePath, input, { appendTrailingNewline: true });
      await expect(fs.readFile(filePath, "utf8")).resolves.toBe(expected);
    });
  });

  it("falls back to copy-on-replace for Windows rename EPERM", async () => {
    await withTempDir({ prefix: "openclaw-json-files-" }, async (base) => {
      const filePath = path.join(base, "state.json");
      await fs.writeFile(filePath, "old", "utf8");

      Object.defineProperty(process, "platform", { value: "win32", configurable: true });
      const renameError = Object.assign(new Error("EPERM"), { code: "EPERM" });
      const renameSpy = vi.spyOn(fs, "rename").mockRejectedValueOnce(renameError);
      const copySpy = vi.spyOn(fs, "copyFile");

      await writeTextAtomic(filePath, "new");

      expect(renameSpy).toHaveBeenCalledOnce();
      expect(copySpy).toHaveBeenCalledOnce();
      await expect(fs.readFile(filePath, "utf8")).resolves.toBe("new");
    });
  });

  it.each([
    {
      name: "serializes async lock callers even across rejections",
      firstTask: async (events: string[]) => {
        events.push("first:start");
        await sleep(20);
        events.push("first:end");
        throw new Error("boom");
      },
      expectedFirstError: "boom",
      expectedEvents: ["first:start", "first:end", "second:start", "second:end"],
    },
    {
      name: "releases the async lock after synchronous throws",
      firstTask: async (events: string[]) => {
        events.push("first:start");
        throw new Error("sync boom");
      },
      expectedFirstError: "sync boom",
      expectedEvents: ["first:start", "second:start", "second:end"],
    },
  ])("$name", async ({ firstTask, expectedFirstError, expectedEvents }) => {
    const withLock = createAsyncLock();
    const events: string[] = [];

    const first = withLock(() => firstTask(events));

    const second = withLock(async () => {
      events.push("second:start");
      events.push("second:end");
      return "ok";
    });

    await expect(first).rejects.toThrow(expectedFirstError);
    await expect(second).resolves.toBe("ok");
    expect(events).toEqual(expectedEvents);
  });
});
