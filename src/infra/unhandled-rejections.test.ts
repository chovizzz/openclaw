import { describe, expect, it } from "vitest";
import {
  isAbortError,
  installUncaughtExceptionHandler,
  isBenignUncaughtExceptionError,
  isTransientNetworkError,
  isTransientSqliteError,
  isTransientUnhandledRejectionError,
} from "./unhandled-rejections.js";

describe("isAbortError", () => {
  it("returns true for error with name AbortError", () => {
    const error = new Error("aborted");
    error.name = "AbortError";
    expect(isAbortError(error)).toBe(true);
  });

  it('returns true for error with "This operation was aborted" message', () => {
    const error = new Error("This operation was aborted");
    expect(isAbortError(error)).toBe(true);
  });

  it("returns true for undici-style AbortError", () => {
    // Node's undici throws errors with this exact message
    const error = Object.assign(new Error("This operation was aborted"), { name: "AbortError" });
    expect(isAbortError(error)).toBe(true);
  });

  it("returns true for object with AbortError name", () => {
    expect(isAbortError({ name: "AbortError", message: "test" })).toBe(true);
  });

  it("returns false for regular errors", () => {
    expect(isAbortError(new Error("Something went wrong"))).toBe(false);
    expect(isAbortError(new TypeError("Cannot read property"))).toBe(false);
    expect(isAbortError(new RangeError("Invalid array length"))).toBe(false);
  });

  it("returns false for errors with similar but different messages", () => {
    expect(isAbortError(new Error("Operation aborted"))).toBe(false);
    expect(isAbortError(new Error("aborted"))).toBe(false);
    expect(isAbortError(new Error("Request was aborted"))).toBe(false);
  });

  it.each([null, undefined, "string error", 42, { message: "plain object" }])(
    "returns false for non-abort input %#",
    (value) => {
      expect(isAbortError(value)).toBe(false);
    },
  );
});

