import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mockRestartWarn = vi.fn();

vi.mock("../logging/subsystem.js", () => ({
  createSubsystemLogger: vi.fn(() => ({
    warn: (...args: unknown[]) => mockRestartWarn(...args),
    info: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
    trace: vi.fn(),
    fatal: vi.fn(),
    raw: vi.fn(),
    isEnabled: () => true,
    child: vi.fn(),
  })),
}));

import { __testing, deferGatewayRestartUntilIdle, type RestartDeferralHooks } from "./restart.js";

// Matches DEFAULT_DEFERRAL_POLL_MS in restart.ts.
const DEFAULT_POLL_MS = 500;

// A throwing restart deferral hook must never skip the emitGatewayRestart()
// call that follows it (that would silently drop the restart) and must never
// crash the process from inside a setInterval callback (an uncaught throw
// there becomes an unhandled exception with no restart emitted either).
describe("deferGatewayRestartUntilIdle hook safety", () => {
  let sigusr1Listener: ReturnType<typeof vi.fn<() => void>>;
  let sigusr1Handler: () => void;

  beforeEach(() => {
    vi.useFakeTimers();
    mockRestartWarn.mockClear();
    __testing.resetSigusr1State();
    sigusr1Listener = vi.fn<() => void>();
    sigusr1Handler = () => sigusr1Listener();
    process.on("SIGUSR1", sigusr1Handler);
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
    __testing.resetSigusr1State();
    process.removeAllListeners("SIGUSR1");
  });

  it("still restarts and logs a warning when onReady throws (immediate-ready path)", () => {
    const hooks: RestartDeferralHooks = {
      onReady: () => {
        throw new Error("boom in onReady");
      },
    };

    deferGatewayRestartUntilIdle({
      getPendingCount: () => 0,
      hooks,
    });

    // The restart must still have been emitted even though the hook threw.
    expect(sigusr1Listener).toHaveBeenCalledOnce();
    expect(mockRestartWarn).toHaveBeenCalledOnce();
    expect(mockRestartWarn.mock.calls[0]?.[0]).toContain('restart deferral hook "onReady" failed');
    expect(mockRestartWarn.mock.calls[0]?.[0]).toContain("boom in onReady");
  });

  it("still restarts and logs a warning when onCheckError throws", () => {
    const hooks: RestartDeferralHooks = {
      onCheckError: () => {
        throw new Error("boom in onCheckError");
      },
    };

    deferGatewayRestartUntilIdle({
      getPendingCount: () => {
        throw new Error("store corrupted");
      },
      hooks,
    });

    expect(sigusr1Listener).toHaveBeenCalledOnce();
    expect(mockRestartWarn).toHaveBeenCalledOnce();
    expect(mockRestartWarn.mock.calls[0]?.[0]).toContain(
      'restart deferral hook "onCheckError" failed',
    );
  });

  it("still restarts and logs a warning when onTimeout throws (polling path)", () => {
    const hooks: RestartDeferralHooks = {
      onTimeout: () => {
        throw new Error("boom in onTimeout");
      },
    };

    deferGatewayRestartUntilIdle({
      getPendingCount: () => 1, // never drains
      maxWaitMs: 1000,
      hooks,
    });

    expect(sigusr1Listener).not.toHaveBeenCalled();
    vi.advanceTimersByTime(1000);

    expect(sigusr1Listener).toHaveBeenCalledOnce();
    expect(mockRestartWarn).toHaveBeenCalledOnce();
    expect(mockRestartWarn.mock.calls[0]?.[0]).toContain(
      'restart deferral hook "onTimeout" failed',
    );
  });

  it("still restarts and logs a warning when onReady throws (polling path after drain)", () => {
    let pending = 1;
    const hooks: RestartDeferralHooks = {
      onReady: () => {
        throw new Error("boom in onReady poll");
      },
    };

    deferGatewayRestartUntilIdle({
      getPendingCount: () => pending,
      hooks,
    });
    expect(sigusr1Listener).not.toHaveBeenCalled();

    pending = 0;
    vi.advanceTimersByTime(DEFAULT_POLL_MS);

    expect(sigusr1Listener).toHaveBeenCalledOnce();
    expect(mockRestartWarn).toHaveBeenCalledOnce();
  });

  it("still restarts and logs a warning when onDeferring throws", () => {
    const hooks: RestartDeferralHooks = {
      onDeferring: () => {
        throw new Error("boom in onDeferring");
      },
      onReady: vi.fn(),
    };

    deferGatewayRestartUntilIdle({
      getPendingCount: () => 1,
      hooks,
    });

    // onDeferring fires synchronously; the poll loop must still have been armed.
    expect(mockRestartWarn).toHaveBeenCalledOnce();
    expect(mockRestartWarn.mock.calls[0]?.[0]).toContain(
      'restart deferral hook "onDeferring" failed',
    );
    expect(sigusr1Listener).not.toHaveBeenCalled();
  });

  it("does not log or interfere when hooks do not throw", () => {
    const hooks: RestartDeferralHooks = {
      onReady: vi.fn(),
    };

    deferGatewayRestartUntilIdle({
      getPendingCount: () => 0,
      hooks,
    });

    expect(hooks.onReady).toHaveBeenCalledOnce();
    expect(sigusr1Listener).toHaveBeenCalledOnce();
    expect(mockRestartWarn).not.toHaveBeenCalled();
  });
});
