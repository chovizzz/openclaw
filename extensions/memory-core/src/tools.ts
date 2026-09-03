import { formatErrorMessage } from "openclaw/plugin-sdk/error-runtime";
import {
  jsonResult,
  readNumberParam,
  readStringParam,
  type MemoryCorpusSearchResult,
  type OpenClawConfig,
} from "openclaw/plugin-sdk/memory-core-host-runtime-core";
import type { MemorySearchResult } from "openclaw/plugin-sdk/memory-core-host-runtime-files";
import {
  resolveMemoryCorePluginConfig,
  resolveMemoryDeepDreamingConfig,
} from "openclaw/plugin-sdk/memory-core-host-status";
import { recordShortTermRecalls } from "./short-term-promotion.js";
import {
  clampResultsByInjectedChars,
  decorateCitations,
  resolveMemoryCitationsMode,
  shouldIncludeCitations,
} from "./tools.citations.js";
import {
  buildMemorySearchUnavailableResult,
  createMemoryTool,
  getMemoryCorpusSupplementResult,
  getMemoryManagerContext,
  getMemoryManagerContextWithPurpose,
  loadMemoryToolRuntime,
  MemoryGetSchema,
  MemorySearchSchema,
  searchMemoryCorpusSupplements,
} from "./tools.shared.js";

const MEMORY_SEARCH_TOOL_TIMEOUT_MS = 15_000;

/**
 * Bound memory_search with a hard deadline and cancel the work it abandons.
 *
 * Racing a deadline is not enough on its own: without the abort the losing task
 * keeps running with no consumer (an embedding retry loop for minutes, or a QMD
 * subprocess for the full command timeout) after the tool already told the agent
 * it timed out. The signal handed to `run` is what backends use to stop that work.
 */
async function runMemorySearchToolWithDeadline<T>(params: {
  timeoutMs: number;
  run: (signal: AbortSignal) => Promise<T>;
}): Promise<{ status: "ok"; value: T } | { status: "unavailable"; error: string }> {
  const timeoutError = () =>
    new Error(`memory_search timed out after ${Math.round(params.timeoutMs / 1000)}s`);
  // A unique sentinel, so a legitimate `T` can never be mistaken for the deadline.
  const TIMED_OUT: unique symbol = Symbol("memory_search timeout");
  const controller = new AbortController();
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeoutPromise = new Promise<typeof TIMED_OUT>((resolve) => {
    timer = setTimeout(() => {
      // Resolve before aborting: abort listeners dispatch synchronously, so an
      // abort-aware backend could reject the task first and replace the stable
      // "timed out" result with a provider-wrapped abort error.
      resolve(TIMED_OUT);
      controller.abort(timeoutError());
    }, params.timeoutMs);
    timer.unref?.();
  });
  // Wrapped so a synchronous throw from `run` becomes a rejection instead of
  // escaping past the `finally` that clears the timer.
  const task = (async () => await params.run(controller.signal))();
  // The losing task still rejects once aborted; swallow it so the abandoned
  // rejection never surfaces as an unhandled rejection.
  task.catch(() => undefined);

  try {
    const result = await Promise.race([task, timeoutPromise]);
    if (result === TIMED_OUT) {
      return { status: "unavailable", error: timeoutError().message };
    }
    return { status: "ok", value: result };
  } catch (error) {
    return { status: "unavailable", error: formatErrorMessage(error) };
  } finally {
    if (timer) {
      clearTimeout(timer);
    }
  }
}

type MemorySearchToolResult =
  | (Record<string, unknown> & { corpus: "memory"; score: number; path: string })
  | MemoryCorpusSearchResult;

function sortMemorySearchToolResults<T extends { score: number; path: string }>(results: T[]): T[] {
  return results.toSorted((left, right) => {
    if (left.score !== right.score) {
      return right.score - left.score;
    }
    return left.path.localeCompare(right.path);
  });
}

