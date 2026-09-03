import { resolveConfigWriteTargetFromPath } from "../../channels/plugins/config-writes.js";
import { normalizeChannelId } from "../../channels/registry.js";
import {
  getConfigValueAtPath,
  parseConfigPath,
  setConfigValueAtPath,
  unsetConfigValueAtPath,
} from "../../config/config-paths.js";
import {
  readConfigFileSnapshot,
  validateConfigObjectWithPlugins,
  writeConfigFile,
} from "../../config/config.js";
import { redactConfigObject, redactConfigSnapshot } from "../../config/redact-snapshot.js";
import {
  getConfigOverrides,
  resetConfigOverrides,
  setConfigOverride,
  unsetConfigOverride,
} from "../../config/runtime-overrides.js";
import { loadGatewayRuntimeConfigSchema } from "../../config/runtime-schema.js";
import { normalizeOptionalString } from "../../shared/string-coerce.js";
import { isInternalMessageChannel } from "../../utils/message-channel.js";
import { resolveChannelAccountId } from "./channel-context.js";
import {
  rejectNonOwnerCommand,
  rejectUnauthorizedCommand,
  requireCommandFlagEnabled,
  requireGatewayClientScopeForInternalChannel,
} from "./command-gates.js";
import type { CommandHandler } from "./commands-types.js";
import { parseConfigCommand } from "./config-commands.js";
import { resolveConfigWriteDeniedText } from "./config-write-authorization.js";
import { parseDebugCommand } from "./debug-commands.js";

type ConfigSchemaUiHints = ReturnType<typeof loadGatewayRuntimeConfigSchema>["uiHints"];

/**
 * Loads the runtime config schema at most once per command invocation.
 * Schema construction walks the plugin manifest registry, so it is kept lazy:
 * only the branches that actually render config values pay for it.
 */
function createSchemaLoader(): () => ConfigSchemaUiHints {
  let cached: ConfigSchemaUiHints | undefined;
  return () => {
    cached ??= loadGatewayRuntimeConfigSchema().uiHints;
    return cached;
  };
}

/**
 * Renders a `path=value` acknowledgement label with schema-aware redaction.
 * The value is staged into a throwaway object at its real config path so the
 * redactor can decide sensitivity from the path, then read back out.
 */
function formatConfigSetValueLabel(params: {
  path: string[];
  value: unknown;
  uiHints: ConfigSchemaUiHints;
}): string {
  const previewRoot: Record<string, unknown> = {};
  setConfigValueAtPath(previewRoot, params.path, params.value);
  const redactedRoot = redactConfigObject(previewRoot, params.uiHints);
  const redactedValue = getConfigValueAtPath(redactedRoot, params.path);
  return typeof redactedValue === "string"
    ? `"${redactedValue}"`
    : (JSON.stringify(redactedValue) ?? "null");
}

