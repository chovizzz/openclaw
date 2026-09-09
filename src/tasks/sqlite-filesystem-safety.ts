// Detects filesystems where SQLite WAL mode is unsafe.
//
// SQLite's WAL journal requires shared-memory (mmap) coherence between every
// process touching the database: readers and writers coordinate through the
// `-shm` file, and a host<->guest cache split (or a network round trip) can
// silently desync that coordination, corrupting the database under write
// pressure. This is documented SQLite behavior, not an OpenClaw-specific
// finding: https://www.sqlite.org/wal.html#use_of_wal_without_shared_memory
//
// Cross-VM filesystems (virtiofs, 9p — used by Parallels/QEMU/Docker Desktop
// shared folders) and network filesystems (NFS, SMB/CIFS) cannot provide that
// coherence. When a task/flow registry database lands on one of these, this
// module reports "delete" so the caller falls back to the rollback-journal
// (`PRAGMA journal_mode = DELETE`) instead of WAL.
import fs from "node:fs";
import path from "node:path";

export type SqliteJournalMode = "wal" | "delete";

const LINUX_NFS_SUPER_MAGIC = 0x6969;
const LINUX_SMB_SUPER_MAGIC = 0x517b;
const LINUX_CIFS_SUPER_MAGIC = 0xff534d42;
const LINUX_SMB2_SUPER_MAGIC = 0xfe534d42;
const LINUX_V9FS_SUPER_MAGIC = 0x01021997; // Linux 9p (V9FS)
/**
 * Why status is reported separately from mode: "we checked and it is a local
 * disk" and "we could not tell" both end up on WAL, but only the first is an
 * answer. Collapsing them hides the case where the guard is not actually
 * running on a machine — which is exactly the case worth knowing about, since
 * a host can later move onto a share.
 */
export type SqliteFilesystemSafety = {
  mode: SqliteJournalMode;
  status: "safe" | "unsafe" | "unrecognized" | "undetermined";
  filesystemType?: string;
};

// Ordinary local filesystems. Only used to tell "confirmed safe" apart from
// "not recognized"; anything absent here still runs on WAL.
const KNOWN_SAFE_FILESYSTEM_TYPE_NAMES = new Set([
  "apfs",
  "hfs",
  "ext2",
  "ext3",
  "ext4",
  "xfs",
  "btrfs",
  "zfs",
  "f2fs",
  "ntfs",
  "ntfs3",
  "exfat",
  "vfat",
  "msdos",
  "overlay",
  "tmpfs",
  "devtmpfs",
]);

const UNSAFE_STATFS_MAGICS = new Set([
  LINUX_NFS_SUPER_MAGIC,
  LINUX_SMB_SUPER_MAGIC,
  LINUX_CIFS_SUPER_MAGIC,
  LINUX_SMB2_SUPER_MAGIC,
  LINUX_V9FS_SUPER_MAGIC,
]);

// Named filesystem types reported by /proc/self/mountinfo (Linux) or the
// `mount` command (macOS/BSD) that cannot provide WAL's shared-memory
// coherence, or are known network filesystems.
const UNSAFE_FILESYSTEM_TYPE_NAMES = new Set([
  // VM shared folders. prl_fs is Parallels Tools, which matters most here:
  // part of the fleet runs in Parallels guests, and a shared home directory is
  // exactly the case this guard exists for.
  "virtiofs",
  "fuse.virtiofs",
  "prl_fs",
  "prlfs",
  "fuse.prl_fsd",
  "vboxsf",
  "vmhgfs",
  "fuse.vmhgfs-fuse",
  "osxfs",
  "fuse.osxfs",
  "grpcfuse",
  "9p",
  "9p2000.l",
  // Network mounts.
  "nfs",
  "nfs4",
  "cifs",
  "smbfs",
  "smb2",
  "smb3",
  "afpfs",
  "sshfs",
  "fuse.sshfs",
  "davfs",
  "davfs2",
  "fuse.davfs",
]);

// Filesystem classification runs during database open; never let a stalled
// `mount` invocation delay startup.
const MOUNT_COMMAND_TIMEOUT_MS = 1_000;

type MountEntry = { mountPoint: string; fsType: string };

function isUnsafeFilesystemTypeName(fsType: string): boolean {
  const normalized = fsType.toLowerCase();
  return UNSAFE_FILESYSTEM_TYPE_NAMES.has(normalized) || normalized.startsWith("9p");
}

function decodeMountInfoPath(value: string): string {
  return value.replace(/\\([0-7]{3})/g, (_, octal: string) =>
    String.fromCharCode(Number.parseInt(octal, 8)),
  );
}

function parseProcMountInfoEntries(contents: string): MountEntry[] {
  const entries: MountEntry[] = [];
  for (const line of contents.split("\n")) {
    const separator = line.indexOf(" - ");
    if (separator === -1) {
      continue;
    }
    const fields = line.slice(0, separator).split(" ");
    const suffixFields = line.slice(separator + 3).split(" ");
    const mountPoint = fields[4];
    const fsType = suffixFields[0];
    if (mountPoint && fsType) {
      entries.push({ mountPoint: decodeMountInfoPath(mountPoint), fsType });
    }
  }
  return entries;
}

