import { describe, expect, it } from "vitest";
import {
  resolveExecApprovalCommandDisplay,
  sanitizeExecApprovalDisplayText,
} from "./exec-approval-command-display.js";

describe("sanitizeExecApprovalDisplayText", () => {
  it.each([
    ["echo hi\u200Bthere", "echo hi\\u{200B}there"],
    ["date\u3164\uFFA0\u115F\u1160가", "date\\u{3164}\\u{FFA0}\\u{115F}\\u{1160}가"],
  ])("sanitizes exec approval display text for %j", (input, expected) => {
    expect(sanitizeExecApprovalDisplayText(input)).toBe(expected);
  });

  it("redacts bearer tokens embedded in commands", () => {
    const token = "eyJhbGciOiJSUzI1NiIsInR5cCI6IkpXVCJ9.longtokenpayload.signature";
    const result = sanitizeExecApprovalDisplayText(
      `curl -H "Authorization: Bearer ${token}" https://api.example.com`,
    );
    expect(result).not.toContain(token);
    // Negative half: the operator still sees what the command actually does.
    expect(result).toContain("curl");
    expect(result).toContain("https://api.example.com");
  });

  it("redacts API keys in environment variable assignments", () => {
    const secret = "sk-abc123456789012345678";
    const result = sanitizeExecApprovalDisplayText(`API_SECRET="${secret}" python script.py`);
    expect(result).not.toContain(secret);
    expect(result).toContain("python script.py");
    expect(result).toContain("API_SECRET=");
  });

  it("redacts GitHub personal access tokens", () => {
    const token = "ghp_1234567890abcdefghij1234567890abcdef";
    const result = sanitizeExecApprovalDisplayText(
      `git clone https://${token}@github.com/user/repo`,
    );
    expect(result).not.toContain(token);
    expect(result).toContain("git clone");
    expect(result).toContain("github.com/user/repo");
  });

  it("leaves ordinary commands untouched", () => {
    const command = "ls -la /var/log && df -h /";
    expect(sanitizeExecApprovalDisplayText(command)).toBe(command);
  });

  it("redacts secrets on the resolved approval display and its preview", () => {
    const secret = "sk-resolvedapproval1234567890";
    const display = resolveExecApprovalCommandDisplay({
      host: "node",
      command: `deploy --api-key ${secret}`,
      commandPreview: `deploy --api-key ${secret} (preview)`,
    } as Parameters<typeof resolveExecApprovalCommandDisplay>[0]);
    expect(display.commandText).not.toContain(secret);
    expect(display.commandPreview ?? "").not.toContain(secret);
    expect(display.commandText).toContain("deploy --api-key");
    expect(display.commandPreview ?? "").toContain("(preview)");
  });
});

describe("resolveExecApprovalCommandDisplay", () => {
  it.each([
    {
      name: "prefers explicit command fields and drops identical previews after trimming",
      input: {
        command: "echo hi",
        commandPreview: "  echo hi  ",
        host: "gateway" as const,
      },
      expected: {
        commandText: "echo hi",
        commandPreview: null,
      },
    },
    {
      name: "falls back to node systemRunPlan values and sanitizes preview text",
      input: {
        command: "",
        host: "node" as const,
        systemRunPlan: {
          argv: ["python3", "-c", "print(1)"],
          cwd: null,
          commandText: 'python3 -c "print(1)"',
          commandPreview: "print\u200B(1)",
          agentId: null,
          sessionKey: null,
        },
      },
      expected: {
        commandText: 'python3 -c "print(1)"',
        commandPreview: "print\\u{200B}(1)",
      },
    },
    {
      name: "ignores systemRunPlan fallback for non-node hosts",
      input: {
        command: "",
        host: "sandbox" as const,
        systemRunPlan: {
          argv: ["echo", "hi"],
          cwd: null,
          commandText: "echo hi",
          commandPreview: "echo hi",
          agentId: null,
          sessionKey: null,
        },
      },
      expected: {
        commandText: "",
        commandPreview: null,
      },
    },
  ])("$name", ({ input, expected }) => {
    expect(resolveExecApprovalCommandDisplay(input)).toEqual(expected);
  });
});
