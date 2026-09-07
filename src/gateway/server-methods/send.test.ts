import { beforeEach, describe, expect, it, vi } from "vitest";
import { setActivePluginRegistry } from "../../plugins/runtime.js";
import { createTestRegistry } from "../../test-utils/channel-plugins.js";
import type { GatewayRequestContext } from "./types.js";

type ResolveOutboundTarget = typeof import("../../infra/outbound/targets.js").resolveOutboundTarget;

const mocks = vi.hoisted(() => ({
  deliverOutboundPayloads: vi.fn(),
  appendAssistantMessageToSessionTranscript: vi.fn(async () => ({ ok: true, sessionFile: "x" })),
  recordSessionMetaFromInbound: vi.fn(async () => ({ ok: true })),
  resolveOutboundTarget: vi.fn<ResolveOutboundTarget>(() => ({ ok: true, to: "resolved" })),
  resolveOutboundSessionRoute: vi.fn(),
  ensureOutboundSessionEntry: vi.fn(async () => undefined),
  resolveMessageChannelSelection: vi.fn(),
  sendPoll: vi.fn<
    () => Promise<{
      messageId: string;
      toJid?: string;
      channelId?: string;
      conversationId?: string;
      pollId?: string;
    }>
  >(async () => ({ messageId: "poll-1" })),
  getChannelPlugin: vi.fn(),
  loadOpenClawPlugins: vi.fn(),
  applyPluginAutoEnable: vi.fn(),
}));

vi.mock("../../config/config.js", async () => {
  const actual =
    await vi.importActual<typeof import("../../config/config.js")>("../../config/config.js");
  return {
    ...actual,
    loadConfig: () => ({}),
  };
});

vi.mock("../../channels/plugins/index.js", () => ({
  getChannelPlugin: mocks.getChannelPlugin,
  normalizeChannelId: (value: string) => (value === "webchat" ? null : value),
}));

const TEST_AGENT_WORKSPACE = "/tmp/openclaw-test-workspace";
let sendHandlers: typeof import("./send.js").sendHandlers;

function resolveAgentIdFromSessionKeyForTests(params: { sessionKey?: string }): string {
  if (typeof params.sessionKey === "string") {
    const match = params.sessionKey.match(/^agent:([^:]+)/i);
    if (match?.[1]) {
      return match[1];
    }
  }
  return "main";
}

vi.mock("../../agents/agent-scope.js", () => ({
  resolveSessionAgentId: ({
    sessionKey,
  }: {
    sessionKey?: string;
    config?: unknown;
    agentId?: string;
  }) => resolveAgentIdFromSessionKeyForTests({ sessionKey }),
  resolveDefaultAgentId: () => "main",
  resolveAgentWorkspaceDir: () => TEST_AGENT_WORKSPACE,
}));

vi.mock("../../config/plugin-auto-enable.js", () => ({
  applyPluginAutoEnable: ({ config, env }: { config: unknown; env?: unknown }) =>
    mocks.applyPluginAutoEnable({ config, env }),
}));

vi.mock("../../plugins/loader.js", () => ({
  loadOpenClawPlugins: mocks.loadOpenClawPlugins,
}));

vi.mock("../../infra/outbound/targets.js", () => ({
  resolveOutboundTarget: mocks.resolveOutboundTarget,
}));

vi.mock("../../infra/outbound/outbound-session.js", () => ({
  resolveOutboundSessionRoute: mocks.resolveOutboundSessionRoute,
  ensureOutboundSessionEntry: mocks.ensureOutboundSessionEntry,
}));

vi.mock("../../infra/outbound/channel-selection.js", () => ({
  resolveMessageChannelSelection: mocks.resolveMessageChannelSelection,
}));

vi.mock("../../infra/outbound/deliver.js", () => ({
  deliverOutboundPayloads: mocks.deliverOutboundPayloads,
}));

vi.mock("../../config/sessions.js", async () => {
  const actual = await vi.importActual<typeof import("../../config/sessions.js")>(
    "../../config/sessions.js",
  );
  return {
    ...actual,
    appendAssistantMessageToSessionTranscript: mocks.appendAssistantMessageToSessionTranscript,
    recordSessionMetaFromInbound: mocks.recordSessionMetaFromInbound,
  };
});

async function loadFreshSendHandlersForTest() {
  vi.resetModules();
  ({ sendHandlers } = await import("./send.js"));
}

const makeContext = (): GatewayRequestContext =>
  ({
    dedupe: new Map(),
  }) as unknown as GatewayRequestContext;

