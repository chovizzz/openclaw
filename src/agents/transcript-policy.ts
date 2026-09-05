import type { OpenClawConfig } from "../config/config.js";
import { shouldPreserveThinkingBlocks } from "../plugins/provider-replay-helpers.js";
import { resolveProviderRuntimePlugin } from "../plugins/provider-runtime.js";
import type { ProviderReplayPolicy, ProviderRuntimeModel } from "../plugins/types.js";
import { normalizeLowercaseStringOrEmpty } from "../shared/string-coerce.js";
import { normalizeProviderId } from "./model-selection.js";
import { isGoogleModelApi } from "./pi-embedded-helpers/google.js";
import type { ToolCallIdMode } from "./tool-call-id.js";

export type TranscriptSanitizeMode = "full" | "images-only";

export type TranscriptPolicy = {
  sanitizeMode: TranscriptSanitizeMode;
  sanitizeToolCallIds: boolean;
  toolCallIdMode?: ToolCallIdMode;
  preserveNativeAnthropicToolUseIds: boolean;
  repairToolUseResultPairing: boolean;
  preserveSignatures: boolean;
  sanitizeThoughtSignatures?: {
    allowBase64Only?: boolean;
    includeCamelCase?: boolean;
  };
  sanitizeThinkingSignatures: boolean;
  dropThinkingBlocks: boolean;
  applyGoogleTurnOrdering: boolean;
  validateGeminiTurns: boolean;
  validateAnthropicTurns: boolean;
  allowSyntheticToolResults: boolean;
};

const DEFAULT_TRANSCRIPT_POLICY: TranscriptPolicy = {
  sanitizeMode: "images-only",
  sanitizeToolCallIds: false,
  toolCallIdMode: undefined,
  preserveNativeAnthropicToolUseIds: false,
  repairToolUseResultPairing: true,
  preserveSignatures: false,
  sanitizeThoughtSignatures: undefined,
  sanitizeThinkingSignatures: false,
  dropThinkingBlocks: false,
  applyGoogleTurnOrdering: false,
  validateGeminiTurns: false,
  validateAnthropicTurns: false,
  allowSyntheticToolResults: false,
};

/**
 * Read the `supportsReasoningEffort` compat flag off a resolved model. The
 * upstream `Model["compat"]` type is narrowed per API family, so read it
 * through a structural view instead of the conditional type.
 */
function resolveSupportsReasoningEffort(model?: ProviderRuntimeModel): boolean | undefined {
  const compat = (model as { compat?: { supportsReasoningEffort?: unknown } } | undefined)?.compat;
  const value = compat?.supportsReasoningEffort;
  return typeof value === "boolean" ? value : undefined;
}

function isAnthropicApi(modelApi?: string | null): boolean {
  return modelApi === "anthropic-messages" || modelApi === "bedrock-converse-stream";
}

const SIGNED_THINKING_PROVIDERS = new Set(["anthropic", "amazon-bedrock", "anthropic-vertex"]);

/** Return true when a provider family owns signed thinking blocks. */
export function providerRequiresSignedThinking(provider?: string | null): boolean {
  return SIGNED_THINKING_PROVIDERS.has(normalizeProviderId(provider ?? ""));
}

/**
 * Decide whether signed thinking can be replayed under the current provider
 * policy.
 *
 * Only these providers hand back thinking blocks whose bytes are signed and
 * must be replayed verbatim. Everywhere else (`type: "thinking"` is the shared
 * pi-ai shape used by OpenAI reasoning and Google thoughts too) it is safe to
 * normalize sibling tool calls in place, so the stricter drop-the-whole-turn
 * repair path must stay off.
 */
export function shouldAllowProviderOwnedThinkingReplay(params: {
  modelApi?: string | null;
  provider?: string | null;
  policy: Pick<
    TranscriptPolicy,
    "validateAnthropicTurns" | "preserveSignatures" | "dropThinkingBlocks"
  >;
}): boolean {
  const hasProviderOwnedSignedThinking =
    params.policy.preserveSignatures || providerRequiresSignedThinking(params.provider);
  return (
    isAnthropicApi(params.modelApi) &&
    params.policy.validateAnthropicTurns &&
    hasProviderOwnedSignedThinking &&
    !params.policy.dropThinkingBlocks
  );
}

/**
 * Provides a narrow replay-policy fallback for providers that do not have an
 * owning runtime plugin.
 *
 * This exists to preserve generic custom-provider behavior. Bundled providers
 * should express replay ownership through `buildReplayPolicy` instead.
 */
