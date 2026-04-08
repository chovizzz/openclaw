import type {
  BundledChannelEntryContract,
  BundledChannelSetupEntryContract,
} from "../plugin-sdk/channel-entry-contract.js";
import type { OpenClawPluginDefinition } from "./types.js";

/**
 * Unwrap nested `default` exports (e.g. `{ default: { default: plugin } }`) until we find
 * a function or an object that already exposes `register`/`activate`. This matches common
 * ESM/CJS interop shapes from bundlers and jiti.
 */
export function unwrapPluginModuleDefaultExport(moduleExport: unknown): unknown {
  let current: unknown = moduleExport;
  for (let depth = 0; depth < 16; depth++) {
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

/** Resolve bundled channel entry exports (same nested-default rules as plugin loader). */
export function resolveBundledChannelEntryContract(
  moduleExport: unknown,
): BundledChannelEntryContract | null {
  const resolved = unwrapPluginModuleDefaultExport(moduleExport);
  if (!resolved || typeof resolved !== "object") {
    return null;
  }
  const record = resolved as Partial<BundledChannelEntryContract>;
  if (record.kind !== "bundled-channel-entry") {
    return null;
  }
  if (
    typeof record.id !== "string" ||
    typeof record.name !== "string" ||
    typeof record.description !== "string" ||
    typeof record.register !== "function" ||
    typeof record.loadChannelPlugin !== "function"
  ) {
    return null;
  }
  return record as BundledChannelEntryContract;
}

/** Resolve bundled channel setup entry exports (same nested-default rules as plugin loader). */
export function resolveBundledChannelSetupEntryContract(
  moduleExport: unknown,
): BundledChannelSetupEntryContract | null {
  const resolved = unwrapPluginModuleDefaultExport(moduleExport);
  if (!resolved || typeof resolved !== "object") {
    return null;
  }
  const record = resolved as Partial<BundledChannelSetupEntryContract>;
  if (record.kind !== "bundled-channel-setup-entry") {
    return null;
  }
  if (typeof record.loadSetupPlugin !== "function") {
    return null;
  }
  return record as BundledChannelSetupEntryContract;
}
