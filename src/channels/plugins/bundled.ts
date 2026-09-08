import path from "node:path";
import { fileURLToPath } from "node:url";
import { formatErrorMessage } from "../../infra/errors.js";
import { resolveOpenClawPackageRootSync } from "../../infra/openclaw-root.js";
import { createSubsystemLogger } from "../../logging/subsystem.js";
import {
  listBundledChannelPluginMetadata,
  resolveBundledChannelGeneratedPath,
  type BundledChannelPluginMetadata,
} from "../../plugins/bundled-channel-runtime.js";
import type { PluginRuntime } from "../../plugins/runtime/types.js";
import { isJavaScriptModulePath, loadChannelPluginModule } from "./module-loader.js";
import type { ChannelId, ChannelPlugin } from "./types.js";

// Core owns its own runtime-shape view of the bundled entry contract instead of
// importing the plugin-facing type from `../../plugin-sdk/channel-entry-contract.js`.
// `src/plugin-sdk/*` is the public contract extensions build against; core
// depending back on it for its own internal loader typing creates an
// unnecessary core -> plugin-sdk -> core back-edge. This mirrors only the
// fields bundled.ts actually reads off a loaded module at runtime.
type BundledChannelEntryRuntimeContract = {
  kind: "bundled-channel-entry";
  id: string;
  name: string;
  description: string;
  register: (api: unknown) => void;
  loadChannelPlugin: () => ChannelPlugin;
  loadChannelSecrets?: () => ChannelPlugin["secrets"] | undefined;
  setChannelRuntime?: (runtime: PluginRuntime) => void;
};

type BundledChannelSetupEntryRuntimeContract = {
  kind: "bundled-channel-setup-entry";
  loadSetupPlugin: () => ChannelPlugin;
  loadSetupSecrets?: () => ChannelPlugin["secrets"] | undefined;
};

type GeneratedBundledChannelEntry = {
  id: string;
  entry: BundledChannelEntryRuntimeContract;
  setupEntry?: BundledChannelSetupEntryRuntimeContract;
};

const log = createSubsystemLogger("channels");
const OPENCLAW_PACKAGE_ROOT =
  resolveOpenClawPackageRootSync({
    argv1: process.argv[1],
    cwd: process.cwd(),
    moduleUrl: import.meta.url.startsWith("file:") ? import.meta.url : undefined,
  }) ??
  (import.meta.url.startsWith("file:")
    ? path.resolve(fileURLToPath(new URL("../../..", import.meta.url)))
    : process.cwd());

function resolveChannelPluginModuleEntry(
  moduleExport: unknown,
): BundledChannelEntryRuntimeContract | null {
  const resolved =
    moduleExport &&
    typeof moduleExport === "object" &&
    "default" in (moduleExport as Record<string, unknown>)
      ? (moduleExport as { default: unknown }).default
      : moduleExport;
  if (!resolved || typeof resolved !== "object") {
    return null;
  }
  const record = resolved as Partial<BundledChannelEntryRuntimeContract>;
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
  return record as BundledChannelEntryRuntimeContract;
}

function resolveChannelSetupModuleEntry(
  moduleExport: unknown,
): BundledChannelSetupEntryRuntimeContract | null {
  const resolved =
    moduleExport &&
    typeof moduleExport === "object" &&
    "default" in (moduleExport as Record<string, unknown>)
      ? (moduleExport as { default: unknown }).default
      : moduleExport;
  if (!resolved || typeof resolved !== "object") {
    return null;
  }
  const record = resolved as Partial<BundledChannelSetupEntryRuntimeContract>;
  if (record.kind !== "bundled-channel-setup-entry") {
    return null;
  }
  if (typeof record.loadSetupPlugin !== "function") {
    return null;
  }
  return record as BundledChannelSetupEntryRuntimeContract;
}

function resolveBundledChannelBoundaryRoot(params: {
  metadata: BundledChannelPluginMetadata;
  modulePath: string;
}): string {
  const distRoot = path.resolve(
    OPENCLAW_PACKAGE_ROOT,
    "dist",
    "extensions",
    params.metadata.dirName,
  );
  if (params.modulePath === distRoot || params.modulePath.startsWith(`${distRoot}${path.sep}`)) {
    return distRoot;
  }
  return path.resolve(OPENCLAW_PACKAGE_ROOT, "extensions", params.metadata.dirName);
}

