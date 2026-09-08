import { setImmediate } from "node:timers/promises";
import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

const INLINE_EVAL_HIT = {
  executable: "python3",
  normalizedExecutable: "python3",
  flag: "-c",
  argv: ["python3", "-c", "print(1)"],
};

const preparedPlan = vi.hoisted(() => ({
  argv: ["bun", "./script.ts"],
  cwd: "/tmp/work",
  commandText: "bun ./script.ts",
  commandPreview: "bun ./script.ts",
  agentId: "prepared-agent",
  sessionKey: "prepared-session",
  mutableFileOperand: {
    argvIndex: 1,
    path: "/tmp/work/script.ts",
    sha256: "abc123",
  },
}));

const callGatewayToolMock = vi.hoisted(() => vi.fn());
const listNodesMock = vi.hoisted(() => vi.fn());
const parsePreparedSystemRunPayloadMock = vi.hoisted(() => vi.fn());
const requiresExecApprovalMock = vi.hoisted(() => vi.fn(() => true));
const resolveExecHostApprovalContextMock = vi.hoisted(() =>
  vi.fn(() => ({
    approvals: { allowlist: [], file: { version: 1, agents: {} } },
    hostSecurity: "full",
    hostAsk: "off",
    askFallback: "deny",
  })),
);
const createAndRegisterDefaultExecApprovalRequestMock = vi.hoisted(() => vi.fn());
const resolveApprovalDecisionOrUndefinedMock = vi.hoisted(() =>
  vi.fn(
    async (_params?: { onFailure: () => void }): Promise<string | null | undefined> => "allow-once",
  ),
);
const createExecApprovalDecisionStateMock = vi.hoisted(() =>
  vi.fn(
    (): {
      baseDecision: { timedOut: boolean };
      approvedByAsk: boolean;
      deniedReason: string | null;
    } => ({
      baseDecision: { timedOut: false },
      approvedByAsk: false,
      deniedReason: null,
    }),
  ),
);
const buildExecApprovalPendingToolResultMock = vi.hoisted(() => vi.fn());
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
const registerExecApprovalRequestForHostOrThrowMock = vi.hoisted(() =>
  vi.fn(async () => undefined),
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
  evaluateShellAllowlist: vi.fn(() => ({
    allowlistMatches: [],
    analysisOk: true,
    allowlistSatisfied: false,
    segments: [{ resolution: null, argv: ["bun", "./script.ts"] }],
    segmentAllowlistEntries: [],
  })),
  hasDurableExecApproval: vi.fn(() => false),
  requiresExecApproval: requiresExecApprovalMock,
  resolveExecApprovalAllowedDecisions: vi.fn(() => ["allow-once", "allow-always", "deny"]),
  resolveExecApprovalsFromFile: vi.fn(() => ({
    allowlist: [],
    file: { version: 1, agents: {} },
  })),
}));

vi.mock("../infra/exec-inline-eval.js", () => ({
  describeInterpreterInlineEval: vi.fn(() => "inline-eval"),
  detectInterpreterInlineEvalArgv: detectInterpreterInlineEvalArgvMock,
}));

vi.mock("../infra/node-shell.js", () => ({
  buildNodeShellCommand: vi.fn(() => ["bash", "-lc", "bun ./script.ts"]),
}));

vi.mock("../infra/system-run-approval-context.js", () => ({
  parsePreparedSystemRunPayload: parsePreparedSystemRunPayloadMock,
}));

vi.mock("./bash-tools.exec-approval-request.js", () => ({
  buildExecApprovalRequesterContext: vi.fn(() => ({})),
  buildExecApprovalTurnSourceContext: vi.fn(() => ({})),
  registerExecApprovalRequestForHostOrThrow: registerExecApprovalRequestForHostOrThrowMock,
}));

