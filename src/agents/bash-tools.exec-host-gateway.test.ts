import { setImmediate } from "node:timers/promises";
import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

const INLINE_EVAL_HIT = {
  executable: "python3",
  normalizedExecutable: "python3",
  flag: "-c",
  argv: ["python3", "-c", "print(1)"],
};

const createAndRegisterDefaultExecApprovalRequestMock = vi.hoisted(() => vi.fn());
const buildExecApprovalPendingToolResultMock = vi.hoisted(() => vi.fn());
const buildExecApprovalFollowupTargetMock = vi.hoisted(() => vi.fn(() => null));
const createExecApprovalDecisionStateMock = vi.hoisted(() =>
  vi.fn(
    (): {
      baseDecision: { timedOut: boolean };
      approvedByAsk: boolean;
      deniedReason: string | null;
    } => ({
      baseDecision: { timedOut: false },
      approvedByAsk: false,
      deniedReason: "approval-required",
    }),
  ),
);
const evaluateShellAllowlistMock = vi.hoisted(() =>
  vi.fn(() => ({
    allowlistMatches: [],
    analysisOk: true,
    allowlistSatisfied: true,
    segments: [{ resolution: null, argv: ["echo", "ok"] }],
    segmentAllowlistEntries: [{ pattern: "/usr/bin/echo", source: "allow-always" }],
  })),
);
const hasDurableExecApprovalMock = vi.hoisted(() => vi.fn(() => true));
const buildEnforcedShellCommandMock = vi.hoisted(() =>
  vi.fn((): { ok: boolean; reason?: string; command?: string } => ({
    ok: false,
    reason: "segment execution plan unavailable",
  })),
);
const recordAllowlistMatchesUseMock = vi.hoisted(() => vi.fn());
const resolveApprovalDecisionOrUndefinedMock = vi.hoisted(() =>
  vi.fn(
    async (_params?: { onFailure: () => void }): Promise<string | null | undefined> => undefined,
  ),
);
const resolveExecHostApprovalContextMock = vi.hoisted(() =>
  vi.fn(() => ({
    approvals: { allowlist: [], file: { version: 1, agents: {} } },
    hostSecurity: "allowlist",
    hostAsk: "off",
    askFallback: "deny",
  })),
);
const runExecProcessMock = vi.hoisted(() => vi.fn());
const sendExecApprovalFollowupResultMock = vi.hoisted(() =>
  vi.fn(async (_target: unknown, _text: string) => undefined),
);
const enforceStrictInlineEvalApprovalBoundaryMock = vi.hoisted(() =>
  vi.fn(
    (value: {
      approvedByAsk: boolean;
      deniedReason: string | null;
    }): {
      approvedByAsk: boolean;
      deniedReason: string | null;
    } => value,
  ),
);
const detectInterpreterInlineEvalArgvMock = vi.hoisted(() =>
  vi.fn(
    (): {
      executable: string;
      normalizedExecutable: string;
      flag: string;
      argv: string[];
    } | null => null,
  ),
);

vi.mock("../infra/exec-approvals.js", () => ({
  evaluateShellAllowlist: evaluateShellAllowlistMock,
  hasDurableExecApproval: hasDurableExecApprovalMock,
  buildEnforcedShellCommand: buildEnforcedShellCommandMock,
  requiresExecApproval: vi.fn(() => false),
  recordAllowlistUse: vi.fn(),
  recordAllowlistMatchesUse: recordAllowlistMatchesUseMock,
  resolveApprovalAuditCandidatePath: vi.fn(() => null),
  resolveAllowAlwaysPatterns: vi.fn(() => []),
  resolveExecApprovalAllowedDecisions: vi.fn(() => ["allow-once", "allow-always", "deny"]),
  addAllowlistEntry: vi.fn(),
  addDurableCommandApproval: vi.fn(),
}));

vi.mock("./bash-tools.exec-approval-request.js", () => ({
  buildExecApprovalRequesterContext: vi.fn(() => ({})),
  buildExecApprovalTurnSourceContext: vi.fn(() => ({})),
  registerExecApprovalRequestForHostOrThrow: vi.fn(async () => undefined),
}));

