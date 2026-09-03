import { spawn } from "node:child_process";
import {
  materializeWindowsSpawnProgram,
  resolveWindowsSpawnProgram,
} from "../../plugin-sdk/windows-spawn.js";

export type CliSpawnInvocation = {
  command: string;
  argv: string[];
  shell?: boolean;
  windowsHide?: boolean;
};

export type QmdBinaryAvailability = {
  available: boolean;
  error?: string;
};

export function resolveCliSpawnInvocation(params: {
  command: string;
  args: string[];
  env: NodeJS.ProcessEnv;
  packageName: string;
}): CliSpawnInvocation {
  const program = resolveWindowsSpawnProgram({
    command: params.command,
    platform: process.platform,
    env: params.env,
    execPath: process.execPath,
    packageName: params.packageName,
    allowShellFallback: false,
  });
  return materializeWindowsSpawnProgram(program, params.args);
}

export async function checkQmdBinaryAvailability(params: {
  command: string;
  env: NodeJS.ProcessEnv;
  cwd?: string;
  timeoutMs?: number;
}): Promise<QmdBinaryAvailability> {
  let spawnInvocation: CliSpawnInvocation;
  try {
    spawnInvocation = resolveCliSpawnInvocation({
      command: params.command,
      args: [],
      env: params.env,
      packageName: "qmd",
    });
  } catch (err) {
    return { available: false, error: formatQmdAvailabilityError(err) };
  }

  return await new Promise((resolve) => {
    let settled = false;
    let didSpawn = false;
    const finish = (result: QmdBinaryAvailability) => {
      if (settled) {
        return;
      }
      settled = true;
      if (timer) {
        clearTimeout(timer);
      }
      resolve(result);
    };

    const child = spawn(spawnInvocation.command, spawnInvocation.argv, {
      env: params.env,
      cwd: params.cwd ?? process.cwd(),
      shell: spawnInvocation.shell,
      windowsHide: spawnInvocation.windowsHide,
      stdio: "ignore",
    });
    const timer = setTimeout(() => {
      child.kill("SIGKILL");
      finish({
        available: false,
        error: `spawn ${params.command} timed out after ${params.timeoutMs ?? 2_000}ms`,
      });
    }, params.timeoutMs ?? 2_000);

    child.once("error", (err) => {
      finish({ available: false, error: formatQmdAvailabilityError(err) });
    });
    child.once("spawn", () => {
      didSpawn = true;
      child.kill();
      finish({ available: true });
    });
    child.once("close", () => {
      if (!didSpawn) {
        return;
      }
      finish({ available: true });
    });
  });
}

/**
 * Normalize an aborted signal into the error used to reject a killed command.
 * Prefers the caller-supplied abort reason (so a deadline message survives) and
 * falls back to a stable per-command abort error.
 */
export function cliAbortReason(signal: AbortSignal | undefined, commandSummary: string): Error {
  const reason = signal?.reason;
  if (reason instanceof Error) {
    return reason;
  }
  if (typeof reason === "string" && reason.length > 0) {
    return new Error(reason);
  }
  return new Error(`${commandSummary} aborted`);
}

export async function runCliCommand(params: {
  commandSummary: string;
  spawnInvocation: CliSpawnInvocation;
  env: NodeJS.ProcessEnv;
  cwd: string;
  timeoutMs?: number;
  maxOutputChars: number;
  discardStdout?: boolean;
  /**
   * Caller-owned cancellation. When the signal aborts, the spawned child is
   * killed immediately and the call rejects, so a caller that already stopped
   * waiting (for example after its own deadline) does not leave an orphaned
   * process running for the full command timeout.
   */
  signal?: AbortSignal;
}): Promise<{ stdout: string; stderr: string }> {
  return await new Promise((resolve, reject) => {
    const { signal } = params;
    if (signal?.aborted) {
      reject(cliAbortReason(signal, params.commandSummary));
      return;
    }
    const child = spawn(params.spawnInvocation.command, params.spawnInvocation.argv, {
      env: params.env,
      cwd: params.cwd,
      shell: params.spawnInvocation.shell,
      windowsHide: params.spawnInvocation.windowsHide,
    });
    let stdout = "";
    let stderr = "";
    let stdoutTruncated = false;
    let stderrTruncated = false;
    let settled = false;
    const discardStdout = params.discardStdout === true;
    // Single settle guard so abort/timeout/error/close cannot double-settle the
    // promise, and so the abort listener is always detached.
    const settle = (run: () => void): void => {
      if (settled) {
        return;
      }
      settled = true;
      if (timer) {
        clearTimeout(timer);
      }
      signal?.removeEventListener("abort", onAbort);
      run();
    };
    const onAbort = (): void => {
      child.kill("SIGKILL");
      settle(() => reject(cliAbortReason(signal, params.commandSummary)));
    };
    const timer = params.timeoutMs
      ? setTimeout(() => {
          child.kill("SIGKILL");
          settle(() =>
            reject(new Error(`${params.commandSummary} timed out after ${params.timeoutMs}ms`)),
          );
        }, params.timeoutMs)
      : null;
    signal?.addEventListener("abort", onAbort, { once: true });
    child.stdout.on("data", (data) => {
      if (discardStdout) {
        return;
      }
      const next = appendOutputWithCap(stdout, data.toString("utf8"), params.maxOutputChars);
      stdout = next.text;
      stdoutTruncated = stdoutTruncated || next.truncated;
    });
    child.stderr.on("data", (data) => {
      const next = appendOutputWithCap(stderr, data.toString("utf8"), params.maxOutputChars);
      stderr = next.text;
      stderrTruncated = stderrTruncated || next.truncated;
    });
    child.on("error", (err) => {
      settle(() => reject(err));
    });
    child.on("close", (code) => {
      settle(() => {
        if (!discardStdout && (stdoutTruncated || stderrTruncated)) {
          reject(
            new Error(
              `${params.commandSummary} produced too much output (limit ${params.maxOutputChars} chars)`,
            ),
          );
          return;
        }
        if (code === 0) {
          resolve({ stdout, stderr });
        } else {
          reject(new Error(`${params.commandSummary} failed (code ${code}): ${stderr || stdout}`));
        }
      });
    });
  });
}

function appendOutputWithCap(
  current: string,
  chunk: string,
  maxChars: number,
): { text: string; truncated: boolean } {
  const appended = current + chunk;
  if (appended.length <= maxChars) {
    return { text: appended, truncated: false };
  }
  return { text: appended.slice(-maxChars), truncated: true };
}

function formatQmdAvailabilityError(err: unknown): string {
  if (err instanceof Error && err.message) {
    return err.message;
  }
  return String(err);
}