function buildUnownedProviderTransportReplayFallback(params: {
  modelApi?: string | null;
  modelId?: string | null;
  model?: ProviderRuntimeModel;
}): ProviderReplayPolicy | undefined {
  const isGoogle = isGoogleModelApi(params.modelApi);
  const isAnthropic = isAnthropicApi(params.modelApi);
  const isStrictOpenAiCompatible = params.modelApi === "openai-completions";
  const requiresOpenAiCompatibleToolIdSanitization =
    params.modelApi === "openai-completions" ||
    params.modelApi === "openai-responses" ||
    params.modelApi === "openai-codex-responses" ||
    params.modelApi === "azure-openai-responses";

  if (
    !isGoogle &&
    !isAnthropic &&
    !isStrictOpenAiCompatible &&
    !requiresOpenAiCompatibleToolIdSanitization
  ) {
    return undefined;
  }

  const modelId = normalizeLowercaseStringOrEmpty(params.modelId);
  return {
    ...(isGoogle || isAnthropic ? { sanitizeMode: "full" as const } : {}),
    ...(isGoogle || isAnthropic || requiresOpenAiCompatibleToolIdSanitization
      ? {
          sanitizeToolCallIds: true,
          toolCallIdMode: "strict" as const,
        }
      : {}),
    ...(isAnthropic ? { preserveSignatures: true } : {}),
    ...(isGoogle
      ? {
          sanitizeThoughtSignatures: {
            allowBase64Only: true,
            includeCamelCase: true,
          },
        }
      : {}),
    ...(isAnthropic && modelId.includes("claude")
      ? { dropThinkingBlocks: !shouldPreserveThinkingBlocks(modelId) }
      : {}),
    // A model that cannot take a reasoning effort cannot accept replayed
    // thinking blocks either; keeping them makes the request fail outright.
    ...(isAnthropic && resolveSupportsReasoningEffort(params.model) === false
      ? { dropThinkingBlocks: true }
      : {}),
    ...(isGoogle || isStrictOpenAiCompatible ? { applyAssistantFirstOrderingFix: true } : {}),
    ...(isGoogle || isStrictOpenAiCompatible ? { validateGeminiTurns: true } : {}),
    ...(isAnthropic || isStrictOpenAiCompatible ? { validateAnthropicTurns: true } : {}),
    ...(isGoogle || isAnthropic ? { allowSyntheticToolResults: true } : {}),
  };
}

function mergeTranscriptPolicy(
  policy: ProviderReplayPolicy | undefined,
  basePolicy: TranscriptPolicy = DEFAULT_TRANSCRIPT_POLICY,
): TranscriptPolicy {
  if (!policy) {
    return basePolicy;
  }

  return {
    ...basePolicy,
    ...(policy.sanitizeMode != null ? { sanitizeMode: policy.sanitizeMode } : {}),
    ...(typeof policy.sanitizeToolCallIds === "boolean"
      ? { sanitizeToolCallIds: policy.sanitizeToolCallIds }
      : {}),
    ...(policy.toolCallIdMode ? { toolCallIdMode: policy.toolCallIdMode as ToolCallIdMode } : {}),
    ...(typeof policy.preserveNativeAnthropicToolUseIds === "boolean"
      ? { preserveNativeAnthropicToolUseIds: policy.preserveNativeAnthropicToolUseIds }
      : {}),
    ...(typeof policy.repairToolUseResultPairing === "boolean"
      ? { repairToolUseResultPairing: policy.repairToolUseResultPairing }
      : {}),
    ...(typeof policy.preserveSignatures === "boolean"
      ? { preserveSignatures: policy.preserveSignatures }
      : {}),
    ...(policy.sanitizeThoughtSignatures
      ? { sanitizeThoughtSignatures: policy.sanitizeThoughtSignatures }
      : {}),
    ...(typeof policy.dropThinkingBlocks === "boolean"
      ? { dropThinkingBlocks: policy.dropThinkingBlocks }
      : {}),
    ...(typeof policy.applyAssistantFirstOrderingFix === "boolean"
      ? { applyGoogleTurnOrdering: policy.applyAssistantFirstOrderingFix }
      : {}),
    ...(typeof policy.validateGeminiTurns === "boolean"
      ? { validateGeminiTurns: policy.validateGeminiTurns }
      : {}),
    ...(typeof policy.validateAnthropicTurns === "boolean"
      ? { validateAnthropicTurns: policy.validateAnthropicTurns }
      : {}),
    ...(typeof policy.allowSyntheticToolResults === "boolean"
      ? { allowSyntheticToolResults: policy.allowSyntheticToolResults }
      : {}),
  };
}

export function resolveTranscriptPolicy(params: {
  modelApi?: string | null;
  provider?: string | null;
  modelId?: string | null;
  config?: OpenClawConfig;
  workspaceDir?: string;
  env?: NodeJS.ProcessEnv;
  model?: ProviderRuntimeModel;
}): TranscriptPolicy {
  const provider = normalizeProviderId(params.provider ?? "");
  const runtimePlugin = provider
    ? resolveProviderRuntimePlugin({
        provider,
        config: params.config,
        workspaceDir: params.workspaceDir,
        env: params.env,
      })
    : undefined;
  const context = {
    config: params.config,
    workspaceDir: params.workspaceDir,
    env: params.env,
    provider,
    modelId: params.modelId ?? "",
    modelApi: params.modelApi,
    model: params.model,
  };

  // Once a provider adopts the replay-policy hook, replay policy should come
  // from the plugin, not from transport-family defaults in core.
  const buildReplayPolicy = runtimePlugin?.buildReplayPolicy;
  if (buildReplayPolicy) {
    const pluginPolicy = buildReplayPolicy(context);
    return mergeTranscriptPolicy(pluginPolicy ?? undefined);
  }

  return mergeTranscriptPolicy(
    buildUnownedProviderTransportReplayFallback({
      modelApi: params.modelApi,
      modelId: params.modelId,
      model: params.model,
    }),
  );
}
