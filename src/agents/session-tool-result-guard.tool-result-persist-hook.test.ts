import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { AgentMessage } from "@mariozechner/pi-agent-core";
import { SessionManager } from "@mariozechner/pi-coding-agent";
import { describe, expect, it, afterEach } from "vitest";
import {
  initializeGlobalHookRunner,
  resetGlobalHookRunner,
} from "../plugins/hook-runner-global.js";
import { loadOpenClawPlugins } from "../plugins/loader.js";
import { guardSessionManager } from "./session-tool-result-guard-wrapper.js";

const EMPTY_PLUGIN_SCHEMA = { type: "object", additionalProperties: false, properties: {} };

function writeTempPlugin(params: { dir: string; id: string; body: string }): string {
  const pluginDir = path.join(params.dir, params.id);
  fs.mkdirSync(pluginDir, { recursive: true });
  const file = path.join(pluginDir, `${params.id}.mjs`);
  fs.writeFileSync(file, params.body, "utf-8");
  fs.writeFileSync(
    path.join(pluginDir, "openclaw.plugin.json"),
    JSON.stringify(
      {
        id: params.id,
        configSchema: EMPTY_PLUGIN_SCHEMA,
      },
      null,
      2,
    ),
    "utf-8",
  );
  return file;
}

function appendToolCallAndResult(sm: ReturnType<typeof SessionManager.inMemory>) {
  const appendMessage = sm.appendMessage.bind(sm) as unknown as (message: AgentMessage) => void;
  appendMessage({
    role: "assistant",
    content: [{ type: "toolCall", id: "call_1", name: "read", arguments: {} }],
  } as AgentMessage);

  appendMessage({
    role: "toolResult",
    toolCallId: "call_1",
    isError: false,
    content: [{ type: "text", text: "ok" }],
    details: { big: "x".repeat(10_000) },
  } as any);
}

function getPersistedToolResult(sm: ReturnType<typeof SessionManager.inMemory>) {
  const messages = sm
    .getEntries()
    .filter((e) => e.type === "message")
    .map((e) => (e as { message: AgentMessage }).message);

  return messages.find((m) => (m as any).role === "toolResult") as any;
}

afterEach(() => {
  resetGlobalHookRunner();
});

describe("tool_result_persist hook", () => {
  it("does not modify persisted toolResult messages when no hook is registered", () => {
    const sm = guardSessionManager(SessionManager.inMemory(), {
      agentId: "main",
      sessionKey: "main",
    });
    appendToolCallAndResult(sm);
    const toolResult = getPersistedToolResult(sm);
    expect(toolResult).toBeTruthy();
    expect(toolResult.details).toBeTruthy();
  });

  it("loads tool_result_persist hooks without breaking persistence", () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "openclaw-toolpersist-"));
    process.env.OPENCLAW_BUNDLED_PLUGINS_DIR = "/nonexistent/bundled/plugins";

    const pluginA = writeTempPlugin({
      dir: tmp,
      id: "persist-a",
      body: `export default { id: "persist-a", register(api) {
  api.on("tool_result_persist", (event, ctx) => {
    const msg = event.message;
    // Example: remove large diagnostic payloads before persistence.
    const { details: _details, ...rest } = msg;
    return { message: { ...rest, persistOrder: ["a"], agentSeen: ctx.agentId ?? null } };
  }, { priority: 10 });
} };`,
    });

    const pluginB = writeTempPlugin({
      dir: tmp,
      id: "persist-b",
      body: `export default { id: "persist-b", register(api) {
  api.on("tool_result_persist", (event) => {
    const prior = (event.message && event.message.persistOrder) ? event.message.persistOrder : [];
    return { message: { ...event.message, persistOrder: [...prior, "b"] } };
  }, { priority: 5 });
} };`,
    });

    const registry = loadOpenClawPlugins({
      cache: false,
      workspaceDir: tmp,
      config: {
        plugins: {
          load: { paths: [pluginA, pluginB] },
          allow: ["persist-a", "persist-b"],
        },
      },
    });
    initializeGlobalHookRunner(registry);

    const sm = guardSessionManager(SessionManager.inMemory(), {
      agentId: "main",
      sessionKey: "main",
    });

    appendToolCallAndResult(sm);
    const toolResult = getPersistedToolResult(sm);
    expect(toolResult).toBeTruthy();

    // Hook registration should preserve a valid toolResult message shape.
    expect(toolResult.role).toBe("toolResult");
    expect(toolResult.toolCallId).toBe("call_1");
    expect(Array.isArray(toolResult.content)).toBe(true);
  });

  it("reapplies the cap after tool_result_persist expands a tool result", () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "openclaw-toolpersist-expand-"));
    process.env.OPENCLAW_BUNDLED_PLUGINS_DIR = "/nonexistent/bundled/plugins";

    const plugin = writeTempPlugin({
      dir: tmp,
      id: "persist-expand",
      body: `export default { id: "persist-expand", register(api) {
  api.on("tool_result_persist", (event) => {
    return {
      message: {
        ...event.message,
        content: [{ type: "text", text: "y".repeat(5000) }],
      },
    };
  }, { priority: 10 });
} };`,
    });

    const registry = loadOpenClawPlugins({
      cache: false,
      workspaceDir: tmp,
      config: {
        plugins: {
          load: { paths: [plugin] },
          allow: ["persist-expand"],
        },
      },
    });
    initializeGlobalHookRunner(registry);

    const sm = guardSessionManager(SessionManager.inMemory(), {
      agentId: "main",
      sessionKey: "main",
      contextWindowTokens: 100,
    });

    appendToolCallAndResult(sm);
    const toolResult = getPersistedToolResult(sm);
    const text = toolResult.content.find((block: { type: string }) => block.type === "text")?.text;
    expect(typeof text).toBe("string");
    expect(text.length).toBeLessThanOrEqual(120);
    expect(text).toContain("truncated");
  });
});

