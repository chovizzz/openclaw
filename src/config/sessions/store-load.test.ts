import fs from "node:fs/promises";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { withTempDir } from "../../test-helpers/temp-dir.js";
import type { SessionEntry } from "./types.js";

vi.mock("../config.js", async () => ({
  ...(await vi.importActual<typeof import("../config.js")>("../config.js")),
  loadConfig: vi.fn().mockReturnValue({}),
}));

let loadConfig: typeof import("../config.js").loadConfig;
let loadSessionStore: typeof import("./store-load.js").loadSessionStore;
let resolveMaintenanceConfig: typeof import("./store-maintenance.js").resolveMaintenanceConfig;
let mockLoadConfig: ReturnType<typeof vi.fn>;

const DAY_MS = 24 * 60 * 60_000;

function buildOversizedStore(params: {
  freshCount: number;
  staleCount: number;
}): Record<string, SessionEntry> {
  const now = Date.now();
  const store: Record<string, SessionEntry> = {};
  for (let i = 0; i < params.freshCount; i++) {
    store[`agent:main:fresh-${i}`] = {
      sessionId: `fresh-${i}`,
      // Stagger so cap-by-recency has a deterministic order.
      updatedAt: now - i,
    } as SessionEntry;
  }
  for (let i = 0; i < params.staleCount; i++) {
    store[`agent:main:stale-${i}`] = {
      sessionId: `stale-${i}`,
      updatedAt: now - 400 * DAY_MS,
    } as SessionEntry;
  }
  return store;
}

function enforceMaintenance() {
  mockLoadConfig.mockReturnValue({ session: { maintenance: { mode: "enforce" } } });
}

beforeEach(async () => {
  vi.resetModules();
  ({ loadConfig } = await import("../config.js"));
  ({ loadSessionStore } = await import("./store-load.js"));
  ({ resolveMaintenanceConfig } = await import("./store-maintenance.js"));
  mockLoadConfig = vi.mocked(loadConfig) as ReturnType<typeof vi.fn>;
  mockLoadConfig.mockReturnValue({});
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe("session store maintenance defaults", () => {
  it("keeps the warn default so unattended stores are never pruned implicitly", () => {
    // Fork decision: upstream flipped this to "enforce", which prunes on every
    // write with no active-session protection. Pruning is opt-in here.
    expect(resolveMaintenanceConfig().mode).toBe("warn");
  });
});

describe("loadSessionStore load-time maintenance", () => {
  it("prunes and caps an oversized store on load when enforce is opted in", async () => {
    enforceMaintenance();
    await withTempDir({ prefix: "openclaw-session-load-" }, async (dir) => {
      const storePath = path.join(dir, "sessions.json");
      const { maxEntries } = resolveMaintenanceConfig();
      const staleCount = 10;
      const freshCount = maxEntries + 5;
      await fs.writeFile(
        storePath,
        JSON.stringify(buildOversizedStore({ freshCount, staleCount })),
        "utf8",
      );

      const loaded = loadSessionStore(storePath, { skipCache: true });

      expect(Object.keys(loaded)).toHaveLength(maxEntries);
      // Every 400-day-old entry is gone, and the newest fresh entries survive.
      expect(Object.keys(loaded).some((key) => key.startsWith("agent:main:stale-"))).toBe(false);
      expect(loaded["agent:main:fresh-0"]).toBeDefined();
    });
  });

  it("leaves an oversized store untouched under the warn default", async () => {
    await withTempDir({ prefix: "openclaw-session-load-" }, async (dir) => {
      const storePath = path.join(dir, "sessions.json");
      const { maxEntries } = resolveMaintenanceConfig();
      const store = buildOversizedStore({ freshCount: maxEntries + 5, staleCount: 10 });
      await fs.writeFile(storePath, JSON.stringify(store), "utf8");

      const loaded = loadSessionStore(storePath, { skipCache: true });

      // Warn mode must not delete anything behind the operator's back.
      expect(Object.keys(loaded).toSorted()).toEqual(Object.keys(store).toSorted());
    });
  });

  it("leaves a store within the entry cap untouched even when enforced", async () => {
    enforceMaintenance();
    await withTempDir({ prefix: "openclaw-session-load-" }, async (dir) => {
      const storePath = path.join(dir, "sessions.json");
      // Stale but small: the load-time pass is gated on exceeding maxEntries so a
      // normal-sized store is never rewritten behind the operator's back.
      const store = buildOversizedStore({ freshCount: 1, staleCount: 2 });
      await fs.writeFile(storePath, JSON.stringify(store), "utf8");

      const loaded = loadSessionStore(storePath, { skipCache: true });

      expect(Object.keys(loaded).toSorted()).toEqual(Object.keys(store).toSorted());
    });
  });
});