/**
 * Wiki and memory scores use incomparable scales, so a raw merge-and-slice lets
 * whichever corpus happens to emit larger numbers starve the other out. For
 * corpus=all, take up to half the slots from each corpus first, then backfill
 * any slots the smaller corpus could not fill.
 */
function mergeMemorySearchCorpusResults(params: {
  memoryResults: MemorySearchToolResult[];
  supplementResults: MemorySearchToolResult[];
  maxResults: number;
  balanceCorpora: boolean;
}): MemorySearchToolResult[] {
  const memoryResults = sortMemorySearchToolResults(params.memoryResults);
  const supplementResults = sortMemorySearchToolResults(params.supplementResults);
  if (!params.balanceCorpora || memoryResults.length === 0 || supplementResults.length === 0) {
    return sortMemorySearchToolResults([...memoryResults, ...supplementResults]).slice(
      0,
      params.maxResults,
    );
  }

  const perCorpusCap = Math.ceil(params.maxResults / 2);
  const selectedMemory = memoryResults.slice(0, perCorpusCap);
  const selectedSupplements = supplementResults.slice(0, perCorpusCap);
  const selected = [...selectedMemory, ...selectedSupplements];
  if (selected.length < params.maxResults) {
    selected.push(
      ...sortMemorySearchToolResults([
        ...memoryResults.slice(selectedMemory.length),
        ...supplementResults.slice(selectedSupplements.length),
      ]).slice(0, params.maxResults - selected.length),
    );
  }

  return sortMemorySearchToolResults(selected).slice(0, params.maxResults);
}

function buildRecallKey(
  result: Pick<MemorySearchResult, "source" | "path" | "startLine" | "endLine">,
): string {
  return `${result.source}:${result.path}:${result.startLine}:${result.endLine}`;
}

function resolveRecallTrackingResults(
  rawResults: MemorySearchResult[],
  surfacedResults: MemorySearchResult[],
): MemorySearchResult[] {
  if (surfacedResults.length === 0 || rawResults.length === 0) {
    return surfacedResults;
  }
  const rawByKey = new Map<string, MemorySearchResult>();
  for (const raw of rawResults) {
    const key = buildRecallKey(raw);
    if (!rawByKey.has(key)) {
      rawByKey.set(key, raw);
    }
  }
  return surfacedResults.map((surfaced) => rawByKey.get(buildRecallKey(surfaced)) ?? surfaced);
}

function queueShortTermRecallTracking(params: {
  workspaceDir?: string;
  query: string;
  rawResults: MemorySearchResult[];
  surfacedResults: MemorySearchResult[];
  timezone?: string;
}): void {
  const trackingResults = resolveRecallTrackingResults(params.rawResults, params.surfacedResults);
  void recordShortTermRecalls({
    workspaceDir: params.workspaceDir,
    query: params.query,
    results: trackingResults,
    timezone: params.timezone,
  }).catch(() => {
    // Recall tracking is best-effort and must never block memory recall.
  });
}

async function getSupplementMemoryReadResult(params: {
  relPath: string;
  from?: number;
  lines?: number;
  agentSessionKey?: string;
  corpus?: "memory" | "wiki" | "all";
}) {
  const supplement = await getMemoryCorpusSupplementResult({
    lookup: params.relPath,
    fromLine: params.from,
    lineCount: params.lines,
    agentSessionKey: params.agentSessionKey,
    corpus: params.corpus,
  });
  if (!supplement) {
    return null;
  }
  const { content, ...rest } = supplement;
  return {
    ...rest,
    text: content,
  };
}

async function resolveMemoryReadFailureResult(params: {
  error: unknown;
  requestedCorpus?: "memory" | "wiki" | "all";
  relPath: string;
  from?: number;
  lines?: number;
  agentSessionKey?: string;
}) {
  if (params.requestedCorpus === "all") {
    const supplement = await getSupplementMemoryReadResult({
      relPath: params.relPath,
      from: params.from,
      lines: params.lines,
      agentSessionKey: params.agentSessionKey,
      corpus: params.requestedCorpus,
    });
    if (supplement) {
      return jsonResult(supplement);
    }
  }
  const message = formatErrorMessage(params.error);
  return jsonResult({ path: params.relPath, text: "", disabled: true, error: message });
}

