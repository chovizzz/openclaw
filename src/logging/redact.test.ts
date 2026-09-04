import { describe, expect, it } from "vitest";
import { isReadingLoggingConfigForTest } from "./config.js";
import {
  getDefaultRedactPatterns,
  isSensitiveFieldKey,
  redactSensitiveFieldValueWithConfig,
  redactSensitiveText,
} from "./redact.js";

const defaults = getDefaultRedactPatterns();

describe("redactSensitiveText", () => {
  it("masks env assignments while keeping the key", () => {
    const input = "OPENAI_API_KEY=sk-1234567890abcdef";
    const output = redactSensitiveText(input, {
      mode: "tools",
      patterns: defaults,
    });
    expect(output).toBe("OPENAI_API_KEY=sk-123…cdef");
  });

  it("masks CLI flags", () => {
    const input = "curl --token abcdef1234567890ghij https://api.test";
    const output = redactSensitiveText(input, {
      mode: "tools",
      patterns: defaults,
    });
    expect(output).toBe("curl --token abcdef…ghij https://api.test");
  });

  it("masks JSON fields", () => {
    const input = '{"token":"abcdef1234567890ghij"}';
    const output = redactSensitiveText(input, {
      mode: "tools",
      patterns: defaults,
    });
    expect(output).toBe('{"token":"abcdef…ghij"}');
  });

  it("masks bearer tokens", () => {
    const input = "Authorization: Bearer abcdef1234567890ghij";
    const output = redactSensitiveText(input, {
      mode: "tools",
      patterns: defaults,
    });
    expect(output).toBe("Authorization: Bearer abcdef…ghij");
  });

  it("masks Telegram-style tokens", () => {
    const input = "123456:ABCDEFGHIJKLMNOPQRSTUVWXYZabcdef";
    const output = redactSensitiveText(input, {
      mode: "tools",
      patterns: defaults,
    });
    expect(output).toBe("123456…cdef");
  });

  it("masks Telegram Bot API URL tokens", () => {
    const input =
      "GET https://api.telegram.org/bot123456:ABCDEFGHIJKLMNOPQRSTUVWXYZabcdef/getMe HTTP/1.1";
    const output = redactSensitiveText(input, {
      mode: "tools",
      patterns: defaults,
    });
    expect(output).toBe("GET https://api.telegram.org/bot123456…cdef/getMe HTTP/1.1");
  });

  it("redacts short tokens fully", () => {
    const input = "TOKEN=shortvalue";
    const output = redactSensitiveText(input, {
      mode: "tools",
      patterns: defaults,
    });
    expect(output).toBe("TOKEN=***");
  });

  it("redacts private key blocks", () => {
    const input = [
      "-----BEGIN PRIVATE KEY-----",
      "ABCDEF1234567890",
      "ZYXWVUT987654321",
      "-----END PRIVATE KEY-----",
    ].join("\n");
    const output = redactSensitiveText(input, {
      mode: "tools",
      patterns: defaults,
    });
    expect(output).toBe(
      ["-----BEGIN PRIVATE KEY-----", "…redacted…", "-----END PRIVATE KEY-----"].join("\n"),
    );
  });

  it("honors custom patterns with flags", () => {
    const input = "token=abcdef1234567890ghij";
    const output = redactSensitiveText(input, {
      mode: "tools",
      patterns: ["/token=([A-Za-z0-9]+)/i"],
    });
    expect(output).toBe("token=abcdef…ghij");
  });

  it("ignores unsafe nested-repetition custom patterns", () => {
    const input = `${"a".repeat(28)}!`;
    const output = redactSensitiveText(input, {
      mode: "tools",
      patterns: ["(a+)+$"],
    });
    expect(output).toBe(input);
  });

  it("redacts large payloads with bounded regex passes", () => {
    const input = `${"x".repeat(40_000)} OPENAI_API_KEY=sk-1234567890abcdef ${"y".repeat(40_000)}`;
    const output = redactSensitiveText(input, {
      mode: "tools",
      patterns: defaults,
    });
    expect(output).toContain("OPENAI_API_KEY=sk-123…cdef");
  });

  it("masks Tencent Cloud SecretId (AKID prefix)", () => {
    const output = redactSensitiveText("SecretId is AKIDZ8EXAMPLEFAKE01KEY99TEST", {
      mode: "tools",
      patterns: defaults,
    });
    expect(output).toBe("SecretId is AKIDZ8\u2026TEST");
  });

  it("masks Tencent Cloud SecretId with mixed-case characters", () => {
    const output = redactSensitiveText("id AKIDz8exampleFake01Key99Test used for region ap-1", {
      mode: "tools",
      patterns: defaults,
    });
    expect(output).toBe("id AKIDz8\u2026Test used for region ap-1");
  });

  it("masks Alibaba Cloud AccessKey ID (LTAI prefix)", () => {
    const output = redactSensitiveText("AccessKeyId=LTAI5tExampleFakeKeyXyz9", {
      mode: "tools",
      patterns: defaults,
    });
    expect(output).toBe("AccessKeyId=LTAI5t\u2026Xyz9");
  });

  it("masks HuggingFace tokens (hf_ prefix)", () => {
    const output = redactSensitiveText("login hf_ABCDEFghijklmnopqrstuv to hub", {
      mode: "tools",
      patterns: defaults,
    });
    expect(output).toBe("login hf_ABC\u2026stuv to hub");
  });

  it("masks Replicate tokens (r8_ prefix)", () => {
    const output = redactSensitiveText("token r8_ABCDEFghijklmnopqrstuv ok", {
      mode: "tools",
      patterns: defaults,
    });
    expect(output).toBe("token r8_ABC\u2026stuv ok");
  });

  it("does not redact ordinary SCREAMING_CASE identifiers sharing a vendor prefix", () => {
    // The vendor prefixes are compiled case-sensitively for exactly this reason:
    // under `gi`, `hf_`/`r8_` would swallow these ordinary config identifiers.
    // `AKID`/`LTAI` are genuinely uppercase prefixes upstream, so an identifier
    // that literally starts with them still matches; that stays fail-closed.
    const input = "HF_CONFIGURATION_DEFAULTS R8_COMPILATION_UNIT hfx r8x akid_lowercase";
    expect(redactSensitiveText(input, { mode: "tools", patterns: defaults })).toBe(input);
  });

  it("does not redact uppercase GitLab-prefixed identifiers", () => {
    const input = `GLPAT-${"A".repeat(30)} GLRT-${"B".repeat(30)}`;
    expect(redactSensitiveText(input, { mode: "tools", patterns: defaults })).toBe(input);
  });

  it("keeps surrounding text intact for the new vendor prefixes", () => {
    const input =
      "deploy host=build-07 region=us-east-1 key=AKIDZ8EXAMPLEFAKE01KEY99TEST status=ok note=hfx r8x";
    const output = redactSensitiveText(input, { mode: "tools", patterns: defaults });
    expect(output).not.toContain("AKIDZ8EXAMPLEFAKE01KEY99TEST");
    expect(output).toContain("deploy host=build-07 region=us-east-1 key=");
    expect(output).toContain("status=ok note=hfx r8x");
  });

  it("masks additional GitLab token prefixes", () => {
    const dashToken = (prefix: string, suffix: string): string => [prefix, suffix].join("-");
    const repeated = (prefix: string, length: number): string =>
      dashToken(prefix, "A".repeat(length));
    const tokens = [
      dashToken("glpat", "A".repeat(20)),
      dashToken("gloas", "a".repeat(32)),
      dashToken("gloas", "a".repeat(80)),
      repeated("gldt", 20),
      dashToken("glcbt", `a1B2_${"A".repeat(20)}`),
      repeated("glptt", 40),
      repeated("glft", 20),
      repeated("glimt", 25),
      repeated("glagent", 50),
      repeated("glwt", 20),
      repeated("glsoat", 20),
      repeated("glffct", 20),
      dashToken("glrt", `t1_${"A".repeat(20)}`),
      dashToken("glrtr", `${"A".repeat(27)}.01.${"a".repeat(9)}`),
      `GR1348941${"A".repeat(20)}`,
      `_gitlab_session=${"A".repeat(32)}`,
    ];
    for (const token of tokens) {
      const output = redactSensitiveText(`prefix ${token} suffix`, {
        mode: "tools",
        patterns: defaults,
      });
      expect(output, token).not.toContain(token);
      // Negative half: the non-secret framing must survive untouched.
      expect(output, token).toContain("prefix ");
      expect(output, token).toContain(" suffix");
    }
  });

  it("leaves short GitLab-prefixed identifiers alone", () => {
    const input = "glpat-docs gloas-docs gldt-docs glrt-docs GR1348941-docs _gitlab_session=short";
    expect(redactSensitiveText(input, { mode: "tools", patterns: defaults })).toBe(input);
  });

  it("keeps redacted token hints UTF-16 safe", () => {
    const cases: Array<[string, string]> = [
      [`abcde\u{1F600}${"x".repeat(9)}wxyz`, "abcde\u2026wxyz"],
      [`abcdef${"x".repeat(9)}\u{1F600}abc`, "abcdef\u2026abc"],
      [`abcd\u{1F600}${"x".repeat(9)}\u{1F600}ab`, "abcd\u{1F600}\u2026\u{1F600}ab"],
    ];
    for (const [secret, expected] of cases) {
      const output = redactSensitiveText(`--token ${secret} rest`, {
        mode: "tools",
        patterns: defaults,
      });
      expect(output, secret).toBe(`--token ${expected} rest`);
      // No lone surrogate may survive into log output.
      expect(output.replace(/[\u{10000}-\u{10FFFF}]/gu, ""), secret).not.toMatch(
        /[\uD800-\uDFFF]/u,
      );
    }
  });

  it("masks Telegram bot tokens that cross bounded-replacement chunk boundaries", () => {
    const chunkSize = 16_384;
    const credential = `123456:${"A".repeat(28)}WXYZ`;
    const cases = [
      { token: `bot${credential}`, redacted: "bot123456\u2026WXYZ" },
      { token: credential, redacted: "123456\u2026WXYZ" },
    ];
    for (const { token, redacted } of cases) {
      const prefix = `${"x".repeat(chunkSize - 13)} `;
      const suffix = ` ${"y".repeat(chunkSize * 2)}`;
      const output = redactSensitiveText(`${prefix}${token}${suffix}`, {
        mode: "tools",
        patterns: defaults,
      });
      expect(output, token).not.toContain(token);
      // Negative half: everything around the straddling token is byte-identical.
      expect(output, token).toBe(`${prefix}${redacted}${suffix}`);
    }
  });

  it("masks GitLab and HTTP-diagnostic secrets across chunk boundaries", () => {
    const chunkSize = 16_384;
    const tokens = [
      `glpat-${"A".repeat(24)}`,
      `hf_${"B".repeat(24)}`,
      `authorization: "Basic ${"C".repeat(24)}"`,
    ];
    for (const token of tokens) {
      // Straddle the 16KB slice boundary that replacePatternBounded would cut on.
      const prefix = `${"x".repeat(chunkSize - Math.floor(token.length / 2))} `;
      const suffix = ` ${"y".repeat(chunkSize * 2)}`;
      const output = redactSensitiveText(`${prefix}${token}${suffix}`, {
        mode: "tools",
        patterns: defaults,
      });
      expect(output, token).not.toContain(token);
      // Negative half: the filler on both sides is byte-identical.
      expect(output.startsWith(prefix), token).toBe(true);
      expect(output.endsWith(suffix), token).toBe(true);
    }
  });

  it("stays linear on adversarial long inputs for the new patterns", () => {
    const hostile = [
      "a".repeat(50_000),
      `glrtr-${"A".repeat(50_000)}`,
      `gloas-${"a".repeat(50_000)}`,
      `glcbt-${"a".repeat(50_000)}`,
      `AKID${"A".repeat(50_000)}`,
      `${"1".repeat(50_000)}:${"A".repeat(50_000)}`,
    ];
    const started = Date.now();
    for (const input of hostile) {
      const output = redactSensitiveText(input, { mode: "tools", patterns: defaults });
      // Guard against a pattern that "passes" by eating the whole input.
      expect(output.length, input.slice(0, 24)).toBeGreaterThan(0);
    }
    expect(Date.now() - started).toBeLessThan(5_000);
    // Plain text with no secret shape must survive byte-identically.
    expect(redactSensitiveText("a".repeat(50_000), { mode: "tools", patterns: defaults })).toBe(
      "a".repeat(50_000),
    );
  });

  it("masks quoted HTTP client secret fields in stringified request configs", () => {
    const input = `{ url: 'https://api.test/v1', api_key: 'abcdef1234567890ghij', timeout: 30000 }`;
    const output = redactSensitiveText(input, { mode: "tools", patterns: defaults });
    expect(output).not.toContain("abcdef1234567890ghij");
    // Negative half: the non-secret request config survives verbatim.
    expect(output).toContain("url: 'https://api.test/v1'");
    expect(output).toContain("timeout: 30000");
  });

  it("masks HTTP auth header fields in stringified request configs", () => {
    const input = `headers: { authorization: "Basic dXNlcjpwYXNzd29yZDEyMw==", accept: "application/json", x-api-key: 'zyxwvu9876543210abcd', user-agent: 'openclaw/1' }`;
    const output = redactSensitiveText(input, { mode: "tools", patterns: defaults });
    expect(output).not.toContain("Basic dXNlcjpwYXNzd29yZDEyMw==");
    expect(output).not.toContain("zyxwvu9876543210abcd");
    // Negative half: non-secret headers are untouched.
    expect(output).toContain(`accept: "application/json"`);
    expect(output).toContain("headers: {");
    // Benign field after the last secret: catches an over-broad trailing match.
    expect(output).toContain("user-agent: 'openclaw/1'");
  });

  it("masks cookie headers without eating neighboring fields", () => {
    const input = `{ method: 'POST', cookie: 'session=abcdefghij0123456789', retries: 3 }`;
    const output = redactSensitiveText(input, { mode: "tools", patterns: defaults });
    expect(output).not.toContain("session=abcdefghij0123456789");
    expect(output).toContain("method: 'POST'");
    expect(output).toContain("retries: 3");
  });

  it("stays linear on adversarial HTTP-diagnostic shaped input", () => {
    const started = Date.now();
    const unterminated = `{ authorization: "${"a".repeat(50_000)}`;
    // No closing quote, so the pattern cannot match: output must be unchanged.
    expect(redactSensitiveText(unterminated, { mode: "tools", patterns: defaults })).toBe(
      unterminated,
    );
    const trailing = `{ api_key: ${" ".repeat(50_000)}`;
    expect(redactSensitiveText(trailing, { mode: "tools", patterns: defaults })).toBe(trailing);
    expect(Date.now() - started).toBeLessThan(5_000);
  });

  it("skips redaction when mode is off", () => {
    const input = "OPENAI_API_KEY=sk-1234567890abcdef";
    const output = redactSensitiveText(input, {
      mode: "off",
      patterns: defaults,
    });
    expect(output).toBe(input);
  });
});