async function runSend(params: Record<string, unknown>) {
  return await runSendWithClient(params);
}

async function runSendWithClient(
  params: Record<string, unknown>,
  client?: { connect?: { scopes?: string[] } } | null,
) {
  const respond = vi.fn();
  await sendHandlers.send({
    params: params as never,
    respond,
    context: makeContext(),
    req: { type: "req", id: "1", method: "send" },
    client: (client ?? null) as never,
    isWebchatConnect: () => false,
  });
  return { respond };
}

// Dedupe lives on the GatewayRequestContext, so exercising it requires callers
// that share one context. The default helpers above deliberately do not.
async function runSendOn(context: GatewayRequestContext, params: Record<string, unknown>) {
  const respond = vi.fn();
  await sendHandlers.send({
    params: params as never,
    respond,
    context,
    req: { type: "req", id: "1", method: "send" },
    client: null as never,
    isWebchatConnect: () => false,
  });
  return { respond };
}

async function runPollOn(context: GatewayRequestContext, params: Record<string, unknown>) {
  const respond = vi.fn();
  await sendHandlers.poll({
    params: params as never,
    respond,
    context,
    req: { type: "req", id: "1", method: "poll" },
    client: null as never,
    isWebchatConnect: () => false,
  });
  return { respond };
}

async function runPoll(params: Record<string, unknown>) {
  return await runPollWithClient(params);
}

async function runPollWithClient(
  params: Record<string, unknown>,
  client?: { connect?: { scopes?: string[] } } | null,
) {
  const respond = vi.fn();
  await sendHandlers.poll({
    params: params as never,
    respond,
    context: makeContext(),
    req: { type: "req", id: "1", method: "poll" },
    client: (client ?? null) as never,
    isWebchatConnect: () => false,
  });
  return { respond };
}

function expectDeliverySessionMirror(params: { agentId: string; sessionKey: string }) {
  expect(mocks.deliverOutboundPayloads).toHaveBeenCalledWith(
    expect.objectContaining({
      session: expect.objectContaining({
        agentId: params.agentId,
        key: params.sessionKey,
      }),
      mirror: expect.objectContaining({
        sessionKey: params.sessionKey,
        agentId: params.agentId,
      }),
    }),
  );
}

function mockDeliverySuccess(messageId: string) {
  mocks.deliverOutboundPayloads.mockResolvedValue([{ messageId, channel: "slack" }]);
}