async function executeMemoryReadResult<T>(params: {
  read: () => Promise<T>;
  requestedCorpus?: "memory" | "wiki" | "all";
  relPath: string;
  from?: number;
  lines?: number;
  agentSessionKey?: string;
}) {
  try {
    return jsonResult(await params.read());
  } catch (error) {
    return await resolveMemoryReadFailureResult({
      error,
      requestedCorpus: params.requestedCorpus,
      relPath: params.relPath,
      from: params.from,
      lines: params.lines,
      agentSessionKey: params.agentSessionKey,
    });
  }
}

export function createMemorySearchTool(options: {
  config?: OpenClawConfig;
  agentSessionKey?: string;
}) {
  return createMemoryTool({
    options,
    label: "Memory Search",
    name: "memory_search",
    description:
      "Mandatory recall step: semantically search MEMORY.md + memory/*.md (and optional session transcripts) before answering questions about prior work, decisions, dates, people, preferences, or todos. Optional `corpus=wiki` or `corpus=all` also searches registered compiled-wiki supplements. If response has disabled=true, memory retrieval is unavailable and should be surfaced to the user.",
    parameters: MemorySearchSchema,
    execute:
      ({ cfg, agentId }) =>
      async (_toolCallId, params) => {
        const query = readStringParam(params, "query", { required: true });
        const maxResults = readNumberParam(params, "maxResults");
        const minScore = readNumberParam(params, "minScore");
        const requestedCorpus = readStringParam(params, "corpus") as
          | "memory"
          | "wiki"
          | "all"
          | undefined;
        const shouldQueryMemory = requestedCorpus !== "wiki";
        const shouldQuerySupplements = requestedCorpus === "wiki" || requestedCorpus === "all";
        const outcome = await runMemorySearchToolWithDeadline({
          timeoutMs: MEMORY_SEARCH_TOOL_TIMEOUT_MS,
          run: async (deadlineSignal) => {
            // Runtime load and manager resolution sit inside the deadline on
            // purpose: index bootstrap can block, and a search that never gets
            // a manager must still time out instead of hanging the agent.
            const { resolveMemoryBackendConfig } = await loadMemoryToolRuntime();
            const memory = shouldQueryMemory
              ? await getMemoryManagerContext({ cfg, agentId })
              : null;
            if (shouldQueryMemory && memory && "error" in memory && !shouldQuerySupplements) {
              return buildMemorySearchUnavailableResult(memory.error);
            }
            const citationsMode = resolveMemoryCitationsMode(cfg);
            const includeCitations = shouldIncludeCitations({
              mode: citationsMode,
              sessionKey: options.agentSessionKey,
            });
            let rawResults: MemorySearchResult[] = [];
            let surfacedMemoryResults: Array<
              Record<string, unknown> & { corpus: "memory"; score: number; path: string }
            > = [];
            let provider: string | undefined;
            let model: string | undefined;
            let fallback: unknown;
            let searchMode: string | undefined;
            if (shouldQueryMemory && memory && !("error" in memory)) {
              rawResults = await memory.manager.search(query, {
                maxResults,
                minScore,
                sessionKey: options.agentSessionKey,
                signal: deadlineSignal,
              });
              const status = memory.manager.status();
              const decorated = decorateCitations(rawResults, includeCitations);
              const resolved = resolveMemoryBackendConfig({ cfg, agentId });
              const memoryResults =
                status.backend === "qmd"
                  ? clampResultsByInjectedChars(decorated, resolved.qmd?.limits.maxInjectedChars)
                  : decorated;
              surfacedMemoryResults = memoryResults.map((result) => ({
                ...result,
                corpus: "memory" as const,
              }));
              const sleepTimezone = resolveMemoryDeepDreamingConfig({
                pluginConfig: resolveMemoryCorePluginConfig(cfg),
                cfg,
              }).timezone;
              queueShortTermRecallTracking({
                workspaceDir: status.workspaceDir,
                query,
                rawResults,
                surfacedResults: memoryResults,
                timezone: sleepTimezone,
              });
              provider = status.provider;
              model = status.model;
              fallback = status.fallback;
              searchMode = (status.custom as { searchMode?: string } | undefined)?.searchMode;
            }
            const supplementResults = shouldQuerySupplements
              ? await searchMemoryCorpusSupplements({
                  query,
                  maxResults,
                  agentSessionKey: options.agentSessionKey,
                  corpus: requestedCorpus,
                })
              : [];
            const effectiveMax = Math.max(1, maxResults ?? 10);
            const results = mergeMemorySearchCorpusResults({
              memoryResults: surfacedMemoryResults,
              supplementResults,
              maxResults: effectiveMax,
              balanceCorpora: requestedCorpus === "all",
            });
            return {
              results,
              provider,
              model,
              fallback,
              citations: citationsMode,
              mode: searchMode,
            };
          },
        });
        if (outcome.status === "unavailable") {
          return jsonResult(buildMemorySearchUnavailableResult(outcome.error));
        }
        return jsonResult(outcome.value);
      },
  });
}