describe("isTransientNetworkError", () => {
  it("returns true for errors with transient network codes", () => {
    const codes = [
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
      "EPROTO",
      "UND_ERR_CONNECT_TIMEOUT",
      "UND_ERR_SOCKET",
      "UND_ERR_HEADERS_TIMEOUT",
      "UND_ERR_BODY_TIMEOUT",
      "ERR_SSL_WRONG_VERSION_NUMBER",
      "ERR_SSL_PROTOCOL_RETURNED_AN_ERROR",
    ];

    for (const code of codes) {
      const error = Object.assign(new Error("test"), { code });
      expect(isTransientNetworkError(error), `code: ${code}`).toBe(true);
    }
  });

  it('returns true for TypeError with "fetch failed" message', () => {
    const error = new TypeError("fetch failed");
    expect(isTransientNetworkError(error)).toBe(true);
  });

  it("returns true for fetch failed with network cause", () => {
    const cause = Object.assign(new Error("getaddrinfo ENOTFOUND"), { code: "ENOTFOUND" });
    const error = Object.assign(new TypeError("fetch failed"), { cause });
    expect(isTransientNetworkError(error)).toBe(true);
  });

  it("returns true for fetch failed with unclassified cause", () => {
    const cause = Object.assign(new Error("unknown socket state"), { code: "UNKNOWN" });
    const error = Object.assign(new TypeError("fetch failed"), { cause });
    expect(isTransientNetworkError(error)).toBe(true);
  });

  it("returns true for nested cause chain with network error", () => {
    const innerCause = Object.assign(new Error("connection reset"), { code: "ECONNRESET" });
    const outerCause = Object.assign(new Error("wrapper"), { cause: innerCause });
    const error = Object.assign(new TypeError("fetch failed"), { cause: outerCause });
    expect(isTransientNetworkError(error)).toBe(true);
  });

  it("returns true for Slack request errors that wrap network codes in .original", () => {
    const error = Object.assign(new Error("A request error occurred: getaddrinfo EAI_AGAIN"), {
      code: "slack_webapi_request_error",
      original: {
        errno: -3001,
        code: "EAI_AGAIN",
        syscall: "getaddrinfo",
        hostname: "slack.com",
      },
    });
    expect(isTransientNetworkError(error)).toBe(true);
  });

  it("returns true for network codes nested in .data payloads", () => {
    const error = {
      code: "slack_webapi_request_error",
      message: "A request error occurred",
      data: {
        code: "EAI_AGAIN",
      },
    };
    expect(isTransientNetworkError(error)).toBe(true);
  });

  it("returns true for AggregateError containing network errors", () => {
    const networkError = Object.assign(new Error("timeout"), { code: "ETIMEDOUT" });
    const error = new AggregateError([networkError], "Multiple errors");
    expect(isTransientNetworkError(error)).toBe(true);
  });

  it("returns true for wrapped fetch-failed messages from integration clients", () => {
    const error = new Error("Failed to get gateway information from Discord: fetch failed");
    expect(isTransientNetworkError(error)).toBe(true);
  });

  it("returns true for wrapped Discord upstream-connect parse failures", () => {
    const error = new Error(
      `Failed to get gateway information from Discord: Unexpected token 'u', "upstream connect error or disconnect/reset before headers. reset reason: overflow" is not valid JSON`,
    );
    expect(isTransientNetworkError(error)).toBe(true);
  });

  it("returns false for non-network fetch-failed wrappers from tools", () => {
    const error = new Error("Web fetch failed (404): Not Found");
    expect(isTransientNetworkError(error)).toBe(false);
  });

  it("returns true for TLS/SSL transient message snippets", () => {
    expect(isTransientNetworkError(new Error("write EPROTO 00A8B0C9:error"))).toBe(true);
    expect(
      isTransientNetworkError(
        new Error("SSL routines:OPENSSL_internal:WRONG_VERSION_NUMBER while connecting"),
      ),
    ).toBe(true);
    expect(isTransientNetworkError(new Error("tlsv1 alert protocol version"))).toBe(true);
  });

  it("returns false for regular errors without network codes", () => {
    expect(isTransientNetworkError(new Error("Something went wrong"))).toBe(false);
    expect(isTransientNetworkError(new TypeError("Cannot read property"))).toBe(false);
    expect(isTransientNetworkError(new RangeError("Invalid array length"))).toBe(false);
  });

  it("returns false for errors with non-network codes", () => {
    const error = Object.assign(new Error("test"), { code: "INVALID_CONFIG" });
    expect(isTransientNetworkError(error)).toBe(false);
  });

  it("returns false for Slack request errors without network indicators", () => {
    const error = Object.assign(new Error("A request error occurred"), {
      code: "slack_webapi_request_error",
    });
    expect(isTransientNetworkError(error)).toBe(false);
  });

  it("returns false for non-transient undici codes that only appear in message text", () => {
    const error = new Error("Request failed with UND_ERR_INVALID_ARG");
    expect(isTransientNetworkError(error)).toBe(false);
  });

  it.each([null, undefined, "string error", 42, { message: "plain object" }])(
    "returns false for non-network input %#",
    (value) => {
      expect(isTransientNetworkError(value)).toBe(false);
    },
  );

  it("returns false for AggregateError with only non-network errors", () => {
    const error = new AggregateError([new Error("regular error")], "Multiple errors");
    expect(isTransientNetworkError(error)).toBe(false);
  });
});

describe("isTransientSqliteError", () => {
  it("returns true for named transient SQLite codes", () => {
    const codes = ["SQLITE_CANTOPEN", "SQLITE_BUSY", "SQLITE_LOCKED", "SQLITE_IOERR"];

    for (const code of codes) {
      const error = Object.assign(new Error("sqlite transient"), { code });
      expect(isTransientSqliteError(error), `code: ${code}`).toBe(true);
    }
  });

  it("returns true for node:sqlite transient errcodes", () => {
    const sqliteCases = [
      { errcode: 14, errstr: "unable to open database file" },
      { errcode: 5, errstr: "database is locked" },
      { errcode: 6, errstr: "database table is locked" },
      { errcode: 10, errstr: "disk I/O error" },
    ] as const;

    for (const { errcode, errstr } of sqliteCases) {
      const error = Object.assign(new Error(errstr), {
        code: "ERR_SQLITE_ERROR",
        errcode,
        errstr,
      });
      expect(isTransientSqliteError(error), `errcode: ${errcode}`).toBe(true);
    }
  });

  it("returns true for wrapped SQLite message strings", () => {
    const error = new Error("SQLITE_BUSY: database is locked");
    expect(isTransientSqliteError(error)).toBe(true);
  });

  it("returns false for non-transient SQLite failures", () => {
    const constraintError = Object.assign(new Error("UNIQUE constraint failed"), {
      code: "SQLITE_CONSTRAINT",
    });
    const genericSqliteError = Object.assign(new Error("constraint failed"), {
      code: "ERR_SQLITE_ERROR",
      errcode: 19,
      errstr: "constraint failed",
    });

    expect(isTransientSqliteError(constraintError)).toBe(false);
    expect(isTransientSqliteError(genericSqliteError)).toBe(false);
  });

  it("returns false for matching errcodes without SQLite context", () => {
    const error = Object.assign(new Error("plain error"), {
      code: "ERR_OTHER",
      errcode: 14,
      errstr: "unable to open database file",
    });

    expect(isTransientSqliteError(error)).toBe(false);
  });

  it("returns false for SQLite-like snippets without SQLite context", () => {
    const error = new Error("database is locked");

    expect(isTransientSqliteError(error)).toBe(false);
  });
});