describe("gateway send mirroring", () => {
  let registrySeq = 0;

  beforeEach(async () => {
    vi.clearAllMocks();
    registrySeq += 1;
    setActivePluginRegistry(createTestRegistry([]), `send-test-${registrySeq}`);
    mocks.applyPluginAutoEnable.mockImplementation(({ config }) => ({
      config,
      changes: [],
      autoEnabledReasons: {},
    }));
    mocks.resolveOutboundTarget.mockReturnValue({ ok: true, to: "resolved" });
    mocks.resolveOutboundSessionRoute.mockImplementation(
      async ({ agentId, channel }: { agentId?: string; channel?: string }) => ({
        sessionKey:
          channel === "slack"
            ? `agent:${agentId ?? "main"}:slack:channel:resolved`
            : `agent:${agentId ?? "main"}:${channel ?? "main"}:resolved`,
      }),
    );
    mocks.resolveMessageChannelSelection.mockResolvedValue({
      channel: "slack",
      configured: ["slack"],
    });
    mocks.sendPoll.mockResolvedValue({ messageId: "poll-1" });
    // `config.listAccountIds` is part of the ChannelPlugin contract and is read
    // when canonicalizing the dedupe route scope, so the fixture must supply it.
    mocks.getChannelPlugin.mockReturnValue({
      outbound: { sendPoll: mocks.sendPoll },
      config: { listAccountIds: () => ["default"] },
    });
    await loadFreshSendHandlersForTest();
  });

  it("accepts media-only sends without message", async () => {
    mockDeliverySuccess("m-media");

    const { respond } = await runSend({
      to: "channel:C1",
      mediaUrl: "https://example.com/a.png",
      channel: "slack",
      idempotencyKey: "idem-media-only",
    });

    expect(mocks.deliverOutboundPayloads).toHaveBeenCalledWith(
      expect.objectContaining({
        payloads: [{ text: "", mediaUrl: "https://example.com/a.png", mediaUrls: undefined }],
      }),
    );
    expect(respond).toHaveBeenCalledWith(
      true,
      expect.objectContaining({ messageId: "m-media" }),
      undefined,
      expect.objectContaining({ channel: "slack" }),
    );
  });

  it("forwards gateway client scopes into outbound delivery", async () => {
    mockDeliverySuccess("m-scope");

    await runSendWithClient(
      {
        to: "channel:C1",
        message: "hi",
        channel: "slack",
        idempotencyKey: "idem-scope",
      },
      { connect: { scopes: ["operator.write"] } },
    );

    expect(mocks.deliverOutboundPayloads).toHaveBeenCalledWith(
      expect.objectContaining({
        channel: "slack",
        gatewayClientScopes: ["operator.write"],
      }),
    );
  });

  it("forwards an empty gateway scope array into outbound delivery", async () => {
    mockDeliverySuccess("m-empty-scope");

    await runSendWithClient(
      {
        to: "channel:C1",
        message: "hi",
        channel: "slack",
        idempotencyKey: "idem-empty-scope",
      },
      { connect: { scopes: [] } },
    );

    expect(mocks.deliverOutboundPayloads).toHaveBeenCalledWith(
      expect.objectContaining({
        channel: "slack",
        gatewayClientScopes: [],
      }),
    );
  });

  it("rejects empty sends when neither text nor media is present", async () => {
    const { respond } = await runSend({
      to: "channel:C1",
      message: "   ",
      channel: "slack",
      idempotencyKey: "idem-empty",
    });

    expect(mocks.deliverOutboundPayloads).not.toHaveBeenCalled();
    expect(respond).toHaveBeenCalledWith(
      false,
      undefined,
      expect.objectContaining({
        message: expect.stringContaining("text or media is required"),
      }),
    );
  });

  it("returns actionable guidance when channel is internal webchat", async () => {
    const { respond } = await runSend({
      to: "x",
      message: "hi",
      channel: "webchat",
      idempotencyKey: "idem-webchat",
    });

    expect(mocks.deliverOutboundPayloads).not.toHaveBeenCalled();
    expect(respond).toHaveBeenCalledWith(
      false,
      undefined,
      expect.objectContaining({
        message: expect.stringContaining("unsupported channel: webchat"),
      }),
    );
    expect(respond).toHaveBeenCalledWith(
      false,
      undefined,
      expect.objectContaining({
        message: expect.stringContaining("Use `chat.send`"),
      }),
    );
  });

  it("auto-picks the single configured channel for send", async () => {
    mockDeliverySuccess("m-single-send");

    const { respond } = await runSend({
      to: "x",
      message: "hi",
      idempotencyKey: "idem-missing-channel",
    });

    expect(mocks.resolveMessageChannelSelection).toHaveBeenCalled();
    expect(mocks.deliverOutboundPayloads).toHaveBeenCalled();
    expect(respond).toHaveBeenCalledWith(
      true,
      expect.objectContaining({ messageId: "m-single-send" }),
      undefined,
      expect.objectContaining({ channel: "slack" }),
    );
  });

  it("auto-picks the single configured channel from the auto-enabled config snapshot for send", async () => {
    const autoEnabledConfig = { channels: { slack: {} }, plugins: { allow: ["slack"] } };
    mocks.applyPluginAutoEnable.mockReturnValue({
      config: autoEnabledConfig,
      changes: [],
      autoEnabledReasons: {},
    });
    mockDeliverySuccess("m-single-send-auto");

    const { respond } = await runSend({
      to: "x",
      message: "hi",
      idempotencyKey: "idem-missing-channel-auto-enabled",
    });

    expect(mocks.applyPluginAutoEnable).toHaveBeenCalledWith({
      config: {},
      env: process.env,
    });
    expect(mocks.resolveMessageChannelSelection).toHaveBeenCalledWith({
      cfg: autoEnabledConfig,
    });
    expect(respond).toHaveBeenCalledWith(
      true,
      expect.objectContaining({ messageId: "m-single-send-auto" }),
      undefined,
      expect.objectContaining({ channel: "slack" }),
    );
  });

  it("returns invalid request when send channel selection is ambiguous", async () => {
    mocks.resolveMessageChannelSelection.mockRejectedValueOnce(
      new Error("Channel is required when multiple channels are configured: telegram, slack"),
    );

    const { respond } = await runSend({
      to: "x",
      message: "hi",
      idempotencyKey: "idem-missing-channel-ambiguous",
    });

    expect(mocks.deliverOutboundPayloads).not.toHaveBeenCalled();
    expect(respond).toHaveBeenCalledWith(
      false,
      undefined,
      expect.objectContaining({
        message: expect.stringContaining("Channel is required"),
      }),
    );
  });

  it("forwards gateway client scopes into outbound poll delivery", async () => {
    await runPollWithClient(
      {
        to: "channel:C1",
        question: "Q?",
        options: ["A", "B"],
        channel: "slack",
        idempotencyKey: "idem-poll-scope",
      },
      { connect: { scopes: ["operator.admin"] } },
    );

    expect(mocks.sendPoll).toHaveBeenCalledWith(
      expect.objectContaining({
        cfg: expect.any(Object),
        to: "resolved",
        gatewayClientScopes: ["operator.admin"],
      }),
    );
  });

  it("forwards an empty gateway scope array into outbound poll delivery", async () => {
    await runPollWithClient(
      {
        to: "channel:C1",
        question: "Q?",
        options: ["A", "B"],
        channel: "slack",
        idempotencyKey: "idem-poll-empty-scope",
      },
      { connect: { scopes: [] } },
    );

    expect(mocks.sendPoll).toHaveBeenCalledWith(
      expect.objectContaining({
        cfg: expect.any(Object),
        to: "resolved",
        gatewayClientScopes: [],
      }),
    );
  });

  it("includes optional poll delivery identifiers in the gateway payload", async () => {
    mocks.sendPoll.mockResolvedValue({
      messageId: "poll-rich",
      channelId: "C123",
      conversationId: "conv-1",
      toJid: "jid-1",
      pollId: "poll-meta-1",
    });

    const { respond } = await runPoll({
      to: "channel:C1",
      question: "Q?",
      options: ["A", "B"],
      channel: "slack",
      idempotencyKey: "idem-poll-rich",
    });

    expect(respond).toHaveBeenCalledWith(
      true,
      expect.objectContaining({
        runId: "idem-poll-rich",
        messageId: "poll-rich",
        channel: "slack",
        channelId: "C123",
        conversationId: "conv-1",
        toJid: "jid-1",
        pollId: "poll-meta-1",
      }),
      undefined,
      expect.objectContaining({ channel: "slack" }),
    );
  });

  it("auto-picks the single configured channel for poll", async () => {
    const { respond } = await runPoll({
      to: "x",
      question: "Q?",
      options: ["A", "B"],
      idempotencyKey: "idem-poll-missing-channel",
    });

    expect(mocks.resolveMessageChannelSelection).toHaveBeenCalled();
    expect(respond).toHaveBeenCalledWith(true, expect.any(Object), undefined, {
      channel: "slack",
    });
  });

  it("returns invalid request when poll channel selection is ambiguous", async () => {
    mocks.resolveMessageChannelSelection.mockRejectedValueOnce(
      new Error("Channel is required when multiple channels are configured: telegram, slack"),
    );

    const { respond } = await runPoll({
      to: "x",
      question: "Q?",
      options: ["A", "B"],
      idempotencyKey: "idem-poll-missing-channel-ambiguous",
    });

    expect(respond).toHaveBeenCalledWith(
      false,
      undefined,
      expect.objectContaining({
        message: expect.stringContaining("Channel is required"),
      }),
    );
  });

  it("does not mirror when delivery returns no results", async () => {
    mocks.deliverOutboundPayloads.mockResolvedValue([]);

    await runSend({
      to: "channel:C1",
      message: "hi",
      channel: "slack",
      idempotencyKey: "idem-1",
      sessionKey: "agent:main:main",
    });

    expect(mocks.deliverOutboundPayloads).toHaveBeenCalledWith(
      expect.objectContaining({
        mirror: expect.objectContaining({
          sessionKey: "agent:main:main",
        }),
      }),
    );
  });

  it("mirrors media filenames when delivery succeeds", async () => {
    mockDeliverySuccess("m1");

    await runSend({
      to: "channel:C1",
      message: "caption",
      mediaUrl: "https://example.com/files/report.pdf?sig=1",
      channel: "slack",
      idempotencyKey: "idem-2",
      sessionKey: "agent:main:main",
    });

    expect(mocks.deliverOutboundPayloads).toHaveBeenCalledWith(
      expect.objectContaining({
        mirror: expect.objectContaining({
          sessionKey: "agent:main:main",
          text: "caption",
          mediaUrls: ["https://example.com/files/report.pdf?sig=1"],
          idempotencyKey: "idem-2",
        }),
      }),
    );
  });

  it("mirrors MEDIA tags as attachments", async () => {
    mockDeliverySuccess("m2");

    await runSend({
      to: "channel:C1",
      message: "Here\nMEDIA:https://example.com/image.png",
      channel: "slack",
      idempotencyKey: "idem-3",
      sessionKey: "agent:main:main",
    });

    expect(mocks.deliverOutboundPayloads).toHaveBeenCalledWith(
      expect.objectContaining({
        mirror: expect.objectContaining({
          sessionKey: "agent:main:main",
          text: "Here",
          mediaUrls: ["https://example.com/image.png"],
        }),
      }),
    );
  });

  it("lowercases provided session keys for mirroring", async () => {
    mockDeliverySuccess("m-lower");

    await runSend({
      to: "channel:C1",
      message: "hi",
      channel: "slack",
      idempotencyKey: "idem-lower",
      sessionKey: "agent:main:slack:channel:C123",
    });

    expect(mocks.deliverOutboundPayloads).toHaveBeenCalledWith(
      expect.objectContaining({
        mirror: expect.objectContaining({
          sessionKey: "agent:main:slack:channel:c123",
        }),
      }),
    );
  });

  it("derives a target session key when none is provided", async () => {
    mockDeliverySuccess("m3");

    await runSend({
      to: "channel:C1",
      message: "hello",
      channel: "slack",
      idempotencyKey: "idem-4",
    });

    expect(mocks.deliverOutboundPayloads).toHaveBeenCalledWith(
      expect.objectContaining({
        mirror: expect.objectContaining({
          sessionKey: "agent:main:slack:channel:resolved",
          agentId: "main",
        }),
      }),
    );
  });

  it("uses explicit agentId for delivery when sessionKey is not provided", async () => {
    mockDeliverySuccess("m-agent");

    await runSend({
      to: "channel:C1",
      message: "hello",
      channel: "slack",
      agentId: "work",
      idempotencyKey: "idem-agent-explicit",
    });

    expect(mocks.deliverOutboundPayloads).toHaveBeenCalledWith(
      expect.objectContaining({
        session: expect.objectContaining({
          agentId: "work",
          key: "agent:work:slack:channel:resolved",
        }),
        mirror: expect.objectContaining({
          sessionKey: "agent:work:slack:channel:resolved",
          agentId: "work",
        }),
      }),
    );
  });

  it("uses sessionKey agentId when explicit agentId is omitted", async () => {
    mockDeliverySuccess("m-session-agent");

    await runSend({
      to: "channel:C1",
      message: "hello",
      channel: "slack",
      sessionKey: "agent:work:slack:channel:c1",
      idempotencyKey: "idem-session-agent",
    });

    expectDeliverySessionMirror({
      agentId: "work",
      sessionKey: "agent:work:slack:channel:c1",
    });
  });

  it("still resolves outbound routing metadata when a sessionKey is provided", async () => {
    mockDeliverySuccess("m-matrix-session-route");
    mocks.resolveOutboundSessionRoute.mockResolvedValueOnce({
      sessionKey: "agent:main:matrix:channel:!dm:example.org",
      baseSessionKey: "agent:main:matrix:channel:!dm:example.org",
      peer: { kind: "channel", id: "!dm:example.org" },
      chatType: "direct",
      from: "matrix:@alice:example.org",
      to: "room:!dm:example.org",
    });

    await runSend({
      to: "@alice:example.org",
      message: "hello",
      channel: "matrix",
      sessionKey: "agent:main:matrix:channel:!dm:example.org",
      idempotencyKey: "idem-matrix-session-route",
    });

    expect(mocks.resolveOutboundSessionRoute).toHaveBeenCalledWith(
      expect.objectContaining({
        channel: "matrix",
        target: "resolved",
        currentSessionKey: "agent:main:matrix:channel:!dm:example.org",
      }),
    );
    expect(mocks.ensureOutboundSessionEntry).toHaveBeenCalledWith(
      expect.objectContaining({
        route: expect.objectContaining({
          sessionKey: "agent:main:matrix:channel:!dm:example.org",
          baseSessionKey: "agent:main:matrix:channel:!dm:example.org",
          to: "room:!dm:example.org",
        }),
      }),
    );
    expectDeliverySessionMirror({
      agentId: "main",
      sessionKey: "agent:main:matrix:channel:!dm:example.org",
    });
  });

  it("falls back to the provided sessionKey when outbound route lookup returns null", async () => {
    mockDeliverySuccess("m-session-fallback");
    mocks.resolveOutboundSessionRoute.mockResolvedValueOnce(null);

    await runSend({
      to: "channel:C1",
      message: "hello",
      channel: "slack",
      sessionKey: "agent:work:slack:channel:c1",
      idempotencyKey: "idem-session-fallback",
    });

    expect(mocks.ensureOutboundSessionEntry).not.toHaveBeenCalled();
    expect(mocks.deliverOutboundPayloads).toHaveBeenCalledWith(
      expect.objectContaining({
        session: expect.objectContaining({
          agentId: "work",
          key: "agent:work:slack:channel:c1",
        }),
        mirror: expect.objectContaining({
          sessionKey: "agent:work:slack:channel:c1",
          agentId: "work",
        }),
      }),
    );
  });

  it("prefers explicit agentId over sessionKey agent for delivery and mirror", async () => {
    mockDeliverySuccess("m-agent-precedence");

    await runSend({
      to: "channel:C1",
      message: "hello",
      channel: "slack",
      agentId: "work",
      sessionKey: "agent:main:slack:channel:c1",
      idempotencyKey: "idem-agent-precedence",
    });

    expect(mocks.deliverOutboundPayloads).toHaveBeenCalledWith(
      expect.objectContaining({
        session: expect.objectContaining({
          agentId: "work",
          key: "agent:main:slack:channel:c1",
        }),
        mirror: expect.objectContaining({
          sessionKey: "agent:main:slack:channel:c1",
          agentId: "work",
        }),
      }),
    );
  });

  it("ignores blank explicit agentId and falls back to sessionKey agent", async () => {
    mockDeliverySuccess("m-agent-blank");

    await runSend({
      to: "channel:C1",
      message: "hello",
      channel: "slack",
      agentId: "   ",
      sessionKey: "agent:work:slack:channel:c1",
      idempotencyKey: "idem-agent-blank",
    });

    expectDeliverySessionMirror({
      agentId: "work",
      sessionKey: "agent:work:slack:channel:c1",
    });
  });

  it("forwards threadId to outbound delivery when provided", async () => {
    mockDeliverySuccess("m-thread");

    await runSend({
      to: "channel:C1",
      message: "hi",
      channel: "slack",
      threadId: "1710000000.9999",
      idempotencyKey: "idem-thread",
    });

    expect(mocks.deliverOutboundPayloads).toHaveBeenCalledWith(
      expect.objectContaining({
        threadId: "1710000000.9999",
      }),
    );
  });

  it("returns invalid request when outbound target resolution fails", async () => {
    mocks.resolveOutboundTarget.mockReturnValue({
      ok: false,
      error: new Error("target not found"),
    });

    const { respond } = await runSend({
      to: "channel:C1",
      message: "hi",
      channel: "slack",
      idempotencyKey: "idem-target-fail",
    });

    expect(mocks.deliverOutboundPayloads).not.toHaveBeenCalled();
    expect(respond).toHaveBeenCalledWith(
      false,
      undefined,
      expect.objectContaining({
        message: expect.stringContaining("target not found"),
      }),
      expect.objectContaining({
        channel: "slack",
      }),
    );
  });

  it("recovers cold plugin resolution for threaded sends", async () => {
    mocks.resolveOutboundTarget.mockReturnValue({ ok: true, to: "123" });
    mocks.deliverOutboundPayloads.mockResolvedValue([
      { messageId: "m-threaded", channel: "slack" },
    ]);
    const outboundPlugin = {
      outbound: { sendPoll: mocks.sendPoll },
      config: { listAccountIds: () => ["default"] },
    };
    mocks.getChannelPlugin
      .mockReturnValueOnce(undefined)
      .mockReturnValueOnce(outboundPlugin)
      .mockReturnValue(outboundPlugin);

    const { respond } = await runSend({
      to: "123",
      message: "threaded completion",
      channel: "slack",
      threadId: "1710000000.9999",
      idempotencyKey: "idem-cold-thread",
    });

    expect(mocks.deliverOutboundPayloads).toHaveBeenCalledWith(
      expect.objectContaining({
        channel: "slack",
        to: "123",
        threadId: "1710000000.9999",
      }),
    );
    expect(respond).toHaveBeenCalledWith(
      true,
      expect.objectContaining({ messageId: "m-threaded" }),
      undefined,
      expect.objectContaining({ channel: "slack" }),
    );
  });

  describe("outbound request dedupe (#68341) and route canonicalization", () => {
    const sendParams = (overrides: Record<string, unknown> = {}) => ({
      to: "channel:C1",
      message: "hi",
      channel: "slack",
      idempotencyKey: "idem-shared",
      ...overrides,
    });

    const pollParams = (overrides: Record<string, unknown> = {}) => ({
      to: "channel:C1",
      question: "q?",
      options: ["a", "b"],
      channel: "slack",
      idempotencyKey: "idem-shared-poll",
      ...overrides,
    });

    it("collapses two concurrent identical sends into one delivery", async () => {
      const context = makeContext();
      let release: (() => void) | undefined;
      mocks.deliverOutboundPayloads.mockImplementation(async () => {
        await new Promise<void>((resolve) => {
          release = resolve;
        });
        return [{ messageId: "m-dedupe", channel: "slack" }];
      });

      const first = runSendOn(context, sendParams());
      // Let the first request finish preflight and register its inflight entry.
      await vi.waitFor(() => expect(release).toBeDefined());
      const second = runSendOn(context, sendParams());
      release?.();
      const [a, b] = await Promise.all([first, second]);

      expect(mocks.deliverOutboundPayloads).toHaveBeenCalledTimes(1);
      expect(a.respond).toHaveBeenCalledWith(true, expect.anything(), undefined, expect.anything());
      expect(b.respond).toHaveBeenCalledWith(
        true,
        expect.anything(),
        undefined,
        expect.objectContaining({ cached: true }),
      );
    });

    it("collapses two concurrent identical polls into one sendPoll", async () => {
      // Before this change poll had no inflight dedupe at all, so both requests
      // executed and the user received two polls.
      const context = makeContext();
      let release: (() => void) | undefined;
      mocks.sendPoll.mockImplementation(async () => {
        await new Promise<void>((resolve) => {
          release = resolve;
        });
        return { messageId: "poll-dedupe" };
      });

      const first = runPollOn(context, pollParams());
      await vi.waitFor(() => expect(release).toBeDefined());
      const second = runPollOn(context, pollParams());
      release?.();
      const [a, b] = await Promise.all([first, second]);

      expect(mocks.sendPoll).toHaveBeenCalledTimes(1);
      expect(a.respond).toHaveBeenCalledTimes(1);
      expect(b.respond).toHaveBeenCalledWith(
        true,
        expect.anything(),
        undefined,
        expect.objectContaining({ cached: true }),
      );
    });

    it("treats an omitted accountId and the explicit default account as one send", async () => {
      // Canonicalization: both requests resolve to the same effective account,
      // so reusing the idempotency key really is a retry of one operation.
      const context = makeContext();
      mockDeliverySuccess("m-canon");

      await runSendOn(context, sendParams());
      const { respond } = await runSendOn(context, sendParams({ accountId: "default" }));

      expect(mocks.deliverOutboundPayloads).toHaveBeenCalledTimes(1);
      expect(respond).toHaveBeenCalledWith(
        true,
        expect.anything(),
        undefined,
        expect.objectContaining({ cached: true }),
      );
    });

    // Reverse coverage. Each case is two requests that share an idempotency key
    // but are genuinely different operations. Collapsing any of them would
    // silently drop a message, which is worse than delivering a duplicate.
    it("still delivers the same idempotency key to a different channel", async () => {
      const context = makeContext();
      mockDeliverySuccess("m-two-channels");

      const a = await runSendOn(context, sendParams({ channel: "slack" }));
      const b = await runSendOn(context, sendParams({ channel: "telegram" }));

      expect(mocks.deliverOutboundPayloads).toHaveBeenCalledTimes(2);
      expect(a.respond).toHaveBeenCalledWith(
        true,
        expect.anything(),
        undefined,
        expect.objectContaining({ channel: "slack" }),
      );
      expect(b.respond).toHaveBeenCalledWith(
        true,
        expect.anything(),
        undefined,
        expect.objectContaining({ channel: "telegram" }),
      );
    });

    it("still delivers the same idempotency key to a different account", async () => {
      const context = makeContext();
      mockDeliverySuccess("m-two-accounts");

      await runSendOn(context, sendParams({ accountId: "default" }));
      await runSendOn(context, sendParams({ accountId: "work" }));

      expect(mocks.deliverOutboundPayloads).toHaveBeenCalledTimes(2);
      const accounts = mocks.deliverOutboundPayloads.mock.calls.map(
        (call) => (call[0] as { accountId?: string }).accountId,
      );
      expect(accounts).toEqual(["default", "work"]);
    });

    it("does not let an uncanonicalizable account reuse the default account result", async () => {
      // "__proto__" normalizes to undefined. It must get its own dedupe bucket
      // instead of inheriting the default account's cached response.
      const context = makeContext();
      mockDeliverySuccess("m-invalid-account");

      await runSendOn(context, sendParams());
      const { respond } = await runSendOn(context, sendParams({ accountId: "__proto__" }));

      expect(mocks.deliverOutboundPayloads).toHaveBeenCalledTimes(2);
      expect(respond).not.toHaveBeenCalledWith(
        expect.anything(),
        expect.anything(),
        expect.anything(),
        expect.objectContaining({ cached: true }),
      );
    });

    it("still sends the same idempotency key as a poll on a different channel", async () => {
      const context = makeContext();
      mocks.sendPoll.mockResolvedValue({ messageId: "poll-x" });

      await runPollOn(context, pollParams({ channel: "slack" }));
      await runPollOn(context, pollParams({ channel: "telegram" }));

      expect(mocks.sendPoll).toHaveBeenCalledTimes(2);
    });

    it("still sends the same idempotency key as a poll for a different account", async () => {
      const context = makeContext();
      mocks.sendPoll.mockResolvedValue({ messageId: "poll-y" });

      await runPollOn(context, pollParams({ accountId: "default" }));
      await runPollOn(context, pollParams({ accountId: "work" }));

      expect(mocks.sendPoll).toHaveBeenCalledTimes(2);
      // sendPoll is declared with no parameters in the mock factory above, so
      // reach for the recorded arguments through unknown.
      const pollCalls = mocks.sendPoll.mock.calls as unknown as Array<[{ accountId?: string }]>;
      expect(pollCalls.map((call) => call[0].accountId)).toEqual(["default", "work"]);
    });

    it("still responds when a plugin account resolver throws", async () => {
      // A throwing listAccountIds must not leave the request hanging with no
      // response at all.
      const context = makeContext();
      mocks.getChannelPlugin.mockReturnValue({
        outbound: { sendPoll: mocks.sendPoll },
        config: {
          listAccountIds: () => {
            throw new Error("plugin blew up");
          },
        },
      });

      const { respond } = await runSendOn(context, sendParams());

      expect(respond).toHaveBeenCalledTimes(1);
      expect(respond).toHaveBeenCalledWith(
        false,
        undefined,
        expect.objectContaining({ message: expect.stringContaining("plugin blew up") }),
        expect.anything(),
      );
    });

    it("still responds to a follower when the inflight worker rejects", async () => {
      const context = makeContext();
      let release: ((reason: Error) => void) | undefined;
      mocks.deliverOutboundPayloads.mockImplementation(async () => {
        await new Promise<never>((_resolve, reject) => {
          release = reject;
        });
        return [];
      });

      const first = runSendOn(context, sendParams());
      await vi.waitFor(() => expect(release).toBeDefined());
      const second = runSendOn(context, sendParams());
      release?.(new Error("delivery exploded"));
      const [a, b] = await Promise.all([first, second]);

      // Both the owner and the duplicate-suppressed follower must hear back.
      expect(a.respond).toHaveBeenCalledTimes(1);
      expect(b.respond).toHaveBeenCalledTimes(1);
      expect(b.respond).toHaveBeenCalledWith(
        false,
        undefined,
        expect.anything(),
        expect.objectContaining({ cached: true }),
      );
    });

    it("replays a completed result for a repeated send on the same route", async () => {
      const context = makeContext();
      mockDeliverySuccess("m-replay");

      await runSendOn(context, sendParams());
      const { respond } = await runSendOn(context, sendParams());

      expect(mocks.deliverOutboundPayloads).toHaveBeenCalledTimes(1);
      expect(respond).toHaveBeenCalledWith(true, expect.anything(), undefined, { cached: true });
    });

    it("replays a completed poll result on the same route", async () => {
      const context = makeContext();
      mocks.sendPoll.mockResolvedValue({ messageId: "poll-replay" });

      await runPollOn(context, pollParams());
      const { respond } = await runPollOn(context, pollParams());

      expect(mocks.sendPoll).toHaveBeenCalledTimes(1);
      expect(respond).toHaveBeenCalledWith(true, expect.anything(), undefined, { cached: true });
    });
  });
});
