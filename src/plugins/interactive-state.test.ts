import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  clearPluginInteractiveHandlersState,
  getPluginInteractiveCallbackDedupeState,
  getPluginInteractiveHandlersState,
  type RegisteredInteractiveHandler,
} from "./interactive-state.js";

const PLUGIN_INTERACTIVE_STATE_KEY = Symbol.for("openclaw.pluginInteractiveState");

const globalStore = globalThis as Record<PropertyKey, unknown>;

type HydratedState = {
  interactiveHandlers?: unknown;
  callbackDedupe?: { clear?: unknown };
};

let originalState: unknown;

function makeHandler(pluginId: string): RegisteredInteractiveHandler {
  return {
    channel: "telegram",
    namespace: "legacy",
    handler: async () => ({ handled: true }),
    pluginId,
  } as RegisteredInteractiveHandler;
}

beforeEach(() => {
  originalState = globalStore[PLUGIN_INTERACTIVE_STATE_KEY];
});

afterEach(() => {
  // Clear the state this test created *before* restoring, so we never clear a
  // restored state that belongs to another test file sharing this global key.
  clearPluginInteractiveHandlersState();
  if (originalState === undefined) {
    delete globalStore[PLUGIN_INTERACTIVE_STATE_KEY];
  } else {
    globalStore[PLUGIN_INTERACTIVE_STATE_KEY] = originalState;
  }
});

describe("plugin interactive state hydration", () => {
  it("does not throw when a legacy global state is missing callbackDedupe", () => {
    // An older OpenClaw build in the same realm stored state under the same global
    // symbol without a dedupe cache; clearing used to crash on `undefined.clear()`.
    globalStore[PLUGIN_INTERACTIVE_STATE_KEY] = { interactiveHandlers: new Map() };

    expect(() => clearPluginInteractiveHandlersState()).not.toThrow();

    const hydrated = globalStore[PLUGIN_INTERACTIVE_STATE_KEY] as HydratedState;
    expect(hydrated.interactiveHandlers).toBeInstanceOf(Map);
    expect(hydrated.callbackDedupe?.clear).toEqual(expect.any(Function));
  });

  it("keeps handlers registered by a legacy state instead of dropping them", () => {
    const legacyHandlers = new Map<string, RegisteredInteractiveHandler>([
      ["telegram:legacy", makeHandler("legacy-plugin")],
    ]);
    globalStore[PLUGIN_INTERACTIVE_STATE_KEY] = { interactiveHandlers: legacyHandlers };

    const handlers = getPluginInteractiveHandlersState();
    expect(handlers).toBe(legacyHandlers);
    expect(handlers.get("telegram:legacy")?.pluginId).toBe("legacy-plugin");
  });

  it("recovers from a non-object global state value", () => {
    globalStore[PLUGIN_INTERACTIVE_STATE_KEY] = "not-a-state";

    expect(() => clearPluginInteractiveHandlersState()).not.toThrow();
    expect(getPluginInteractiveHandlersState()).toBeInstanceOf(Map);
    expect(getPluginInteractiveCallbackDedupeState().size()).toBe(0);
  });

  it("still dedupes callbacks after hydrating a legacy state", () => {
    globalStore[PLUGIN_INTERACTIVE_STATE_KEY] = { interactiveHandlers: new Map() };
    clearPluginInteractiveHandlersState();

    const dedupe = getPluginInteractiveCallbackDedupeState();
    expect(dedupe.check("legacy-state-cb")).toBe(false);
    expect(dedupe.check("legacy-state-cb")).toBe(true);
  });

  it("returns a stable handlers map across calls once hydrated", () => {
    globalStore[PLUGIN_INTERACTIVE_STATE_KEY] = { interactiveHandlers: new Map() };

    const first = getPluginInteractiveHandlersState();
    first.set("telegram:legacy", makeHandler("plugin-a"));
    expect(getPluginInteractiveHandlersState()).toBe(first);
    expect(getPluginInteractiveHandlersState().get("telegram:legacy")?.pluginId).toBe("plugin-a");
  });
});
