import { beforeEach, describe, expect, it, vi } from "vitest";
import type { OpenClawConfig } from "../../config/config.js";
import { REDACTED_SENTINEL } from "../../config/redact-snapshot.js";
import type { MsgContext } from "../templating.js";
import { handleConfigCommand, handleDebugCommand } from "./commands-config.js";
import type { HandleCommandsParams } from "./commands-types.js";
import { parseInlineDirectives } from "./directive-handling.parse.js";

const SECRET = "sk-live-51H8xQpZaBcDeFgHiJkLmNoPqRsTuVwXyZ0123456789";

const readConfigFileSnapshotMock = vi.hoisted(() => vi.fn());
const validateConfigObjectWithPluginsMock = vi.hoisted(() => vi.fn());
const writeConfigFileMock = vi.hoisted(() => vi.fn(async (_cfg: unknown) => undefined));
const getConfigOverridesMock = vi.hoisted(() => vi.fn());
const setConfigOverrideMock = vi.hoisted(() => vi.fn(() => ({ ok: true })));
const loadGatewayRuntimeConfigSchemaMock = vi.hoisted(() =>
  vi.fn<() => { uiHints: Record<string, { sensitive?: boolean }> | undefined }>(() => ({
    uiHints: undefined,
  })),
);

vi.mock("../../config/config.js", () => ({
  readConfigFileSnapshot: readConfigFileSnapshotMock,
  validateConfigObjectWithPlugins: validateConfigObjectWithPluginsMock,
  writeConfigFile: writeConfigFileMock,
}));

vi.mock("../../config/runtime-schema.js", () => ({
  // Building the real schema walks the plugin manifest registry. Without hints
  // the redactor falls back to its regex path detection, which is what we want
  // to exercise here.
  loadGatewayRuntimeConfigSchema: loadGatewayRuntimeConfigSchemaMock,
}));

vi.mock("../../config/runtime-overrides.js", () => ({
  getConfigOverrides: getConfigOverridesMock,
  resetConfigOverrides: vi.fn(),
  setConfigOverride: setConfigOverrideMock,
  unsetConfigOverride: vi.fn(() => ({ ok: true, removed: true })),
}));

vi.mock("../../channels/plugins/config-writes.js", () => ({
  resolveConfigWriteTargetFromPath: vi.fn(() => "config"),
}));

vi.mock("../../channels/registry.js", () => ({
  normalizeChannelId: vi.fn((value?: string) => value),
}));

vi.mock("../../utils/message-channel.js", () => ({
  isInternalMessageChannel: vi.fn(() => false),
}));

vi.mock("./channel-context.js", () => ({
  resolveChannelAccountId: vi.fn(() => undefined),
}));

vi.mock("./config-write-authorization.js", () => ({
  resolveConfigWriteDeniedText: vi.fn(() => undefined),
}));

function buildParams(commandBody: string, cfg: OpenClawConfig): HandleCommandsParams {
  const ctx = {
    Body: commandBody,
    CommandBody: commandBody,
    CommandSource: "text",
    CommandAuthorized: true,
    Provider: "whatsapp",
    Surface: "whatsapp",
    SessionKey: "agent:main:main",
  } as MsgContext;

  return {
    ctx,
    cfg,
    command: {
      surface: "whatsapp",
      channel: "whatsapp",
      channelId: "whatsapp",
      ownerList: [],
      senderIsOwner: true,
      isAuthorizedSender: true,
      senderId: "user-1",
      rawBodyNormalized: commandBody.trim(),
      commandBodyNormalized: commandBody.trim(),
      from: "user-1",
      to: "bot-1",
    },
    directives: parseInlineDirectives(""),
    elevated: { enabled: true, allowed: true, failures: [] },
    sessionKey: "agent:main:main",
    workspaceDir: "/tmp",
    defaultGroupActivation: () => "mention",
    resolvedVerboseLevel: "off",
    resolvedReasoningLevel: "off",
    resolveDefaultThinkingLevel: async () => undefined,
    provider: "whatsapp",
    model: "test-model",
    contextTokens: 0,
    isGroup: false,
  };
}

const enabledCfg = {
  commands: { config: true, debug: true, text: true },
  channels: { whatsapp: { allowFrom: ["*"] } },
} as OpenClawConfig;