function parseMountCommandEntries(contents: string): MountEntry[] {
  const entries: MountEntry[] = [];
  for (const line of contents.split("\n")) {
    // Linux: "source on /mount/point type fstype (opts)"
    const linuxMatch = /^(.+) on (.+) type ([^,\s)]+) \(/.exec(line);
    if (linuxMatch) {
      const mountPoint = linuxMatch[2];
      const fsType = linuxMatch[3];
      if (mountPoint && fsType) {
        entries.push({ mountPoint: decodeMountInfoPath(mountPoint), fsType });
      }
      continue;
    }
    // macOS/BSD: "source on /mount/point (fstype, opts)"
    const bsdMatch = /^(.+) on (.+) \(([^,\s)]+)/.exec(line);
    if (bsdMatch) {
      const mountPoint = bsdMatch[2];
      const fsType = bsdMatch[3];
      if (mountPoint && fsType) {
        // `mount` escapes spaces as \040 just like mountinfo does, so a share
        // at "/Volumes/My Shared" would never match the real path otherwise.
        entries.push({ mountPoint: decodeMountInfoPath(mountPoint), fsType });
      }
    }
  }
  return entries;
}

function tryReadLinuxMountInfo(): string | null {
  try {
    return fs.readFileSync("/proc/self/mountinfo", "utf8");
  } catch {
    return null;
  }
}

function tryReadMountCommandOutput(): string | null {
  try {
    return String(
      process.getBuiltinModule("node:child_process").execFileSync("mount", [], {
        killSignal: "SIGKILL",
        timeout: MOUNT_COMMAND_TIMEOUT_MS,
      }),
    );
  } catch {
    return null;
  }
}

function readMountEntries(): MountEntry[] {
  const mountInfo = tryReadLinuxMountInfo();
  if (mountInfo !== null) {
    return parseProcMountInfoEntries(mountInfo);
  }
  const mountOutput = tryReadMountCommandOutput();
  if (mountOutput !== null) {
    return parseMountCommandEntries(mountOutput);
  }
  return [];
}

function isPathWithinMount(targetPath: string, mountPoint: string): boolean {
  const resolvedTarget = path.resolve(targetPath);
  const resolvedMountPoint = path.resolve(mountPoint);
  return (
    resolvedTarget === resolvedMountPoint ||
    resolvedMountPoint === path.parse(resolvedMountPoint).root ||
    resolvedTarget.startsWith(`${resolvedMountPoint}${path.sep}`)
  );
}

function resolveSafetyFromMountEntries(
  targetPath: string,
  mountEntries: MountEntry[],
): SqliteFilesystemSafety {
  const mountEntry = mountEntries
    .filter((entry) => isPathWithinMount(targetPath, entry.mountPoint))
    .toSorted((a, b) => b.mountPoint.length - a.mountPoint.length)[0];
  if (!mountEntry) {
    return { mode: "wal", status: "undetermined" };
  }
  if (isUnsafeFilesystemTypeName(mountEntry.fsType)) {
    return { mode: "delete", status: "unsafe", filesystemType: mountEntry.fsType };
  }
  if (KNOWN_SAFE_FILESYSTEM_TYPE_NAMES.has(mountEntry.fsType.trim().toLowerCase())) {
    return { mode: "wal", status: "safe", filesystemType: mountEntry.fsType };
  }
  return { mode: "wal", status: "unrecognized", filesystemType: mountEntry.fsType };
}

/** Find the nearest existing ancestor of `targetPath`, resolving symlinks. */
function resolveExistingAncestor(targetPath: string): string | null {
  let current = path.resolve(targetPath);
  while (true) {
    try {
      return fs.realpathSync(current);
    } catch {
      const parent = path.dirname(current);
      if (parent === current) {
        return null;
      }
      current = parent;
    }
  }
}

/**
 * Determine the SQLite journal mode that is safe to use for a database that
 * will live under `dirPath`. Defaults to "wal" (today's behavior) whenever
 * detection is inconclusive, so this never regresses performance on ordinary
 * local disks; it only downgrades when a known-unsafe filesystem is found.
 */
export function resolveSqliteFilesystemSafety(dirPath: string): SqliteFilesystemSafety {
  const existingPath = resolveExistingAncestor(dirPath);
  if (!existingPath) {
    return { mode: "wal", status: "undetermined" };
  }
  if (typeof fs.statfsSync === "function") {
    try {
      const filesystemType = fs.statfsSync(existingPath).type;
      if (UNSAFE_STATFS_MAGICS.has(filesystemType)) {
        return { mode: "delete", status: "unsafe", filesystemType: `statfs:${filesystemType}` };
      }
    } catch {
      // statfs is unsupported for this path (for example on macOS, where the
      // magic-number check does not apply); fall through to mount parsing.
    }
  }
  return resolveSafetyFromMountEntries(existingPath, readMountEntries());
}

export function resolveSqliteJournalMode(dirPath: string): SqliteJournalMode {
  return resolveSqliteFilesystemSafety(dirPath).mode;
}
