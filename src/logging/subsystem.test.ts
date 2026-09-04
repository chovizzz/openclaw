import { afterEach, describe, expect, it, vi } from "vitest";
import { setConsoleSubsystemFilter } from "./console.js";
import { resetLogger, setLoggerOverride } from "./logger.js";
import { loggingState } from "./state.js";
import { createSubsystemLogger } from "./subsystem.js";

function installConsoleMethodSpy(method: "log" | "warn" | "error") {
  const spy = vi.fn();
  loggingState.rawConsole = {
    log: method === "log" ? spy : vi.fn(),
    info: vi.fn(),
    warn: method === "warn" ? spy : vi.fn(),
    error: method === "error" ? spy : vi.fn(),
  };
  return spy;
}

afterEach(() => {
  setConsoleSubsystemFilter(null);
  setLoggerOverride(null);
  loggingState.rawConsole = null;
  resetLogger();
  vi.unstubAllEnvs();
});

describe("createSubsystemLogger().isEnabled", () => {
  it("returns true for any/file when only file logging would emit", () => {
    setLoggerOverride({ level: "debug", consoleLevel: "silent" });
    const log = createSubsystemLogger("agent/embedded");

    expect(log.isEnabled("debug")).toBe(true);
    expect(log.isEnabled("debug", "file")).toBe(true);
    expect(log.isEnabled("debug", "console")).toBe(false);
  });

  it("returns true for any/console when only console logging would emit", () => {
    setLoggerOverride({ level: "silent", consoleLevel: "debug" });
    const log = createSubsystemLogger("agent/embedded");

    expect(log.isEnabled("debug")).toBe(true);
    expect(log.isEnabled("debug", "console")).toBe(true);
    expect(log.isEnabled("debug", "file")).toBe(false);
  });

  it("uses threshold ordering for non-equal console levels", () => {
    setLoggerOverride({ level: "silent", consoleLevel: "fatal" });
    const fatalOnly = createSubsystemLogger("agent/embedded");

    expect(fatalOnly.isEnabled("error", "console")).toBe(false);
    expect(fatalOnly.isEnabled("fatal", "console")).toBe(true);

    setLoggerOverride({ level: "silent", consoleLevel: "trace" });
    const traceLogger = createSubsystemLogger("agent/embedded");

    expect(traceLogger.isEnabled("debug", "console")).toBe(true);
  });

  it("never treats silent as an emittable console level", () => {
    setLoggerOverride({ level: "silent", consoleLevel: "info" });
    const log = createSubsystemLogger("agent/embedded");

    expect(log.isEnabled("silent", "console")).toBe(false);
  });

  it("returns false when neither console nor file logging would emit", () => {
    setLoggerOverride({ level: "silent", consoleLevel: "silent" });
    const log = createSubsystemLogger("agent/embedded");

    expect(log.isEnabled("debug")).toBe(false);
    expect(log.isEnabled("debug", "console")).toBe(false);
    expect(log.isEnabled("debug", "file")).toBe(false);
  });

  it("honors console subsystem filters for console target", () => {
    setLoggerOverride({ level: "silent", consoleLevel: "info" });
    setConsoleSubsystemFilter(["gateway"]);
    const log = createSubsystemLogger("agent/embedded");

    expect(log.isEnabled("info", "console")).toBe(false);
  });

  it("does not apply console subsystem filters to file target", () => {
    setLoggerOverride({ level: "info", consoleLevel: "silent" });
    setConsoleSubsystemFilter(["gateway"]);
    const log = createSubsystemLogger("agent/embedded");

    expect(log.isEnabled("info", "file")).toBe(true);
    expect(log.isEnabled("info")).toBe(true);
  });

  it("suppresses probe warnings for embedded subsystems based on structured run metadata", () => {
    setLoggerOverride({ level: "silent", consoleLevel: "warn" });
    const warn = installConsoleMethodSpy("warn");
    const log = createSubsystemLogger("agent/embedded").child("failover");

    log.warn("embedded run failover decision", {
      runId: "probe-test-run",
      consoleMessage: "embedded run failover decision",
    });

    expect(warn).not.toHaveBeenCalled();
  });

  it("does not suppress probe errors for embedded subsystems", () => {
    setLoggerOverride({ level: "silent", consoleLevel: "error" });
    const error = installConsoleMethodSpy("error");
    const log = createSubsystemLogger("agent/embedded").child("failover");

    log.error("embedded run failover decision", {
      runId: "probe-test-run",
      consoleMessage: "embedded run failover decision",
    });

    expect(error).toHaveBeenCalledTimes(1);
  });

  it("suppresses probe warnings for model-fallback child subsystems based on structured run metadata", () => {
    setLoggerOverride({ level: "silent", consoleLevel: "warn" });
    const warn = installConsoleMethodSpy("warn");
    const log = createSubsystemLogger("model-fallback").child("decision");

    log.warn("model fallback decision", {
      runId: "probe-test-run",
      consoleMessage: "model fallback decision",
    });

    expect(warn).not.toHaveBeenCalled();
  });

  it("does not suppress probe errors for model-fallback child subsystems", () => {
    setLoggerOverride({ level: "silent", consoleLevel: "error" });
    const error = installConsoleMethodSpy("error");
    const log = createSubsystemLogger("model-fallback").child("decision");

    log.error("model fallback decision", {
      runId: "probe-test-run",
      consoleMessage: "model fallback decision",
    });

    expect(error).toHaveBeenCalledTimes(1);
  });

  it("still emits non-probe warnings for embedded subsystems", () => {
    setLoggerOverride({ level: "silent", consoleLevel: "warn" });
    const warn = installConsoleMethodSpy("warn");
    const log = createSubsystemLogger("agent/embedded").child("auth-profiles");

    log.warn("auth profile failure state updated", {
      runId: "run-123",
      consoleMessage: "auth profile failure state updated",
    });

    expect(warn).toHaveBeenCalledTimes(1);
  });

  it("still emits non-probe model-fallback child warnings", () => {
    setLoggerOverride({ level: "silent", consoleLevel: "warn" });
    const warn = installConsoleMethodSpy("warn");
    const log = createSubsystemLogger("model-fallback").child("decision");

    log.warn("model fallback decision", {
      runId: "run-123",
      consoleMessage: "model fallback decision",
    });

    expect(warn).toHaveBeenCalledTimes(1);
  });
});