export const handleConfigCommand: CommandHandler = async (params, allowTextCommands) => {
  const loadUiHints = createSchemaLoader();
  if (!allowTextCommands) {
    return null;
  }
  const configCommand = parseConfigCommand(params.command.commandBodyNormalized);
  if (!configCommand) {
    return null;
  }
  const unauthorized = rejectUnauthorizedCommand(params, "/config");
  if (unauthorized) {
    return unauthorized;
  }
  const allowInternalReadOnlyShow =
    configCommand.action === "show" && isInternalMessageChannel(params.command.channel);
  const nonOwner = allowInternalReadOnlyShow ? null : rejectNonOwnerCommand(params, "/config");
  if (nonOwner) {
    return nonOwner;
  }
  const disabled = requireCommandFlagEnabled(params.cfg, {
    label: "/config",
    configKey: "config",
  });
  if (disabled) {
    return disabled;
  }
  if (configCommand.action === "error") {
    return {
      shouldContinue: false,
      reply: { text: `⚠️ ${configCommand.message}` },
    };
  }

  let parsedWritePath: string[] | undefined;
  if (configCommand.action === "set" || configCommand.action === "unset") {
    const missingAdminScope = requireGatewayClientScopeForInternalChannel(params, {
      label: "/config write",
      allowedScopes: ["operator.admin"],
      missingText: "❌ /config set|unset requires operator.admin for gateway clients.",
    });
    if (missingAdminScope) {
      return missingAdminScope;
    }
    const parsedPath = parseConfigPath(configCommand.path);
    if (!parsedPath.ok || !parsedPath.path) {
      return {
        shouldContinue: false,
        reply: { text: `⚠️ ${parsedPath.error ?? "Invalid path."}` },
      };
    }
    parsedWritePath = parsedPath.path;
    const channelId = params.command.channelId ?? normalizeChannelId(params.command.channel);
    const deniedText = resolveConfigWriteDeniedText({
      cfg: params.cfg,
      channel: params.command.channel,
      channelId,
      accountId: resolveChannelAccountId({
        cfg: params.cfg,
        ctx: params.ctx,
        command: params.command,
      }),
      gatewayClientScopes: params.ctx.GatewayClientScopes,
      target: resolveConfigWriteTargetFromPath(parsedWritePath),
    });
    if (deniedText) {
      return {
        shouldContinue: false,
        reply: {
          text: deniedText,
        },
      };
    }
  }

  const snapshot = await readConfigFileSnapshot();
  if (!snapshot.valid || !snapshot.parsed || typeof snapshot.parsed !== "object") {
    return {
      shouldContinue: false,
      reply: {
        text: "⚠️ Config file is invalid; fix it before using /config.",
      },
    };
  }
  const parsedBase = structuredClone(snapshot.parsed as Record<string, unknown>);

  if (configCommand.action === "show") {
    // Never render on-disk config verbatim to chat: redact via schema hints.
    const redactedSnapshot = redactConfigSnapshot(snapshot, loadUiHints());
    const shownBase = (redactedSnapshot.parsed ?? {}) as Record<string, unknown>;
    const pathRaw = normalizeOptionalString(configCommand.path);
    if (pathRaw) {
      const parsedPath = parseConfigPath(pathRaw);
      if (!parsedPath.ok || !parsedPath.path) {
        return {
          shouldContinue: false,
          reply: { text: `⚠️ ${parsedPath.error ?? "Invalid path."}` },
        };
      }
      const value = getConfigValueAtPath(shownBase, parsedPath.path);
      const rendered = JSON.stringify(value ?? null, null, 2);
      return {
        shouldContinue: false,
        reply: {
          text: `⚙️ Config ${pathRaw}:\n\`\`\`json\n${rendered}\n\`\`\``,
        },
      };
    }
    const json = JSON.stringify(shownBase, null, 2);
    return {
      shouldContinue: false,
      reply: { text: `⚙️ Config (raw):\n\`\`\`json\n${json}\n\`\`\`` },
    };
  }

  if (configCommand.action === "unset") {
    const removed = unsetConfigValueAtPath(parsedBase, parsedWritePath ?? []);
    if (!removed) {
      return {
        shouldContinue: false,
        reply: { text: `⚙️ No config value found for ${configCommand.path}.` },
      };
    }
    const validated = validateConfigObjectWithPlugins(parsedBase);
    if (!validated.ok) {
      const issue = validated.issues[0];
      return {
        shouldContinue: false,
        reply: {
          text: `⚠️ Config invalid after unset (${issue.path}: ${issue.message}).`,
        },
      };
    }
    await writeConfigFile(validated.config);
    return {
      shouldContinue: false,
      reply: { text: `⚙️ Config updated: ${configCommand.path} removed.` },
    };
  }

  if (configCommand.action === "set") {
    setConfigValueAtPath(parsedBase, parsedWritePath ?? [], configCommand.value);
    const validated = validateConfigObjectWithPlugins(parsedBase);
    if (!validated.ok) {
      const issue = validated.issues[0];
      return {
        shouldContinue: false,
        reply: {
          text: `⚠️ Config invalid after set (${issue.path}: ${issue.message}).`,
        },
      };
    }
    // Resolve hints before writing: a schema-build failure must not leave the
    // config persisted while the acknowledgement throws.
    const setUiHints = loadUiHints();
    await writeConfigFile(validated.config);
    const valueLabel = formatConfigSetValueLabel({
      path: parsedWritePath ?? [],
      value: configCommand.value,
      uiHints: setUiHints,
    });
    return {
      shouldContinue: false,
      reply: {
        text: `⚙️ Config updated: ${configCommand.path}=${valueLabel}`,
      },
    };
  }

  return null;
};