describe("isTransientUnhandledRejectionError", () => {
  it("returns true for transient SQLite errors", () => {
    const error = Object.assign(new Error("unable to open database file"), {
      code: "ERR_SQLITE_ERROR",
      errcode: 14,
      errstr: "unable to open database file",
    });

    expect(isTransientUnhandledRejectionError(error)).toBe(true);
  });
});

describe("isBenignUncaughtExceptionError", () => {
  it("treats EIO (dead tty/device behind stdout) as non-fatal, like console.ts does", () => {
    expect(
      isBenignUncaughtExceptionError(Object.assign(new Error("write EIO"), { code: "EIO" })),
    ).toBe(true);
    // Still identity-based: an outer non-benign code wins over a nested EIO cause.
    expect(
      isBenignUncaughtExceptionError(
        Object.assign(new Error("boom"), {
          code: "ERR_OUT_OF_MEMORY",
          cause: Object.assign(new Error("write EIO"), { code: "EIO" }),
        }),
      ),
    ).toBe(false);
  });

  it("treats a broken pipe as non-fatal", () => {
    expect(
      isBenignUncaughtExceptionError(
        Object.assign(new Error("write EPIPE"), {
          code: "EPIPE",
        }),
      ),
    ).toBe(true);
    // errno spelling and nested causes must be recognized too.
    expect(
      isBenignUncaughtExceptionError(
        Object.assign(new Error("write failed"), {
          errno: "EPIPE",
        }),
      ),
    ).toBe(true);
    expect(
      isBenignUncaughtExceptionError(
        new Error("send failed", {
          cause: Object.assign(new Error("write EPIPE"), { code: "EPIPE" }),
        }),
      ),
    ).toBe(true);
  });

  it("keeps every other error fatal", () => {
    // Unknown errors must still take the process down - this is the direction that
    // protects against a silently wedged gateway.
    expect(isBenignUncaughtExceptionError(new Error("boom"))).toBe(false);
    expect(isBenignUncaughtExceptionError(undefined)).toBe(false);
    expect(isBenignUncaughtExceptionError(null)).toBe(false);
    expect(isBenignUncaughtExceptionError("write EPIPE")).toBe(false);

    // Other transient-network codes are retryable for rejections but must NOT be
    // suppressed as uncaught exceptions.
    for (const code of ["ECONNRESET", "ETIMEDOUT", "ENOTFOUND", "EACCES"]) {
      expect(isBenignUncaughtExceptionError(Object.assign(new Error(code), { code }))).toBe(false);
    }

    // Transient SQLite errors stay fatal on the uncaught-exception path.
    expect(
      isBenignUncaughtExceptionError(
        Object.assign(new Error("database is locked"), { code: "SQLITE_BUSY" }),
      ),
    ).toBe(false);

    // AbortError stays fatal here; only the rejection path suppresses it.
    const aborted = new Error("aborted");
    aborted.name = "AbortError";
    expect(isBenignUncaughtExceptionError(aborted)).toBe(false);

    // A message that merely mentions EPIPE is not enough - only a real errno counts.
    expect(isBenignUncaughtExceptionError(new Error("upstream said write EPIPE"))).toBe(false);

    // Business-error shapes (for example a channel API error code) must keep exiting.
    expect(
      isBenignUncaughtExceptionError(Object.assign(new Error("invalid param"), { code: 99991663 })),
    ).toBe(false);
  });

  it("never lets a nested EPIPE rescue an error that is something else", () => {
    // A serious error that happens to carry an EPIPE underneath must still exit. This is the
    // direction that keeps the suppression to exactly one class of error.
    expect(
      isBenignUncaughtExceptionError(
        Object.assign(new Error("out of memory"), {
          code: "ERR_OUT_OF_MEMORY",
          cause: Object.assign(new Error("write EPIPE"), { code: "EPIPE" }),
        }),
      ),
    ).toBe(false);

    // Arbitrary third-party payload fields are never a suppression signal.
    expect(
      isBenignUncaughtExceptionError({
        code: "feishu_api_error",
        message: "invalid param",
        data: { code: "EPIPE" },
      }),
    ).toBe(false);
    expect(
      isBenignUncaughtExceptionError({ message: "wrapped", original: { code: "EPIPE" } }),
    ).toBe(false);
    expect(isBenignUncaughtExceptionError({ message: "wrapped", error: { code: "EPIPE" } })).toBe(
      false,
    );
    expect(isBenignUncaughtExceptionError({ message: "wrapped", reason: { code: "EPIPE" } })).toBe(
      false,
    );
    expect(
      isBenignUncaughtExceptionError(
        new AggregateError([Object.assign(new Error("write EPIPE"), { code: "EPIPE" })], "many"),
      ),
    ).toBe(false);
  });

  it("resolves identity from the first coded node in the cause chain", () => {
    // Untyped wrappers are transparent, however deep.
    expect(
      isBenignUncaughtExceptionError(
        new Error("outer", {
          cause: new Error("middle", {
            cause: Object.assign(new Error("write EPIPE"), { code: "EPIPE" }),
          }),
        }),
      ),
    ).toBe(true);

    // ...but the first node that declares a code decides, in both directions.
    expect(
      isBenignUncaughtExceptionError(
        new Error("outer", {
          cause: Object.assign(new Error("db down"), {
            code: "SQLITE_BUSY",
            cause: Object.assign(new Error("write EPIPE"), { code: "EPIPE" }),
          }),
        }),
      ),
    ).toBe(false);

    // An identity supplied via errno blocks a deeper EPIPE just as a code would.
    expect(
      isBenignUncaughtExceptionError(
        Object.assign(new Error("db down"), {
          errno: "SQLITE_BUSY",
          cause: Object.assign(new Error("write EPIPE"), { code: "EPIPE" }),
        }),
      ),
    ).toBe(false);

    // The outer identity wins in the benign direction too.
    expect(
      isBenignUncaughtExceptionError(
        Object.assign(new Error("write EPIPE"), {
          code: "EPIPE",
          cause: Object.assign(new Error("out of memory"), { code: "ERR_OUT_OF_MEMORY" }),
        }),
      ),
    ).toBe(true);

    // A blank code carries no identity, so the wrapper stays transparent.
    expect(
      isBenignUncaughtExceptionError(
        Object.assign(new Error("wrapper"), {
          code: "   ",
          cause: Object.assign(new Error("write EPIPE"), { code: "EPIPE" }),
        }),
      ),
    ).toBe(true);

    // A cyclic cause chain must terminate rather than hang the handler.
    const cyclic = Object.assign(new Error("cyclic"), {}) as Error & { cause?: unknown };
    cyclic.cause = cyclic;
    expect(isBenignUncaughtExceptionError(cyclic)).toBe(false);

    // A two-node cycle terminates as well.
    const first = Object.assign(new Error("first"), {}) as Error & { cause?: unknown };
    const second = Object.assign(new Error("second"), { cause: first }) as Error & {
      cause?: unknown;
    };
    first.cause = second;
    expect(isBenignUncaughtExceptionError(first)).toBe(false);

    // A primitive cause terminates the walk instead of throwing.
    expect(
      isBenignUncaughtExceptionError(Object.assign(new Error("wrapper"), { cause: "EPIPE" })),
    ).toBe(false);
  });

  it("does not confuse a numeric errno with the EPIPE symbol", () => {
    // The real Node EPIPE shape carries both; the symbolic code must win.
    expect(
      isBenignUncaughtExceptionError(
        Object.assign(new Error("write EPIPE"), { code: "EPIPE", errno: -32, syscall: "write" }),
      ),
    ).toBe(true);
    // A bare numeric errno stringifies to "-32", which can never match "EPIPE".
    expect(isBenignUncaughtExceptionError(Object.assign(new Error("write"), { errno: -32 }))).toBe(
      false,
    );
    // An explicit non-EPIPE code is not overridden by an EPIPE errno.
    expect(
      isBenignUncaughtExceptionError(
        Object.assign(new Error("other"), { code: "OTHER", errno: "EPIPE" }),
      ),
    ).toBe(false);
  });
});

describe("installUncaughtExceptionHandler", () => {
  it("registers the process handler only once across repeated installs", () => {
    const before = process.listenerCount("uncaughtException");
    installUncaughtExceptionHandler();
    installUncaughtExceptionHandler();
    installUncaughtExceptionHandler();
    // Both the library entry and the CLI entry call this in the same process;
    // a second registration used to double every benign-EPIPE warning.
    expect(process.listenerCount("uncaughtException") - before).toBeLessThanOrEqual(1);
  });
});
