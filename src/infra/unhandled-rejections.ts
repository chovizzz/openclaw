import process from "node:process";
import { normalizeLowercaseStringOrEmpty } from "../shared/string-coerce.js";
import { restoreTerminalState } from "../terminal/restore.js";
import {
  collectErrorGraphCandidates,
  extractErrorCode,
  formatUncaughtError,
  readErrorName,
} from "./errors.js";

type UnhandledRejectionHandler = (reason: unknown) => boolean;

const handlers = new Set<UnhandledRejectionHandler>();

const FATAL_ERROR_CODES = new Set([
  "ERR_OUT_OF_MEMORY",
  "ERR_SCRIPT_EXECUTION_TIMEOUT",
  "ERR_WORKER_OUT_OF_MEMORY",
  "ERR_WORKER_UNCAUGHT_EXCEPTION",
  "ERR_WORKER_INITIALIZATION_FAILED",
]);

const CONFIG_ERROR_CODES = new Set(["INVALID_CONFIG", "MISSING_API_KEY", "MISSING_CREDENTIALS"]);

// Network error codes that indicate transient failures (shouldn't crash the gateway)
const TRANSIENT_NETWORK_CODES = new Set([
  "ECONNRESET",
  "ECONNREFUSED",
  "ENOTFOUND",
  "ETIMEDOUT",
  "ESOCKETTIMEDOUT",
  "ECONNABORTED",
  "EPIPE",
  "EHOSTUNREACH",
  "ENETUNREACH",
  "EAI_AGAIN",
  "UND_ERR_CONNECT_TIMEOUT",
  "UND_ERR_DNS_RESOLVE_FAILED",
  "UND_ERR_CONNECT",
  "UND_ERR_SOCKET",
  "UND_ERR_HEADERS_TIMEOUT",
  "UND_ERR_BODY_TIMEOUT",
  "EPROTO",
  "ERR_SSL_WRONG_VERSION_NUMBER",
  "ERR_SSL_PROTOCOL_RETURNED_AN_ERROR",
]);

const TRANSIENT_NETWORK_ERROR_NAMES = new Set([
  "AbortError",
  "ConnectTimeoutError",
  "HeadersTimeoutError",
  "BodyTimeoutError",
  "TimeoutError",
]);

const TRANSIENT_SQLITE_CODES = new Set([
  "SQLITE_BUSY",
  "SQLITE_CANTOPEN",
  "SQLITE_IOERR",
  "SQLITE_LOCKED",
]);

const TRANSIENT_SQLITE_ERRCODES = new Set([5, 6, 10, 14]);

// Uncaught exceptions that must not take the process down. Deliberately limited to broken
// pipes: writing to a closed pipe (a piped-to `head`, a detached terminal, a socket the peer
// already closed) is a normal end-of-consumer condition, not a fault in this process.
// Keep this set minimal - it only relaxes the uncaughtException path, never the
// unhandledRejection classification below.
// EPIPE and EIO are the two shapes a dead stdout/stderr produces (consumer went
// away vs. the tty/device backing the fd is gone). Upstream and this fork's own
// console.ts (`isEpipeError`) already treat them as one family.
const BENIGN_UNCAUGHT_EXCEPTION_CODES = new Set(["EPIPE", "EIO"]);

const TRANSIENT_NETWORK_MESSAGE_CODE_RE =
  /\b(ECONNRESET|ECONNREFUSED|ENOTFOUND|ETIMEDOUT|ESOCKETTIMEDOUT|ECONNABORTED|EPIPE|EHOSTUNREACH|ENETUNREACH|EAI_AGAIN|EPROTO|UND_ERR_CONNECT_TIMEOUT|UND_ERR_DNS_RESOLVE_FAILED|UND_ERR_CONNECT|UND_ERR_SOCKET|UND_ERR_HEADERS_TIMEOUT|UND_ERR_BODY_TIMEOUT)\b/i;

const TRANSIENT_SQLITE_MESSAGE_CODE_RE =
  /\b(SQLITE_BUSY|SQLITE_CANTOPEN|SQLITE_IOERR|SQLITE_LOCKED)\b/i;