export function createMemoryGetTool(options: {
  config?: OpenClawConfig;
  agentSessionKey?: string;
}) {
  return createMemoryTool({
    options,
    label: "Memory Get",
    name: "memory_get",
    description:
      "Safe exact excerpt read from MEMORY.md or memory/*.md. Defaults to a bounded excerpt when lines are omitted, includes truncation/continuation info when more content exists, and `corpus=wiki` reads from registered compiled-wiki supplements.",
    parameters: MemoryGetSchema,
    execute:
      ({ cfg, agentId }) =>
      async (_toolCallId, params) => {
        const relPath = readStringParam(params, "path", { required: true });
        const from = readNumberParam(params, "from", { integer: true });
        const lines = readNumberParam(params, "lines", { integer: true });
        const requestedCorpus = readStringParam(params, "corpus") as
          | "memory"
          | "wiki"
          | "all"
          | undefined;
        const { readAgentMemoryFile, resolveMemoryBackendConfig } = await loadMemoryToolRuntime();
        if (requestedCorpus === "wiki") {
          const supplement = await getSupplementMemoryReadResult({
            relPath,
            from: from ?? undefined,
            lines: lines ?? undefined,
            agentSessionKey: options.agentSessionKey,
            corpus: requestedCorpus,
          });
          return jsonResult(
            supplement ?? {
              path: relPath,
              text: "",
              disabled: true,
              error: "wiki corpus result not found",
            },
          );
        }
        const resolved = resolveMemoryBackendConfig({ cfg, agentId });
        if (resolved.backend === "builtin") {
          return await executeMemoryReadResult({
            read: async () =>
              await readAgentMemoryFile({
                cfg,
                agentId,
                relPath,
                from: from ?? undefined,
                lines: lines ?? undefined,
              }),
            requestedCorpus,
            relPath,
            from: from ?? undefined,
            lines: lines ?? undefined,
            agentSessionKey: options.agentSessionKey,
          });
        }
        const memory = await getMemoryManagerContextWithPurpose({
          cfg,
          agentId,
          purpose: "status",
        });
        if ("error" in memory) {
          return jsonResult({ path: relPath, text: "", disabled: true, error: memory.error });
        }
        return await executeMemoryReadResult({
          read: async () =>
            await memory.manager.readFile({
              relPath,
              from: from ?? undefined,
              lines: lines ?? undefined,
            }),
          requestedCorpus,
          relPath,
          from: from ?? undefined,
          lines: lines ?? undefined,
          agentSessionKey: options.agentSessionKey,
        });
      },
  });
}
