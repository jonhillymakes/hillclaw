import { emitHillclawError } from "../infra/hillclaw-error-handler.js";
import { ErrorCodes, HillclawError } from "../infra/hillclaw-error.js";

export const CONFIG_BACKUP_COUNT = 5;

export async function rotateConfigBackups(
  configPath: string,
  ioFs: {
    unlink: (path: string) => Promise<void>;
    rename: (from: string, to: string) => Promise<void>;
  },
): Promise<void> {
  if (CONFIG_BACKUP_COUNT <= 1) {
    return;
  }
  const backupBase = `${configPath}.bak`;
  const maxIndex = CONFIG_BACKUP_COUNT - 1;
  await ioFs.unlink(`${backupBase}.${maxIndex}`).catch((err: unknown) => {
    emitHillclawError(new HillclawError({
      code: ErrorCodes.CONFIG_BACKUP_FAILED,
      subsystem: "config",
      severity: "low",
      message: `Failed to delete oldest config backup: ${backupBase}.${maxIndex}`,
      cause: err instanceof Error ? err : new Error(String(err)),
    }));
  });
  for (let index = maxIndex - 1; index >= 1; index -= 1) {
    await ioFs.rename(`${backupBase}.${index}`, `${backupBase}.${index + 1}`).catch((err: unknown) => {
      emitHillclawError(new HillclawError({
        code: ErrorCodes.CONFIG_BACKUP_FAILED,
        subsystem: "config",
        severity: "low",
        message: `Failed to rotate config backup: ${backupBase}.${index} -> ${backupBase}.${index + 1}`,
        cause: err instanceof Error ? err : new Error(String(err)),
      }));
    });
  }
  await ioFs.rename(backupBase, `${backupBase}.1`).catch((err: unknown) => {
    emitHillclawError(new HillclawError({
      code: ErrorCodes.CONFIG_BACKUP_FAILED,
      subsystem: "config",
      severity: "low",
      message: `Failed to move current config backup: ${backupBase} -> ${backupBase}.1`,
      cause: err instanceof Error ? err : new Error(String(err)),
    }));
  });
}
