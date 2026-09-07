import { resolveSendableOutboundReplyParts } from "openclaw/plugin-sdk/reply-payload";
import { resolveSessionAgentId } from "../../agents/agent-scope.js";
import { resolveChannelDefaultAccountId } from "../../channels/plugins/helpers.js";
import { normalizeChannelId } from "../../channels/plugins/index.js";
import type { ChannelPlugin } from "../../channels/plugins/types.js";
import { createOutboundSendDeps } from "../../cli/deps.js";
import { loadConfig, type OpenClawConfig } from "../../config/config.js";
import { applyPluginAutoEnable } from "../../config/plugin-auto-enable.js";
import { resolveOutboundChannelPlugin } from "../../infra/outbound/channel-resolution.js";
import { resolveMessageChannelSelection } from "../../infra/outbound/channel-selection.js";
import { deliverOutboundPayloads } from "../../infra/outbound/deliver.js";
import {
  ensureOutboundSessionEntry,
  resolveOutboundSessionRoute,
} from "../../infra/outbound/outbound-session.js";
import { normalizeReplyPayloadsForDelivery } from "../../infra/outbound/payloads.js";
import { buildOutboundSessionContext } from "../../infra/outbound/session-context.js";
import { maybeResolveIdLikeTarget } from "../../infra/outbound/target-resolver.js";
import { resolveOutboundTarget } from "../../infra/outbound/targets.js";
import { normalizePollInput } from "../../polls.js";
import {
  normalizeOptionalLowercaseString,
  normalizeOptionalString,
  readStringValue,
} from "../../shared/string-coerce.js";
import { normalizeAccountId } from "../../utils/account-id.js";
import {
  ErrorCodes,
  errorShape,
  formatValidationErrors,
  validatePollParams,
  validateSendParams,
} from "../protocol/index.js";
import { formatForLog } from "../ws-log.js";
import type { GatewayRequestContext, GatewayRequestHandlers, RespondFn } from "./types.js";

type InflightResult = {
  ok: boolean;
  payload?: Record<string, unknown>;
  error?: ReturnType<typeof errorShape>;
  meta?: Record<string, unknown>;
};

const inflightByContext = new WeakMap<
  GatewayRequestContext,
  Map<string, Promise<InflightResult>>
>();

const getInflightMap = (context: GatewayRequestContext) => {
  let inflight = inflightByContext.get(context);
  if (!inflight) {
    inflight = new Map();
    inflightByContext.set(context, inflight);
  }
  return inflight;
};

/**
 * Shared cache + inflight arbitration for idempotent outbound operations.
 *
 * Returns a discriminated union rather than responding itself, so each handler
 * keeps ownership of its own response/meta shape:
 *  - "cached": a completed result for this key is already memoized.
 *  - "inflight": an identical request is still running; follow it.
 *  - "ready": this caller owns the work and must register it in `inflightMap`.
 */
function resolveGatewayInflightMap(params: {
  context: GatewayRequestContext;
  dedupeKey: string;
}):
  | { kind: "cached"; cached: NonNullable<ReturnType<GatewayRequestContext["dedupe"]["get"]>> }
  | { kind: "inflight"; inflight: Promise<InflightResult> }
  | { kind: "ready"; inflightMap: Map<string, Promise<InflightResult>> } {
  const cached = params.context.dedupe.get(params.dedupeKey);
  if (cached) {
    return { kind: "cached", cached };
  }
  const inflightMap = getInflightMap(params.context);
  const inflight = inflightMap.get(params.dedupeKey);
  if (inflight) {
    return { kind: "inflight", inflight };
  }
  return { kind: "ready", inflightMap };
}

/**
 * Canonical route component of a dedupe key.
 *
 * An idempotency key only identifies an operation *within a route*. Keying on
 * the bare key made "same key, different channel" return the first channel's
 * payload and silently skip the second delivery. Scoping by the resolved
 * channel plus the effective account fixes that.
 *
 * The account is canonicalized to the account the send will actually use, so an
 * omitted accountId and an accountId explicitly set to the channel default
 * collapse to the same key. An explicit-but-uncanonicalizable account never
 * collapses into the default: it gets its own `invalid:` bucket, otherwise a
 * cached default-account result could satisfy a request that still carries the
 * raw invalid account downstream.
 */