vi.mock("./bash-tools.exec-host-shared.js", () => ({
  resolveExecHostApprovalContext: resolveExecHostApprovalContextMock,
  buildDefaultExecApprovalRequestArgs: vi.fn(() => ({})),
  createAndRegisterDefaultExecApprovalRequest: createAndRegisterDefaultExecApprovalRequestMock,
  shouldResolveExecApprovalUnavailableInline: vi.fn(() => false),
  buildExecApprovalFollowupTarget: vi.fn(() => ({ approvalId: "approval-1" })),
  resolveApprovalDecisionOrUndefined: resolveApprovalDecisionOrUndefinedMock,
  createExecApprovalDecisionState: createExecApprovalDecisionStateMock,
  enforceStrictInlineEvalApprovalBoundary: enforceStrictInlineEvalApprovalBoundaryMock,
  sendExecApprovalFollowupResult: sendExecApprovalFollowupResultMock,
  buildExecApprovalPendingToolResult: buildExecApprovalPendingToolResultMock,
  buildHeadlessExecApprovalDeniedMessage: vi.fn(() => "denied"),
}));

vi.mock("./bash-tools.exec-runtime.js", () => ({
  DEFAULT_NOTIFY_TAIL_CHARS: 1000,
  createApprovalSlug: vi.fn(() => "slug"),
  normalizeNotifyOutput: vi.fn((value: string) => value),
}));

vi.mock("./tools/gateway.js", () => ({
  callGatewayTool: callGatewayToolMock,
}));

vi.mock("./tools/nodes-utils.js", () => ({
  listNodes: listNodesMock,
  resolveNodeIdFromList: vi.fn(() => "node-1"),
}));

vi.mock("../logger.js", () => ({
  logInfo: vi.fn(),
}));

let executeNodeHostCommand: typeof import("./bash-tools.exec-host-node.js").executeNodeHostCommand;

type MockNodeInvokeParams = {
  command?: string;
};

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