describe("isSensitiveFieldKey", () => {
  it("classifies credential field names as sensitive", () => {
    for (const key of [
      "apiKey",
      "api_key",
      "token",
      "authToken",
      "clientSecret",
      "password",
      "OPENAI_API_KEY",
      "GITHUB_TOKEN",
      "cvc",
    ]) {
      expect(isSensitiveFieldKey(key), key).toBe(true);
    }
  });

  it("does not classify ordinary data keys ending in _key as sensitive", () => {
    // Over-masking here destroys whole persisted-detail subtrees, because the
    // key is inherited down the branch.
    for (const key of [
      "primary_key",
      "primaryKey",
      "partition_key",
      "sort_key",
      "cache_key",
      "object_key",
      "idempotency_key",
      "public_key",
      "row_key",
      "foreign_key",
    ]) {
      expect(isSensitiveFieldKey(key), key).toBe(false);
    }
  });
});

describe("redactSensitiveFieldValueWithConfig", () => {
  it("masks a value whose key names a credential even when no pattern matches", () => {
    expect(redactSensitiveFieldValueWithConfig("token", "shortsecret", undefined)).toBe("***");
  });

  it("leaves a value under a benign key untouched", () => {
    expect(redactSensitiveFieldValueWithConfig("primary_key", "orders-2026", undefined)).toBe(
      "orders-2026",
    );
    expect(redactSensitiveFieldValueWithConfig("hostname", "build-07", undefined)).toBe("build-07");
  });
});

describe("config re-entrancy safety", () => {
  it("never reads config when explicit options are supplied", () => {
    // src/config/io.audit.ts calls this *during* config load with an explicit
    // { mode: "tools" }. If that path read config it would recurse forever.
    expect(isReadingLoggingConfigForTest()).toBe(false);
    const out = redactSensitiveText("token=sk-live-abcdefghijklmnopqrstuvwx", { mode: "tools" });
    expect(out).not.toContain("sk-live-abcdefghijklmnopqrstuvwx");
    expect(out).toContain("token=");
    expect(isReadingLoggingConfigForTest()).toBe(false);
  });
});