vi.mock("./bash-tools.exec-host-shared.js", () => ({
  resolveExecHostApprovalContext: resolveExecHostApprovalContextMock,
  buildDefaultExecApprovalRequestArgs: vi.fn(() => ({})),
  buildHeadlessExecApprovalDeniedMessage: vi.fn(() => "denied"),
  buildExecApprovalFollowupTarget: buildExecApprovalFollowupTargetMock,
  buildExecApprovalPendingToolResult: buildExecApprovalPendingToolResultMock,
  createExecApprovalDecisionState: createExecApprovalDecisionStateMock,
  createAndRegisterDefaultExecApprovalRequest: createAndRegisterDefaultExecApprovalRequestMock,
  enforceStrictInlineEvalApprovalBoundary: enforceStrictInlineEvalApprovalBoundaryMock,
  resolveApprovalDecisionOrUndefined: resolveApprovalDecisionOrUndefinedMock,
  sendExecApprovalFollowupResult: sendExecApprovalFollowupResultMock,
  shouldResolveExecApprovalUnavailableInline: vi.fn(() => false),
}));

vi.mock("./bash-tools.exec-runtime.js", () => ({
  DEFAULT_NOTIFY_TAIL_CHARS: 1000,
  createApprovalSlug: vi.fn(() => "slug"),
  normalizeNotifyOutput: vi.fn((value) => value),
  runExecProcess: runExecProcessMock,
}));

vi.mock("./bash-process-registry.js", () => ({
  markBackgrounded: vi.fn(),
  tail: vi.fn((value) => value),
}));

vi.mock("../infra/exec-inline-eval.js", () => ({
  describeInterpreterInlineEval: vi.fn(() => "python -c"),
  detectInterpreterInlineEvalArgv: detectInterpreterInlineEvalArgvMock,
}));

let processGatewayAllowlist: typeof import("./bash-tools.exec-host-gateway.js").processGatewayAllowlist;

function captureProcessUnhandledRejections() {
  const reasons: unknown[] = [];
  const originalProcessEmit = process.emit.bind(process);
  const processEmit = vi.spyOn(process, "emit").mockImplementation((event, ...args) => {
    if (event === "unhandledRejection") {
      reasons.push(args[0]);
      return true;
    }
    return originalProcessEmit(event, ...args);
  });
  return { reasons, restore: () => processEmit.mockRestore() };
}