describe("before_message_write hook", () => {
  it("continues persistence when a before_message_write hook throws", () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "openclaw-before-write-"));
    process.env.OPENCLAW_BUNDLED_PLUGINS_DIR = "/nonexistent/bundled/plugins";

    const plugin = writeTempPlugin({
      dir: tmp,
      id: "before-write-throws",
      body: `export default { id: "before-write-throws", register(api) {
  api.on("before_message_write", () => {
    throw new Error("boom");
  }, { priority: 10 });
} };`,
    });

    const registry = loadOpenClawPlugins({
      cache: false,
      workspaceDir: tmp,
      config: {
        plugins: {
          load: { paths: [plugin] },
          allow: ["before-write-throws"],
        },
      },
    });
    initializeGlobalHookRunner(registry);

    const sm = guardSessionManager(SessionManager.inMemory(), {
      agentId: "main",
      sessionKey: "main",
    });
    const appendMessage = sm.appendMessage.bind(sm) as unknown as (message: AgentMessage) => void;
    appendMessage({
      role: "user",
      content: "hello",
      timestamp: Date.now(),
    } as AgentMessage);

    const messages = sm
      .getEntries()
      .filter((e) => e.type === "message")
      .map((e) => (e as { message: AgentMessage }).message);

    expect(messages).toHaveLength(1);
    expect(messages[0]?.role).toBe("user");
  });

  it("reapplies the cap after before_message_write expands a tool result", () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "openclaw-before-write-expand-"));
    process.env.OPENCLAW_BUNDLED_PLUGINS_DIR = "/nonexistent/bundled/plugins";

    const plugin = writeTempPlugin({
      dir: tmp,
      id: "before-write-expand",
      body: `export default { id: "before-write-expand", register(api) {
  api.on("before_message_write", (event) => {
    if (event.message?.role !== "toolResult") return;
    return {
      message: {
        ...event.message,
        content: [{ type: "text", text: "z".repeat(5000) }],
      },
    };
  }, { priority: 10 });
} };`,
    });

    const registry = loadOpenClawPlugins({
      cache: false,
      workspaceDir: tmp,
      config: {
        plugins: {
          load: { paths: [plugin] },
          allow: ["before-write-expand"],
        },
      },
    });
    initializeGlobalHookRunner(registry);

    const sm = guardSessionManager(SessionManager.inMemory(), {
      agentId: "main",
      sessionKey: "main",
      contextWindowTokens: 100,
    });

    appendToolCallAndResult(sm);
    const toolResult = getPersistedToolResult(sm);
    const text = toolResult.content.find((block: { type: string }) => block.type === "text")?.text;
    expect(typeof text).toBe("string");
    expect(text.length).toBeLessThanOrEqual(120);
    expect(text).toContain("truncated");
  });
});

