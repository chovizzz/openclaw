import { getCommandPathWithRootOptions } from "../cli/argv.js";
import type { OpenClawConfig } from "../config/config.js";
import { resolveNodeRequireFromMeta } from "./node-require.js";

type LoggingConfig = OpenClawConfig["logging"];

const requireConfig = resolveNodeRequireFromMeta(import.meta.url);

export function shouldSkipMutatingLoggingConfigRead(argv: string[] = process.argv): boolean {
  const [primary, secondary] = getCommandPathWithRootOptions(argv, 2);
  return primary === "config" && (secondary === "schema" || secondary === "validate");
}

// Re-entrancy guard. Config loading itself logs (and src/config/io.audit.ts
// redacts argv *during* the load), so a redactor that reads config here would
// recurse until the stack blows. Every reader goes through this function, so
// the guard belongs here rather than at one call site.
let readingLoggingConfig = false;

/** Test-only: true while a `readLoggingConfig()` call is in flight (re-entrancy guard). */
export function isReadingLoggingConfigForTest(): boolean {
  return readingLoggingConfig;
}

export function readLoggingConfig(): LoggingConfig | undefined {
  if (shouldSkipMutatingLoggingConfigRead() || readingLoggingConfig) {
    return undefined;
  }
  readingLoggingConfig = true;
  try {
    const loaded = requireConfig?.("../config/config.js") as
      | {
          loadConfig?: () => OpenClawConfig;
        }
      | undefined;
    const parsed = loaded?.loadConfig?.();
    const logging = parsed?.logging;
    if (!logging || typeof logging !== "object" || Array.isArray(logging)) {
      return undefined;
    }
    return logging as LoggingConfig;
  } catch {
    return undefined;
  } finally {
    readingLoggingConfig = false;
  }
}
