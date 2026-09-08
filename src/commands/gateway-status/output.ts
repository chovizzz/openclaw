import type { RuntimeEnv } from "../../runtime.js";
import { writeRuntimeJson } from "../../runtime.js";
import { colorize, theme } from "../../terminal/theme.js";
import { serializeGatewayDiscoveryBeacon } from "./discovery.js";
import {
  isProbeReachable,
  isScopeLimitedProbeFailure,
  renderProbeSummaryLine,
  renderTargetHeader,
} from "./helpers.js";
import type { GatewayStatusProbedTarget } from "./probe-run.js";

export type GatewayStatusWarning = {
  code: string;
  message: string;
  targetIds?: string[];
};

export function pickPrimaryProbedTarget(probed: GatewayStatusProbedTarget[]) {
  const reachable = probed.filter((entry) => isProbeReachable(entry.probe));
  return (
    reachable.find((entry) => entry.target.kind === "explicit") ??
    reachable.find((entry) => entry.target.kind === "sshTunnel") ??
    reachable.find((entry) => entry.target.kind === "configRemote") ??
    reachable.find((entry) => entry.target.kind === "localLoopback") ??
    null
  );
}

/**
 * Builds a per-target identity key from the probe's self-reported host/ip
 * plus a device/instance discriminator. Two probe targets (e.g. an SSH
 * tunnel and a configured remote URL) that both answer as the *same*
 * gateway process should not trip the "multiple gateways" warning just
 * because they were reached over different transports/ports.
 *
 * Returns null when identity can't be established (missing self info, or a
 * self record with host/ip but no device/instance discriminator) - callers
 * treat null as "can't prove same identity", which conservatively still
 * warns rather than silently hiding a real multi-gateway situation.
 */
function gatewaySelfIdentityKey(entry: GatewayStatusProbedTarget): string | null {
  if (!entry.self) {
    return null;
  }
  const host = typeof entry.self.host === "string" ? entry.self.host.trim().toLowerCase() : "";
  const ip = typeof entry.self.ip === "string" ? entry.self.ip.trim().toLowerCase() : "";
  const discriminator =
    typeof entry.self.instanceId === "string" && entry.self.instanceId.trim()
      ? `instance:${entry.self.instanceId.trim().toLowerCase()}`
      : typeof entry.self.deviceId === "string" && entry.self.deviceId.trim()
        ? `device:${entry.self.deviceId.trim().toLowerCase()}`
        : "";
  if ((!host && !ip) || !discriminator) {
    return null;
  }
  return `${host}\0${ip}\0${discriminator}`;
}

function hasMultipleReachableGatewayIdentities(reachable: GatewayStatusProbedTarget[]): boolean {
  if (reachable.length <= 1) {
    return false;
  }
  const identityKeys = reachable.map((entry) => gatewaySelfIdentityKey(entry));
  // Any target we can't identify keeps the warning conservative: dropping a
  // false alarm (missed reporting a real dupe) is worse than a false positive.
  if (identityKeys.some((key) => key === null)) {
    return true;
  }
  return new Set(identityKeys).size > 1;
}

export function buildGatewayStatusWarnings(params: {
  probed: GatewayStatusProbedTarget[];
  sshTarget: string | null;
  sshTunnelStarted: boolean;
  sshTunnelError: string | null;
  localTlsLoadError?: string | null;
}): GatewayStatusWarning[] {
  const reachable = params.probed.filter((entry) => isProbeReachable(entry.probe));
  const degradedScopeLimited = params.probed.filter((entry) =>
    isScopeLimitedProbeFailure(entry.probe),
  );
  const warnings: GatewayStatusWarning[] = [];
  if (params.sshTarget && !params.sshTunnelStarted) {
    warnings.push({
      code: "ssh_tunnel_failed",
      message: params.sshTunnelError
        ? `SSH tunnel failed: ${String(params.sshTunnelError)}`
        : "SSH tunnel failed to start; falling back to direct probes.",
    });
  }
  if (params.localTlsLoadError) {
    warnings.push({
      code: "local_tls_runtime_unavailable",
      message: `Local gateway TLS is enabled but OpenClaw could not load the local certificate fingerprint: ${params.localTlsLoadError}`,
      targetIds: ["localLoopback"],
    });
  }
  if (hasMultipleReachableGatewayIdentities(reachable)) {
    // Multiple reachable gateways are valid for isolated profiles but surprising
    // enough to call out before users debug against the wrong process.
    warnings.push({
      code: "multiple_gateways",
      message:
        "Unconventional setup: multiple reachable gateway identities detected. Usually one gateway per network is recommended unless you intentionally run isolated profiles, like a rescue bot (see docs: /gateway#multiple-gateways-same-host).",
      targetIds: reachable.map((entry) => entry.target.id),
    });
  }
  for (const result of params.probed) {
    if (result.authDiagnostics.length === 0 || isProbeReachable(result.probe)) {
      continue;
    }
    for (const diagnostic of result.authDiagnostics) {
      warnings.push({
        code: "auth_secretref_unresolved",
        message: diagnostic,
        targetIds: [result.target.id],
      });
    }
  }
  for (const result of degradedScopeLimited) {
    warnings.push({
      code: "probe_scope_limited",
      message:
        "Probe diagnostics are limited by gateway scopes (missing operator.read). Connection succeeded, but status details may be incomplete. Hint: pair device identity or use credentials with operator.read.",
      targetIds: [result.target.id],
    });
  }
  return warnings;
}

