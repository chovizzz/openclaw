import { describe, expect, it } from "vitest";
import type { CronSchedule } from "../../cron/types.js";
import { needsStoredCronTz, preserveStoredCronTz } from "./schedule-options.js";

const storedCron: CronSchedule = {
  kind: "cron",
  expr: "0 * * * *",
  tz: "America/Phoenix",
  staggerMs: 120_000,
};

describe("needsStoredCronTz", () => {
  it("requires a lookup only for cron replacements that omit tz", () => {
    expect(needsStoredCronTz({ kind: "cron", expr: "0 */2 * * *" })).toBe(true);
    expect(needsStoredCronTz({ kind: "cron", expr: "0 */2 * * *", tz: "UTC" })).toBe(false);
    expect(needsStoredCronTz({ kind: "every", everyMs: 60_000 })).toBe(false);
    expect(needsStoredCronTz({ kind: "at", at: "2026-01-01T00:00:00Z" })).toBe(false);
  });
});

describe("preserveStoredCronTz", () => {
  it("carries the stored timezone into an expression-only edit", () => {
    const next = preserveStoredCronTz({ kind: "cron", expr: "0 */2 * * *" }, storedCron);

    expect(next).toEqual({ kind: "cron", expr: "0 */2 * * *", tz: "America/Phoenix" });
  });

  it("keeps an explicitly passed --tz instead of the stored one", () => {
    const next = preserveStoredCronTz({ kind: "cron", expr: "0 */2 * * *", tz: "UTC" }, storedCron);

    expect(next).toEqual({ kind: "cron", expr: "0 */2 * * *", tz: "UTC" });
  });

  it("does not invent a timezone when the stored job has none", () => {
    const next = preserveStoredCronTz(
      { kind: "cron", expr: "0 */2 * * *" },
      { kind: "cron", expr: "0 * * * *" },
    );

    expect(next).toEqual({ kind: "cron", expr: "0 */2 * * *" });
  });

  it("does not carry a timezone across a non-cron to cron conversion", () => {
    const next = preserveStoredCronTz(
      { kind: "cron", expr: "0 */2 * * *" },
      {
        kind: "every",
        everyMs: 60_000,
      },
    );

    expect(next).toEqual({ kind: "cron", expr: "0 */2 * * *" });
  });

  it("leaves non-cron replacements untouched", () => {
    const next: CronSchedule = { kind: "every", everyMs: 60_000 };

    expect(preserveStoredCronTz(next, storedCron)).toBe(next);
  });
});