describe("processGatewayAllowlist", () => {
  beforeAll(async () => {
    ({ processGatewayAllowlist } = await import("./bash-tools.exec-host-gateway.js"));
  });

  beforeEach(() => {
    buildExecApprovalPendingToolResultMock.mockReset();
    buildExecApprovalFollowupTargetMock.mockReset();
    buildExecApprovalFollowupTargetMock.mockReturnValue(null);
    createExecApprovalDecisionStateMock.mockReset();
    createExecApprovalDecisionStateMock.mockReturnValue({
      baseDecision: { timedOut: false },
      approvedByAsk: false,
      deniedReason: "approval-required",
    });
    evaluateShellAllowlistMock.mockReset();
    evaluateShellAllowlistMock.mockReturnValue({
      allowlistMatches: [],
      analysisOk: true,
      allowlistSatisfied: true,
      segments: [{ resolution: null, argv: ["echo", "ok"] }],
      segmentAllowlistEntries: [{ pattern: "/usr/bin/echo", source: "allow-always" }],
    });
    hasDurableExecApprovalMock.mockReset();
    hasDurableExecApprovalMock.mockReturnValue(true);
    buildEnforcedShellCommandMock.mockReset();
    buildEnforcedShellCommandMock.mockReturnValue({
      ok: false,
      reason: "segment execution plan unavailable",
    });
    recordAllowlistMatchesUseMock.mockReset();
    resolveApprovalDecisionOrUndefinedMock.mockReset();
    resolveApprovalDecisionOrUndefinedMock.mockResolvedValue(undefined);
    resolveExecHostApprovalContextMock.mockReset();
    resolveExecHostApprovalContextMock.mockReturnValue({
      approvals: { allowlist: [], file: { version: 1, agents: {} } },
      hostSecurity: "allowlist",
      hostAsk: "off",
      askFallback: "deny",
    });
    runExecProcessMock.mockReset();
    sendExecApprovalFollowupResultMock.mockReset();
    enforceStrictInlineEvalApprovalBoundaryMock.mockReset();
    enforceStrictInlineEvalApprovalBoundaryMock.mockImplementation(
      (value: { approvedByAsk: boolean; deniedReason: string | null }) => value,
    );
    detectInterpreterInlineEvalArgvMock.mockReset();
    detectInterpreterInlineEvalArgvMock.mockReturnValue(null);
    buildExecApprovalPendingToolResultMock.mockReturnValue({
      details: { status: "approval-pending" },
      content: [],
    });
    createAndRegisterDefaultExecApprovalRequestMock.mockReset();
    createAndRegisterDefaultExecApprovalRequestMock.mockResolvedValue({
      approvalId: "req-1",
      approvalSlug: "slug-1",
      warningText: "",
      expiresAtMs: Date.now() + 60_000,
      preResolvedDecision: null,
      initiatingSurface: "origin",
      sentApproverDms: false,
      unavailableReason: null,
    });
  });

  it("still requires approval when allowlist execution plan is unavailable despite durable trust", async () => {
    const result = await processGatewayAllowlist({
      command: "echo ok",
      workdir: process.cwd(),
      env: process.env as Record<string, string>,
      pty: false,
      defaultTimeoutSec: 30,
      security: "allowlist",
      ask: "off",
      safeBins: new Set(),
      safeBinProfiles: {},
      warnings: [],
      approvalRunningNoticeMs: 0,
      maxOutput: 1000,
      pendingMaxOutput: 1000,
    });

    expect(createAndRegisterDefaultExecApprovalRequestMock).toHaveBeenCalledTimes(1);
    expect(result.pendingResult?.details.status).toBe("approval-pending");
  });

  it("allows durable exact-command trust to bypass the synchronous allowlist miss", async () => {
    evaluateShellAllowlistMock.mockReturnValue({
      allowlistMatches: [],
      analysisOk: false,
      allowlistSatisfied: false,
      segments: [{ resolution: null, argv: ["node", "--version"] }],
      segmentAllowlistEntries: [],
    });
    hasDurableExecApprovalMock.mockReturnValue(true);
    buildEnforcedShellCommandMock.mockReturnValue({
      ok: true,
      command: "node --version",
    });

    const result = await processGatewayAllowlist({
      command: "node --version",
      workdir: process.cwd(),
      env: process.env as Record<string, string>,
      pty: false,
      defaultTimeoutSec: 30,
      security: "allowlist",
      ask: "off",
      safeBins: new Set(),
      safeBinProfiles: {},
      warnings: [],
      approvalRunningNoticeMs: 0,
      maxOutput: 1000,
      pendingMaxOutput: 1000,
    });

    expect(createAndRegisterDefaultExecApprovalRequestMock).not.toHaveBeenCalled();
    expect(result).toEqual({ execCommandOverride: undefined });
  });

  it("keeps denying allowlist misses when durable trust does not match", async () => {
    evaluateShellAllowlistMock.mockReturnValue({
      allowlistMatches: [],
      analysisOk: false,
      allowlistSatisfied: false,
      segments: [{ resolution: null, argv: ["node", "--version"] }],
      segmentAllowlistEntries: [],
    });
    hasDurableExecApprovalMock.mockReturnValue(false);

    await expect(
      processGatewayAllowlist({
        command: "node --version",
        workdir: process.cwd(),
        env: process.env as Record<string, string>,
        pty: false,
        defaultTimeoutSec: 30,
        security: "allowlist",
        ask: "off",
        safeBins: new Set(),
        safeBinProfiles: {},
        warnings: [],
        approvalRunningNoticeMs: 0,
        maxOutput: 1000,
        pendingMaxOutput: 1000,
      }),
    ).rejects.toThrow("exec denied: allowlist miss");
  });

  it("uses sessionKey for followups when notifySessionKey is absent", async () => {
    await processGatewayAllowlist({
      command: "echo ok",
      workdir: process.cwd(),
      env: process.env as Record<string, string>,
      pty: false,
      defaultTimeoutSec: 30,
      security: "allowlist",
      ask: "off",
      safeBins: new Set(),
      safeBinProfiles: {},
      warnings: [],
      approvalRunningNoticeMs: 0,
      maxOutput: 1000,
      pendingMaxOutput: 1000,
      sessionKey: "agent:main:telegram:direct:123",
    });

    expect(buildExecApprovalFollowupTargetMock).toHaveBeenCalledWith(
      expect.objectContaining({
        sessionKey: "agent:main:telegram:direct:123",
      }),
    );
  });

  it("denies timed-out inline-eval requests instead of auto-running them", async () => {
    resolveExecHostApprovalContextMock.mockReturnValue({
      approvals: { allowlist: [], file: { version: 1, agents: {} } },
      hostSecurity: "full",
      hostAsk: "always",
      askFallback: "full",
    });
    detectInterpreterInlineEvalArgvMock.mockReturnValue(INLINE_EVAL_HIT);
    resolveApprovalDecisionOrUndefinedMock.mockResolvedValue(null);
    createExecApprovalDecisionStateMock.mockReturnValue({
      baseDecision: { timedOut: true },
      approvedByAsk: true,
      deniedReason: null,
    });
    enforceStrictInlineEvalApprovalBoundaryMock.mockReturnValue({
      approvedByAsk: false,
      deniedReason: "approval-timeout",
    });

    const result = await processGatewayAllowlist({
      command: "python3 -c 'print(1)'",
      workdir: process.cwd(),
      env: process.env as Record<string, string>,
      pty: false,
      defaultTimeoutSec: 30,
      security: "full",
      ask: "always",
      safeBins: new Set(),
      safeBinProfiles: {},
      strictInlineEval: true,
      warnings: [],
      approvalRunningNoticeMs: 0,
      maxOutput: 1000,
      pendingMaxOutput: 1000,
    });

    expect(result.pendingResult?.details.status).toBe("approval-pending");
    await vi.waitFor(() => {
      expect(sendExecApprovalFollowupResultMock).toHaveBeenCalledWith(
        null,
        "Exec denied (gateway id=req-1, approval-timeout): python3 -c 'print(1)'",
      );
    });
    expect(runExecProcessMock).not.toHaveBeenCalled();
  });

  it("denies allowlist timeout fallback for strict inline-eval commands", async () => {
    resolveExecHostApprovalContextMock.mockReturnValue({
      approvals: { allowlist: [], file: { version: 1, agents: {} } },
      hostSecurity: "allowlist",
      hostAsk: "always",
      askFallback: "allowlist",
    });
    detectInterpreterInlineEvalArgvMock.mockReturnValue(INLINE_EVAL_HIT);
    resolveApprovalDecisionOrUndefinedMock.mockResolvedValue(null);
    createExecApprovalDecisionStateMock.mockReturnValue({
      baseDecision: { timedOut: true },
      approvedByAsk: false,
      deniedReason: null,
    });
    enforceStrictInlineEvalApprovalBoundaryMock.mockReturnValue({
      approvedByAsk: false,
      deniedReason: "approval-timeout",
    });

    const result = await processGatewayAllowlist({
      command: "python3 -c 'print(1)'",
      workdir: process.cwd(),
      env: process.env as Record<string, string>,
      pty: false,
      defaultTimeoutSec: 30,
      security: "allowlist",
      ask: "always",
      safeBins: new Set(),
      safeBinProfiles: {},
      strictInlineEval: true,
      warnings: [],
      approvalRunningNoticeMs: 0,
      maxOutput: 1000,
      pendingMaxOutput: 1000,
    });

    expect(result.pendingResult?.details.status).toBe("approval-pending");
    await vi.waitFor(() => {
      expect(sendExecApprovalFollowupResultMock).toHaveBeenCalledWith(
        null,
        "Exec denied (gateway id=req-1, approval-timeout): python3 -c 'print(1)'",
      );
    });
    expect(runExecProcessMock).not.toHaveBeenCalled();
  });

  it("does not send a false approval-request-failed denial once dispatch has started", async () => {
    const unhandledRejections = captureProcessUnhandledRejections();

    try {
      resolveApprovalDecisionOrUndefinedMock.mockResolvedValue("allow-once");
      createExecApprovalDecisionStateMock.mockReturnValue({
        baseDecision: { timedOut: false },
        approvedByAsk: true,
        deniedReason: null,
      });
      runExecProcessMock.mockResolvedValue({
        session: { id: "sess-1" },
        promise: Promise.resolve({ aggregated: "done", timedOut: false, exitCode: 0 }),
      });
      // Delivering the final "finished" summary fails. Once dispatch has started (the
      // process actually spawned and ran), the outer race guard must not additionally
      // claim the request itself failed -- that would misreport a real (successful)
      // execution as an approval failure, i.e. lose the real outcome to the wrong side
      // of the race.
      sendExecApprovalFollowupResultMock.mockRejectedValue(
        new Error("notify delivery unavailable"),
      );

      const result = await processGatewayAllowlist({
        command: "echo ok",
        workdir: process.cwd(),
        env: process.env as Record<string, string>,
        pty: false,
        defaultTimeoutSec: 30,
        security: "allowlist",
        ask: "off",
        safeBins: new Set(),
        safeBinProfiles: {},
        warnings: [],
        approvalRunningNoticeMs: 0,
        maxOutput: 1000,
        pendingMaxOutput: 1000,
      });

      expect(result.pendingResult?.details.status).toBe("approval-pending");
      await vi.waitFor(() => {
        expect(runExecProcessMock).toHaveBeenCalledTimes(1);
      });
      await vi.waitFor(() => {
        expect(sendExecApprovalFollowupResultMock).toHaveBeenCalledTimes(1);
      });
      await setImmediate();

      expect(unhandledRejections.reasons).toEqual([]);
      // Only the real "finished" delivery was attempted; a second
      // "approval-request-failed" call would mean the race guard let the wrong-side
      // message through after dispatch already started.
      expect(sendExecApprovalFollowupResultMock).toHaveBeenCalledTimes(1);
      expect(sendExecApprovalFollowupResultMock.mock.calls[0]?.[1]).not.toContain(
        "approval-request-failed",
      );
    } finally {
      unhandledRejections.restore();
    }
  });

  it("sends the approval-request-failed fallback and reports it cleanly when dispatch never started", async () => {
    const unhandledRejections = captureProcessUnhandledRejections();

    try {
      // The approval decision itself fails before dispatch, and even the fallback
      // follow-up delivery fails. This must not escape as an unhandled rejection.
      resolveApprovalDecisionOrUndefinedMock.mockImplementation(
        async (params?: { onFailure: () => void }) => {
          params?.onFailure();
          return undefined;
        },
      );
      sendExecApprovalFollowupResultMock.mockRejectedValue(
        new Error("approval failure follow-up unavailable"),
      );

      const result = await processGatewayAllowlist({
        command: "echo ok",
        workdir: process.cwd(),
        env: process.env as Record<string, string>,
        pty: false,
        defaultTimeoutSec: 30,
        security: "allowlist",
        ask: "off",
        safeBins: new Set(),
        safeBinProfiles: {},
        warnings: [],
        approvalRunningNoticeMs: 0,
        maxOutput: 1000,
        pendingMaxOutput: 1000,
      });

      expect(result.pendingResult?.details.status).toBe("approval-pending");
      await vi.waitFor(() => {
        expect(sendExecApprovalFollowupResultMock).toHaveBeenCalledTimes(1);
      });
      await setImmediate();

      expect(unhandledRejections.reasons).toEqual([]);
      expect(sendExecApprovalFollowupResultMock).toHaveBeenCalledWith(
        null,
        "Exec denied (gateway id=req-1, approval-request-failed): echo ok",
      );
      expect(runExecProcessMock).not.toHaveBeenCalled();
    } finally {
      unhandledRejections.restore();
    }
  });
});