function resolveGeneratedBundledChannelModulePath(params: {
  metadata: BundledChannelPluginMetadata;
  entry: BundledChannelPluginMetadata["source"] | BundledChannelPluginMetadata["setupSource"];
}): string | null {
  if (!params.entry) {
    return null;
  }
  const resolved = resolveBundledChannelGeneratedPath(
    OPENCLAW_PACKAGE_ROOT,
    params.entry,
    params.metadata.dirName,
  );
  if (resolved) {
    return resolved;
  }
  return null;
}

function loadGeneratedBundledChannelModule(params: {
  metadata: BundledChannelPluginMetadata;
  entry: BundledChannelPluginMetadata["source"] | BundledChannelPluginMetadata["setupSource"];
}): unknown {
  const modulePath = resolveGeneratedBundledChannelModulePath(params);
  if (!modulePath) {
    throw new Error(`missing generated module for bundled channel ${params.metadata.manifest.id}`);
  }
  return loadChannelPluginModule({
    modulePath,
    rootDir: resolveBundledChannelBoundaryRoot({
      metadata: params.metadata,
      modulePath,
    }),
    boundaryRootDir: resolveBundledChannelBoundaryRoot({
      metadata: params.metadata,
      modulePath,
    }),
    shouldTryNativeRequire: (safePath) =>
      safePath.includes(`${path.sep}dist${path.sep}`) && isJavaScriptModulePath(safePath),
  });
}

function loadGeneratedBundledChannelEntries(): readonly GeneratedBundledChannelEntry[] {
  const entries: GeneratedBundledChannelEntry[] = [];

  for (const metadata of listBundledChannelPluginMetadata({
    includeChannelConfigs: false,
    includeSyntheticChannelConfigs: false,
  })) {
    if ((metadata.manifest.channels?.length ?? 0) === 0) {
      continue;
    }

    try {
      const entry = resolveChannelPluginModuleEntry(
        loadGeneratedBundledChannelModule({
          metadata,
          entry: metadata.source,
        }),
      );
      if (!entry) {
        log.warn(
          `[channels] bundled channel entry ${metadata.manifest.id} missing bundled-channel-entry contract; skipping`,
        );
        continue;
      }
      const setupEntry = metadata.setupSource
        ? resolveChannelSetupModuleEntry(
            loadGeneratedBundledChannelModule({
              metadata,
              entry: metadata.setupSource,
            }),
          )
        : null;
      entries.push({
        id: metadata.manifest.id,
        entry,
        ...(setupEntry ? { setupEntry } : {}),
      });
    } catch (error) {
      const detail = formatErrorMessage(error);
      log.warn(`[channels] failed to load bundled channel ${metadata.manifest.id}: ${detail}`);
    }
  }

  return entries;
}

type BundledChannelState = {
  entries: readonly GeneratedBundledChannelEntry[];
  entriesById: Map<ChannelId, BundledChannelEntryRuntimeContract>;
  setupEntriesById: Map<ChannelId, BundledChannelSetupEntryRuntimeContract>;
  sortedIds: readonly ChannelId[];
  pluginsById: Map<ChannelId, ChannelPlugin>;
  setupPluginsById: Map<ChannelId, ChannelPlugin>;
  secretsById: Map<ChannelId, ChannelPlugin["secrets"] | null>;
  setupSecretsById: Map<ChannelId, ChannelPlugin["secrets"] | null>;
  runtimeSettersById: Map<
    ChannelId,
    NonNullable<BundledChannelEntryRuntimeContract["setChannelRuntime"]>
  >;
};

const EMPTY_BUNDLED_CHANNEL_STATE: BundledChannelState = {
  entries: [],
  entriesById: new Map(),
  setupEntriesById: new Map(),
  sortedIds: [],
  pluginsById: new Map(),
  setupPluginsById: new Map(),
  secretsById: new Map(),
  setupSecretsById: new Map(),
  runtimeSettersById: new Map(),
};

let cachedBundledChannelState: BundledChannelState | null = null;
let bundledChannelStateLoadInProgress = false;
const pluginLoadInProgressIds = new Set<ChannelId>();
const setupPluginLoadInProgressIds = new Set<ChannelId>();

