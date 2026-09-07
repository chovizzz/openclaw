import { describe, expect, it, vi } from "vitest";

const { updateSessionStoreEntryMock } = vi.hoisted(() => ({
  updateSessionStoreEntryMock: vi.fn(),
}));

vi.mock("../config/sessions.js", () => ({
  updateSessionStoreEntry: updateSessionStoreEntryMock,
}));

vi.mock("./session-utils.js", () => ({
  loadSessionEntry: (sessionKey: string) => ({
    entry: { updatedAt: 1, status: "running" },
    storePath: "/tmp/sessions-test-store.json",
    canonicalKey: sessionKey,
  }),
}));

import {
  deriveGatewaySessionLifecycleSnapshot,
  derivePersistedSessionLifecyclePatch,
  persistGatewaySessionLifecycleEvent,
} from "./session-lifecycle-state.js";

describe("session lifecycle state", () => {
  it("reactivates completed sessions on lifecycle start", () => {
    expect(
      deriveGatewaySessionLifecycleSnapshot({
        session: {
          updatedAt: 500,
          status: "done",
          startedAt: 100,
          endedAt: 400,
          runtimeMs: 300,
          abortedLastRun: true,
        },
        event: {
          ts: 1_000,
          data: {
            phase: "start",
            startedAt: 900,
          },
        },
      }),
    ).toEqual({
      updatedAt: 900,
      status: "running",
      startedAt: 900,
      endedAt: undefined,
      runtimeMs: undefined,
      abortedLastRun: false,
    });
  });

  it("marks completed lifecycle end events as done with terminal timing", () => {
    expect(
      deriveGatewaySessionLifecycleSnapshot({
        session: {
          updatedAt: 1_000,
          status: "running",
          startedAt: 1_200,
        },
        event: {
          ts: 2_000,
          data: {
            phase: "end",
            startedAt: 1_200,
            endedAt: 1_900,
          },
        },
      }),
    ).toEqual({
      updatedAt: 1_900,
      status: "done",
      startedAt: 1_200,
      endedAt: 1_900,
      runtimeMs: 700,
      abortedLastRun: false,
    });
  });

  it("maps aborted stop reasons to killed", () => {
    expect(
      derivePersistedSessionLifecyclePatch({
        entry: {
          updatedAt: 1_000,
          startedAt: 1_100,
        },
        event: {
          ts: 2_000,
          data: {
            phase: "end",
            endedAt: 1_800,
            stopReason: "aborted",
          },
        },
      }),
    ).toEqual({
      updatedAt: 1_800,
      status: "killed",
      startedAt: 1_100,
      endedAt: 1_800,
      runtimeMs: 700,
      abortedLastRun: true,
    });
  });

  it("maps aborted lifecycle end events without stopReason to timeout", () => {
    expect(
      derivePersistedSessionLifecyclePatch({
        entry: {
          updatedAt: 1_000,
          startedAt: 1_050,
        },
        event: {
          ts: 2_000,
          data: {
            phase: "end",
            endedAt: 1_550,
            aborted: true,
          },
        },
      }),
    ).toEqual({
      updatedAt: 1_550,
      status: "timeout",
      startedAt: 1_050,
      endedAt: 1_550,
      runtimeMs: 500,
      abortedLastRun: false,
    });
  });
});

describe("persistGatewaySessionLifecycleEvent retry/give-up behavior", () => {
  const endEvent = {
    ts: 2_000,
    data: { phase: "end" as const, startedAt: 1_000, endedAt: 1_500 },
  };

  it("retries a transient store-write failure and succeeds within the retry budget", async () => {
    updateSessionStoreEntryMock.mockReset();
    updateSessionStoreEntryMock
      .mockRejectedValueOnce(new Error("store locked"))
      .mockRejectedValueOnce(new Error("store locked"))
      .mockResolvedValueOnce({ updatedAt: 1_500, status: "done" });

    await expect(
      persistGatewaySessionLifecycleEvent({ sessionKey: "agent:main:active", event: endEvent }),
    ).resolves.toBeUndefined();

    // Bounded: at most 3 attempts total (2 failures + 1 success), never more.
    expect(updateSessionStoreEntryMock).toHaveBeenCalledTimes(3);
  });

  it("gives up after exhausting the retry budget without throwing (reverse test: a real writer stays bounded, never hangs)", async () => {
    updateSessionStoreEntryMock.mockReset();
    updateSessionStoreEntryMock.mockRejectedValue(new Error("store locked forever"));

    // Must resolve (not throw/hang) once the retry budget is spent — the
    // caller's fire-and-forget `.catch(() => undefined)` must never be
    // asked to catch an unbounded number of attempts.
    await expect(
      persistGatewaySessionLifecycleEvent({ sessionKey: "agent:main:active", event: endEvent }),
    ).resolves.toBeUndefined();

    // Capped at exactly 3 attempts — not 4, not infinite.
    expect(updateSessionStoreEntryMock).toHaveBeenCalledTimes(3);
  });

  it("does not retry (single attempt) when the write succeeds immediately", async () => {
    updateSessionStoreEntryMock.mockReset();
    updateSessionStoreEntryMock.mockResolvedValueOnce({ updatedAt: 1_500, status: "done" });

    await persistGatewaySessionLifecycleEvent({ sessionKey: "agent:main:active", event: endEvent });

    expect(updateSessionStoreEntryMock).toHaveBeenCalledTimes(1);
  });
});