const TRANSIENT_NETWORK_MESSAGE_SNIPPETS = [
  "getaddrinfo",
  "socket hang up",
  "client network socket disconnected before secure tls connection was established",
  "network error",
  "network is unreachable",
  "temporary failure in name resolution",
  "upstream connect error",
  "disconnect/reset before headers",
  "tlsv1 alert",
  "ssl routines",
  "packet length too long",
  "write eproto",
];

const TRANSIENT_SQLITE_MESSAGE_SNIPPETS = [
  "unable to open database file",
  "database is locked",
  "database table is locked",
  "disk i/o error",
];

function hasSqliteSignal(err: unknown): boolean {
  if (!err || typeof err !== "object") {
    return false;
  }

  const code = extractErrorCode(err);
  if (typeof code === "string") {
    const normalizedCode = code.trim().toUpperCase();
    if (normalizedCode === "ERR_SQLITE_ERROR" || normalizedCode.startsWith("SQLITE_")) {
      return true;
    }
  }

  const name = normalizeLowercaseStringOrEmpty(readErrorName(err));
  if (name.includes("sqlite")) {
    return true;
  }

  const message =
    "message" in err && typeof err.message === "string"
      ? normalizeLowercaseStringOrEmpty(err.message)
      : "";
  if (message.includes("sqlite")) {
    return true;
  }

  return false;
}

function isWrappedFetchFailedMessage(message: string): boolean {
  if (message === "fetch failed") {
    return true;
  }

  // Keep wrapped variants (for example "...: fetch failed") while avoiding broad
  // matches like "Web fetch failed (404): ..." that are not transport failures.
  return /:\s*fetch failed$/.test(message);
}

function getErrorCause(err: unknown): unknown {
  if (!err || typeof err !== "object") {
    return undefined;
  }
  return (err as { cause?: unknown }).cause;
}

function extractErrorCodeOrErrno(err: unknown): string | undefined {
  const code = extractErrorCode(err);
  if (code) {
    return code.trim().toUpperCase();
  }
  if (!err || typeof err !== "object") {
    return undefined;
  }
  const errno = (err as { errno?: unknown }).errno;
  if (typeof errno === "string" && errno.trim()) {
    return errno.trim().toUpperCase();
  }
  if (typeof errno === "number" && Number.isFinite(errno)) {
    return String(errno);
  }
  return undefined;
}

function extractNumericErrorCode(err: unknown, key: "errno" | "errcode"): number | undefined {
  if (!err || typeof err !== "object") {
    return undefined;
  }
  const value = (err as Record<"errno" | "errcode", unknown>)[key];
  if (typeof value === "number" && Number.isFinite(value)) {
    return value;
  }
  if (typeof value === "string" && value.trim()) {
    const parsed = Number(value.trim());
    return Number.isFinite(parsed) ? parsed : undefined;
  }
  return undefined;
}

function extractErrorCodeWithCause(err: unknown): string | undefined {
  const direct = extractErrorCode(err);
  if (direct) {
    return direct;
  }
  return extractErrorCode(getErrorCause(err));
}

/**
 * Checks if an error is an AbortError.
 * These are typically intentional cancellations (e.g., during shutdown) and shouldn't crash.
 */
export function isAbortError(err: unknown): boolean {
  if (!err || typeof err !== "object") {
    return false;
  }
  const name = "name" in err ? String(err.name) : "";
  if (name === "AbortError") {
    return true;
  }
  // Check for "This operation was aborted" message from Node's undici
  const message = "message" in err && typeof err.message === "string" ? err.message : "";
  if (message === "This operation was aborted") {
    return true;
  }
  return false;
}

function isFatalError(err: unknown): boolean {
  const code = extractErrorCodeWithCause(err);
  return code !== undefined && FATAL_ERROR_CODES.has(code);
}

function isConfigError(err: unknown): boolean {
  const code = extractErrorCodeWithCause(err);
  return code !== undefined && CONFIG_ERROR_CODES.has(code);
}

/**
 * Checks if an error is a transient network error that shouldn't crash the gateway.
 * These are typically temporary connectivity issues that will resolve on their own.
 */