describe("executeNodeHostCommand", () => {
  beforeAll(async () => {
    ({ executeNodeHostCommand } = await import("./bash-tools.exec-host-node.js"));
  });

  beforeEach(() => {
    callGatewayToolMock.mockReset();
    callGatewayToolMock.mockImplementation(
      async (method: string, _options: unknown, params: MockNodeInvokeParams | undefined) => {
        if (method !== "node.invoke") {
          throw new Error(`unexpected gateway method: ${method}`);
        }
        if (params?.command === "system.run.prepare") {
          return { payload: { plan: preparedPlan } };
        }
        if (params?.command === "system.run") {
          return {
            payload: {
              success: true,
              stdout: "ok",
              stderr: "",
              exitCode: 0,
              timedOut: false,
            },
          };
        }
        throw new Error(`unexpected node invoke command: ${String(params?.command)}`);
      },
    );
    listNodesMock.mockReset();
    listNodesMock.mockResolvedValue([
      { nodeId: "node-1", commands: ["system.run"], platform: process.platform },
    ]);
    parsePreparedSystemRunPayloadMock.mockReset();
    parsePreparedSystemRunPayloadMock.mockReturnValue({ plan: preparedPlan });
    requiresExecApprovalMock.mockReset();
    requiresExecApprovalMock.mockReturnValue(true);
    resolveExecHostApprovalContextMock.mockReset();
    resolveExecHostApprovalContextMock.mockReturnValue({
      approvals: { allowlist: [], file: { version: 1, agents: {} } },
      hostSecurity: "full",
      hostAsk: "off",
      askFallback: "deny",
    });
    createAndRegisterDefaultExecApprovalRequestMock.mockReset();
    createAndRegisterDefaultExecApprovalRequestMock.mockImplementation(async (args?: unknown) => {
      const register =
        args && typeof args === "object" && "register" in args
          ? (args as { register?: (approvalId: string) => Promise<void> }).register
          : undefined;
      await register?.("approval-1");
      return {
        approvalId: "approval-1",
        approvalSlug: "slug-1",
        warningText: "",
        expiresAtMs: Date.now() + 60_000,
        preResolvedDecision: null,
        initiatingSurface: "origin",
        sentApproverDms: false,
        unavailableReason: null,
      };
    });
    resolveApprovalDecisionOrUndefinedMock.mockReset();
    resolveApprovalDecisionOrUndefinedMock.mockResolvedValue("allow-once");
    createExecApprovalDecisionStateMock.mockReset();
    createExecApprovalDecisionStateMock.mockReturnValue({
      baseDecision: { timedOut: false },
      approvedByAsk: false,
      deniedReason: null,
    });
    buildExecApprovalPendingToolResultMock.mockReset();
    buildExecApprovalPendingToolResultMock.mockReturnValue({
      content: [],
      details: { status: "approval-pending" },
    });
    sendExecApprovalFollowupResultMock.mockReset();
    enforceStrictInlineEvalApprovalBoundaryMock.mockReset();
    enforceStrictInlineEvalApprovalBoundaryMock.mockImplementation(
      (value: { approvedByAsk: boolean; deniedReason: string | null }) => value,
    );
    detectInterpreterInlineEvalArgvMock.mockReset();
    detectInterpreterInlineEvalArgvMock.mockReturnValue(null);
    registerExecApprovalRequestForHostOrThrowMock.mockReset();
  });

  it("forwards prepared systemRunPlan on async node invoke after approval", async () => {
    const result = await executeNodeHostCommand({
      command: "bun ./script.ts",
      workdir: "/tmp/work",
      env: {},
      security: "full",
      ask: "off",
      defaultTimeoutSec: 30,
      approvalRunningNoticeMs: 0,
      warnings: [],
      agentId: "requested-agent",
      sessionKey: "requested-session",
    });

    expect(result.details?.status).toBe("approval-pending");
    expect(registerExecApprovalRequestForHostOrThrowMock).toHaveBeenCalledWith(
      expect.objectContaining({
        systemRunPlan: preparedPlan,
      }),
    );

    await vi.waitFor(() => {
      expect(callGatewayToolMock).toHaveBeenCalledTimes(2);
    });

    expect(callGatewayToolMock).toHaveBeenNthCalledWith(
      2,
      "node.invoke",
      expect.anything(),
      expect.objectContaining({
        command: "system.run",
        params: expect.objectContaining({
          approved: true,
          approvalDecision: "allow-once",
          systemRunPlan: preparedPlan,
        }),
      }),
    );
  });

  it("caps an overflowed invoke timeout instead of letting it collapse to a tiny default", async () => {
    await executeNodeHostCommand({
      command: "bun ./script.ts",
      workdir: "/tmp/work",
      env: {},
      security: "full",
      ask: "off",
      timeoutSec: Number.MAX_VALUE,
      defaultTimeoutSec: 30,
      approvalRunningNoticeMs: 0,
      warnings: [],
      agentId: "requested-agent",
      sessionKey: "requested-session",
    });

    await vi.waitFor(() => {
      expect(callGatewayToolMock).toHaveBeenCalledTimes(2);
    });

    // 2_147_483_647 ms is the longest safe Node timer delay. Without the cap, timeoutSec *
    // 1000 + grace overflows to Infinity and the gateway call would silently fall back to a
    // tiny default timeout instead of honoring the (extreme but requested) long timeout.
    expect(callGatewayToolMock).toHaveBeenNthCalledWith(
      2,
      "node.invoke",
      { timeoutMs: 2_147_483_647 },
      expect.objectContaining({ command: "system.run" }),
    );
  });

  it("does not cap an ordinary, well within bounds invoke timeout (reverse case)", async () => {
    await executeNodeHostCommand({
      command: "bun ./script.ts",
      workdir: "/tmp/work",
      env: {},
      security: "full",
      ask: "off",
      timeoutSec: 30,
      defaultTimeoutSec: 30,
      approvalRunningNoticeMs: 0,
      warnings: [],
      agentId: "requested-agent",
      sessionKey: "requested-session",
    });

    await vi.waitFor(() => {
      expect(callGatewayToolMock).toHaveBeenCalledTimes(2);
    });

    // 30s * 1000 + 5_000 grace = 35_000, well below any cap: the ordinary path is unaffected.
    expect(callGatewayToolMock).toHaveBeenNthCalledWith(
      2,
      "node.invoke",
      { timeoutMs: 35_000 },
      expect.objectContaining({ command: "system.run" }),
    );
  });

  it("denies timed-out inline-eval requests instead of invoking the node", async () => {
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
    resolveExecHostApprovalContextMock.mockReturnValue({
      approvals: { allowlist: [], file: { version: 1, agents: {} } },
      hostSecurity: "full",
      hostAsk: "off",
      askFallback: "full",
    });

    const result = await executeNodeHostCommand({
      command: "python3 -c 'print(1)'",
      workdir: "/tmp/work",
      env: {},
      security: "full",
      ask: "off",
      strictInlineEval: true,
      defaultTimeoutSec: 30,
      approvalRunningNoticeMs: 0,
      warnings: [],
      agentId: "requested-agent",
      sessionKey: "requested-session",
    });

    expect(result.details?.status).toBe("approval-pending");
    await vi.waitFor(() => {
      expect(sendExecApprovalFollowupResultMock).toHaveBeenCalledWith(
        { approvalId: "approval-1" },
        "Exec denied (node=node-1 id=approval-1, approval-timeout): python3 -c 'print(1)'",
      );
    });
    expect(callGatewayToolMock).toHaveBeenCalledTimes(1);
  });

  it("does not send a false approval-request-failed denial once invoke dispatch has started", async () => {
    const unhandledRejections = captureProcessUnhandledRejections();

    try {
      // Invocation itself succeeds (callGatewayToolMock resolves normally per beforeEach),
      // but delivering both the "finished" summary and the invoke-failed fallback fails.
      // Once dispatch has started, the outer race guard must not additionally claim the
      // request itself failed -- that would misreport a real (successful) execution as an
      // approval failure, i.e. it would lose the real outcome to the wrong side of the race.
      sendExecApprovalFollowupResultMock.mockRejectedValue(
        new Error("notify delivery unavailable"),
      );

      const result = await executeNodeHostCommand({
        command: "bun ./script.ts",
        workdir: "/tmp/work",
        env: {},
        security: "full",
        ask: "off",
        defaultTimeoutSec: 30,
        approvalRunningNoticeMs: 0,
        warnings: [],
        agentId: "requested-agent",
        sessionKey: "requested-session",
      });

      expect(result.details?.status).toBe("approval-pending");
      await vi.waitFor(() => {
        expect(callGatewayToolMock).toHaveBeenCalledTimes(2);
      });
      await vi.waitFor(() => {
        expect(sendExecApprovalFollowupResultMock).toHaveBeenCalledTimes(2);
      });
      await setImmediate();

      expect(unhandledRejections.reasons).toEqual([]);
      // Both delivery attempts were for the real outcome (finished, then invoke-failed
      // fallback); a third "approval-request-failed" call would mean the race guard let
      // the wrong-side message through after dispatch already started.
      expect(sendExecApprovalFollowupResultMock).toHaveBeenCalledTimes(2);
      expect(sendExecApprovalFollowupResultMock.mock.calls.map((call) => call[1])).not.toContain(
        expect.stringContaining("approval-request-failed"),
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

      const result = await executeNodeHostCommand({
        command: "bun ./script.ts",
        workdir: "/tmp/work",
        env: {},
        security: "full",
        ask: "off",
        defaultTimeoutSec: 30,
        approvalRunningNoticeMs: 0,
        warnings: [],
        agentId: "requested-agent",
        sessionKey: "requested-session",
      });

      expect(result.details?.status).toBe("approval-pending");
      await vi.waitFor(() => {
        expect(sendExecApprovalFollowupResultMock).toHaveBeenCalledTimes(1);
      });
      await setImmediate();

      expect(unhandledRejections.reasons).toEqual([]);
      expect(sendExecApprovalFollowupResultMock).toHaveBeenCalledWith(
        { approvalId: "approval-1" },
        "Exec denied (node=node-1 id=approval-1, approval-request-failed): bun ./script.ts",
      );
      // Dispatch never started (approval resolution itself failed), so system.run must
      // never have been invoked.
      expect(
        callGatewayToolMock.mock.calls.some(
          ([method, , params]) =>
            method === "node.invoke" &&
            (params as MockNodeInvokeParams | undefined)?.command === "system.run",
        ),
      ).toBe(false);
    } finally {
      unhandledRejections.restore();
    }
  });
});
