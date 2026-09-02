import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  clearFastTestEnv,
  dispatchCronDeliveryMock,
  isCliProviderMock,
  isHeartbeatOnlyResponseMock,
  loadRunCronIsolatedAgentTurn,
  mockRunCronFallbackPassthrough,
  resetRunCronIsolatedAgentTurnHarness,
  resolveCronDeliveryPlanMock,
  resolveDeliveryTargetMock,
  restoreFastTestEnv,
  runCliAgentMock,
  runEmbeddedPiAgentMock,
  runWithModelFallbackMock,
} from "./run.test-harness.js";

const runCronIsolatedAgentTurn = await loadRunCronIsolatedAgentTurn();

function makeParams() {
  return {
    cfg: {},
    deps: {} as never,
    job: {
      id: "message-tool-policy",
      name: "Message Tool Policy",
      schedule: { kind: "every", everyMs: 60_000 },
      sessionTarget: "isolated",
      payload: { kind: "agentTurn", message: "send a message" },
      delivery: { mode: "none" },
    } as never,
    message: "send a message",
    sessionKey: "cron:message-tool-policy",
  };
}

describe("runCronIsolatedAgentTurn message tool policy", () => {
  let previousFastTestEnv: string | undefined;

  async function expectMessageToolDisabledForPlan(plan: {
    requested: boolean;
    mode: "none" | "announce";
    channel?: string;
    to?: string;
  }) {
    mockRunCronFallbackPassthrough();
    resolveCronDeliveryPlanMock.mockReturnValue(plan);
    await runCronIsolatedAgentTurn(makeParams());
    expect(runEmbeddedPiAgentMock).toHaveBeenCalledTimes(1);
    expect(runEmbeddedPiAgentMock.mock.calls[0]?.[0]?.disableMessageTool).toBe(true);
  }

  beforeEach(() => {
    previousFastTestEnv = clearFastTestEnv();
    resetRunCronIsolatedAgentTurnHarness();
    resolveDeliveryTargetMock.mockResolvedValue({
      ok: true,
      channel: "telegram",
      to: "123",
      accountId: undefined,
      error: undefined,
    });
  });

  afterEach(() => {
    restoreFastTestEnv(previousFastTestEnv);
  });

  it('disables the message tool when delivery.mode is "none"', async () => {
    await expectMessageToolDisabledForPlan({
      requested: false,
      mode: "none",
    });
  });

  it("disables the message tool when cron delivery is active", async () => {
    await expectMessageToolDisabledForPlan({
      requested: true,
      mode: "announce",
      channel: "telegram",
      to: "123",
    });
  });

  it("keeps the message tool enabled for shared callers when delivery is not requested", async () => {
    mockRunCronFallbackPassthrough();
    resolveCronDeliveryPlanMock.mockReturnValue({
      requested: false,
      mode: "none",
    });

    await runCronIsolatedAgentTurn({
      ...makeParams(),
      deliveryContract: "shared",
    });

    expect(runEmbeddedPiAgentMock).toHaveBeenCalledTimes(1);
    expect(runEmbeddedPiAgentMock.mock.calls[0]?.[0]?.disableMessageTool).toBe(false);
  });

  it("skips cron delivery when output is heartbeat-only", async () => {
    mockRunCronFallbackPassthrough();
    resolveCronDeliveryPlanMock.mockReturnValue({
      requested: true,
      mode: "announce",
      channel: "telegram",
      to: "123",
    });
    isHeartbeatOnlyResponseMock.mockReturnValue(true);

    await runCronIsolatedAgentTurn({
      ...makeParams(),
      job: {
        id: "message-tool-policy",
        name: "Message Tool Policy",
        schedule: { kind: "every", everyMs: 60_000 },
        sessionTarget: "isolated",
        payload: { kind: "agentTurn", message: "send a message" },
        delivery: { mode: "announce", channel: "telegram", to: "123" },
      } as never,
    });

    expect(dispatchCronDeliveryMock).toHaveBeenCalledTimes(1);
    expect(dispatchCronDeliveryMock.mock.calls[0]?.[0]).toEqual(
      expect.objectContaining({
        deliveryRequested: true,
        skipHeartbeatDelivery: true,
      }),
    );
  });

  it("skips cron delivery when a shared caller already sent to the same target", async () => {
    mockRunCronFallbackPassthrough();
    const params = makeParams();
    const job = {
      id: "message-tool-policy",
      name: "Message Tool Policy",
      schedule: { kind: "every", everyMs: 60_000 },
      sessionTarget: "isolated",
      payload: { kind: "agentTurn", message: "send a message" },
      delivery: { mode: "announce", channel: "telegram", to: "123" },
    } as const;
    resolveCronDeliveryPlanMock.mockReturnValue({
      requested: true,
      mode: "announce",
      channel: "telegram",
      to: "123",
    });
    runEmbeddedPiAgentMock.mockResolvedValue({
      payloads: [{ text: "sent" }],
      didSendViaMessagingTool: true,
      messagingToolSentTargets: [{ tool: "message", provider: "telegram", to: "123" }],
      meta: { agentMeta: { usage: { input: 10, output: 20 } } },
    });

    await runCronIsolatedAgentTurn({
      ...params,
      deliveryContract: "shared",
      job: job as never,
    });

    expect(dispatchCronDeliveryMock).toHaveBeenCalledTimes(1);
    expect(dispatchCronDeliveryMock.mock.calls[0]?.[0]).toEqual(
      expect.objectContaining({
        deliveryRequested: true,
        skipMessagingToolDelivery: true,
      }),
    );
  });
  it("binds the resolved delivery account to CLI-backed announce runs (#126995)", async () => {
    // The CLI runner forwards agentAccountId into the loopback MCP env, which
    // is what scopes account-implicit message sends to the selected account.
    isCliProviderMock.mockReturnValue(true);
    runCliAgentMock.mockResolvedValue({
      payloads: [{ text: "done" }],
      meta: { agentMeta: { usage: { input: 5, output: 10 } } },
    });
    runWithModelFallbackMock.mockImplementationOnce(
      async (fallbackParams: { run: (provider: string, model: string) => Promise<unknown> }) => {
        const result = await fallbackParams.run("claude-cli", "claude-opus-4-6");
        return { result, provider: "claude-cli", model: "claude-opus-4-6", attempts: [] };
      },
    );
    resolveCronDeliveryPlanMock.mockReturnValue({
      requested: true,
      mode: "announce",
      channel: "telegram",
      to: "123",
      accountId: "bot-a",
    });
    resolveDeliveryTargetMock.mockResolvedValue({
      ok: true,
      channel: "telegram",
      to: "123",
      accountId: "bot-a",
      error: undefined,
    });

    await runCronIsolatedAgentTurn({
      ...makeParams(),
      job: {
        id: "message-tool-policy",
        name: "Message Tool Policy",
        schedule: { kind: "every", everyMs: 60_000 },
        sessionTarget: "isolated",
        payload: { kind: "agentTurn", message: "send a message" },
        delivery: { mode: "announce", channel: "telegram", to: "123", accountId: "bot-a" },
      } as never,
    });

    expect(runCliAgentMock).toHaveBeenCalledOnce();
    expect(runCliAgentMock.mock.calls[0][0]).toHaveProperty("agentAccountId", "bot-a");
    expect(runCliAgentMock.mock.calls[0][0]).toHaveProperty("messageProvider", "telegram");
  });
});