function resolveMessageOperationRouteScope(params: {
  cfg: OpenClawConfig;
  channel: string;
  plugin: ChannelPlugin;
  requestedAccountId?: unknown;
}): string {
  const raw = normalizeOptionalString(params.requestedAccountId);
  const account = raw
    ? (normalizeAccountId(raw) ?? `invalid:${raw}`)
    : (normalizeAccountId(
        resolveChannelDefaultAccountId({ plugin: params.plugin, cfg: params.cfg }),
      ) ?? null);
  return JSON.stringify([params.channel, account]);
}

/**
 * Awaits an inflight result on behalf of a follower. A rejecting worker would
 * otherwise leave the caller with no response at all, which hangs the request;
 * a duplicate-suppressed caller must still always hear back.
 */
async function respondFromInflight(params: {
  respond: RespondFn;
  inflight: Promise<InflightResult>;
}): Promise<void> {
  try {
    const result = await params.inflight;
    const meta = result.meta ? { ...result.meta, cached: true } : { cached: true };
    params.respond(result.ok, result.payload, result.error, meta);
  } catch (err) {
    params.respond(false, undefined, errorShape(ErrorCodes.UNAVAILABLE, String(err)), {
      cached: true,
      error: formatForLog(err),
    });
  }
}

async function resolveRequestedChannel(params: {
  requestChannel: unknown;
  unsupportedMessage: (input: string) => string;
  rejectWebchatAsInternalOnly?: boolean;
}): Promise<
  | {
      cfg: ReturnType<typeof loadConfig>;
      channel: string;
    }
  | {
      error: ReturnType<typeof errorShape>;
    }
> {
  const channelInput = readStringValue(params.requestChannel);
  const normalizedChannel = channelInput ? normalizeChannelId(channelInput) : null;
  if (channelInput && !normalizedChannel) {
    const normalizedInput = normalizeOptionalLowercaseString(channelInput) ?? "";
    if (params.rejectWebchatAsInternalOnly && normalizedInput === "webchat") {
      return {
        error: errorShape(
          ErrorCodes.INVALID_REQUEST,
          "unsupported channel: webchat (internal-only). Use `chat.send` for WebChat UI messages or choose a deliverable channel.",
        ),
      };
    }
    return {
      error: errorShape(ErrorCodes.INVALID_REQUEST, params.unsupportedMessage(channelInput)),
    };
  }
  const cfg = applyPluginAutoEnable({
    config: loadConfig(),
    env: process.env,
  }).config;
  let channel = normalizedChannel;
  if (!channel) {
    try {
      channel = (await resolveMessageChannelSelection({ cfg })).channel;
    } catch (err) {
      return { error: errorShape(ErrorCodes.INVALID_REQUEST, String(err)) };
    }
  }
  return { cfg, channel };
}

function resolveGatewayOutboundTarget(params: {
  channel: string;
  to: string;
  cfg: ReturnType<typeof loadConfig>;
  accountId?: string;
}):
  | {
      ok: true;
      to: string;
    }
  | {
      ok: false;
      error: ReturnType<typeof errorShape>;
    } {
  const resolved = resolveOutboundTarget({
    channel: params.channel,
    to: params.to,
    cfg: params.cfg,
    accountId: params.accountId,
    mode: "explicit",
  });
  if (!resolved.ok) {
    return {
      ok: false,
      error: errorShape(ErrorCodes.INVALID_REQUEST, String(resolved.error)),
    };
  }
  return { ok: true, to: resolved.to };
}

function buildGatewayDeliveryPayload(params: {
  runId: string;
  channel: string;
  result: Record<string, unknown>;
}): Record<string, unknown> {
  const payload: Record<string, unknown> = {
    runId: params.runId,
    messageId: params.result.messageId,
    channel: params.channel,
  };
  if ("chatId" in params.result) {
    payload.chatId = params.result.chatId;
  }
  if ("channelId" in params.result) {
    payload.channelId = params.result.channelId;
  }
  if ("toJid" in params.result) {
    payload.toJid = params.result.toJid;
  }
  if ("conversationId" in params.result) {
    payload.conversationId = params.result.conversationId;
  }
  if ("pollId" in params.result) {
    payload.pollId = params.result.pollId;
  }
  return payload;
}

function cacheGatewayDedupeSuccess(params: {
  context: GatewayRequestContext;
  dedupeKey: string;
  payload: Record<string, unknown>;
}) {
  params.context.dedupe.set(params.dedupeKey, {
    ts: Date.now(),
    ok: true,
    payload: params.payload,
  });
}

function cacheGatewayDedupeFailure(params: {
  context: GatewayRequestContext;
  dedupeKey: string;
  error: ReturnType<typeof errorShape>;
}) {
  params.context.dedupe.set(params.dedupeKey, {
    ts: Date.now(),
    ok: false,
    error: params.error,
  });
}

