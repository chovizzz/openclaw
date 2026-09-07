import { describe, expect, test } from "vitest";
import { formatForLog, shortId, summarizeAgentEventForWsLog } from "./ws-log.js";

describe("gateway ws log helpers", () => {
  test.each([
    {
      name: "compacts uuids",
      input: "12345678-1234-1234-1234-123456789abc",
      expected: "12345678…9abc",
    },
    {
      name: "compacts long strings",
      input: "a".repeat(30),
      expected: "aaaaaaaaaaaa…aaaa",
    },
    {
      name: "trims before checking length",
      input: " short ",
      expected: "short",
    },
  ])("shortId $name", ({ input, expected }) => {
    expect(shortId(input)).toBe(expected);
  });

  test.each([
    {
      name: "formats Error instances",
      input: Object.assign(new Error("boom"), { name: "TestError" }),
      expected: "TestError: boom",
    },
    {
      name: "formats message-like objects with codes",
      input: { name: "Oops", message: "failed", code: "E1" },
      expected: "Oops: failed: code=E1",
    },
  ])("formatForLog $name", ({ input, expected }) => {
    expect(formatForLog(input)).toBe(expected);
  });

  test("formatForLog redacts obvious secrets", () => {
    const token = "sk-abcdefghijklmnopqrstuvwxyz123456";
    const out = formatForLog({ token });
    expect(out).toContain("token");
    expect(out).not.toContain(token);
    expect(out).toContain("…");
  });

  test("summarizeAgentEventForWsLog compacts assistant payloads", () => {
    const summary = summarizeAgentEventForWsLog({
      runId: "12345678-1234-1234-1234-123456789abc",
      sessionKey: "agent:main:main",
      stream: "assistant",
      seq: 2,
      data: {
        text: "hello\n\nworld ".repeat(20),
        mediaUrls: ["a", "b"],
      },
    });

    expect(summary).toMatchObject({
      agent: "main",
      run: "12345678…9abc",
      session: "main",
      stream: "assistant",
      aseq: 2,
      media: 2,
    });
    expect(summary.text).toBeTypeOf("string");
    expect(summary.text).not.toContain("\n");
  });

  test("summarizeAgentEventForWsLog includes tool metadata", () => {
    expect(
      summarizeAgentEventForWsLog({
        runId: "run-1",
        stream: "tool",
        data: { phase: "start", name: "fetch", toolCallId: "12345678-1234-1234-1234-123456789abc" },
      }),
    ).toMatchObject({
      run: "run-1",
      stream: "tool",
      tool: "start:fetch",
      call: "12345678…9abc",
    });
  });

  test("summarizeAgentEventForWsLog includes lifecycle errors with compact previews", () => {
    const summary = summarizeAgentEventForWsLog({
      runId: "run-2",
      sessionKey: "agent:main:thread-1",
      stream: "lifecycle",
      data: {
        phase: "abort",
        aborted: true,
        error: "fatal ".repeat(40),
      },
    });

    expect(summary).toMatchObject({
      agent: "main",
      session: "thread-1",
      stream: "lifecycle",
      phase: "abort",
      aborted: true,
    });
    expect(summary.error).toBeTypeOf("string");
    expect((summary.error as string).length).toBeLessThanOrEqual(120);
  });

  describe("UTF-16 safe truncation (#102561)", () => {
    // A lone surrogate is a code unit in D800-DFFF with no matching partner.
    // Naive .slice() at a fixed code-unit limit produces one whenever the limit
    // lands inside a surrogate pair; it renders as U+FFFD in console logs.
    const hasLoneSurrogate = (value: string): boolean => {
      for (let i = 0; i < value.length; i += 1) {
        const unit = value.charCodeAt(i);
        if (unit >= 0xd800 && unit <= 0xdbff) {
          const next = value.charCodeAt(i + 1);
          if (!(next >= 0xdc00 && next <= 0xdfff)) {
            return true;
          }
          i += 1;
        } else if (unit >= 0xdc00 && unit <= 0xdfff) {
          return true;
        }
      }
      return false;
    };

    // LOG_VALUE_LIMIT is 240. The leading "a" shifts the emoji run by one code
    // unit, so unit index 240 falls exactly between a high and a low surrogate.
    const straddling = `a${"\u{1F642}".repeat(200)}`;

    test("the fixture really does straddle a surrogate pair at the limit", () => {
      expect(straddling.slice(0, 240)).toSatisfy(hasLoneSurrogate);
    });

    test("formatForLog does not split a surrogate pair on a long string", () => {
      const out = formatForLog(straddling);
      expect(out.endsWith("...")).toBe(true);
      expect(hasLoneSurrogate(out)).toBe(false);
      // Backed off by one code unit to keep the emoji whole.
      expect(out).toBe(`${straddling.slice(0, 239)}...`);
    });

    test("formatForLog does not split a surrogate pair on an Error message", () => {
      const out = formatForLog(new Error(straddling));
      expect(hasLoneSurrogate(out)).toBe(false);
    });

    test("formatForLog does not split a surrogate pair on an error-like object", () => {
      const out = formatForLog({ message: straddling });
      expect(hasLoneSurrogate(out)).toBe(false);
    });

    test("compactPreview does not split a surrogate pair in assistant text", () => {
      // compactPreview cuts at maxLen - 1 = 159, an odd offset into a pure
      // emoji run, so the naive cut lands mid-pair.
      const text = "\u{1F642}".repeat(200);
      expect(text.slice(0, 159)).toSatisfy(hasLoneSurrogate);
      const summary = summarizeAgentEventForWsLog({ stream: "assistant", data: { text } });
      expect(hasLoneSurrogate(String(summary.text))).toBe(false);
      expect(summary.text).toBe(`${text.slice(0, 158)}…`);
    });

    test("redacts a secret in an Error message", () => {
      // formatForLog(err) is fed third-party HTTP failures from tts/web/channels
      // and is returned to gateway clients via errorShape, not just console.
      const out = formatForLog(new Error(`request failed: sk-${"a".repeat(32)}`));
      expect(out).not.toContain("a".repeat(32));
      expect(out).toContain("request failed");
    });

    test("redacts a Telegram bot token embedded in an Error message URL", () => {
      // The redact pattern list carries a dedicated Telegram bot-URL pattern
      // precisely because these tokens leak through API error text.
      const token = `123456789:${"A".repeat(35)}`;
      const out = formatForLog(
        new Error(`ETELEGRAM: https://api.telegram.org/bot${token}/sendMessage failed`),
      );
      expect(out).not.toContain(token);
    });

    test("redacts a secret in an error-like object message", () => {
      const out = formatForLog({
        name: "HttpError",
        message: `Authorization: Bearer ${"z".repeat(40)}`,
        code: 401,
      });
      expect(out).not.toContain("z".repeat(40));
      expect(out).toContain("HttpError");
    });

    test("redacts before truncating, so a long secret cannot survive the cut", () => {
      // Truncate-then-redact would slice the token so the pattern misses it and
      // the surviving prefix would still carry most of the secret.
      const secret = `sk-${"b".repeat(300)}`;
      const out = formatForLog(new Error(`boom ${secret}`));
      expect(out).not.toContain("b".repeat(60));
    });

    // Reverse coverage: redaction must not eat ordinary diagnostics. Trading
    // observability for safety here would make gateway errors unactionable.
    test("leaves ordinary diagnostic detail intact", () => {
      const out = formatForLog(
        Object.assign(
          new Error(
            "connect ECONNREFUSED 10.0.0.4:8443 while reading /var/lib/openclaw/state.json",
          ),
          {
            code: "ECONNREFUSED",
          },
        ),
      );
      expect(out).toContain("ECONNREFUSED");
      expect(out).toContain("10.0.0.4:8443");
      expect(out).toContain("/var/lib/openclaw/state.json");
      expect(out).toContain("code=ECONNREFUSED");
    });

    // The redactor does mask `*_key=` values, including benign ones such as
    // idempotency_key. That cost is pre-existing policy, not something this
    // change introduced: the string branch has always behaved this way. The
    // invariant worth pinning is that the Error branch is not treated
    // differently from the string branch, so no path silently skips redaction.
    test("Error branch redacts identically to the string branch", () => {
      const detail = "upsert failed: idempotency_key=send-42 partition_key=eu-west";
      expect(formatForLog(new Error(detail))).toBe(`Error: ${formatForLog(detail)}`);
      // Field names survive so the line stays readable; only values are masked.
      expect(formatForLog(detail)).toContain("idempotency_key=");
    });

    test("still redacts before truncating", () => {
      // Truncation must not become a way to smuggle a secret into logs: the
      // redaction pass runs first and the truncated tail is already scrubbed.
      const secret = `token=${"A".repeat(64)}`;
      const out = formatForLog(`${secret} ${"\u{1F642}".repeat(200)}`);
      expect(out).not.toContain("A".repeat(64));
      expect(hasLoneSurrogate(out)).toBe(false);
    });
  });

  test("summarizeAgentEventForWsLog preserves invalid session keys and unknown-stream reasons", () => {
    expect(
      summarizeAgentEventForWsLog({
        sessionKey: "bogus-session",
        stream: "other",
        data: { reason: "dropped" },
      }),
    ).toEqual({
      session: "bogus-session",
      stream: "other",
      reason: "dropped",
    });
  });
});
