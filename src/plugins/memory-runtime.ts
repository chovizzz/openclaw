import type { OpenClawConfig } from "../config/config.js";
import { resolveRuntimePluginRegistry } from "./loader.js";
import { getMemoryRuntime, setMemorySearchManagerActive } from "./memory-state.js";
import {
  buildPluginRuntimeLoadOptions,
  resolvePluginRuntimeLoadContext,
} from "./runtime/load-context.js";

function ensureMemoryRuntime(cfg?: OpenClawConfig) {
  const current = getMemoryRuntime();
  if (current || !cfg) {
    return current;
  }
  resolveRuntimePluginRegistry(
    buildPluginRuntimeLoadOptions(resolvePluginRuntimeLoadContext({ config: cfg })),
  );
  return getMemoryRuntime();
}

export async function getActiveMemorySearchManager(params: {
  cfg: OpenClawConfig;
  agentId: string;
  purpose?: "default" | "status";
}) {
  const runtime = ensureMemoryRuntime(params.cfg);
  if (!runtime) {
    return { manager: null, error: "memory plugin unavailable" };
  }
  // Arm before the call, not after: a rejected acquisition can still have
  // opened a sqlite handle or an embedding provider, so CLI teardown must run.
  setMemorySearchManagerActive(true);
  return await runtime.getMemorySearchManager(params);
}

export function resolveActiveMemoryBackendConfig(params: { cfg: OpenClawConfig; agentId: string }) {
  return ensureMemoryRuntime(params.cfg)?.resolveMemoryBackendConfig(params) ?? null;
}

export async function closeActiveMemorySearchManagers(cfg?: OpenClawConfig): Promise<void> {
  void cfg;
  const runtime = getMemoryRuntime();
  // Bound at capture so the reference cannot be called with the wrong `this`.
  const closeAll = runtime?.closeAllMemorySearchManagers
    ? () => runtime.closeAllMemorySearchManagers!()
    : undefined;
  if (!closeAll) {
    // Nothing to close *through* — most likely a plugin registry reload dropped
    // the capability while managers are still open in the plugin's own cache.
    // Staying armed keeps the CLI teardown gate open for a later attempt;
    // disarming here would report success for a teardown that never ran.
    return;
  }
  await closeAll();
  // Disarm only after the runtime's close-all resolved; a throwing close leaves
  // the flag set so a later attempt still runs. Note this is not a guarantee
  // that every handle is released: memory-core's own close paths swallow some
  // per-manager close errors, so a resolved promise means "teardown ran", not
  // "teardown fully succeeded".
  setMemorySearchManagerActive(false);
}