export const handleDebugCommand: CommandHandler = async (params, allowTextCommands) => {
  const loadUiHints = createSchemaLoader();
  if (!allowTextCommands) {
    return null;
  }
  const debugCommand = parseDebugCommand(params.command.commandBodyNormalized);
  if (!debugCommand) {
    return null;
  }
  const unauthorized = rejectUnauthorizedCommand(params, "/debug");
  if (unauthorized) {
    return unauthorized;
  }
  const nonOwner = rejectNonOwnerCommand(params, "/debug");
  if (nonOwner) {
    return nonOwner;
  }
  const disabled = requireCommandFlagEnabled(params.cfg, {
    label: "/debug",
    configKey: "debug",
  });
  if (disabled) {
    return disabled;
  }
  if (debugCommand.action === "error") {
    return {
      shouldContinue: false,
      reply: { text: `⚠️ ${debugCommand.message}` },
    };
  }
  if (debugCommand.action === "show") {
    const overrides = getConfigOverrides();
    const hasOverrides = Object.keys(overrides).length > 0;
    if (!hasOverrides) {
      return {
        shouldContinue: false,
        reply: { text: "⚙️ Debug overrides: (none)" },
      };
    }
    // Overrides can hold secret-shaped values (tokens, keys); redact before echoing.
    const json = JSON.stringify(redactConfigObject(overrides, loadUiHints()), null, 2);
    return {
      shouldContinue: false,
      reply: {
        text: `⚙️ Debug overrides (memory-only):\n\`\`\`json\n${json}\n\`\`\``,
      },
    };
  }
  if (debugCommand.action === "reset") {
    resetConfigOverrides();
    return {
      shouldContinue: false,
      reply: { text: "⚙️ Debug overrides cleared; using config on disk." },
    };
  }
  if (debugCommand.action === "unset") {
    const result = unsetConfigOverride(debugCommand.path);
    if (!result.ok) {
      return {
        shouldContinue: false,
        reply: { text: `⚠️ ${result.error ?? "Invalid path."}` },
      };
    }
    if (!result.removed) {
      return {
        shouldContinue: false,
        reply: {
          text: `⚙️ No debug override found for ${debugCommand.path}.`,
        },
      };
    }
    return {
      shouldContinue: false,
      reply: { text: `⚙️ Debug override removed for ${debugCommand.path}.` },
    };
  }
  if (debugCommand.action === "set") {
    const result = setConfigOverride(debugCommand.path, debugCommand.value);
    if (!result.ok) {
      return {
        shouldContinue: false,
        reply: { text: `⚠️ ${result.error ?? "Invalid override."}` },
      };
    }
    const parsedOverridePath = parseConfigPath(debugCommand.path);
    const valueLabel = parsedOverridePath.path
      ? formatConfigSetValueLabel({
          path: parsedOverridePath.path,
          value: debugCommand.value,
          uiHints: loadUiHints(),
        })
      : typeof debugCommand.value === "string"
        ? `"${debugCommand.value}"`
        : (JSON.stringify(debugCommand.value) ?? "null");
    return {
      shouldContinue: false,
      reply: {
        text: `⚙️ Debug override set: ${debugCommand.path}=${valueLabel}`,
      },
    };
  }

  return null;
};
