import { describe, expect, it } from "vitest";
import { capFrozenResultText } from "./subagent-registry-helpers.js";

const FROZEN_RESULT_TEXT_MAX_BYTES = 100 * 1024;

describe("capFrozenResultText", () => {
  it("truncates at a UTF-8 continuation byte boundary without producing replacement characters", () => {
    // A 4-byte emoji repeated enough times to blow past the 100KB byte budget.
    // The naive `Buffer.subarray(0, N)` approach used to cut mid-codepoint at
    // the raw byte cap, which is exactly what this test targets.
    const input = "😀".repeat(30_000);

    // Sanity check: confirm the naive cut point (payload budget bytes) really
    // does land inside a multi-byte sequence for this input/config, so the
    // test is proving something real rather than trivially passing.
    const notice = `\n\n[truncated: frozen completion output exceeded ${Math.round(
      FROZEN_RESULT_TEXT_MAX_BYTES / 1024,
    )}KB (${Math.round(Buffer.byteLength(input, "utf8") / 1024)}KB)]`;
    const naiveCap = FROZEN_RESULT_TEXT_MAX_BYTES - Buffer.byteLength(notice, "utf8");
    const rawBytes = Buffer.from(input, "utf8");
    const byteAtNaiveCap = rawBytes[naiveCap];
    expect((byteAtNaiveCap & 0xc0) === 0x80).toBe(true);

    const result = capFrozenResultText(input);

    expect(result).not.toContain("�");
    expect(Buffer.byteLength(result, "utf8")).toBeLessThanOrEqual(FROZEN_RESULT_TEXT_MAX_BYTES);
    expect(result).toContain("[truncated: frozen completion output exceeded");
  });

  it("does not shorten output further when the cap already lands on a character boundary", () => {
    // All-ASCII input: any byte-aligned cut point is automatically also a
    // character boundary, so the safe truncation must keep exactly as many
    // bytes as the naive approach would (no over-trimming regression).
    const input = "a".repeat(FROZEN_RESULT_TEXT_MAX_BYTES + 5_000);

    const result = capFrozenResultText(input);

    const notice = `\n\n[truncated: frozen completion output exceeded ${Math.round(
      FROZEN_RESULT_TEXT_MAX_BYTES / 1024,
    )}KB (${Math.round(Buffer.byteLength(input, "utf8") / 1024)}KB)]`;
    const expectedPayloadBytes = FROZEN_RESULT_TEXT_MAX_BYTES - Buffer.byteLength(notice, "utf8");
    const payload = result.slice(0, result.length - notice.length);

    expect(Buffer.byteLength(payload, "utf8")).toBe(expectedPayloadBytes);
  });

  it("returns the trimmed input unchanged when within the byte budget", () => {
    expect(capFrozenResultText("  hello world  ")).toBe("hello world");
  });

  it("returns an empty string for blank input", () => {
    expect(capFrozenResultText("   ")).toBe("");
  });
});
