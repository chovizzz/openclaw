import { describe, expect, it } from "vitest";
import { buildGatewayConnectionDetailsWithResolvers } from "./connection-details.js";

const RESOLVERS = {
  resolveConfigPath: () => "/tmp/openclaw.json",
  resolveGatewayPort: () => 18789,
};

describe("buildGatewayConnectionDetails diagnostics redaction", () => {
  it("redacts userinfo credentials in the human-readable message but keeps url raw", () => {
    const details = buildGatewayConnectionDetailsWithResolvers(
      { url: "wss://alice:hunter2@gateway.example:18789/ws", urlSource: "cli" },
      RESOLVERS,
    );
    // (a) credentials never reach the printed diagnostics
    expect(details.message).not.toContain("hunter2");
    expect(details.message).not.toContain("alice:hunter2");
    // (b) the rest of the target stays readable, and the programmatic url is untouched
    expect(details.message).toContain("gateway.example:18789/ws");
    expect(details.message).toContain("Source: cli --url");
    expect(details.url).toBe("wss://alice:hunter2@gateway.example:18789/ws");
  });

  it("redacts a token query param in the human-readable message but keeps url raw", () => {
    const details = buildGatewayConnectionDetailsWithResolvers(
      {
        url: "wss://gateway.example:18789/ws?token=super-secret-token&agent=main",
        urlSource: "cli",
      },
      RESOLVERS,
    );
    expect(details.message).not.toContain("super-secret-token");
    expect(details.message).toContain("token=***");
    // Non-sensitive query params survive.
    expect(details.message).toContain("agent=main");
    expect(details.url).toBe("wss://gateway.example:18789/ws?token=super-secret-token&agent=main");
  });

  it("leaves credential-free targets untouched", () => {
    const details = buildGatewayConnectionDetailsWithResolvers(
      { url: "wss://gateway.example:18789/ws?agent=main", urlSource: "cli" },
      RESOLVERS,
    );
    expect(details.message).toContain("Gateway target: wss://gateway.example:18789/ws?agent=main");
    expect(details.message).not.toContain("***");
  });

  it("redacts credentials in the plaintext-ws security error", () => {
    expect(() =>
      buildGatewayConnectionDetailsWithResolvers(
        { url: "ws://alice:hunter2@gateway.example:18789/ws", urlSource: "cli" },
        RESOLVERS,
      ),
    ).toThrow(/SECURITY ERROR: Gateway URL "ws:\/\/\*\*\*:\*\*\*@gateway\.example:18789\/ws"/);
  });
});
