import { describe, expect, it } from "vitest";
import type { CronPayload } from "../types.js";
import { normalizePayloadToSystemText } from "./normalize.js";

describe("normalizePayloadToSystemText", () => {
  it("trims systemEvent text", () => {
    expect(normalizePayloadToSystemText({ kind: "systemEvent", text: "  tick  " })).toBe("tick");
  });

  it("trims agentTurn message", () => {
    expect(normalizePayloadToSystemText({ kind: "agentTurn", message: "  hello  " })).toBe("hello");
  });

  it("falls back to the legacy message field on systemEvent payloads", () => {
    const legacy = { kind: "systemEvent", message: "  legacy text  " } as unknown as CronPayload;
    expect(normalizePayloadToSystemText(legacy)).toBe("legacy text");
  });

  it("returns an empty string instead of throwing on malformed payloads", () => {
    expect(normalizePayloadToSystemText({ kind: "systemEvent" } as unknown as CronPayload)).toBe(
      "",
    );
    expect(normalizePayloadToSystemText({ kind: "agentTurn" } as unknown as CronPayload)).toBe("");
    expect(
      normalizePayloadToSystemText({ kind: "agentTurn", message: 42 } as unknown as CronPayload),
    ).toBe("");
  });
});
