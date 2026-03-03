import net from "node:net";
import {
  acquireGatewayLock,
  type GatewayLockHandle,
  GatewayLockError,
} from "../infra/gateway-lock.js";
import { ErrorCodes, HillclawError } from "../infra/hillclaw-error.js";
import { emitHillclawError } from "../infra/hillclaw-error-handler.js";

export interface BootGuardHandle {
  /** Release the boot guard lock */
  release: () => Promise<void>;
  /** The underlying gateway lock handle */
  gatewayLock: GatewayLockHandle;
}

export interface BootGuardOptions {
  /** Timeout waiting for lock. Default: 10000ms */
  timeoutMs?: number;
  /** Port the gateway listens on (for liveness check). Default: 18789 */
  port?: number;
  /** Allow in test environments. Default: false */
  allowInTests?: boolean;
}

/**
 * Acquires an exclusive boot guard that prevents multiple gateway instances.
 *
 * Uses the existing gateway lock mechanism but wraps it with:
 * - HillclawError emission on failure
 * - Stronger stale-lock detection
 * - Clear error messages for the user
 *
 * @throws HillclawError with code GATEWAY_BOOT_GUARD_FAILED if another instance is running
 */
export async function acquireBootGuard(
  opts?: BootGuardOptions,
): Promise<BootGuardHandle> {
  const timeoutMs = opts?.timeoutMs ?? 10_000;
  const port = opts?.port ?? 18789;
  const allowInTests = opts?.allowInTests ?? false;

  try {
    const lock = await acquireGatewayLock({
      timeoutMs,
      port,
      allowInTests,
    });

    if (!lock) {
      const hillclawErr = new HillclawError({
        code: ErrorCodes.GATEWAY_BOOT_GUARD_FAILED,
        subsystem: "gateway",
        severity: "critical",
        message:
          "Failed to acquire gateway boot guard — another instance may be running. Only one gateway instance is allowed.",
      });
      emitHillclawError(hillclawErr);
      throw hillclawErr;
    }

    return {
      release: async () => {
        await lock.release();
      },
      gatewayLock: lock,
    };
  } catch (err) {
    if (err instanceof HillclawError) throw err;

    const message =
      err instanceof GatewayLockError
        ? `Boot guard failed: ${err.message}`
        : `Boot guard failed: ${err instanceof Error ? err.message : String(err)}`;

    const hillclawErr = new HillclawError({
      code: ErrorCodes.GATEWAY_BOOT_GUARD_FAILED,
      subsystem: "gateway",
      severity: "critical",
      message,
      cause: err instanceof Error ? err : undefined,
    });
    emitHillclawError(hillclawErr);
    throw hillclawErr;
  }
}

/**
 * Check if a gateway instance is already running (without acquiring the lock).
 * Useful for CLI tools that want to check before starting.
 */
export async function isGatewayRunning(opts?: {
  port?: number;
}): Promise<boolean> {
  const port = opts?.port ?? 18789;
  return new Promise<boolean>((resolve) => {
    const socket = net.createConnection({ port, host: "127.0.0.1" }, () => {
      socket.destroy();
      resolve(true);
    });
    socket.on("error", () => resolve(false));
    socket.setTimeout(2000, () => {
      socket.destroy();
      resolve(false);
    });
  });
}