export const sendHandlers: GatewayRequestHandlers = {
  send: async ({ params, respond, context, client }) => {
    const p = params;
    if (!validateSendParams(p)) {
      respond(
        false,
        undefined,
        errorShape(
          ErrorCodes.INVALID_REQUEST,
          `invalid send params: ${formatValidationErrors(validateSendParams.errors)}`,
        ),
      );
      return;
    }
    const request = p as {
      to: string;
      message?: string;
      mediaUrl?: string;
      mediaUrls?: string[];
      gifPlayback?: boolean;
      channel?: string;
      accountId?: string;
      agentId?: string;
      threadId?: string;
      sessionKey?: string;
      idempotencyKey: string;
    };
    const idem = request.idempotencyKey;
    const to = normalizeOptionalString(request.to) ?? "";
    const message = normalizeOptionalString(request.message) ?? "";
    const mediaUrl = normalizeOptionalString(request.mediaUrl);
    const mediaUrls = Array.isArray(request.mediaUrls)
      ? request.mediaUrls
          .map((entry) => normalizeOptionalString(entry))
          .filter((entry): entry is string => Boolean(entry))
      : undefined;
    if (!message && !mediaUrl && (mediaUrls?.length ?? 0) === 0) {
      respond(
        false,
        undefined,
        errorShape(ErrorCodes.INVALID_REQUEST, "invalid send params: text or media is required"),
      );
      return;
    }
    // Route preflight runs before dedupe arbitration: the dedupe key is scoped
    // by the resolved route, so the route has to be known first. This also
    // closes a race where two callers both passed the pre-resolution cache check
    // and then both registered work.
    let resolvedChannel: Awaited<ReturnType<typeof resolveRequestedChannel>>;
    try {
      resolvedChannel = await resolveRequestedChannel({
        requestChannel: request.channel,
        unsupportedMessage: (input) => `unsupported channel: ${input}`,
        rejectWebchatAsInternalOnly: true,
      });
    } catch (err) {
      // loadConfig/applyPluginAutoEnable can throw; never leave the caller
      // without a response.
      respond(false, undefined, errorShape(ErrorCodes.UNAVAILABLE, String(err)), {
        error: formatForLog(err),
      });
      return;
    }
    if ("error" in resolvedChannel) {
      respond(false, undefined, resolvedChannel.error);
      return;
    }
    const { cfg, channel } = resolvedChannel;
    const accountId = normalizeOptionalString(request.accountId);
    const threadId = normalizeOptionalString(request.threadId);
    const outboundChannel = channel;
    const plugin = resolveOutboundChannelPlugin({ channel, cfg });
    if (!plugin) {
      respond(
        false,
        undefined,
        errorShape(ErrorCodes.INVALID_REQUEST, `unsupported channel: ${channel}`),
      );
      return;
    }
    // A plugin-supplied listAccountIds/defaultAccountId can throw; never leave
    // the caller without a response.
    let routeScope: string;
    try {
      routeScope = resolveMessageOperationRouteScope({
        cfg,
        channel,
        plugin,
        requestedAccountId: request.accountId,
      });
    } catch (err) {
      respond(false, undefined, errorShape(ErrorCodes.UNAVAILABLE, String(err)), {
        channel,
        error: formatForLog(err),
      });
      return;
    }
    const dedupeKey = `send:${routeScope}:${idem}`;
    const arbitration = resolveGatewayInflightMap({ context, dedupeKey });
    if (arbitration.kind === "cached") {
      respond(arbitration.cached.ok, arbitration.cached.payload, arbitration.cached.error, {
        cached: true,
      });
      return;
    }
    if (arbitration.kind === "inflight") {
      await respondFromInflight({ respond, inflight: arbitration.inflight });
      return;
    }
    const { inflightMap } = arbitration;

    const work = (async (): Promise<InflightResult> => {
      try {
        const resolvedTarget = resolveGatewayOutboundTarget({
          channel: outboundChannel,
          to,
          cfg,
          accountId,
        });
        if (!resolvedTarget.ok) {
          return {
            ok: false,
            error: resolvedTarget.error,
            meta: { channel },
          };
        }
        const idLikeTarget = await maybeResolveIdLikeTarget({
          cfg,
          channel,
          input: resolvedTarget.to,
          accountId,
        });
        const deliveryTarget = idLikeTarget?.to ?? resolvedTarget.to;
        const outboundDeps = context.deps ? createOutboundSendDeps(context.deps) : undefined;
        const mirrorPayloads = normalizeReplyPayloadsForDelivery([
          { text: message, mediaUrl, mediaUrls },
        ]);
        const mirrorText = mirrorPayloads
          .map((payload) => payload.text)
          .filter(Boolean)
          .join("\n");
        const mirrorMediaUrls = mirrorPayloads.flatMap(
          (payload) => resolveSendableOutboundReplyParts(payload).mediaUrls,
        );
        const providedSessionKey = normalizeOptionalLowercaseString(request.sessionKey);
        const explicitAgentId = normalizeOptionalString(request.agentId);
        const sessionAgentId = providedSessionKey
          ? resolveSessionAgentId({ sessionKey: providedSessionKey, config: cfg })
          : undefined;
        const defaultAgentId = resolveSessionAgentId({ config: cfg });
        const effectiveAgentId = explicitAgentId ?? sessionAgentId ?? defaultAgentId;
        const derivedRoute = await resolveOutboundSessionRoute({
          cfg,
          channel,
          agentId: effectiveAgentId,
          accountId,
          target: deliveryTarget,
          currentSessionKey: providedSessionKey,
          resolvedTarget: idLikeTarget,
          threadId,
        });
        const outboundRoute = derivedRoute
          ? providedSessionKey
            ? {
                ...derivedRoute,
                sessionKey: providedSessionKey,
                baseSessionKey: providedSessionKey,
              }
            : derivedRoute
          : null;
        if (outboundRoute) {
          await ensureOutboundSessionEntry({
            cfg,
            channel,
            accountId,
            route: outboundRoute,
          });
        }
        const outboundSessionKey = outboundRoute?.sessionKey ?? providedSessionKey;
        const outboundSession = buildOutboundSessionContext({
          cfg,
          agentId: effectiveAgentId,
          sessionKey: outboundSessionKey,
        });
        const results = await deliverOutboundPayloads({
          cfg,
          channel: outboundChannel,
          to: deliveryTarget,
          accountId,
          payloads: [{ text: message, mediaUrl, mediaUrls }],
          session: outboundSession,
          gifPlayback: request.gifPlayback,
          threadId: threadId ?? null,
          deps: outboundDeps,
          gatewayClientScopes: client?.connect?.scopes ?? [],
          mirror: outboundSessionKey
            ? {
                sessionKey: outboundSessionKey,
                agentId: effectiveAgentId,
                text: mirrorText || message,
                mediaUrls: mirrorMediaUrls.length > 0 ? mirrorMediaUrls : undefined,
                idempotencyKey: idem,
              }
            : undefined,
        });

        const result = results.at(-1);
        if (!result) {
          throw new Error("No delivery result");
        }
        const payload = buildGatewayDeliveryPayload({ runId: idem, channel, result });
        cacheGatewayDedupeSuccess({ context, dedupeKey, payload });
        return {
          ok: true,
          payload,
          meta: { channel },
        };
      } catch (err) {
        const error = errorShape(ErrorCodes.UNAVAILABLE, String(err));
        cacheGatewayDedupeFailure({ context, dedupeKey, error });
        return { ok: false, error, meta: { channel, error: formatForLog(err) } };
      }
    })();

    inflightMap.set(dedupeKey, work);
    try {
      const result = await work;
      respond(result.ok, result.payload, result.error, result.meta);
    } catch (err) {
      // The worker is not expected to reject, but a throw here would otherwise
      // leave the request with no response at all.
      respond(false, undefined, errorShape(ErrorCodes.UNAVAILABLE, String(err)), {
        error: formatForLog(err),
      });
    } finally {
      inflightMap.delete(dedupeKey);
    }
  },
  poll: async ({ params, respond, context, client }) => {
    const p = params;
    if (!validatePollParams(p)) {
      respond(
        false,
        undefined,
        errorShape(
          ErrorCodes.INVALID_REQUEST,
          `invalid poll params: ${formatValidationErrors(validatePollParams.errors)}`,
        ),
      );
      return;
    }
    const request = p as {
      to: string;
      question: string;
      options: string[];
      maxSelections?: number;
      durationSeconds?: number;
      durationHours?: number;
      silent?: boolean;
      isAnonymous?: boolean;
      threadId?: string;
      channel?: string;
      accountId?: string;
      idempotencyKey: string;
    };
    const idem = request.idempotencyKey;
    const to = request.to.trim();
    // Route preflight before dedupe arbitration, so the dedupe key can be
    // scoped by the resolved route (see resolveMessageOperationRouteScope).
    let resolvedChannel: Awaited<ReturnType<typeof resolveRequestedChannel>>;
    try {
      resolvedChannel = await resolveRequestedChannel({
        requestChannel: request.channel,
        unsupportedMessage: (input) => `unsupported poll channel: ${input}`,
      });
    } catch (err) {
      respond(false, undefined, errorShape(ErrorCodes.UNAVAILABLE, String(err)), {
        error: formatForLog(err),
      });
      return;
    }
    if ("error" in resolvedChannel) {
      respond(false, undefined, resolvedChannel.error);
      return;
    }
    const { cfg, channel } = resolvedChannel;
    const plugin = resolveOutboundChannelPlugin({ channel, cfg });
    const outbound = plugin?.outbound;
    if (
      typeof request.durationSeconds === "number" &&
      outbound?.supportsPollDurationSeconds !== true
    ) {
      respond(
        false,
        undefined,
        errorShape(
          ErrorCodes.INVALID_REQUEST,
          `durationSeconds is not supported for ${channel} polls`,
        ),
      );
      return;
    }
    if (typeof request.isAnonymous === "boolean" && outbound?.supportsAnonymousPolls !== true) {
      respond(
        false,
        undefined,
        errorShape(ErrorCodes.INVALID_REQUEST, `isAnonymous is not supported for ${channel} polls`),
      );
      return;
    }
    // Reject an unusable channel before route scoping: the default-account
    // resolver needs a real plugin.
    const sendPoll = outbound?.sendPoll;
    if (!plugin || !sendPoll) {
      respond(
        false,
        undefined,
        errorShape(ErrorCodes.INVALID_REQUEST, `unsupported poll channel: ${channel}`),
      );
      return;
    }
    let routeScope: string;
    try {
      routeScope = resolveMessageOperationRouteScope({
        cfg,
        channel,
        plugin,
        requestedAccountId: request.accountId,
      });
    } catch (err) {
      respond(false, undefined, errorShape(ErrorCodes.UNAVAILABLE, String(err)), {
        channel,
        error: formatForLog(err),
      });
      return;
    }
    const dedupeKey = `poll:${routeScope}:${idem}`;
    const arbitration = resolveGatewayInflightMap({ context, dedupeKey });
    if (arbitration.kind === "cached") {
      respond(arbitration.cached.ok, arbitration.cached.payload, arbitration.cached.error, {
        cached: true,
      });
      return;
    }
    if (arbitration.kind === "inflight") {
      await respondFromInflight({ respond, inflight: arbitration.inflight });
      return;
    }
    const { inflightMap } = arbitration;
    const poll = {
      question: request.question,
      options: request.options,
      maxSelections: request.maxSelections,
      durationSeconds: request.durationSeconds,
      durationHours: request.durationHours,
    };
    const threadId = normalizeOptionalString(request.threadId);
    const accountId = normalizeOptionalString(request.accountId);

    // Every path returns an InflightResult; the single runner below responds
    // exactly once, both for the owner and for any inflight follower.
    const work = (async (): Promise<InflightResult> => {
      try {
        const resolvedTarget = resolveGatewayOutboundTarget({
          channel,
          to,
          cfg,
          accountId,
        });
        if (!resolvedTarget.ok) {
          return { ok: false, error: resolvedTarget.error };
        }
        const normalized = outbound.pollMaxOptions
          ? normalizePollInput(poll, { maxOptions: outbound.pollMaxOptions })
          : normalizePollInput(poll);
        const result = await sendPoll({
          cfg,
          to: resolvedTarget.to,
          poll: normalized,
          accountId,
          threadId,
          silent: request.silent,
          isAnonymous: request.isAnonymous,
          gatewayClientScopes: client?.connect?.scopes ?? [],
        });
        const payload = buildGatewayDeliveryPayload({ runId: idem, channel, result });
        cacheGatewayDedupeSuccess({ context, dedupeKey, payload });
        return { ok: true, payload, meta: { channel } };
      } catch (err) {
        const error = errorShape(ErrorCodes.UNAVAILABLE, String(err));
        cacheGatewayDedupeFailure({ context, dedupeKey, error });
        return { ok: false, error, meta: { channel, error: formatForLog(err) } };
      }
    })();

    inflightMap.set(dedupeKey, work);
    try {
      const result = await work;
      respond(result.ok, result.payload, result.error, result.meta);
    } catch (err) {
      // The worker is not expected to reject, but a throw here would otherwise
      // leave the request with no response at all.
      respond(false, undefined, errorShape(ErrorCodes.UNAVAILABLE, String(err)), {
        error: formatForLog(err),
      });
    } finally {
      inflightMap.delete(dedupeKey);
    }
  },
};
