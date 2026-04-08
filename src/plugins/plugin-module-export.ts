import type { OpenClawPluginDefinition } from "./types.js";

/**
 * Unwrap nested `default` exports (e.g. `{ default: { default: plugin } }`) until we find
 * a function or an object that already exposes `register`/`activate`. This matches common
 * ESM/CJS interop shapes from bundlers and jiti.
 */
export function unwrapPluginModuleDefaultExport(moduleExport: unknown): unknown {
  let current: unknown = moduleExport;
  for (let depth = 0; depth < 8; depth++) {
    if (typeof current === "function") {
      return current;
    }
    if (current && typeof current === "object") {
      const obj = current as Record<string, unknown>;
      const register = obj.register ?? obj.activate;
      if (typeof register === "function") {
        return current;
      }
      if ("default" in obj) {
        const next = obj.default;
        if (next === current) {
          return current;
        }
        current = next;
        continue;
      }
    }
    break;
  }
  return current;
}

export function resolvePluginModuleExport(moduleExport: unknown): {
  definition?: OpenClawPluginDefinition;
  register?: OpenClawPluginDefinition["register"];
} {
  const resolved = unwrapPluginModuleDefaultExport(moduleExport);
  if (typeof resolved === "function") {
    return {
      register: resolved as OpenClawPluginDefinition["register"],
    };
  }
  if (resolved && typeof resolved === "object") {
    const def = resolved as OpenClawPluginDefinition;
    const register = def.register ?? def.activate;
    return { definition: def, register };
  }
  return {};
}