export function isTransientNetworkError(err: unknown): boolean {
  if (!err) {
    return false;
  }
  for (const candidate of collectErrorGraphCandidates(err, (current) => {
    const nested: Array<unknown> = [
      current.cause,
      current.reason,
      current.original,
      current.error,
      current.data,
    ];
    if (Array.isArray(current.errors)) {
      nested.push(...current.errors);
    }
    return nested;
  })) {
    const code = extractErrorCodeOrErrno(candidate);
    if (code && TRANSIENT_NETWORK_CODES.has(code)) {
      return true;
    }

    const name = readErrorName(candidate);
    if (name && TRANSIENT_NETWORK_ERROR_NAMES.has(name)) {
      return true;
    }

    if (!candidate || typeof candidate !== "object") {
      continue;
    }
    const rawMessage = (candidate as { message?: unknown }).message;
    const message = normalizeLowercaseStringOrEmpty(rawMessage);
    if (!message) {
      continue;
    }
    if (TRANSIENT_NETWORK_MESSAGE_CODE_RE.test(message)) {
      return true;
    }
    if (isWrappedFetchFailedMessage(message)) {
      return true;
    }
    if (TRANSIENT_NETWORK_MESSAGE_SNIPPETS.some((snippet) => message.includes(snippet))) {
      return true;
    }
  }

  return false;
}

export function isTransientSqliteError(err: unknown): boolean {
  if (!err) {
    return false;
  }

  for (const candidate of collectErrorGraphCandidates(err, (current) => {
    const nested: Array<unknown> = [
      current.cause,
      current.reason,
      current.original,
      current.error,
      current.data,
    ];
    if (Array.isArray(current.errors)) {
      nested.push(...current.errors);
    }
    return nested;
  })) {
    const code = extractErrorCodeOrErrno(candidate);
    if (code && TRANSIENT_SQLITE_CODES.has(code)) {
      return true;
    }

    if (!hasSqliteSignal(candidate)) {
      continue;
    }

    const sqliteErrcode = extractNumericErrorCode(candidate, "errcode");
    if (sqliteErrcode !== undefined && TRANSIENT_SQLITE_ERRCODES.has(sqliteErrcode)) {
      return true;
    }

    if (!candidate || typeof candidate !== "object") {
      continue;
    }

    const messageParts = [
      (candidate as { message?: unknown }).message,
      (candidate as { errstr?: unknown }).errstr,
    ];
    for (const rawMessage of messageParts) {
      const message = normalizeLowercaseStringOrEmpty(rawMessage);
      if (!message) {
        continue;
      }
      if (TRANSIENT_SQLITE_MESSAGE_CODE_RE.test(message)) {
        return true;
      }
      if (TRANSIENT_SQLITE_MESSAGE_SNIPPETS.some((snippet) => message.includes(snippet))) {
        return true;
      }
    }
  }

  return false;
}

export function isTransientUnhandledRejectionError(err: unknown): boolean {
  return isTransientNetworkError(err) || isTransientSqliteError(err);
}

/**
 * True only when the error's own identity is a broken pipe (`EPIPE`).
 *
 * Used exclusively by the `uncaughtException` handlers to skip a process exit. It is
 * deliberately much stricter than the transient-network classification:
 *
 * - It resolves the error's identity from the first node in the `cause` chain that actually
 *   carries a code/errno. If that code is not EPIPE, the error is fatal - a nested EPIPE
 *   buried under, say, an OOM or a business error must never suppress the exit.
 * - It never inspects `data`, `errors`, `reason`, `original` or `error`. Those carry arbitrary
 *   third-party payloads, and a stray `{ code: "EPIPE" }` in one of them says nothing about
 *   whether this process is still healthy.
 *
 * The net effect is that exactly one class of error changes exit behavior: a broken pipe.
 */
