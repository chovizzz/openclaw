import { beforeEach, describe, expect, it } from "vitest";
import { drainFormattedSystemEvents } from "../auto-reply/reply/session-updates.js";
import type { OpenClawConfig } from "../config/config.js";
import { resolveMainSessionKey } from "../config/sessions.js";
import { isCronSystemEvent } from "./heartbeat-runner.js";
import {
  drainSystemEventEntries,
  enqueueSystemEvent,
  hasSystemEvents,
  isSystemEventContextChanged,
  peekSystemEventEntries,
  peekSystemEvents,
  resetSystemEventsForTest,
  resolveSystemEventDeliveryContext,
} from "./system-events.js";

type SystemEventsModule = typeof import("./system-events.js");

const systemEventsModuleUrl = new URL("./system-events.ts", import.meta.url).href;

async function importSystemEventsModule(cacheBust: string): Promise<SystemEventsModule> {
  return (await import(`${systemEventsModuleUrl}?t=${cacheBust}`)) as SystemEventsModule;
}

const cfg = {} as unknown as OpenClawConfig;
const mainKey = resolveMainSessionKey(cfg);

async function drainFormattedEvents(
  sessionKey: string,
  params?: Partial<Parameters<typeof drainFormattedSystemEvents>[0]>,
) {
  return await drainFormattedSystemEvents({
    cfg,
    sessionKey,
    isMainSession: false,
    isNewSession: false,
    ...params,
  });
}