describe("persisted toolResult detail redaction", () => {
  function appendDetails(
    sm: ReturnType<typeof guardSessionManager>,
    details: Record<string, unknown>,
  ) {
    const appendMessage = sm.appendMessage.bind(sm) as unknown as (message: AgentMessage) => void;
    appendMessage({
      role: "assistant",
      content: [{ type: "toolCall", id: "call_1", name: "exec", arguments: {} }],
    } as AgentMessage);
    appendMessage({
      role: "toolResult",
      toolCallId: "call_1",
      isError: false,
      content: [{ type: "text", text: "visible output stays small" }],
      details,
    } as never);
  }

  it("redacts toolResult details before persistence", () => {
    const tokenValue = "abcdefghijklmnopqrstuvwx1234567890";
    const bearerValue = "bearerdiagnosticvalue1234567890";
    const sm = guardSessionManager(SessionManager.inMemory(), {
      agentId: "main",
      sessionKey: "main",
    });
    appendDetails(sm, {
      status: "completed",
      exitCode: 0,
      cwd: "/tmp/work",
      token: tokenValue,
      GITHUB_TOKEN: tokenValue,
      aggregated: `GITHUB_TOKEN=${tokenValue}`,
      nested: {
        apiKey: { value: bearerValue },
        stdout: `Authorization: Bearer ${bearerValue}`,
        items: [`curl --token ${tokenValue} https://example.test`],
      },
    });

    const toolResult = getPersistedToolResult(sm);
    const serialized = JSON.stringify(toolResult.details);
    expect(serialized).not.toContain(tokenValue);
    expect(serialized).not.toContain(bearerValue);
    // Negative half: non-secret diagnostics and the visible content survive.
    expect(toolResult.content[0]?.text).toBe("visible output stays small");
    expect(serialized).toContain('"status":"completed"');
    expect(serialized).toContain('"exitCode":0');
    expect(serialized).toContain("/tmp/work");
    expect(serialized).toContain("GITHUB_TOKEN=");
    expect(serialized).toContain("Bearer");
    expect(serialized).toContain("https://example.test");
  });

  it("masks values under credential-named keys even when no pattern matches", () => {
    const sm = guardSessionManager(SessionManager.inMemory(), {
      agentId: "main",
      sessionKey: "main",
    });
    appendDetails(sm, {
      token: { value: "shortsecret" },
      hostname: "build-07",
    });

    const toolResult = getPersistedToolResult(sm);
    const serialized = JSON.stringify(toolResult.details);
    expect(serialized).not.toContain("shortsecret");
    expect(serialized).toContain("***");
    expect(serialized).toContain("build-07");
  });

  it("redacts secrets embedded in detail keys and caps recursion depth", () => {
    const tokenValue = "abcdefghijklmnopqrstuvwx1234567890";
    const sm = guardSessionManager(SessionManager.inMemory(), {
      agentId: "main",
      sessionKey: "main",
    });
    let deepDetails: Record<string, unknown> = { token: tokenValue };
    for (let index = 0; index < 10; index += 1) {
      deepDetails = { child: deepDetails };
    }
    appendDetails(sm, {
      [`https://example.test/callback?token=${tokenValue}`]: "ok",
      deepDetails,
    });

    const toolResult = getPersistedToolResult(sm);
    const serialized = JSON.stringify(toolResult.details);
    expect(serialized).not.toContain(tokenValue);
    expect(serialized).toContain("max depth exceeded");
    // Negative half: the non-secret part of the key survives.
    expect(serialized).toContain("https://example.test/callback?token=");
    expect(serialized).toContain('"ok"');
  });

  it("applies configured redactPatterns supplied through the wrapper config", () => {
    const customSecret = "customsecret=abcdef1234567890ghij";
    const sm = guardSessionManager(SessionManager.inMemory(), {
      agentId: "main",
      sessionKey: "main",
      config: {
        logging: { redactPatterns: [String.raw`customsecret=([^\s]+)`] },
      } as never,
    });
    appendDetails(sm, { diagnostic: customSecret, hostname: "build-07" });

    const toolResult = getPersistedToolResult(sm);
    const serialized = JSON.stringify(toolResult.details);
    expect(serialized).not.toContain(customSecret);
    // Custom patterns run first, then the built-in ENV-assignment pattern masks
    // the already-shortened hint again; either way the key name survives.
    expect(serialized).toContain("customsecret=");
    expect(serialized).toContain("build-07");
  });

  it("leaves details without secrets byte-identical", () => {
    const sm = guardSessionManager(SessionManager.inMemory(), {
      agentId: "main",
      sessionKey: "main",
    });
    const details = { status: "completed", exitCode: 0, cwd: "/tmp/work", durationMs: 12 };
    appendDetails(sm, details);

    const toolResult = getPersistedToolResult(sm);
    expect(toolResult.details).toEqual(details);
  });
});
