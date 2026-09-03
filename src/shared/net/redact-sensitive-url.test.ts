import { describe, expect, it } from "vitest";
import {
  isSensitiveUrlQueryParamName,
  isSensitiveUrlConfigPath,
  SENSITIVE_URL_HINT_TAG,
  hasSensitiveUrlHintTag,
  redactSensitiveUrl,
  redactSensitiveUrlLikeString,
} from "./redact-sensitive-url.js";

describe("redactSensitiveUrl", () => {
  it("redacts userinfo and sensitive query params from valid URLs", () => {
    expect(redactSensitiveUrl("https://user:pass@example.com/mcp?token=secret&safe=value")).toBe(
      "https://***:***@example.com/mcp?token=***&safe=value",
    );
  });

  it("treats query param names case-insensitively", () => {
    expect(redactSensitiveUrl("https://example.com/mcp?Access_Token=secret")).toBe(
      "https://example.com/mcp?Access_Token=***",
    );
  });

  it.each([
    "auth_token",
    "auth-token",
    "api-key",
    "passwd",
    "hook_token",
    "signature",
    "sig",
    "x-api-key",
    "x_amz_security_token",
    "authorization",
  ])("redacts the %s query param that reaches the persisted audit log", (name) => {
    expect(redactSensitiveUrl(`https://example.com/hook?${name}=secret&safe=value`)).toBe(
      `https://example.com/hook?${name}=***&safe=value`,
    );
  });

  it("redacts scoped and hex-suffixed token params", () => {
    expect(
      redactSensitiveUrl(
        "https://proxy.example/r?proxy_token=abc&token_0123456789abcdef=def&safe=1",
      ),
    ).toBe("https://proxy.example/r?proxy_token=***&token_0123456789abcdef=***&safe=1");
  });

  it("does not treat token-like prefixes or short suffixes as secrets", () => {
    expect(redactSensitiveUrl("https://example.com/x?tokenizer=on&token_abc=1&mytoken2=x")).toBe(
      "https://example.com/x?tokenizer=on&token_abc=1&mytoken2=x",
    );
  });

  it("redacts userinfo whose password contains @ inside free text", () => {
    expect(redactSensitiveUrlLikeString("connect wss://user:pa@ss@gateway.example/ws failed")).toBe(
      "connect wss://***:***@gateway.example/ws failed",
    );
  });

  it("redacts every URL's userinfo in a message, not just the first", () => {
    expect(
      redactSensitiveUrlLikeString("a wss://u:p@one.example/x then http://v:q@two.example/y"),
    ).toBe("a wss://***:***@one.example/x then http://***:***@two.example/y");
  });

  it("classifies percent-encoded query names before redacting", () => {
    expect(
      redactSensitiveUrlLikeString("err at https://h.example/p?access_%74%6f%6b%65%6e=abc&ok=1"),
    ).toBe("err at https://h.example/p?access_%74%6f%6b%65%6e=***&ok=1");
  });

  it("does not let an Error-name prefix masquerade as a URL scheme", () => {
    // "GatewayClientRequestError:" parses as a valid scheme; the credentials
    // then sit in the path and must still be scrubbed by the fragment pass.
    expect(
      redactSensitiveUrlLikeString(
        "GatewayClientRequestError: wss://user:pass@gateway.example/ws?token=secret failed",
      ),
    ).toBe("GatewayClientRequestError: wss://***:***@gateway.example/ws?token=*** failed");
  });

  it("keeps non-sensitive URLs unchanged", () => {
    expect(redactSensitiveUrl("https://example.com/mcp?safe=value")).toBe(
      "https://example.com/mcp?safe=value",
    );
  });
});

describe("redactSensitiveUrlLikeString", () => {
  it("redacts invalid URL-like strings", () => {
    expect(redactSensitiveUrlLikeString("//user:pass@example.com/mcp?client_secret=secret")).toBe(
      "//***:***@example.com/mcp?client_secret=***",
    );
  });
});

describe("isSensitiveUrlQueryParamName", () => {
  it("matches the auth-oriented query params used by MCP SSE config redaction", () => {
    expect(isSensitiveUrlQueryParamName("token")).toBe(true);
    expect(isSensitiveUrlQueryParamName("refresh_token")).toBe(true);
    expect(isSensitiveUrlQueryParamName("safe")).toBe(false);
  });
});

describe("sensitive URL config metadata", () => {
  it("recognizes config paths that may embed URL secrets", () => {
    expect(isSensitiveUrlConfigPath("models.providers.*.baseUrl")).toBe(true);
    expect(isSensitiveUrlConfigPath("mcp.servers.remote.url")).toBe(true);
    expect(isSensitiveUrlConfigPath("gateway.remote.url")).toBe(false);
  });

  it("uses an explicit url-secret hint tag", () => {
    expect(SENSITIVE_URL_HINT_TAG).toBe("url-secret");
    expect(hasSensitiveUrlHintTag({ tags: [SENSITIVE_URL_HINT_TAG] })).toBe(true);
    expect(hasSensitiveUrlHintTag({ tags: ["security"] })).toBe(false);
  });
});
