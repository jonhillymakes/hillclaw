import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { ErrorCodes, HillclawError } from "../infra/hillclaw-error.js";

export interface AtomicWriteOptions {
  /** File mode. Default: 0o600 */
  mode?: number;
  /** Max retries on Windows. Default: 5 */
  maxRetries?: number;
  /** Retry delay in ms. Default: 50 */
  retryDelayMs?: number;
}

/**
 * Atomically write content to a file using rename.
 *
 * Strategy:
 * 1. Write to a temp file in the same directory (same filesystem)
 * 2. fsync the temp file
 * 3. rename temp -> target (atomic on POSIX, empirically tested on Windows)
 * 4. On failure: retry with delay (Windows NTFS contention)
 * 5. Clean up temp file on any failure
 *
 * @throws HillclawError on write failure after all retries
 */
export async function atomicWriteFile(
  filePath: string,
  content: string,
  opts?: AtomicWriteOptions,
): Promise<void> {
  const mode = opts?.mode ?? 0o600;
  const maxRetries = opts?.maxRetries ?? (os.platform() === "win32" ? 5 : 1);
  const retryDelayMs = opts?.retryDelayMs ?? 50;

  const dir = path.dirname(filePath);
  const tmpPath = path.join(
    dir,
    `.tmp.${path.basename(filePath)}.${process.pid}.${Date.now()}`,
  );

  let tmpCreated = false;
  try {
    // Write to temp file
    await fs.promises.writeFile(tmpPath, content, { mode });
    tmpCreated = true;

    // fsync to ensure data hits disk.
    // Open r+ (read-write) so fsync is permitted on Windows NTFS.
    const fd = await fs.promises.open(tmpPath, "r+");
    try {
      await fd.sync();
    } finally {
      await fd.close();
    }

    // Atomic rename with retry
    let lastError: Error | undefined;
    for (let attempt = 0; attempt < maxRetries; attempt++) {
      try {
        await fs.promises.rename(tmpPath, filePath);
        tmpCreated = false; // rename succeeded — temp is now the target
        return; // Success
      } catch (err) {
        lastError = err instanceof Error ? err : new Error(String(err));
        if (attempt < maxRetries - 1) {
          await new Promise<void>((resolve) =>
            setTimeout(resolve, retryDelayMs * (attempt + 1)),
          );
        }
      }
    }

    throw lastError;
  } catch (err) {
    // Clean up temp file on failure
    if (tmpCreated) {
      await fs.promises.unlink(tmpPath).catch(() => {});
    }

    if (err instanceof HillclawError) {
      throw err;
    }

    throw new HillclawError({
      code: ErrorCodes.CONFIG_WRITE_FAILED,
      subsystem: "config",
      severity: "critical",
      message: `Atomic write failed for ${filePath}: ${err instanceof Error ? err.message : String(err)}`,
      cause: err instanceof Error ? err : undefined,
    });
  }
}

/**
 * Test whether native fs.rename() is atomic on the current filesystem.
 * Used as an empirical gate for Windows NTFS atomicity.
 */
export async function testAtomicRenameSupport(testDir?: string): Promise<boolean> {
  const dir = testDir ?? os.tmpdir();
  const srcPath = path.join(dir, `.atomic-test-src-${process.pid}-${Date.now()}`);
  const destPath = path.join(dir, `.atomic-test-dest-${process.pid}-${Date.now()}`);

  try {
    const testContent = `atomic-test-${Date.now()}`;
    await fs.promises.writeFile(srcPath, testContent, { mode: 0o600 });
    await fs.promises.rename(srcPath, destPath);
    const read = await fs.promises.readFile(destPath, "utf8");
    return read === testContent;
  } catch {
    return false;
  } finally {
    await fs.promises.unlink(srcPath).catch(() => {});
    await fs.promises.unlink(destPath).catch(() => {});
  }
}