describe("createSubsystemLogger() console redaction", () => {
  it("redacts sensitive tokens at the console sink so subsystem writes do not leak secrets", () => {
    setLoggerOverride({ level: "silent", consoleLevel: "warn" });
    const warn = installConsoleMethodSpy("warn");
    const log = createSubsystemLogger("gateway");
    const secret = "sk-supersecretvaluefortest12345";

    log.warn(`connect failed token=${secret} host=build-07`);

    expect(warn).toHaveBeenCalledTimes(1);
    const written = String(warn.mock.calls[0]?.[0] ?? "");
    expect(written).not.toContain(secret);
    // Negative half: the surrounding diagnostic text survives.
    expect(written).toContain("connect failed");
    expect(written).toContain("host=build-07");
    expect(written).toContain("[gateway]");
  });

  it("redacts Bearer tokens on subsystem error console writes", () => {
    setLoggerOverride({ level: "silent", consoleLevel: "error" });
    const error = installConsoleMethodSpy("error");
    const log = createSubsystemLogger("gateway").child("auth");

    log.error("Authorization failed: Bearer abcdefghijklmnopqrstuvwxyz");

    expect(error).toHaveBeenCalledTimes(1);
    const written = String(error.mock.calls[0]?.[0] ?? "");
    expect(written).not.toContain("abcdefghijklmnopqrstuvwxyz");
    expect(written).toContain("Authorization failed: ");
    expect(written).toContain("Bearer ");
  });

  it("redacts before colorizing so the trailing ANSI reset survives", () => {
    vi.stubEnv("FORCE_COLOR", "1");
    setLoggerOverride({ level: "silent", consoleLevel: "info" });
    const logSpy = installConsoleMethodSpy("log");
    const log = createSubsystemLogger("gateway/auth");
    const secret = "sk-abcdefghijklmnopqrstuvwxyz123456";

    log.info(`provider API_KEY=${secret} ready`);

    expect(logSpy).toHaveBeenCalledTimes(1);
    const written = String(logSpy.mock.calls[0]?.[0] ?? "");
    expect(written).not.toContain(secret);
    expect(written).toContain("provider API_KEY=");
    expect(written).toContain(" ready");
    // Colorization wraps the already-redacted message, so the reset code is last.
    expect(written.endsWith("\u001B[39m")).toBe(true);
  });

  it("redacts sensitive tokens from raw subsystem console output", () => {
    setLoggerOverride({ level: "silent", consoleLevel: "info" });
    const logSpy = installConsoleMethodSpy("log");
    const log = createSubsystemLogger("gateway/auth");
    const secret = "sk-rawtokenabcdefghijklmnopqrstuvwxyz123456";

    log.raw(`raw token ${secret} tail`);

    expect(logSpy).toHaveBeenCalledTimes(1);
    const written = String(logSpy.mock.calls[0]?.[0] ?? "");
    expect(written).not.toContain(secret);
    expect(written).toContain("raw token ");
    expect(written).toContain(" tail");
  });

  it("redacts json-style console lines including formatted meta", () => {
    setLoggerOverride({ level: "silent", consoleLevel: "info", consoleStyle: "json" });
    const logSpy = installConsoleMethodSpy("log");
    const log = createSubsystemLogger("gateway");
    const secret = "sk-jsonmetasecretvalue0123456789";

    log.info("startup", { apiKey: secret, host: "build-07" });

    expect(logSpy).toHaveBeenCalledTimes(1);
    const written = String(logSpy.mock.calls[0]?.[0] ?? "");
    expect(written).not.toContain(secret);
    // Negative half: the line must still be valid JSON with its fields intact.
    const parsed = JSON.parse(written) as Record<string, unknown>;
    expect(parsed.message).toBe("startup");
    expect(parsed.host).toBe("build-07");
    expect(parsed.subsystem).toBe("gateway");
    expect(String(parsed.apiKey)).not.toContain(secret);
  });
});
