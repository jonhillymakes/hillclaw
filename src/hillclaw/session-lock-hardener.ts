import fs from "node:fs/promises";
import path from "node:path";
import { isPidAlive } from "../shared/pid-alive.js";
import { ErrorCodes, HillclawError } from "../infra/hillclaw-error.js";
import { emitHillclawError } from "../infra/hillclaw-error-handler.js";

export interface LockInfo {
  lockPath: string;
  pid?: number;
  createdAt?: number;
  isStale: boolean;
  staleSince?: number;
}

type LockFileData = {
  pid?: unknown;
  createdAt?: unknown;
};

async function analyzeLock(lockPath: string, staleMs: number): Promise<LockInfo> {
  const stat = await fs.stat(lockPath);
  const age = Date.now() - stat.mtimeMs;

  let pid: number | undefined;
  let createdAt: number | undefined;
  try {
    const content = await fs.readFile(lockPath, "utf8");
    const data = JSON.parse(content) as LockFileData;
    pid = typeof data.pid === "number" && data.pid > 0 ? data.pid : undefined;
    if (typeof data.createdAt === "string") {
      const parsed = Date.parse(data.createdAt);
      createdAt = Number.isFinite(parsed) ? parsed : undefined;
    } else if (typeof data.createdAt === "number") {
      createdAt = data.createdAt;
    }
  } catch {
    // Lock file may not have JSON content (simple file locks)
  }

  let isStale = age > staleMs;

  // If we have a PID and the lock isn't already stale by age, check if process is alive
  if (pid != null && !isStale) {
    isStale = !isPidAlive(pid);
  }

  return {
    lockPath,
    pid,
    createdAt,
    isStale,
    staleSince: isStale ? stat.mtimeMs : undefined,
  };
}

/**
 * Check and recover stale session locks.
 *
 * Handles both lock layers:
 * 1. sessions.json.lock — global metadata lock
 * 2. {session}.jsonl.lock — per-session transcript lock
 *
 * A lock is stale if:
 * - The owning PID is no longer running
 * - The lock file is older than staleMs (default: 30s)
 * - The PID has been reused (creation time differs)
 */
export async function checkAndRecoverStaleLocks(params: {
  sessionsDir: string;
  staleMs?: number;
  dryRun?: boolean;
}): Promise<{ recovered: LockInfo[]; active: LockInfo[]; errors: string[] }> {
  const staleMs = params.staleMs ?? 30_000;
  const recovered: LockInfo[] = [];
  const active: LockInfo[] = [];
  const errors: string[] = [];

  // Find all .lock files (flat scan — session locks are not deeply nested)
  const lockFiles: string[] = [];
  try {
    let names: string[];
    try {
      names = await fs.readdir(params.sessionsDir);
    } catch (err) {
      const code = (err as { code?: string }).code;
      if (code === "ENOENT") {
        return { recovered, active, errors };
      }
      throw err;
    }

    for (const name of names) {
      if (name.endsWith(".lock")) {
        lockFiles.push(path.join(params.sessionsDir, name));
      }
    }
  } catch (err) {
    errors.push(
      `Failed to scan for lock files: ${err instanceof Error ? err.message : String(err)}`,
    );
    return { recovered, active, errors };
  }

  for (const lockPath of lockFiles) {
    try {
      const info = await analyzeLock(lockPath, staleMs);

      if (info.isStale) {
        if (!params.dryRun) {
          await fs.rm(lockPath, { force: true });
          emitHillclawError(
            new HillclawError({
              code: ErrorCodes.SESSION_LOCK_FAILED,
              subsystem: "session",
              severity: "medium",
              message: `Recovered stale lock: ${lockPath} (PID ${info.pid ?? "unknown"}, age ${
                info.staleSince != null
                  ? `${Math.round((Date.now() - info.staleSince) / 1000)}s`
                  : "unknown"
              })`,
            }),
          );
        }
        recovered.push(info);
      } else {
        active.push(info);
      }
    } catch (err) {
      errors.push(
        `Failed to analyze lock ${lockPath}: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
  }

  return { recovered, active, errors };
}

/**
 * Run at startup to clean up any orphaned locks from previous crashes.
 * Returns the number of recovered (removed) stale locks.
 */
export async function cleanupOrphanedLocks(sessionsDir: string): Promise<number> {
  const result = await checkAndRecoverStaleLocks({ sessionsDir, dryRun: false });
  return result.recovered.length;
}