describe("commands-config secret redaction", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    readConfigFileSnapshotMock.mockResolvedValue({
      valid: true,
      config: {},
      raw: null,
      resolved: {},
      parsed: {
        gateway: { auth: { token: SECRET } },
        messages: { ackReaction: ":)" },
      },
    });
    validateConfigObjectWithPluginsMock.mockImplementation((config: unknown) => ({
      ok: true,
      config,
      issues: [],
    }));
    getConfigOverridesMock.mockReturnValue({});
    setConfigOverrideMock.mockReturnValue({ ok: true });
    loadGatewayRuntimeConfigSchemaMock.mockReturnValue({ uiHints: undefined });
  });

  it("redacts secrets but keeps non-secret fields in /config show", async () => {
    const result = await handleConfigCommand(buildParams("/config show", enabledCfg), true);
    const text = result?.reply?.text ?? "";
    // (a) the secret must not survive into chat-visible output
    expect(text).not.toContain(SECRET);
    expect(text).toContain(REDACTED_SENTINEL);
    // (b) non-secret fields are preserved verbatim
    expect(text).toContain("ackReaction");
    expect(text).toContain('":)"');
  });

  it("redacts a secret addressed by path in /config show <path>", async () => {
    const secretResult = await handleConfigCommand(
      buildParams("/config show gateway.auth.token", enabledCfg),
      true,
    );
    expect(secretResult?.reply?.text ?? "").not.toContain(SECRET);
    expect(secretResult?.reply?.text ?? "").toContain(REDACTED_SENTINEL);

    const plainResult = await handleConfigCommand(
      buildParams("/config show messages.ackReaction", enabledCfg),
      true,
    );
    expect(plainResult?.reply?.text ?? "").toContain('":)"');
    expect(plainResult?.reply?.text ?? "").not.toContain(REDACTED_SENTINEL);
  });

  it("redacts the /config set acknowledgement but still persists the real value", async () => {
    const result = await handleConfigCommand(
      buildParams(`/config set gateway.auth.token=${SECRET}`, enabledCfg),
      true,
    );
    const text = result?.reply?.text ?? "";
    expect(text).not.toContain(SECRET);
    expect(text).toContain(REDACTED_SENTINEL);
    // The write path must keep the real value; redaction is display-only.
    const written = writeConfigFileMock.mock.calls[0]?.[0] as Record<string, unknown>;
    expect((written.gateway as { auth: { token: string } }).auth.token).toBe(SECRET);
  });

  it("keeps non-secret /config set acknowledgements readable", async () => {
    const result = await handleConfigCommand(
      buildParams("/config set messages.ackReaction=:)", enabledCfg),
      true,
    );
    const text = result?.reply?.text ?? "";
    expect(text).toContain('":)"');
    expect(text).not.toContain(REDACTED_SENTINEL);
  });

  it("redacts secrets but keeps non-secret overrides in /debug show", async () => {
    getConfigOverridesMock.mockReturnValue({
      gateway: { auth: { token: SECRET } },
      messages: { ackReaction: ":)" },
    });
    const result = await handleDebugCommand(buildParams("/debug show", enabledCfg), true);
    const text = result?.reply?.text ?? "";
    // (a) secret-shaped override is not echoed
    expect(text).not.toContain(SECRET);
    expect(text).toContain(REDACTED_SENTINEL);
    // (b) non-secret override is preserved
    expect(text).toContain("ackReaction");
    expect(text).toContain('":)"');
  });

  it("redacts the /debug set acknowledgement but keeps non-secret ones", async () => {
    const secretResult = await handleDebugCommand(
      buildParams(`/debug set gateway.auth.token=${SECRET}`, enabledCfg),
      true,
    );
    const secretText = secretResult?.reply?.text ?? "";
    expect(secretText).not.toContain(SECRET);
    expect(secretText).toContain(REDACTED_SENTINEL);
    // The override store still receives the real value.
    expect(setConfigOverrideMock).toHaveBeenCalledWith("gateway.auth.token", SECRET);

    const plainResult = await handleDebugCommand(
      buildParams("/debug set messages.ackReaction=:)", enabledCfg),
      true,
    );
    const plainText = plainResult?.reply?.text ?? "";
    expect(plainText).toContain('":)"');
    expect(plainText).not.toContain(REDACTED_SENTINEL);
  });

  describe("schema-only sensitive paths", () => {
    // `mcp.servers.demo.headers.Authorization` matches none of the redactor's
    // regex fallbacks, so these cases only pass if the handler really threads
    // the schema uiHints through to the redactor.
    const HEADER_PATH = "mcp.servers.demo.headers.Authorization";

    beforeEach(() => {
      loadGatewayRuntimeConfigSchemaMock.mockReturnValue({
        uiHints: { [HEADER_PATH]: { sensitive: true } },
      });
      readConfigFileSnapshotMock.mockResolvedValue({
        valid: true,
        config: {},
        raw: null,
        resolved: {},
        parsed: {
          mcp: { servers: { demo: { headers: { Authorization: SECRET }, url: "https://demo" } } },
        },
      });
    });

    it("redacts a schema-only sensitive path in /config show", async () => {
      const result = await handleConfigCommand(buildParams("/config show", enabledCfg), true);
      const text = result?.reply?.text ?? "";
      expect(text).not.toContain(SECRET);
      expect(text).toContain(REDACTED_SENTINEL);
      // Sibling non-sensitive field in the same object is preserved.
      expect(text).toContain('"https://demo"');
    });

    it("redacts a schema-only sensitive path in the /config set acknowledgement", async () => {
      const result = await handleConfigCommand(
        buildParams(`/config set ${HEADER_PATH}=${SECRET}`, enabledCfg),
        true,
      );
      const text = result?.reply?.text ?? "";
      expect(text).not.toContain(SECRET);
      expect(text).toContain(REDACTED_SENTINEL);
    });

    it("redacts a schema-only sensitive path in /debug show and /debug set", async () => {
      getConfigOverridesMock.mockReturnValue({
        mcp: { servers: { demo: { headers: { Authorization: SECRET }, url: "https://demo" } } },
      });
      const showResult = await handleDebugCommand(buildParams("/debug show", enabledCfg), true);
      const showText = showResult?.reply?.text ?? "";
      expect(showText).not.toContain(SECRET);
      expect(showText).toContain(REDACTED_SENTINEL);
      expect(showText).toContain('"https://demo"');

      const setResult = await handleDebugCommand(
        buildParams(`/debug set ${HEADER_PATH}=${SECRET}`, enabledCfg),
        true,
      );
      const setText = setResult?.reply?.text ?? "";
      expect(setText).not.toContain(SECRET);
      expect(setText).toContain(REDACTED_SENTINEL);
    });
  });
});
