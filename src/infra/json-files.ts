import { randomUUID } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";

function getErrorCode(err: unknown): string | undefined {
  return err instanceof Error ? (err as NodeJS.ErrnoException).code : undefined;
}

// Bounded retry policy for transient read races. This runs unattended, so the
// budget is a hard cap: at most READ_MAX_ATTEMPTS reads with backoff
// 50ms then 100ms, i.e. at most 150ms of added delay, then we give up. There is
// deliberately no unbounded loop and no "retry forever until it parses".
const READ_MAX_ATTEMPTS = 3;
// Parse failures get a smaller budget than errno failures: a torn read usually
// resolves on the very next attempt, while a genuinely corrupt file would
// otherwise pay the full backoff on every single read.
const PARSE_MAX_ATTEMPTS = 2;
const RETRY_BASE_DELAY_MS = 50;

// Codes that mean "try again shortly", not "this file is unusable".
// ENOENT is deliberately absent: a missing file is the expected hot path and
// must return null immediately rather than stalling for 150ms.
const TRANSIENT_READ_ERROR_CODES = new Set(["EAGAIN", "EBUSY", "EMFILE", "ENFILE", "EINTR"]);
// On Windows a sharing violation raised by an in-progress copy fallback, an
// antivirus scanner, or the search indexer surfaces as EPERM/EACCES. On POSIX
// those are real permission failures and retrying only delays the error.
const WINDOWS_TRANSIENT_READ_ERROR_CODES = new Set(["EPERM", "EACCES"]);

function readErrorCode(err: unknown): string | undefined {
  const fromError = getErrorCode(err);
  if (fromError) {
    return fromError;
  }
  // Wrapped/plain rejection values still carry a usable code in practice.
  if (err && typeof err === "object" && "code" in err) {
    const code = (err as { code?: unknown }).code;
    return typeof code === "string" ? code : undefined;
  }
  return undefined;
}

function isTransientReadError(err: unknown): boolean {
  const code = readErrorCode(err);
  if (!code) {
    return false;
  }
  return (
    TRANSIENT_READ_ERROR_CODES.has(code) ||
    (process.platform === "win32" && WINDOWS_TRANSIENT_READ_ERROR_CODES.has(code))
  );
}

function retryDelay(attempt: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, RETRY_BASE_DELAY_MS * 2 ** attempt));
}

async function replaceFileWithWindowsFallback(tempPath: string, filePath: string, mode: number) {
  try {
    await fs.rename(tempPath, filePath);
    return;
  } catch (err) {
    const code = getErrorCode(err);
    if (process.platform !== "win32" || (code !== "EPERM" && code !== "EEXIST")) {
      throw err;
    }
  }

  await fs.copyFile(tempPath, filePath);
  try {
    await fs.chmod(filePath, mode);
  } catch {
    // best-effort; ignore on platforms without chmod
  }
  await fs.rm(tempPath, { force: true }).catch(() => undefined);
}

/**
 * Reads and parses a JSON file, returning null when it is absent or unreadable.
 *
 * Reads are retried a bounded number of times for two distinct races:
 *  - transient errno failures (EBUSY/EAGAIN/..., plus Windows sharing
 *    violations), and
 *  - a torn read, which is observable only as a JSON parse failure. The Windows
 *    rename fallback in replaceFileWithWindowsFallback copies straight onto the
 *    live destination and is not atomic, so a concurrent reader can briefly see
 *    a partially written file.
 *
 * `attempt` is a single shared budget across both cases, so the total is capped
 * at READ_MAX_ATTEMPTS reads and ~150ms of added delay no matter how the
 * failures interleave. After the budget is exhausted the long-standing contract
 * is preserved and null is returned rather than throwing, because every caller
 * treats null as "absent or unreadable" and substitutes its own default.
 */
export async function readJsonFile<T>(filePath: string): Promise<T | null> {
  for (let attempt = 0; ; attempt += 1) {
    let raw: string;
    try {
      raw = await fs.readFile(filePath, "utf8");
    } catch (err) {
      if (attempt + 1 < READ_MAX_ATTEMPTS && isTransientReadError(err)) {
        await retryDelay(attempt);
        continue;
      }
      // ENOENT and any other non-transient error: nothing to wait for.
      return null;
    }
    try {
      return JSON.parse(raw) as T;
    } catch {
      if (attempt + 1 < PARSE_MAX_ATTEMPTS) {
        // Give an in-flight non-atomic write one chance to land.
        await retryDelay(attempt);
        continue;
      }
      // Still unparseable: treat the file as corrupt, same as before.
      return null;
    }
  }
}

export async function writeJsonAtomic(
  filePath: string,
  value: unknown,
  options?: { mode?: number; trailingNewline?: boolean; ensureDirMode?: number },
) {
  const text = JSON.stringify(value, null, 2);
  await writeTextAtomic(filePath, text, {
    mode: options?.mode,
    ensureDirMode: options?.ensureDirMode,
    appendTrailingNewline: options?.trailingNewline,
  });
}

export async function writeTextAtomic(
  filePath: string,
  content: string,
  options?: { mode?: number; ensureDirMode?: number; appendTrailingNewline?: boolean },
) {
  const mode = options?.mode ?? 0o600;
  const payload =
    options?.appendTrailingNewline && !content.endsWith("\n") ? `${content}\n` : content;
  const mkdirOptions: { recursive: true; mode?: number } = { recursive: true };
  if (typeof options?.ensureDirMode === "number") {
    mkdirOptions.mode = options.ensureDirMode;
  }
  await fs.mkdir(path.dirname(filePath), mkdirOptions);
  const parentDir = path.dirname(filePath);
  const tmp = `${filePath}.${randomUUID()}.tmp`;
  try {
    const tmpHandle = await fs.open(tmp, "w", mode);
    try {
      await tmpHandle.writeFile(payload, { encoding: "utf8" });
      await tmpHandle.sync();
    } finally {
      await tmpHandle.close().catch(() => undefined);
    }
    try {
      await fs.chmod(tmp, mode);
    } catch {
      // best-effort; ignore on platforms without chmod
    }
    await replaceFileWithWindowsFallback(tmp, filePath, mode);
    try {
      const dirHandle = await fs.open(parentDir, "r");
      try {
        await dirHandle.sync();
      } finally {
        await dirHandle.close().catch(() => undefined);
      }
    } catch {
      // best-effort; some platforms/filesystems do not support syncing directories.
    }
    try {
      await fs.chmod(filePath, mode);
    } catch {
      // best-effort; ignore on platforms without chmod
    }
  } finally {
    await fs.rm(tmp, { force: true }).catch(() => undefined);
  }
}

export function createAsyncLock() {
  let lock: Promise<void> = Promise.resolve();
  return async function withLock<T>(fn: () => Promise<T>): Promise<T> {
    const prev = lock;
    let release: (() => void) | undefined;
    lock = new Promise<void>((resolve) => {
      release = resolve;
    });
    await prev;
    try {
      return await fn();
    } finally {
      release?.();
    }
  };
}