export function writeGatewayStatusJson(params: {
  runtime: RuntimeEnv;
  startedAt: number;
  overallTimeoutMs: number;
  discoveryTimeoutMs: number;
  network: ReturnType<typeof import("./helpers.js").buildNetworkHints>;
  discovery: Parameters<typeof serializeGatewayDiscoveryBeacon>[0][];
  probed: GatewayStatusProbedTarget[];
  warnings: GatewayStatusWarning[];
  primaryTargetId: string | null;
}) {
  const reachable = params.probed.filter((entry) => isProbeReachable(entry.probe));
  const degraded = params.probed.some((entry) => isScopeLimitedProbeFailure(entry.probe));
  writeRuntimeJson(params.runtime, {
    ok: reachable.length > 0,
    degraded,
    ts: Date.now(),
    durationMs: Date.now() - params.startedAt,
    timeoutMs: params.overallTimeoutMs,
    primaryTargetId: params.primaryTargetId,
    warnings: params.warnings,
    network: params.network,
    discovery: {
      timeoutMs: params.discoveryTimeoutMs,
      count: params.discovery.length,
      beacons: params.discovery.map((beacon) => serializeGatewayDiscoveryBeacon(beacon)),
    },
    targets: params.probed.map((entry) => ({
      id: entry.target.id,
      kind: entry.target.kind,
      url: entry.target.url,
      active: entry.target.active,
      tunnel: entry.target.tunnel ?? null,
      connect: {
        ok: isProbeReachable(entry.probe),
        rpcOk: entry.probe.ok,
        scopeLimited: isScopeLimitedProbeFailure(entry.probe),
        latencyMs: entry.probe.connectLatencyMs,
        error: entry.probe.error,
        close: entry.probe.close,
      },
      self: entry.self,
      config: entry.configSummary,
      health: entry.probe.health,
      summary: entry.probe.status,
      presence: entry.probe.presence,
    })),
  });
  if (reachable.length === 0) {
    params.runtime.exit(1);
  }
}

export function writeGatewayStatusText(params: {
  runtime: RuntimeEnv;
  rich: boolean;
  overallTimeoutMs: number;
  wideAreaDomain?: string | null;
  discovery: Parameters<typeof serializeGatewayDiscoveryBeacon>[0][];
  probed: GatewayStatusProbedTarget[];
  warnings: GatewayStatusWarning[];
}) {
  const reachable = params.probed.filter((entry) => isProbeReachable(entry.probe));
  const ok = reachable.length > 0;
  params.runtime.log(colorize(params.rich, theme.heading, "Gateway Status"));
  params.runtime.log(
    ok
      ? `${colorize(params.rich, theme.success, "Reachable")}: yes`
      : `${colorize(params.rich, theme.error, "Reachable")}: no`,
  );
  params.runtime.log(
    colorize(params.rich, theme.muted, `Probe budget: ${params.overallTimeoutMs}ms`),
  );

  if (params.warnings.length > 0) {
    params.runtime.log("");
    params.runtime.log(colorize(params.rich, theme.warn, "Warning:"));
    for (const warning of params.warnings) {
      params.runtime.log(`- ${warning.message}`);
    }
  }

  params.runtime.log("");
  params.runtime.log(colorize(params.rich, theme.heading, "Discovery (this machine)"));
  const discoveryDomains = params.wideAreaDomain ? `local. + ${params.wideAreaDomain}` : "local.";
  params.runtime.log(
    params.discovery.length > 0
      ? `Found ${params.discovery.length} gateway(s) via Bonjour (${discoveryDomains})`
      : `Found 0 gateways via Bonjour (${discoveryDomains})`,
  );
  if (params.discovery.length === 0) {
    params.runtime.log(
      colorize(
        params.rich,
        theme.muted,
        "Tip: if the gateway is remote, mDNS won’t cross networks; use Wide-Area Bonjour (split DNS) or SSH tunnels.",
      ),
    );
  }

  params.runtime.log("");
  params.runtime.log(colorize(params.rich, theme.heading, "Targets"));
  for (const result of params.probed) {
    params.runtime.log(renderTargetHeader(result.target, params.rich));
    params.runtime.log(`  ${renderProbeSummaryLine(result.probe, params.rich)}`);
    if (result.target.tunnel?.kind === "ssh") {
      params.runtime.log(
        `  ${colorize(params.rich, theme.muted, "ssh")}: ${colorize(params.rich, theme.command, result.target.tunnel.target)}`,
      );
    }
    if (result.probe.ok && result.self) {
      const host = result.self.host ?? "unknown";
      const ip = result.self.ip ? ` (${result.self.ip})` : "";
      const platform = result.self.platform ? ` · ${result.self.platform}` : "";
      const version = result.self.version ? ` · app ${result.self.version}` : "";
      params.runtime.log(
        `  ${colorize(params.rich, theme.info, "Gateway")}: ${host}${ip}${platform}${version}`,
      );
    }
    if (result.configSummary) {
      const wideArea =
        result.configSummary.discovery.wideAreaEnabled === true
          ? "enabled"
          : result.configSummary.discovery.wideAreaEnabled === false
            ? "disabled"
            : "unknown";
      params.runtime.log(
        `  ${colorize(params.rich, theme.info, "Wide-area discovery")}: ${wideArea}`,
      );
    }
    params.runtime.log("");
  }

  if (!ok) {
    params.runtime.exit(1);
  }
}
