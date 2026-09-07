import { describe, expect, it } from "vitest";
import { truncateCloseReason } from "./close-reason.js";

describe("truncateCloseReason", () => {
  it("returns the reason unchanged when it fits within the byte cap", () => {
    expect(truncateCloseReason("short reason")).toBe("short reason");
  });

  it("returns 'invalid handshake' for empty string", () => {
    expect(truncateCloseReason("")).toBe("invalid handshake");
  });

  it("truncates ASCII-only reasons at exactly maxBytes", () => {
    const reason = "a".repeat(200);
    const result = truncateCloseReason(reason);
    expect(Buffer.byteLength(result)).toBe(120);
    expect(result).toBe("a".repeat(120));
  });

  it("does not cut mid-UTF-8 sequence for 4-byte chars (e.g. emoji)", () => {
    // 118 ASCII chars + emoji starting at byte 118. Each 😀 is 4 UTF-8 bytes, so
    // the naive Buffer.subarray(0, 120) cuts at byte 2 of the first emoji's
    // sequence. Confirm the cut point genuinely lands inside that sequence
    // first: byte 120 must be a UTF-8 continuation byte (10xxxxxx, i.e. its
    // top two bits are 10).
    const reason = "x".repeat(118) + "😀".repeat(5);
    const buf = Buffer.from(reason);
    expect((buf[120] & 0xc0) === 0x80).toBe(true);

    const result = truncateCloseReason(reason);
    expect(Buffer.byteLength(result)).toBeLessThanOrEqual(120);
    expect(result).not.toContain("�");
    expect(result).toBe("x".repeat(118));
  });

  it("does not cut mid-UTF-8 sequence for 2-byte chars (e.g. é)", () => {
    // Each 'é' is 2 bytes. 119 'a' + 'é' occupies bytes 119-120; cap is 120,
    // which falls on the continuation byte of 'é'. Confirm that first.
    const reason = "a".repeat(119) + "é".repeat(5);
    const buf = Buffer.from(reason);
    expect((buf[120] & 0xc0) === 0x80).toBe(true);

    const result = truncateCloseReason(reason);
    expect(Buffer.byteLength(result)).toBeLessThanOrEqual(120);
    expect(result).not.toContain("�");
    expect(result).toBe("a".repeat(119));
  });

  it("does not cut mid-UTF-8 sequence for 3-byte chars (e.g. ✓)", () => {
    // Each '✓' is 3 bytes. 119 'a' + '✓' occupies bytes 119-121; the naive
    // slice at byte 120 cuts the second byte of '✓'. Confirm that first.
    const reason = "a".repeat(119) + "✓".repeat(5);
    const buf = Buffer.from(reason);
    expect((buf[120] & 0xc0) === 0x80).toBe(true);

    const result = truncateCloseReason(reason);
    expect(Buffer.byteLength(result)).toBeLessThanOrEqual(120);
    expect(result).not.toContain("�");
    expect(result).toBe("a".repeat(119));
  });

  it("does not shorten a reason whose byte cap lands on a normal ASCII boundary", () => {
    // No multi-byte sequence anywhere near byte 120: the cap must keep exactly
    // 120 bytes, not back up further than necessary.
    const reason = "a".repeat(130);
    const buf = Buffer.from(reason);
    expect((buf[120] & 0xc0) === 0x80).toBe(false);

    const result = truncateCloseReason(reason);
    expect(Buffer.byteLength(result)).toBe(120);
    expect(result).toBe("a".repeat(120));
  });

  it("respects a custom maxBytes cap", () => {
    const reason = "😀".repeat(10); // each 4 bytes = 40 bytes
    const result = truncateCloseReason(reason, 10);
    expect(Buffer.byteLength(result)).toBeLessThanOrEqual(10);
    expect(result).not.toContain("�");
    expect(result).toBe("😀".repeat(2)); // 8 bytes, next emoji would exceed 10
  });
});
