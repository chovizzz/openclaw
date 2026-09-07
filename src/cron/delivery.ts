import type { CliDeps } from "../cli/deps.js";
import { createOutboundSendDeps } from "../cli/outbound-send-deps.js";
import type { OpenClawConfig } from "../config/types.js";
import { formatErrorMessage } from "../infra/errors.js";
import { deliverOutboundPayloads } from "../infra/outbound/deliver.js";
import { resolveAgentOutboundIdentity } from "../infra/outbound/identity.js";
import { buildOutboundSessionContext } from "../infra/outbound/session-context.js";
import { getChildLogger } from "../logging.js";
import {
  resolveFailureDestination,
  type CronFailureDeliveryPlan,
  type CronFailureDestinationInput,
  type CronDeliveryPlan,
  resolveCronDeliveryPlan,
} from "./delivery-plan.js";
import { resolveDeliveryTarget } from "./isolated-agent/delivery-target.js";
import type { CronMessageChannel } from "./types.js";

export {
  resolveCronDeliveryPlan,
  resolveFailureDestination,
  type CronDeliveryPlan,
  type CronFailureDeliveryPlan,
  type CronFailureDestinationInput,
};

const FAILURE_NOTIFICATION_TIMEOUT_MS = 30_000;
const cronDeliveryLogger = getChildLogger({ subsystem: "cron-delivery" });

/**
 * Sends a cron failure notification via the announce channel.
 *
 * Returns `true` when delivery was attempted and did not throw, `false` when
 * target resolution or delivery failed. Callers should treat `false` as "this
 * alert was dropped" and fall back to another notification path (for example
 * an in-agent system event) so a transient channel/account failure does not
 * silently swallow the only record of a cron job failure.
 */
export async function sendFailureNotificationAnnounce(
  deps: CliDeps,
  cfg: OpenClawConfig,
  agentId: string,
  jobId: string,
  target: { channel?: string; to?: string; accountId?: string; sessionKey?: string },
  message: string,
): Promise<boolean> {
  // Never throws: callers rely on the boolean return to decide whether to run
  // a fallback notification path, so an unexpected rejection here (from
  // target resolution or delivery) must degrade to "dropped" (false) rather
  // than propagate and skip that fallback.
  let resolvedTarget: Awaited<ReturnType<typeof resolveDeliveryTarget>>;
  try {
    resolvedTarget = await resolveDeliveryTarget(cfg, agentId, {
      channel: target.channel as CronMessageChannel | undefined,
      to: target.to,
      accountId: target.accountId,
      sessionKey: target.sessionKey,
    });
  } catch (err) {
    cronDeliveryLogger.warn(
      { err: formatErrorMessage(err) },
      "cron: failed to resolve failure destination target",
    );
    return false;
  }

  if (!resolvedTarget.ok) {
    cronDeliveryLogger.warn(
      { error: resolvedTarget.error.message },
      "cron: failed to resolve failure destination target",
    );
    return false;
  }

  const identity = resolveAgentOutboundIdentity(cfg, agentId);
  const session = buildOutboundSessionContext({
    cfg,
    agentId,
    sessionKey: `cron:${jobId}:failure`,
  });

  const abortController = new AbortController();
  const timeout = setTimeout(() => {
    abortController.abort();
  }, FAILURE_NOTIFICATION_TIMEOUT_MS);

  try {
    await deliverOutboundPayloads({
      cfg,
      channel: resolvedTarget.channel,
      to: resolvedTarget.to,
      accountId: resolvedTarget.accountId,
      threadId: resolvedTarget.threadId,
      payloads: [{ text: message }],
      session,
      identity,
      bestEffort: false,
      deps: createOutboundSendDeps(deps),
      abortSignal: abortController.signal,
    });
    return true;
  } catch (err) {
    cronDeliveryLogger.warn(
      {
        err: formatErrorMessage(err),
        channel: resolvedTarget.channel,
        to: resolvedTarget.to,
      },
      "cron: failure destination announce failed",
    );
    return false;
  } finally {
    clearTimeout(timeout);
  }
}
