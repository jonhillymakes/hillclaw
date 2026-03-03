import fs from "node:fs";
import path from "node:path";
import { emitHillclawError } from "../infra/hillclaw-error-handler.js";
import { ErrorCodes, HillclawError } from "../infra/hillclaw-error.js";

export interface BackupRotationOptions {
  /** Maximum number of backup generations to keep. Default: 3 */
  maxGenerations?: number;
}

export interface BackupRotationResult {
  success: boolean;
  backupsKept: number;
  errors: string[];
}

/**
 * Rotate backup files: file.bak -> file.bak.1 -> file.bak.2 -> ... -> file.bak.N (deleted)
 *
 * Unlike the upstream version, this tracks and reports all errors rather than
 * silently swallowing them. Individual rotation failures are non-fatal (reported
 * in result.errors) but the function continues to best-effort completion.
 */
export async function rotateBackups(
  filePath: string,
  opts?: BackupRotationOptions,
): Promise<BackupRotationResult> {
  const maxGenerations = opts?.maxGenerations ?? 3;
  const backupBase = `${filePath}.bak`;
  const errors: string[] = [];

  // Delete oldest generation
  try {
    await fs.promises.unlink(`${backupBase}.${maxGenerations}`);
  } catch (err) {
    if (!isEnoent(err)) {
      const msg = `Failed to delete oldest backup ${backupBase}.${maxGenerations}: ${formatErr(err)}`;
      errors.push(msg);
      emitHillclawError(
        new HillclawError({
          code: ErrorCodes.CONFIG_BACKUP_FAILED,
          subsystem: "config",
          severity: "medium",
          message: msg,
          cause: err instanceof Error ? err : undefined,
        }),
      );
    }
  }

  // Shift existing generations up
  for (let i = maxGenerations - 1; i >= 1; i--) {
    try {
      await fs.promises.rename(`${backupBase}.${i}`, `${backupBase}.${i + 1}`);
    } catch (err) {
      if (!isEnoent(err)) {
        const msg = `Failed to shift backup ${backupBase}.${i}: ${formatErr(err)}`;
        errors.push(msg);
        emitHillclawError(
          new HillclawError({
            code: ErrorCodes.CONFIG_BACKUP_FAILED,
            subsystem: "config",
            severity: "medium",
            message: msg,
            cause: err instanceof Error ? err : undefined,
          }),
        );
      }
    }
  }

  // Move current backup to .1
  try {
    await fs.promises.rename(backupBase, `${backupBase}.1`);
  } catch (err) {
    if (!isEnoent(err)) {
      const msg = `Failed to rotate current backup ${backupBase}: ${formatErr(err)}`;
      errors.push(msg);
      emitHillclawError(
        new HillclawError({
          code: ErrorCodes.CONFIG_BACKUP_FAILED,
          subsystem: "config",
          severity: "high",
          message: msg,
          cause: err instanceof Error ? err : undefined,
        }),
      );
    }
  }

  // Create new backup from current file
  try {
    await fs.promises.copyFile(filePath, backupBase);
  } catch (err) {
    if (!isEnoent(err)) {
      const msg = `Failed to create backup of ${filePath}: ${formatErr(err)}`;
      errors.push(msg);
      emitHillclawError(
        new HillclawError({
          code: ErrorCodes.CONFIG_BACKUP_FAILED,
          subsystem: "config",
          severity: "high",
          message: msg,
          cause: err instanceof Error ? err : undefined,
        }),
      );
    }
  }

  // Count actual backups kept
  let backupsKept = 0;
  for (let i = 0; i <= maxGenerations; i++) {
    const checkPath = i === 0 ? backupBase : `${backupBase}.${i}`;
    try {
      await fs.promises.access(checkPath);
      backupsKept++;
    } catch {
      // file absent — not counted
    }
  }

  return {
    success: errors.length === 0,
    backupsKept,
    errors,
  };
}

function isEnoent(err: unknown): boolean {
  return (
    err instanceof Error &&
    "code" in err &&
    (err as NodeJS.ErrnoException).code === "ENOENT"
  );
}

function formatErr(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

// Re-export the path helper so callers can derive backup paths consistently
export function backupBasePath(filePath: string): string {
  return `${filePath}.bak`;
}

// Convenience: derive the path for a specific generation number (1-based)
export function backupGenPath(filePath: string, generation: number): string {
  return `${filePath}.bak.${generation}`;
}
