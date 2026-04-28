import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { OpenClawConfig } from "../../config/config.js";
import { loadSessionStore, type SessionEntry } from "../../config/sessions.js";
import type { EmbeddedPiRunResult } from "../pi-embedded.js";
import { updateSessionStoreAfterAgentRun } from "./session-store.js";

describe("updateSessionStoreAfterAgentRun", () => {
  let tmpDir: string;
  let storePath: string;

  beforeEach(async () => {
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-session-store-"));
    storePath = path.join(tmpDir, "sessions.json");
  });

  afterEach(async () => {
    await fs.rm(tmpDir, { recursive: true, force: true });
  });

  it("persists claude-cli session bindings when the backend is configured", async () => {
    const cfg = {
      agents: {
        defaults: {
          cliBackends: {
            "claude-cli": {
              command: "claude",
            },
          },
        },
      },
    } as OpenClawConfig;
    const sessionKey = "agent:main:explicit:test-claude-cli";
    const sessionId = "test-openclaw-session";
    const sessionStore: Record<string, SessionEntry> = {
      [sessionKey]: {
        sessionId,
        updatedAt: 1,
      },
    };
    await fs.writeFile(storePath, JSON.stringify(sessionStore, null, 2));

    const result: EmbeddedPiRunResult = {
      meta: {
        durationMs: 1,
        agentMeta: {
          sessionId: "cli-session-123",
          provider: "claude-cli",
          model: "claude-sonnet-4-6",
          cliSessionBinding: {
            sessionId: "cli-session-123",
          },
        },
      },
    };

    await updateSessionStoreAfterAgentRun({
      cfg,
      sessionId,
      sessionKey,
      storePath,
      sessionStore,
      defaultProvider: "claude-cli",
      defaultModel: "claude-sonnet-4-6",
      result,
    });

    expect(sessionStore[sessionKey]?.cliSessionBindings?.["claude-cli"]).toEqual({
      sessionId: "cli-session-123",
    });
    expect(sessionStore[sessionKey]?.cliSessionIds?.["claude-cli"]).toBe("cli-session-123");
    expect(sessionStore[sessionKey]?.claudeCliSessionId).toBe("cli-session-123");

    const persisted = loadSessionStore(storePath);
    expect(persisted[sessionKey]?.cliSessionBindings?.["claude-cli"]).toEqual({
      sessionId: "cli-session-123",
    });
    expect(persisted[sessionKey]?.cliSessionIds?.["claude-cli"]).toBe("cli-session-123");
    expect(persisted[sessionKey]?.claudeCliSessionId).toBe("cli-session-123");
  });

  it("preserves previous totalTokens when provider returns no usage data (#67667)", async () => {
    const cfg = {} as OpenClawConfig;
    const sessionKey = "agent:main:explicit:test-no-usage";
    const sessionId = "test-session";

    const sessionStore: Record<string, SessionEntry> = {
      [sessionKey]: {
        sessionId,
        updatedAt: 1,
        totalTokens: 21225,
        totalTokensFresh: true,
      },
    };
    await fs.writeFile(storePath, JSON.stringify(sessionStore, null, 2));

    const result: EmbeddedPiRunResult = {
      meta: {
        durationMs: 500,
        agentMeta: {
          sessionId,
          provider: "minimax",
          model: "MiniMax-M2.7",
        },
      },
    };

    await updateSessionStoreAfterAgentRun({
      cfg,
      sessionId,
      sessionKey,
      storePath,
      sessionStore,
      defaultProvider: "minimax",
      defaultModel: "MiniMax-M2.7",
      result,
    });

    expect(sessionStore[sessionKey]?.totalTokens).toBe(21225);
    expect(sessionStore[sessionKey]?.totalTokensFresh).toBe(false);

    const persisted = loadSessionStore(storePath);
    expect(persisted[sessionKey]?.totalTokens).toBe(21225);
    expect(persisted[sessionKey]?.totalTokensFresh).toBe(false);
  });
});
