// Covers WAL-unsafe filesystem detection for task/flow registry SQLite stores.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  resolveSqliteFilesystemSafety,
  resolveSqliteJournalMode,
} from "./sqlite-filesystem-safety.js";

describe("resolveSqliteJournalMode", () => {
  const tempDirs: string[] = [];

  afterEach(() => {
    vi.restoreAllMocks();
    for (const dir of tempDirs.splice(0)) {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  function makeTempDir(): string {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "openclaw-sqlite-fs-safety-"));
    tempDirs.push(dir);
    return dir;
  }

  it("returns wal for an ordinary local directory", () => {
    const dir = makeTempDir();
    expect(resolveSqliteJournalMode(dir)).toBe("wal");
  });

  it("returns wal when the directory does not exist yet but its parent does", () => {
    const dir = makeTempDir();
    const missingChild = path.join(dir, "not-created-yet");
    expect(resolveSqliteJournalMode(missingChild)).toBe("wal");
  });

  it("returns delete when statfs reports the Linux 9p (V9FS) magic number", () => {
    const dir = makeTempDir();
    vi.spyOn(fs, "statfsSync").mockReturnValue({
      type: 0x01021997,
      bsize: 4096,
      blocks: 0,
      bfree: 0,
      bavail: 0,
      files: 0,
      ffree: 0,
    } as fs.StatsFsBase<number>);
    expect(resolveSqliteJournalMode(dir)).toBe("delete");
  });

  it("returns delete when statfs reports the Linux NFS magic number", () => {
    const dir = makeTempDir();
    vi.spyOn(fs, "statfsSync").mockReturnValue({
      type: 0x6969,
      bsize: 4096,
      blocks: 0,
      bfree: 0,
      bavail: 0,
      files: 0,
      ffree: 0,
    } as fs.StatsFsBase<number>);
    expect(resolveSqliteJournalMode(dir)).toBe("delete");
  });

  it("returns wal when statfs reports an ordinary local magic number", () => {
    const dir = makeTempDir();
    vi.spyOn(fs, "statfsSync").mockReturnValue({
      type: 0x01021994, // Linux TMPFS_MAGIC, unrelated to any unsafe type
      bsize: 4096,
      blocks: 0,
      bfree: 0,
      bavail: 0,
      files: 0,
      ffree: 0,
    } as fs.StatsFsBase<number>);
    expect(resolveSqliteJournalMode(dir)).toBe("wal");
  });

  it("returns delete when /proc/self/mountinfo reports virtiofs for the path", () => {
    const dir = makeTempDir();
    const resolvedDir = fs.realpathSync(dir);
    vi.spyOn(fs, "statfsSync").mockImplementation(() => {
      throw new Error("statfs unsupported for this path");
    });
    vi.spyOn(fs, "readFileSync").mockImplementation((requestedPath) => {
      if (requestedPath === "/proc/self/mountinfo") {
        return `1 0 0:1 / ${resolvedDir} rw,relatime shared:1 - virtiofs vm1 rw\n`;
      }
      throw Object.assign(new Error("ENOENT"), { code: "ENOENT" });
    });
    expect(resolveSqliteJournalMode(dir)).toBe("delete");
  });

  it("returns wal when /proc/self/mountinfo reports ext4 for the path", () => {
    const dir = makeTempDir();
    const resolvedDir = fs.realpathSync(dir);
    vi.spyOn(fs, "statfsSync").mockImplementation(() => {
      throw new Error("statfs unsupported for this path");
    });
    vi.spyOn(fs, "readFileSync").mockImplementation((requestedPath) => {
      if (requestedPath === "/proc/self/mountinfo") {
        return `1 0 0:1 / ${resolvedDir} rw,relatime shared:1 - ext4 /dev/sda1 rw\n`;
      }
      throw Object.assign(new Error("ENOENT"), { code: "ENOENT" });
    });
    expect(resolveSqliteJournalMode(dir)).toBe("wal");
  });

  it("returns delete when the mount command reports virtiofs for the path (macOS fallback)", () => {
    const dir = makeTempDir();
    const resolvedDir = fs.realpathSync(dir);
    vi.spyOn(fs, "statfsSync").mockImplementation(() => {
      throw new Error("statfs unsupported for this path");
    });
    vi.spyOn(fs, "readFileSync").mockImplementation(() => {
      throw Object.assign(new Error("ENOENT"), { code: "ENOENT" });
    });
    const childProcess = process.getBuiltinModule("node:child_process");
    vi.spyOn(childProcess, "execFileSync").mockReturnValue(
      `some-share on ${resolvedDir} (virtiofs, nodev, nosuid, mounted by user)\n`,
    );
    expect(resolveSqliteJournalMode(dir)).toBe("delete");
  });

  it("separates a confirmed-safe filesystem from one it could not identify", () => {
    // Both stay on WAL — downgrading on a guess would cost concurrency on an
    // ordinary disk. The point is that they must not be indistinguishable:
    // "unrecognized" means the guard is not really deciding anything here.
    const dir = makeTempDir();
    const resolvedDir = fs.realpathSync(dir);
    vi.spyOn(fs, "statfsSync").mockImplementation(() => {
      throw new Error("statfs unsupported for this path");
    });
    vi.spyOn(fs, "readFileSync").mockReturnValue(
      `1 0 0:1 / ${resolvedDir} rw,relatime shared:1 - ext4 /dev/sda1 rw\n`,
    );

    expect(resolveSqliteFilesystemSafety(dir)).toMatchObject({
      mode: "wal",
      status: "safe",
      filesystemType: "ext4",
    });
  });

  it("reports an unfamiliar filesystem as unrecognized rather than silently safe", () => {
    const dir = makeTempDir();
    const resolvedDir = fs.realpathSync(dir);
    vi.spyOn(fs, "statfsSync").mockImplementation(() => {
      throw new Error("statfs unsupported for this path");
    });
    vi.spyOn(fs, "readFileSync").mockReturnValue(
      `1 0 0:1 / ${resolvedDir} rw,relatime shared:1 - somefuturefs host rw\n`,
    );

    const safety = resolveSqliteFilesystemSafety(dir);
    expect(safety).toMatchObject({ mode: "wal", status: "unrecognized" });
    // Behavior is unchanged for callers that only read the mode.
    expect(resolveSqliteJournalMode(dir)).toBe("wal");
  });

  it("reports undetermined when no mount entry covers the path", () => {
    const dir = makeTempDir();
    vi.spyOn(fs, "statfsSync").mockImplementation(() => {
      throw new Error("statfs unsupported for this path");
    });
    vi.spyOn(fs, "readFileSync").mockImplementation(() => {
      throw Object.assign(new Error("ENOENT"), { code: "ENOENT" });
    });
    const childProcess = process.getBuiltinModule("node:child_process");
    vi.spyOn(childProcess, "execFileSync").mockReturnValue("");

    expect(resolveSqliteFilesystemSafety(dir)).toMatchObject({
      mode: "wal",
      status: "undetermined",
    });
  });

  it("returns delete for a Parallels shared folder (prl_fs)", () => {
    // The fleet includes Parallels guests, so a shared home directory is the
    // case this guard exists for; prl_fs must not fall through to WAL.
    const dir = makeTempDir();
    const resolvedDir = fs.realpathSync(dir);
    vi.spyOn(fs, "statfsSync").mockImplementation(() => {
      throw new Error("statfs unsupported for this path");
    });
    vi.spyOn(fs, "readFileSync").mockReturnValue(
      `1 0 0:1 / ${resolvedDir} rw,relatime shared:1 - prl_fs Host rw\n`,
    );
    expect(resolveSqliteJournalMode(dir)).toBe("delete");
  });

  it("decodes escaped spaces in mount output so an escaped share still downgrades", () => {
    // `mount` escapes spaces as \040 exactly like mountinfo. Without decoding,
    // a share under a path containing a space never matches and silently keeps WAL.
    const base = makeTempDir();
    const spaced = path.join(fs.realpathSync(base), "my shared vol");
    fs.mkdirSync(spaced, { recursive: true });
    const escaped = spaced.replace(/ /g, "\\040");
    vi.spyOn(fs, "statfsSync").mockImplementation(() => {
      throw new Error("statfs unsupported for this path");
    });
    vi.spyOn(fs, "readFileSync").mockImplementation(() => {
      throw Object.assign(new Error("ENOENT"), { code: "ENOENT" });
    });
    const childProcess = process.getBuiltinModule("node:child_process");
    vi.spyOn(childProcess, "execFileSync").mockReturnValue(
      `share on ${escaped} (virtiofs, nodev)\n`,
    );
    expect(resolveSqliteJournalMode(spaced)).toBe("delete");
  });

  it("returns wal when the mount command reports apfs for the path (macOS fallback)", () => {
    const dir = makeTempDir();
    const resolvedDir = fs.realpathSync(dir);
    vi.spyOn(fs, "statfsSync").mockImplementation(() => {
      throw new Error("statfs unsupported for this path");
    });
    vi.spyOn(fs, "readFileSync").mockImplementation(() => {
      throw Object.assign(new Error("ENOENT"), { code: "ENOENT" });
    });
    const childProcess = process.getBuiltinModule("node:child_process");
    vi.spyOn(childProcess, "execFileSync").mockReturnValue(
      `/dev/disk1s1 on ${resolvedDir} (apfs, local, journaled)\n`,
    );
    expect(resolveSqliteJournalMode(dir)).toBe("wal");
  });
});