export function isBenignUncaughtExceptionError(err: unknown): boolean {
  const seen = new Set<unknown>();
  let current: unknown = err;
  while (current != null && !seen.has(current)) {
    seen.add(current);
    const code = extractErrorCodeOrErrno(current);
    if (code) {
      // First node that declares an identity decides, in both directions.
      return BENIGN_UNCAUGHT_EXCEPTION_CODES.has(code);
    }
    if (typeof current !== "object") {
      return false;
    }
    // An untyped wrapper (`new Error("send failed", { cause: epipe })`) is transparent.
    current = (current as { cause?: unknown }).cause;
  }
  return false;
}

export function registerUnhandledRejectionHandler(handler: UnhandledRejectionHandler): () => void {
  handlers.add(handler);
  return () => {
    handlers.delete(handler);
  };
}

export function isUnhandledRejectionHandled(reason: unknown): boolean {
  for (const handler of handlers) {
    try {
      if (handler(reason)) {
        return true;
      }
    } catch (err) {
      console.error(
        "[openclaw] Unhandled rejection handler failed:",
        err instanceof Error ? (err.stack ?? err.message) : err,
      );
    }
  }
  return false;
}

// Module-level so the library entry (src/index.ts) and the CLI entry
// (src/cli/run-main.ts), which share this ESM instance in production, install
// exactly one handler — while a test that resets modules gets a fresh install.
let installedUncaughtExceptionHandler: ((error: unknown) => void) | undefined;

/**
 * Install the process-level uncaughtException handler exactly once.
 *
 * Both the library entry (src/index.ts) and the CLI entry (src/cli/run-main.ts)
 * need it, and both can run in the same process. Before this was shared, each
 * registered its own copy and a benign EPIPE produced two identical warnings.
 */
export function installUncaughtExceptionHandler(): void {
  const installed = installedUncaughtExceptionHandler;
  // Idempotent by *presence*, not by a sticky flag: if a previous install was
  // removed (tests do this), the next call registers again.
  if (installed && process.listeners("uncaughtException").includes(installed)) {
    return;
  }
  const handler = (error: unknown) => {
    // A broken pipe means the consumer went away, not that this process is broken.
    if (isBenignUncaughtExceptionError(error)) {
      console.warn(
        "[openclaw] Non-fatal uncaught exception (continuing):",
        formatUncaughtError(error),
      );
      return;
    }
    console.error("[openclaw] Uncaught exception:", formatUncaughtError(error));
    restoreTerminalState("uncaught exception", { resumeStdinIfPaused: false });
    process.exit(1);
  };
  installedUncaughtExceptionHandler = handler;
  process.on("uncaughtException", handler);
}

/** Test-only: detach the installed uncaughtException handler so a test can observe a fresh install. */
export function resetUncaughtExceptionHandlerForTest(): void {
  if (installedUncaughtExceptionHandler) {
    process.off("uncaughtException", installedUncaughtExceptionHandler);
    installedUncaughtExceptionHandler = undefined;
  }
}

export function installUnhandledRejectionHandler(): void {
  const exitWithTerminalRestore = (reason: string) => {
    restoreTerminalState(reason, { resumeStdinIfPaused: false });
    process.exit(1);
  };

  process.on("unhandledRejection", (reason, _promise) => {
    if (isUnhandledRejectionHandled(reason)) {
      return;
    }

    // AbortError is typically an intentional cancellation (e.g., during shutdown)
    // Log it but don't crash - these are expected during graceful shutdown
    if (isAbortError(reason)) {
      console.warn("[openclaw] Suppressed AbortError:", formatUncaughtError(reason));
      return;
    }

    if (isFatalError(reason)) {
      console.error("[openclaw] FATAL unhandled rejection:", formatUncaughtError(reason));
      exitWithTerminalRestore("fatal unhandled rejection");
      return;
    }

    if (isConfigError(reason)) {
      console.error("[openclaw] CONFIGURATION ERROR - requires fix:", formatUncaughtError(reason));
      exitWithTerminalRestore("configuration error");
      return;
    }

    if (isTransientUnhandledRejectionError(reason)) {
      console.warn(
        "[openclaw] Non-fatal unhandled rejection (continuing):",
        formatUncaughtError(reason),
      );
      return;
    }

    console.error("[openclaw] Unhandled promise rejection:", formatUncaughtError(reason));
    exitWithTerminalRestore("unhandled rejection");
  });
}
