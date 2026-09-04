import type { AgentTool } from "@mariozechner/pi-agent-core";
import { Type } from "@sinclair/typebox";
import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  logDebug: vi.fn(),
  logError: vi.fn(),
}));

vi.mock("../logger.js", () => ({
  logDebug: mocks.logDebug,
  logError: mocks.logError,
}));

let toToolDefinitions: typeof import("./pi-tool-definition-adapter.js").toToolDefinitions;
let wrapToolParamValidation: typeof import("./pi-tools.params.js").wrapToolParamValidation;
let REQUIRED_PARAM_GROUPS: typeof import("./pi-tools.params.js").REQUIRED_PARAM_GROUPS;
let logError: typeof import("../logger.js").logError;

type ToolExecute = ReturnType<
  typeof import("./pi-tool-definition-adapter.js").toToolDefinitions
>[number]["execute"];
const extensionContext = {} as Parameters<ToolExecute>[4];

describe("pi tool definition adapter logging", () => {
  beforeAll(async () => {
    ({ toToolDefinitions } = await import("./pi-tool-definition-adapter.js"));
    ({ wrapToolParamValidation, REQUIRED_PARAM_GROUPS } = await import("./pi-tools.params.js"));
    ({ logError } = await import("../logger.js"));
  });

  beforeEach(() => {
    vi.mocked(logError).mockReset();
    mocks.logDebug.mockReset();
  });

  it("logs raw malformed edit params when required aliases are missing", async () => {
    const baseTool = {
      name: "edit",
      label: "Edit",
      description: "edits files",
      parameters: Type.Object({
        path: Type.String(),
        edits: Type.Array(
          Type.Object({
            oldText: Type.String(),
            newText: Type.String(),
          }),
        ),
      }),
      execute: async () => ({
        content: [{ type: "text" as const, text: "ok" }],
        details: { ok: true },
      }),
    } satisfies AgentTool;

    const tool = wrapToolParamValidation(baseTool, REQUIRED_PARAM_GROUPS.edit);
    const [def] = toToolDefinitions([tool]);
    if (!def) {
      throw new Error("missing tool definition");
    }

    await def.execute("call-edit-1", { path: "notes.txt" }, undefined, undefined, extensionContext);

    expect(logError).toHaveBeenCalledWith(
      expect.stringContaining(
        '[tools] edit failed: Missing required parameter: edits (received: path). Supply correct parameters before retrying. raw_params={"path":"notes.txt"}',
      ),
    );
  });

  it("accepts nested edits arrays for the current edit schema", async () => {
    const execute = vi.fn(async (_toolCallId: string, params: unknown) => ({
      content: [{ type: "text" as const, text: JSON.stringify(params) }],
      details: { ok: true },
    }));
    const baseTool = {
      name: "edit",
      label: "Edit",
      description: "edits files",
      parameters: Type.Object({
        path: Type.String(),
        edits: Type.Array(
          Type.Object({
            oldText: Type.String(),
            newText: Type.String(),
          }),
        ),
      }),
      execute,
    } satisfies AgentTool;

    const tool = wrapToolParamValidation(baseTool, REQUIRED_PARAM_GROUPS.edit);
    const [def] = toToolDefinitions([tool]);
    if (!def) {
      throw new Error("missing tool definition");
    }

    const payload = {
      path: "notes.txt",
      edits: [
        { oldText: "alpha", newText: "beta" },
        { oldText: "gamma", newText: "" },
      ],
    };

    await def.execute("call-edit-batch", payload, undefined, undefined, extensionContext);

    expect(execute).toHaveBeenCalledWith("call-edit-batch", payload, undefined, undefined);
    expect(logError).not.toHaveBeenCalled();
  });
  it("omits raw exec commands and env values from failure logs", async () => {
    const commandSecret = "exec-cleartext-token-ABCDEFGHIJKLMNOPQRSTUVWXYZ1234567890";
    const envSecret = "env-cleartext-token-ABCDEFGHIJKLMNOPQRSTUVWXYZ1234567890";
    const baseTool = {
      name: "exec",
      label: "exec",
      description: "runs commands",
      parameters: Type.Object({
        command: Type.String(),
        env: Type.Optional(Type.Record(Type.String(), Type.String())),
        timeout: Type.Optional(Type.Number()),
      }),
      execute: async () => {
        throw new Error("exec denied: allowlist miss");
      },
    } satisfies AgentTool;
    const [def] = toToolDefinitions([baseTool]);
    if (!def) {
      throw new Error("missing tool definition");
    }

    await def.execute(
      "call-exec-denied",
      {
        command: `export XAI_API_KEY=${commandSecret} && echo blocked`,
        env: { OPENAI_API_KEY: envSecret },
        timeout: 5,
      },
      undefined,
      undefined,
      extensionContext,
    );

    const message = String(vi.mocked(logError).mock.calls[0]?.[0] ?? "");
    expect(message).not.toContain(commandSecret);
    expect(message).not.toContain(envSecret);
    expect(message).not.toContain("export XAI_API_KEY");
    // Negative half: the failure reason and safe correlation metadata survive.
    expect(message).toContain("[tools] exec failed: exec denied: allowlist miss");
    expect(message).toContain('"command":{"omitted":true');
    expect(message).toContain('"reason":"exec command may contain credentials"');
    expect(message).toContain('"chars":');
    expect(message).toMatch(/"sha256":"[a-f0-9]{16}"/u);
    expect(message).toContain('"env":{"OPENAI_API_KEY":"[omitted exec env value]"}');
    expect(message).toContain('"timeout":5');
  });

  it("omits raw exec commands from JSON-string failure params", async () => {
    const commandSecret = "json-cleartext-token-ABCDEFGHIJKLMNOPQRSTUVWXYZ1234567890";
    const baseTool = {
      name: "exec",
      label: "exec",
      description: "runs commands",
      parameters: Type.Any(),
      execute: async () => {
        throw new Error("exec denied: allowlist miss");
      },
    } satisfies AgentTool;
    const [def] = toToolDefinitions([baseTool]);
    if (!def) {
      throw new Error("missing tool definition");
    }

    await def.execute(
      "call-exec-denied-json-string",
      JSON.stringify({
        command: `export XAI_API_KEY=${commandSecret} && echo blocked`,
        timeout: 5,
      }),
      undefined,
      undefined,
      extensionContext,
    );

    const message = String(vi.mocked(logError).mock.calls[0]?.[0] ?? "");
    expect(message).not.toContain(commandSecret);
    expect(message).not.toContain("export XAI_API_KEY");
    expect(message).toContain('"command":{"omitted":true');
    expect(message).toContain('"reason":"exec command may contain credentials"');
    expect(message).toContain('"timeout":5');
  });

  it("omits malformed exec command and env values from failure logs", async () => {
    const commandSecret = "malformed-cleartext-token-ABCDEFGHIJKLMNOPQRSTUVWXYZ1234567890";
    const envSecret = "malformed-env-cleartext-token-ABCDEFGHIJKLMNOPQRSTUVWXYZ1234567890";
    const baseTool = {
      name: "exec",
      label: "exec",
      description: "runs commands",
      parameters: Type.Any(),
      execute: async () => {
        throw new Error("exec denied: allowlist miss");
      },
    } satisfies AgentTool;
    const [def] = toToolDefinitions([baseTool]);
    if (!def) {
      throw new Error("missing tool definition");
    }

    await def.execute(
      "call-exec-denied-malformed",
      {
        command: [`export XAI_API_KEY=${commandSecret} && echo blocked`],
        env: `OPENAI_API_KEY=${envSecret}`,
      },
      undefined,
      undefined,
      extensionContext,
    );

    const message = String(vi.mocked(logError).mock.calls[0]?.[0] ?? "");
    expect(message).not.toContain(commandSecret);
    expect(message).not.toContain(envSecret);
    expect(message).not.toContain("export XAI_API_KEY");
    expect(message).toContain('"command":{"omitted":true');
    expect(message).toContain('"type":"array"');
    expect(message).toContain('"env":"[omitted exec env]"');
  });

  it("leaves non-exec tool failure params untouched", async () => {
    const baseTool = {
      name: "web_search",
      label: "Web search",
      description: "searches",
      parameters: Type.Any(),
      execute: async () => {
        throw new Error("search backend unavailable");
      },
    } satisfies AgentTool;
    const [def] = toToolDefinitions([baseTool]);
    if (!def) {
      throw new Error("missing tool definition");
    }

    await def.execute(
      "call-web-search",
      { query: "openclaw gateway docs", limit: 5 },
      undefined,
      undefined,
      extensionContext,
    );

    const message = String(vi.mocked(logError).mock.calls[0]?.[0] ?? "");
    // Negative half: the exec-specific omission must not spread to other tools.
    expect(message).toContain("openclaw gateway docs");
    expect(message).toContain('"limit":5');
    expect(message).not.toContain("omitted");
  });
});
