import fs from "node:fs/promises";
import path from "node:path";
import { describe, expect, it, vi } from "vitest";
import { setupCronServiceSuite } from "../service.test-harness.js";
import { findJobOrThrow } from "./jobs.js";
import { createCronServiceState } from "./state.js";
import { ensureLoaded, persist } from "./store.js";

const { logger, makeStorePath } = setupCronServiceSuite({
  prefix: "cron-service-store-seam",
});

describe("cron service store seam coverage", () => {
  it("loads stored jobs, recomputes next runs, and does not rewrite the store on load", async () => {
    const { storePath } = await makeStorePath();
    const now = Date.parse("2026-03-23T12:00:00.000Z");

    await fs.mkdir(path.dirname(storePath), { recursive: true });
    await fs.writeFile(
      storePath,
      JSON.stringify(
        {
          version: 1,
          jobs: [
            {
              id: "modern-job",
              name: "modern job",
              enabled: true,
              createdAtMs: now - 60_000,
              updatedAtMs: now - 60_000,
              schedule: { kind: "every", everyMs: 60_000 },
              sessionTarget: "isolated",
              wakeMode: "now",
              payload: { kind: "agentTurn", message: "ping" },
              delivery: { mode: "announce", channel: "telegram", to: "123" },
              state: {},
            },
          ],
        },
        null,
        2,
      ),
      "utf8",
    );

    const state = createCronServiceState({
      storePath,
      cronEnabled: true,
      log: logger,
      nowMs: () => now,
      enqueueSystemEvent: vi.fn(),
      requestHeartbeatNow: vi.fn(),
      runIsolatedAgentJob: vi.fn(async () => ({ status: "ok" as const })),
    });

    await ensureLoaded(state);

    const job = state.store?.jobs[0];
    expect(job).toBeDefined();
    expect(job?.sessionTarget).toBe("isolated");
    expect(job?.payload.kind).toBe("agentTurn");
    if (job?.payload.kind === "agentTurn") {
      expect(job.payload.message).toBe("ping");
    }
    expect(job?.delivery).toMatchObject({
      mode: "announce",
      channel: "telegram",
      to: "123",
    });
    expect(job?.state.nextRunAtMs).toBe(now);

    const persisted = JSON.parse(await fs.readFile(storePath, "utf8")) as {
      jobs: Array<Record<string, unknown>>;
    };
    const persistedJob = persisted.jobs[0];
    expect(persistedJob?.payload).toMatchObject({
      kind: "agentTurn",
      message: "ping",
    });
    expect(persistedJob?.delivery).toMatchObject({
      mode: "announce",
      channel: "telegram",
      to: "123",
    });

    const firstMtime = state.storeFileMtimeMs;
    expect(typeof firstMtime).toBe("number");

    await persist(state);
    expect(typeof state.storeFileMtimeMs).toBe("number");
    expect((state.storeFileMtimeMs ?? 0) >= (firstMtime ?? 0)).toBe(true);
  });

  it("normalizes jobId-only jobs in memory so scheduler lookups resolve by stable id", async () => {
    const { storePath } = await makeStorePath();
    const now = Date.parse("2026-03-23T12:00:00.000Z");

    await fs.mkdir(path.dirname(storePath), { recursive: true });
    await fs.writeFile(
      storePath,
      JSON.stringify(
        {
          version: 1,
          jobs: [
            {
              jobId: "repro-stable-id",
              name: "handed",
              enabled: true,
              createdAtMs: now - 60_000,
              updatedAtMs: now - 60_000,
              schedule: { kind: "every", everyMs: 60_000 },
              sessionTarget: "main",
              wakeMode: "now",
              payload: { kind: "systemEvent", text: "tick" },
              state: {},
            },
          ],
        },
        null,
        2,
      ),
      "utf8",
    );

    const state = createCronServiceState({
      storePath,
      cronEnabled: true,
      log: logger,
      nowMs: () => now,
      enqueueSystemEvent: vi.fn(),
      requestHeartbeatNow: vi.fn(),
      runIsolatedAgentJob: vi.fn(async () => ({ status: "ok" as const })),
    });

    await ensureLoaded(state);

    expect(logger.warn).toHaveBeenCalledWith(
      expect.objectContaining({ storePath, jobId: "repro-stable-id" }),
      expect.stringContaining("legacy jobId"),
    );

    const job = findJobOrThrow(state, "repro-stable-id");
    expect(job.id).toBe("repro-stable-id");
    expect((job as { jobId?: unknown }).jobId).toBeUndefined();

    const raw = JSON.parse(await fs.readFile(storePath, "utf8")) as {
      jobs: Array<Record<string, unknown>>;
    };
    expect(raw.jobs[0]?.jobId).toBe("repro-stable-id");
    expect(raw.jobs[0]?.id).toBeUndefined();
  });

  it("preserves disabled jobs when persisted booleans roundtrip through string values", async () => {
    const { storePath } = await makeStorePath();
    const now = Date.parse("2026-03-23T12:00:00.000Z");

    await fs.mkdir(path.dirname(storePath), { recursive: true });
    await fs.writeFile(
      storePath,
      JSON.stringify(
        {
          version: 1,
          jobs: [
            {
              id: "disabled-string-job",
              name: "disabled string job",
              enabled: "false",
              createdAtMs: now - 60_000,
              updatedAtMs: now - 60_000,
              schedule: { kind: "every", everyMs: 60_000 },
              sessionTarget: "main",
              wakeMode: "now",
              payload: { kind: "systemEvent", text: "tick" },
              state: {},
            },
          ],
        },
        null,
        2,
      ),
      "utf8",
    );

    const before = await fs.readFile(storePath, "utf8");
    const state = createCronServiceState({
      storePath,
      cronEnabled: true,
      log: logger,
      nowMs: () => now,
      enqueueSystemEvent: vi.fn(),
      requestHeartbeatNow: vi.fn(),
      runIsolatedAgentJob: vi.fn(async () => ({ status: "ok" as const })),
    });

    await ensureLoaded(state);

    const job = findJobOrThrow(state, "disabled-string-job");
    expect(job.enabled).toBe(false);

    const after = await fs.readFile(storePath, "utf8");
    expect(after).toBe(before);
  });

  it("preserves schedule tz and staggerMs verbatim when loading cron jobs", async () => {
    const { storePath } = await makeStorePath();
    const now = Date.parse("2026-03-23T12:00:00.000Z");

    await fs.mkdir(path.dirname(storePath), { recursive: true });
    await fs.writeFile(
      storePath,
      JSON.stringify(
        {
          version: 1,
          jobs: [
            {
              id: "tz-job",
              name: "tz job",
              enabled: true,
              createdAtMs: now - 60_000,
              updatedAtMs: now - 60_000,
              schedule: { kind: "cron", expr: "0 9 * * *", tz: "Asia/Shanghai", staggerMs: 12_345 },
              sessionTarget: "main",
              wakeMode: "now",
              payload: { kind: "systemEvent", text: "tick" },
              state: {},
            },
            {
              id: "tz-job-exact",
              name: "tz job with explicit zero stagger",
              enabled: true,
              createdAtMs: now - 60_000,
              updatedAtMs: now - 60_000,
              schedule: { kind: "cron", expr: "0 * * * *", tz: "Asia/Shanghai", staggerMs: 0 },
              sessionTarget: "main",
              wakeMode: "now",
              payload: { kind: "systemEvent", text: "tick" },
              state: {},
            },
            {
              id: "tz-job-no-stagger",
              name: "tz job without stagger",
              enabled: true,
              createdAtMs: now - 60_000,
              updatedAtMs: now - 60_000,
              schedule: { kind: "cron", expr: "0 * * * *", tz: "Asia/Shanghai" },
              sessionTarget: "main",
              wakeMode: "now",
              payload: { kind: "systemEvent", text: "tick" },
              state: {},
            },
          ],
        },
        null,
        2,
      ),
      "utf8",
    );

    const before = await fs.readFile(storePath, "utf8");
    const state = createCronServiceState({
      storePath,
      cronEnabled: true,
      log: logger,
      nowMs: () => now,
      enqueueSystemEvent: vi.fn(),
      requestHeartbeatNow: vi.fn(),
      runIsolatedAgentJob: vi.fn(async () => ({ status: "ok" as const })),
    });

    await ensureLoaded(state);

    const job = findJobOrThrow(state, "tz-job");
    expect(job.schedule).toEqual({
      kind: "cron",
      expr: "0 9 * * *",
      tz: "Asia/Shanghai",
      staggerMs: 12_345,
    });
    // Loading must not inject the top-of-hour stagger default.
    const noStagger = findJobOrThrow(state, "tz-job-no-stagger");
    expect(noStagger.schedule).toEqual({ kind: "cron", expr: "0 * * * *", tz: "Asia/Shanghai" });
    // An explicit staggerMs of 0 ("exact") must not be dropped or defaulted either.
    const exact = findJobOrThrow(state, "tz-job-exact");
    expect(exact.schedule).toEqual({
      kind: "cron",
      expr: "0 * * * *",
      tz: "Asia/Shanghai",
      staggerMs: 0,
    });

    const after = await fs.readFile(storePath, "utf8");
    expect(after).toBe(before);
  });

  it("does not rewrite persisted payload fields such as a fractional timeoutSeconds", async () => {
    const { storePath } = await makeStorePath();
    const now = Date.parse("2026-03-23T12:00:00.000Z");

    await fs.mkdir(path.dirname(storePath), { recursive: true });
    await fs.writeFile(
      storePath,
      JSON.stringify(
        {
          version: 1,
          jobs: [
            {
              id: "fractional-timeout-job",
              name: "fractional timeout job",
              enabled: true,
              createdAtMs: now - 60_000,
              updatedAtMs: now - 60_000,
              schedule: { kind: "cron", expr: "0 9 * * *", tz: "Asia/Shanghai" },
              sessionTarget: "isolated",
              wakeMode: "now",
              payload: { kind: "agentTurn", message: "work", timeoutSeconds: 0.0025 },
              state: {},
            },
          ],
        },
        null,
        2,
      ),
      "utf8",
    );

    const state = createCronServiceState({
      storePath,
      cronEnabled: true,
      log: logger,
      nowMs: () => now,
      enqueueSystemEvent: vi.fn(),
      requestHeartbeatNow: vi.fn(),
      runIsolatedAgentJob: vi.fn(async () => ({ status: "ok" as const })),
    });

    await ensureLoaded(state);

    // Flooring this to 0 would mean "no timeout" (see resolveAgentTimeoutMs),
    // so loading must leave the persisted value untouched.
    const job = findJobOrThrow(state, "fractional-timeout-job");
    expect(job.payload).toEqual({ kind: "agentTurn", message: "work", timeoutSeconds: 0.0025 });
  });
});
