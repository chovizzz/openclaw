import { describe, expect, it } from "vitest";
import { defaultVoiceWakeTriggers } from "../infra/voicewake.js";
import { formatError, normalizeVoiceWakeTriggers } from "./server-utils.js";

const HAS_LONE_SURROGATE = /[\uD800-\uDFFF]/;

describe("normalizeVoiceWakeTriggers", () => {
  it("falls back to defaults for empty or non-array input", () => {
    expect(normalizeVoiceWakeTriggers(undefined)).toEqual(defaultVoiceWakeTriggers());
    expect(normalizeVoiceWakeTriggers([])).toEqual(defaultVoiceWakeTriggers());
    expect(normalizeVoiceWakeTriggers(["  ", 42, null])).toEqual(defaultVoiceWakeTriggers());
  });

  it("bounds the trigger count and trims entries", () => {
    const input = Array.from({ length: 40 }, (_, index) => `  trigger-${index}  `);
    const result = normalizeVoiceWakeTriggers(input);
    expect(result).toHaveLength(32);
    expect(result[0]).toBe("trigger-0");
  });

  it("truncates a long trigger without splitting a surrogate pair", () => {
    // The 64-unit budget lands inside the rocket emoji's surrogate pair.
    const trigger = `${"a".repeat(63)}\u{1F680}tail`;
    const [result] = normalizeVoiceWakeTriggers([trigger]);
    expect(result).toBe("a".repeat(63));
    expect(HAS_LONE_SURROGATE.test(result)).toBe(false);
  });

  it("keeps the emoji when it fits inside the budget", () => {
    // Reverse check: the UTF-16 guard must not drop characters that fit.
    const trigger = `${"a".repeat(62)}\u{1F680}`;
    const [result] = normalizeVoiceWakeTriggers([trigger]);
    expect(result).toBe(trigger);
    expect(result).toHaveLength(64);
  });

  it("leaves short triggers untouched", () => {
    expect(normalizeVoiceWakeTriggers(["hey claw", "ok claw"])).toEqual(["hey claw", "ok claw"]);
  });
});

describe("formatError", () => {
  it("prefers the error message", () => {
    expect(formatError(new Error("boom"))).toBe("boom");
  });

  it("passes strings through", () => {
    expect(formatError("plain")).toBe("plain");
  });

  it("summarizes status/code shapes", () => {
    expect(formatError({ status: 503, code: "EAGAIN" })).toBe("status=503 code=EAGAIN");
    expect(formatError({ status: 503 })).toBe("status=503 code=unknown");
  });
});