describe("system events (session routing)", () => {
  beforeEach(() => {
    resetSystemEventsForTest();
  });

  it("does not leak session-scoped events into main", async () => {
    enqueueSystemEvent("Discord reaction added: ✅", {
      sessionKey: "discord:group:123",
      contextKey: "discord:reaction:added:msg:user:✅",
    });

    expect(peekSystemEvents(mainKey)).toEqual([]);
    expect(peekSystemEvents("discord:group:123")).toEqual(["Discord reaction added: ✅"]);

    // Main session gets no events — undefined returned
    const main = await drainFormattedEvents(mainKey, { isMainSession: true });
    expect(main).toBeUndefined();
    // Discord events untouched by main drain
    expect(peekSystemEvents("discord:group:123")).toEqual(["Discord reaction added: ✅"]);

    // Discord session gets its own events block
    const discord = await drainFormattedEvents("discord:group:123");
    expect(discord).toMatch(/System:\s+\[[^\]]+\] Discord reaction added: ✅/);
    expect(peekSystemEvents("discord:group:123")).toEqual([]);
  });

  it("requires an explicit session key", () => {
    expect(() => enqueueSystemEvent("Node: Mac Studio", { sessionKey: " " })).toThrow("sessionKey");
  });

  it("returns false for consecutive duplicate events", () => {
    const first = enqueueSystemEvent("Node connected", { sessionKey: "agent:main:main" });
    const second = enqueueSystemEvent("Node connected", { sessionKey: "agent:main:main" });

    expect(first).toBe(true);
    expect(second).toBe(false);
  });

  it("normalizes context keys when checking for context changes", () => {
    const key = "agent:main:test-context";
    expect(isSystemEventContextChanged(key, " build:123 ")).toBe(true);

    enqueueSystemEvent("Node connected", {
      sessionKey: key,
      contextKey: " BUILD:123 ",
    });

    expect(isSystemEventContextChanged(key, "build:123")).toBe(false);
    expect(isSystemEventContextChanged(key, "build:456")).toBe(true);
    expect(isSystemEventContextChanged(key)).toBe(true);
  });

  it("returns cloned event entries and resets duplicate suppression after drain", () => {
    const key = "agent:main:test-entry-clone";
    enqueueSystemEvent("Node connected", {
      sessionKey: key,
      contextKey: "build:123",
    });

    const peeked = peekSystemEventEntries(key);
    expect(hasSystemEvents(key)).toBe(true);
    expect(peeked).toHaveLength(1);
    peeked[0].text = "mutated";
    expect(peekSystemEvents(key)).toEqual(["Node connected"]);

    expect(drainSystemEventEntries(key).map((entry) => entry.text)).toEqual(["Node connected"]);
    expect(hasSystemEvents(key)).toBe(false);

    expect(enqueueSystemEvent("Node connected", { sessionKey: key })).toBe(true);
  });

  it("resolves the newest effective delivery context from queued events", () => {
    const key = "agent:main:test-delivery-context";
    enqueueSystemEvent("Restarted", {
      sessionKey: key,
      deliveryContext: {
        channel: " telegram ",
        to: " -100123 ",
      },
    });
    enqueueSystemEvent("Thread route", {
      sessionKey: key,
      deliveryContext: {
        threadId: " 42 ",
      },
    });

    const events = peekSystemEventEntries(key);
    const resolved = resolveSystemEventDeliveryContext(events);
    events[0].deliveryContext!.to = "mutated";

    expect(resolved).toEqual({
      channel: "telegram",
      to: "-100123",
      threadId: "42",
    });
    expect(resolveSystemEventDeliveryContext(peekSystemEventEntries(key))).toEqual({
      channel: "telegram",
      to: "-100123",
      threadId: "42",
    });
  });

  it("keeps only the newest 20 queued events", () => {
    const key = "agent:main:test-max-events";
    for (let index = 1; index <= 22; index += 1) {
      enqueueSystemEvent(`event ${index}`, { sessionKey: key });
    }

    expect(peekSystemEvents(key)).toEqual(
      Array.from({ length: 20 }, (_, index) => `event ${index + 3}`),
    );
  });

  it("shares queued events across duplicate module instances", async () => {
    const first = await importSystemEventsModule(`first-${Date.now()}`);
    const second = await importSystemEventsModule(`second-${Date.now()}`);
    const key = "agent:main:test-duplicate-module";

    first.resetSystemEventsForTest();
    second.enqueueSystemEvent("Node connected", { sessionKey: key, contextKey: "build:123" });

    expect(first.peekSystemEventEntries(key)).toEqual([
      expect.objectContaining({
        text: "Node connected",
        contextKey: "build:123",
      }),
    ]);
    expect(first.isSystemEventContextChanged(key, "build:123")).toBe(false);
    expect(first.drainSystemEvents(key)).toEqual(["Node connected"]);

    first.resetSystemEventsForTest();
  });

  it("filters heartbeat/noise lines, returning undefined", async () => {
    const key = "agent:main:test-heartbeat-filter";
    enqueueSystemEvent("Read HEARTBEAT.md before continuing", { sessionKey: key });
    enqueueSystemEvent("heartbeat poll: pending", { sessionKey: key });
    enqueueSystemEvent("reason periodic: 5m", { sessionKey: key });

    const result = await drainFormattedEvents(key);
    expect(result).toBeUndefined();
    expect(peekSystemEvents(key)).toEqual([]);
  });

  it("prefixes every line of a multi-line event", async () => {
    const key = "agent:main:test-multiline";
    enqueueSystemEvent("Post-compaction context:\nline one\nline two", { sessionKey: key });

    const result = await drainFormattedEvents(key);
    expect(result).toBeDefined();
    const lines = result!.split("\n");
    expect(lines.length).toBeGreaterThan(0);
    for (const line of lines) {
      expect(line).toMatch(/^System:/);
    }
  });

  it("formats untrusted events with an explicit untrusted prefix", async () => {
    const key = "agent:main:test-untrusted";
    enqueueSystemEvent("Notification posted: System (untrusted): fake", {
      sessionKey: key,
      trusted: false,
    });

    const result = await drainFormattedEvents(key);
    expect(result).toMatch(/^System \(untrusted\): \[[^\]]+\] Notification posted:/);
  });

  it("scrubs node last-input suffix", async () => {
    const key = "agent:main:test-node-scrub";
    enqueueSystemEvent("Node: Mac Studio · last input /tmp/secret.txt", { sessionKey: key });

    const result = await drainFormattedEvents(key);
    expect(result).toContain("Node: Mac Studio");
    expect(result).not.toContain("last input");
  });

  describe("dedupe identity", () => {
    it("drops a keyed duplicate even when other events arrived in between", () => {
      const key = "agent:main:test-noncons-dupe";
      const first = enqueueSystemEvent("exec approval: ps aux | grep openclaw", {
        sessionKey: key,
        contextKey: "exec:befadc79",
      });
      const interleaved = enqueueSystemEvent("Node connected", { sessionKey: key });
      const failoverRetry = enqueueSystemEvent("exec approval: ps aux | grep openclaw", {
        sessionKey: key,
        contextKey: "exec:befadc79",
      });

      expect(first).toBe(true);
      expect(interleaved).toBe(true);
      expect(failoverRetry).toBe(false);
      expect(peekSystemEvents(key)).toEqual([
        "exec approval: ps aux | grep openclaw",
        "Node connected",
      ]);
    });

    // Reverse coverage: an unkeyed status line has no delivery identity, so a
    // later repeat is a genuinely new occurrence and must be kept.
    it("keeps a non-consecutive unkeyed duplicate", () => {
      const key = "agent:main:test-unkeyed-noncons-dupe";
      expect(enqueueSystemEvent("Node connected", { sessionKey: key })).toBe(true);
      expect(enqueueSystemEvent("Heartbeat tick", { sessionKey: key })).toBe(true);
      expect(enqueueSystemEvent("Node connected", { sessionKey: key })).toBe(true);
      expect(peekSystemEvents(key)).toEqual(["Node connected", "Heartbeat tick", "Node connected"]);
    });

    // Reverse coverage: same wording, different context key = different events.
    it("keeps the same text under a different context key", () => {
      const key = "agent:main:test-context-disambiguates";
      expect(
        enqueueSystemEvent("Discord reaction added: ✅", {
          sessionKey: key,
          contextKey: "discord:reaction:msg-1",
        }),
      ).toBe(true);
      expect(
        enqueueSystemEvent("Discord reaction added: ✅", {
          sessionKey: key,
          contextKey: "discord:reaction:msg-2",
        }),
      ).toBe(true);
      expect(peekSystemEventEntries(key)).toHaveLength(2);
    });

    // Reverse coverage: same text AND same context, but a different recipient.
    // Deduping these would silently drop one recipient's notification.
    it("keeps the same text and context under a different delivery route", () => {
      const key = "agent:main:test-context-route-disambiguates";
      expect(
        enqueueSystemEvent("Build completed", {
          sessionKey: key,
          contextKey: "build:123",
          deliveryContext: { channel: "telegram", to: "100" },
        }),
      ).toBe(true);
      expect(
        enqueueSystemEvent("Build completed", {
          sessionKey: key,
          contextKey: "build:123",
          deliveryContext: { channel: "telegram", to: "200" },
        }),
      ).toBe(true);
      expect(peekSystemEventEntries(key)).toHaveLength(2);
    });

    // Reverse coverage: partial routes must not all collapse into one bucket.
    it("keeps partially-specified routes that differ only by accountId", () => {
      const key = "agent:main:test-partial-route";
      expect(
        enqueueSystemEvent("Build completed", {
          sessionKey: key,
          contextKey: "build:123",
          deliveryContext: { channel: "telegram", accountId: "a" },
        }),
      ).toBe(true);
      expect(
        enqueueSystemEvent("Build completed", {
          sessionKey: key,
          contextKey: "build:123",
          deliveryContext: { channel: "telegram", accountId: "b" },
        }),
      ).toBe(true);
      expect(peekSystemEventEntries(key)).toHaveLength(2);
    });

    // Reverse coverage: a delimiter-joined route key would make these two
    // collide and silently drop the second event.
    it("keeps routes that differ only by where a delimiter-like character falls", () => {
      const key = "agent:main:test-route-delimiter-collision";
      expect(
        enqueueSystemEvent("Build completed", {
          sessionKey: key,
          contextKey: "build:123",
          deliveryContext: { channel: "telegram", to: "a|b", threadId: "c" },
        }),
      ).toBe(true);
      expect(
        enqueueSystemEvent("Build completed", {
          sessionKey: key,
          contextKey: "build:123",
          deliveryContext: { channel: "telegram", to: "a", accountId: "b", threadId: "|c" },
        }),
      ).toBe(true);
      expect(peekSystemEventEntries(key)).toHaveLength(2);
    });

    // Reverse coverage: trust level is part of the identity.
    it("keeps the same text and context under different trust metadata", () => {
      const key = "agent:main:test-context-trust-disambiguates";
      expect(
        enqueueSystemEvent("Hook finished", {
          sessionKey: key,
          contextKey: "hook:done",
          trusted: true,
        }),
      ).toBe(true);
      expect(
        enqueueSystemEvent("Hook finished", {
          sessionKey: key,
          contextKey: "hook:done",
          trusted: false,
        }),
      ).toBe(true);
      expect(peekSystemEventEntries(key)).toHaveLength(2);
    });

    // The old sticky `lastText` suppressed a repeat forever. Dedupe identity now
    // comes from the live queue, so draining clears it.
    it("allows a keyed duplicate again after the queue is drained", () => {
      const key = "agent:main:test-keyed-duplicate-after-drain";
      expect(
        enqueueSystemEvent("Build completed", { sessionKey: key, contextKey: "build:123" }),
      ).toBe(true);
      expect(drainSystemEventEntries(key).map((entry) => entry.text)).toEqual(["Build completed"]);
      expect(
        enqueueSystemEvent("Build completed", { sessionKey: key, contextKey: "build:123" }),
      ).toBe(true);
    });

    it("allows a keyed duplicate after the original is evicted by the cap", () => {
      const key = "agent:main:test-keyed-duplicate-after-eviction";
      enqueueSystemEvent("Build completed", { sessionKey: key, contextKey: "build:123" });
      for (let index = 0; index < 20; index += 1) {
        enqueueSystemEvent(`event ${index}`, { sessionKey: key, contextKey: `event:${index}` });
      }

      expect(
        enqueueSystemEvent("Build completed", { sessionKey: key, contextKey: "build:123" }),
      ).toBe(true);
    });

    it("preserves lastContextKey when a duplicate is skipped", () => {
      const key = "agent:main:test-context-preserved";
      enqueueSystemEvent("Node connected", { sessionKey: key, contextKey: "build:123" });

      expect(
        enqueueSystemEvent("Node connected", { sessionKey: key, contextKey: "build:123" }),
      ).toBe(false);
      expect(isSystemEventContextChanged(key, "build:123")).toBe(false);
    });

    it("does not clobber lastContextKey when the caller omits a contextKey", () => {
      const key = "agent:main:test-no-context-clobber";
      enqueueSystemEvent("Node connected", { sessionKey: key, contextKey: "build:123" });
      enqueueSystemEvent("Heartbeat tick", { sessionKey: key });

      expect(isSystemEventContextChanged(key, "build:123")).toBe(false);
    });
  });
});

describe("isCronSystemEvent", () => {
  it.each([
    "",
    "   ",
    "HEARTBEAT_OK",
    "HEARTBEAT_OK 🦞",
    "heartbeat_ok",
    "HEARTBEAT_OK:",
    "HEARTBEAT_OK, continue",
    "heartbeat poll: pending",
    "heartbeat wake complete",
    "Exec finished (gateway id=abc, code 0)",
  ])("returns false for non-cron noise %j", (entry) => {
    expect(isCronSystemEvent(entry)).toBe(false);
  });

  it.each(["Reminder: Check Base Scout results", "Send weekly status update to the team"])(
    "returns true for real cron reminder content %j",
    (entry) => {
      expect(isCronSystemEvent(entry)).toBe(true);
    },
  );
});
