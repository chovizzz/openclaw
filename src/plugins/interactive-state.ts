import { resolveGlobalDedupeCache } from "../infra/dedupe.js";
import type { DedupeCache } from "../infra/dedupe.js";
import type { PluginInteractiveHandlerRegistration } from "./types.js";

export type RegisteredInteractiveHandler = PluginInteractiveHandlerRegistration & {
  pluginId: string;
  pluginName?: string;
  pluginRoot?: string;
};

type InteractiveState = {
  interactiveHandlers: Map<string, RegisteredInteractiveHandler>;
  callbackDedupe: DedupeCache;
};

const PLUGIN_INTERACTIVE_STATE_KEY = Symbol.for("openclaw.pluginInteractiveState");
const PLUGIN_INTERACTIVE_CALLBACK_DEDUPE_KEY = Symbol.for(
  "openclaw.pluginInteractiveCallbackDedupe",
);

function createInteractiveCallbackDedupe(): DedupeCache {
  return resolveGlobalDedupeCache(PLUGIN_INTERACTIVE_CALLBACK_DEDUPE_KEY, {
    ttlMs: 5 * 60_000,
    maxSize: 4096,
  });
}

function createInteractiveState(): InteractiveState {
  return {
    interactiveHandlers: new Map<string, RegisteredInteractiveHandler>(),
    callbackDedupe: createInteractiveCallbackDedupe(),
  };
}

// A globally-keyed singleton can outlive this module: an older OpenClaw build sharing the
// same realm may have stored a differently-shaped object under the same global symbol.
// Re-derive a well-formed state from whatever is there instead of trusting the shape,
// so callers never hit `undefined.clear()` (see #70135: doctor crashed on legacy state).
function hydrateInteractiveState(value: unknown): InteractiveState {
  const state =
    typeof value === "object" && value !== null
      ? (value as Partial<InteractiveState>)
      : ({} as Partial<InteractiveState>);

  return {
    interactiveHandlers:
      state.interactiveHandlers instanceof Map
        ? state.interactiveHandlers
        : new Map<string, RegisteredInteractiveHandler>(),
    callbackDedupe: createInteractiveCallbackDedupe(),
  };
}

function getState(): InteractiveState {
  const globalStore = globalThis as Record<PropertyKey, unknown>;
  const existing = globalStore[PLUGIN_INTERACTIVE_STATE_KEY];
  if (existing !== undefined) {
    const hydrated = hydrateInteractiveState(existing);
    globalStore[PLUGIN_INTERACTIVE_STATE_KEY] = hydrated;
    return hydrated;
  }

  const created = createInteractiveState();
  globalStore[PLUGIN_INTERACTIVE_STATE_KEY] = created;
  return created;
}

export function getPluginInteractiveHandlersState() {
  return getState().interactiveHandlers;
}

export function getPluginInteractiveCallbackDedupeState() {
  return getState().callbackDedupe;
}

export function clearPluginInteractiveHandlersState(): void {
  getPluginInteractiveHandlersState().clear();
  getPluginInteractiveCallbackDedupeState().clear();
}