function getBundledChannelState(): BundledChannelState {
  if (cachedBundledChannelState) {
    return cachedBundledChannelState;
  }
  if (bundledChannelStateLoadInProgress) {
    return EMPTY_BUNDLED_CHANNEL_STATE;
  }
  bundledChannelStateLoadInProgress = true;
  const entries = loadGeneratedBundledChannelEntries();
  const entriesById = new Map<ChannelId, BundledChannelEntryRuntimeContract>();
  const setupEntriesById = new Map<ChannelId, BundledChannelSetupEntryRuntimeContract>();
  const runtimeSettersById = new Map<
    ChannelId,
    NonNullable<BundledChannelEntryRuntimeContract["setChannelRuntime"]>
  >();
  for (const { entry } of entries) {
    if (entriesById.has(entry.id)) {
      throw new Error(`duplicate bundled channel plugin id: ${entry.id}`);
    }
    entriesById.set(entry.id, entry);
    if (entry.setChannelRuntime) {
      runtimeSettersById.set(entry.id, entry.setChannelRuntime);
    }
  }
  for (const { id, setupEntry } of entries) {
    if (setupEntry) {
      setupEntriesById.set(id, setupEntry);
    }
  }

  try {
    cachedBundledChannelState = {
      entries,
      entriesById,
      setupEntriesById,
      sortedIds: [...entriesById.keys()].toSorted((left, right) => left.localeCompare(right)),
      pluginsById: new Map(),
      setupPluginsById: new Map(),
      secretsById: new Map(),
      setupSecretsById: new Map(),
      runtimeSettersById,
    };
    return cachedBundledChannelState;
  } finally {
    bundledChannelStateLoadInProgress = false;
  }
}

export function listBundledChannelPlugins(): readonly ChannelPlugin[] {
  const state = getBundledChannelState();
  return state.sortedIds.flatMap((id) => {
    const plugin = getBundledChannelPlugin(id);
    return plugin ? [plugin] : [];
  });
}

export function listBundledChannelSetupPlugins(): readonly ChannelPlugin[] {
  const state = getBundledChannelState();
  return state.sortedIds.flatMap((id) => {
    const plugin = getBundledChannelSetupPlugin(id);
    return plugin ? [plugin] : [];
  });
}

export function getBundledChannelPlugin(id: ChannelId): ChannelPlugin | undefined {
  const state = getBundledChannelState();
  const cached = state.pluginsById.get(id);
  if (cached) {
    return cached;
  }
  if (pluginLoadInProgressIds.has(id)) {
    return undefined;
  }
  const entry = state.entriesById.get(id);
  if (!entry) {
    return undefined;
  }
  pluginLoadInProgressIds.add(id);
  try {
    const plugin = entry.loadChannelPlugin();
    state.pluginsById.set(id, plugin);
    return plugin;
  } finally {
    pluginLoadInProgressIds.delete(id);
  }
}

export function getBundledChannelSecrets(id: ChannelId): ChannelPlugin["secrets"] | undefined {
  const state = getBundledChannelState();
  if (state.secretsById.has(id)) {
    return state.secretsById.get(id) ?? undefined;
  }
  const entry = state.entriesById.get(id);
  if (!entry) {
    return undefined;
  }
  const secrets = entry.loadChannelSecrets?.() ?? getBundledChannelPlugin(id)?.secrets;
  state.secretsById.set(id, secrets ?? null);
  return secrets;
}

export function getBundledChannelSetupPlugin(id: ChannelId): ChannelPlugin | undefined {
  const state = getBundledChannelState();
  const cached = state.setupPluginsById.get(id);
  if (cached) {
    return cached;
  }
  if (setupPluginLoadInProgressIds.has(id)) {
    return undefined;
  }
  const entry = state.setupEntriesById.get(id);
  if (!entry) {
    return undefined;
  }
  setupPluginLoadInProgressIds.add(id);
  try {
    const plugin = entry.loadSetupPlugin();
    state.setupPluginsById.set(id, plugin);
    return plugin;
  } finally {
    setupPluginLoadInProgressIds.delete(id);
  }
}

export function getBundledChannelSetupSecrets(id: ChannelId): ChannelPlugin["secrets"] | undefined {
  const state = getBundledChannelState();
  if (state.setupSecretsById.has(id)) {
    return state.setupSecretsById.get(id) ?? undefined;
  }
  const entry = state.setupEntriesById.get(id);
  if (!entry) {
    return undefined;
  }
  const secrets = entry.loadSetupSecrets?.() ?? getBundledChannelSetupPlugin(id)?.secrets;
  state.setupSecretsById.set(id, secrets ?? null);
  return secrets;
}

export function requireBundledChannelPlugin(id: ChannelId): ChannelPlugin {
  const plugin = getBundledChannelPlugin(id);
  if (!plugin) {
    throw new Error(`missing bundled channel plugin: ${id}`);
  }
  return plugin;
}

export function setBundledChannelRuntime(id: ChannelId, runtime: PluginRuntime): void {
  const setter = getBundledChannelState().runtimeSettersById.get(id);
  if (!setter) {
    throw new Error(`missing bundled channel runtime setter: ${id}`);
  }
  setter(runtime);
}
