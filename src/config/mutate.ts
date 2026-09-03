import path from "node:path";
import { formatErrorMessage, isErrno } from "../infra/errors.js";
import {
  readConfigFileSnapshotForWrite,
  resolveConfigSnapshotHash,
  writeConfigFile,
  type ConfigWriteOptions,
} from "./io.js";
import type { ConfigFileSnapshot, OpenClawConfig } from "./types.js";

export type ConfigMutationBase = "runtime" | "source";

export class ConfigMutationConflictError extends Error {
  readonly currentHash: string | null;

  constructor(message: string, params: { currentHash: string | null }) {
    super(message);
    this.name = "ConfigMutationConflictError";
    this.currentHash = params.currentHash;
  }
}

export type ConfigReplaceResult = {
  path: string;
  previousHash: string | null;
  snapshot: ConfigFileSnapshot;
  nextConfig: OpenClawConfig;
};

function assertBaseHashMatches(snapshot: ConfigFileSnapshot, expectedHash?: string): string | null {
  const currentHash = resolveConfigSnapshotHash(snapshot) ?? null;
  if (expectedHash !== undefined && expectedHash !== currentHash) {
    throw new ConfigMutationConflictError("config changed since last load", {
      currentHash,
    });
  }
  return currentHash;
}

/**
 * True when `error` is a permission failure whose reported path sits directly in `directory`.
 *
 * Scoped to the directory's own entries (the config file, its temp/backup siblings) so an
 * unrelated permission error raised deeper in the write keeps propagating unchanged.
 */
function isPermissionErrorInDirectory(error: unknown, directory: string): boolean {
  if (
    !isErrno(error) ||
    (error.code !== "EACCES" && error.code !== "EPERM" && error.code !== "EROFS")
  ) {
    return false;
  }
  const failedPath = error.path;
  return typeof failedPath === "string" && path.dirname(path.resolve(failedPath)) === directory;
}

/**
 * Runs a config write and relabels an unwritable-config-directory failure.
 *
 * A bare Node errno naming an internal artifact (temp file, backup sidecar) sends operators to
 * investigate the wrong thing; the directory's ownership/permissions are the actual problem.
 */
async function writeConfigFileWithDirectoryDiagnosis(
  configPath: string,
  write: () => Promise<void>,
): Promise<void> {
  const configDir = path.dirname(path.resolve(configPath));
  try {
    await write();
  } catch (error) {
    if (!isPermissionErrorInDirectory(error, configDir)) {
      throw error;
    }
    throw new Error(
      `OpenClaw cannot write to the config directory ${configDir}. Fix its ownership or permissions, then try again. Underlying error: ${formatErrorMessage(error)}`,
      { cause: error },
    );
  }
}

export async function replaceConfigFile(params: {
  nextConfig: OpenClawConfig;
  baseHash?: string;
  writeOptions?: ConfigWriteOptions;
}): Promise<ConfigReplaceResult> {
  const { snapshot, writeOptions } = await readConfigFileSnapshotForWrite();
  const previousHash = assertBaseHashMatches(snapshot, params.baseHash);
  await writeConfigFileWithDirectoryDiagnosis(snapshot.path, async () => {
    await writeConfigFile(params.nextConfig, {
      ...writeOptions,
      ...params.writeOptions,
    });
  });
  return {
    path: snapshot.path,
    previousHash,
    snapshot,
    nextConfig: params.nextConfig,
  };
}

export async function mutateConfigFile<T = void>(params: {
  base?: ConfigMutationBase;
  baseHash?: string;
  writeOptions?: ConfigWriteOptions;
  mutate: (
    draft: OpenClawConfig,
    context: { snapshot: ConfigFileSnapshot; previousHash: string | null },
  ) => Promise<T | void> | T | void;
}): Promise<ConfigReplaceResult & { result: T | undefined }> {
  const { snapshot, writeOptions } = await readConfigFileSnapshotForWrite();
  const previousHash = assertBaseHashMatches(snapshot, params.baseHash);
  const baseConfig = params.base === "runtime" ? snapshot.runtimeConfig : snapshot.sourceConfig;
  const draft = structuredClone(baseConfig) as OpenClawConfig;
  const result = (await params.mutate(draft, { snapshot, previousHash })) as T | undefined;
  await writeConfigFileWithDirectoryDiagnosis(snapshot.path, async () => {
    await writeConfigFile(draft, {
      ...writeOptions,
      ...params.writeOptions,
    });
  });
  return {
    path: snapshot.path,
    previousHash,
    snapshot,
    nextConfig: draft,
    result,
  };
}
