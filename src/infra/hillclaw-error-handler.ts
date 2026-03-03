import { emitDiagnosticEvent } from "./diagnostic-events.js";
import { ErrorCodes, HillclawError, isHillclawError } from "./hillclaw-error.js";
import { formatUncaughtError } from "./errors.js";

export function emitHillclawError(error: HillclawError): void {
  emitDiagnosticEvent({
    type: "hillclaw.error",
    code: error.code,
    subsystem: error.subsystem,
    severity: error.severity,
    message: error.message,
    sessionKey: error.sessionKey,
    agentId: error.agentId,
    stack: error.stack,
    cause: error.cause?.message,
  });
}

export type UncaughtExceptionPolicy = "exit" | "safe-mode";

export function installUncaughtExceptionHandler(opts: {
  policy: UncaughtExceptionPolicy;
  log: { error: (...args: unknown[]) => void };
  onSafeMode?: () => void;
}): void {
  const { policy, log, onSafeMode } = opts;

  process.on("uncaughtException", (err: Error, origin: string) => {
    const formatted = formatUncaughtError(err);
    log.error(`[UNCAUGHT ${origin}] ${formatted}`);

    const hillclawErr = new HillclawError({
      code:
        origin === "unhandledRejection"
          ? ErrorCodes.UNHANDLED_REJECTION
          : ErrorCodes.UNCAUGHT_EXCEPTION,
      subsystem: "gateway",
      severity: "critical",
      message: `Uncaught exception (${origin}): ${err.message}`,
      cause: err,
    });

    emitHillclawError(hillclawErr);

    if (policy === "exit") {
      log.error("Exit policy: shutting down. Process manager should restart.");
      // Give event bus time to deliver, then exit
      setTimeout(() => process.exit(1), 500);
    } else if (policy === "safe-mode") {
      log.error("Safe-mode policy: transitioning to read-only mode.");
      onSafeMode?.();
    }
  });

  process.on("unhandledRejection", (reason: unknown) => {
    const err = reason instanceof Error ? reason : new Error(String(reason));
    const formatted = formatUncaughtError(err);
    log.error(`[UNHANDLED REJECTION] ${formatted}`);

    const hillclawErr = new HillclawError({
      code: ErrorCodes.UNHANDLED_REJECTION,
      subsystem: "gateway",
      severity: "critical",
      message: `Unhandled rejection: ${err.message}`,
      cause: err,
    });

    emitHillclawError(hillclawErr);
  });
}

// Re-export for convenience so callers need only one import
export { isHillclawError };
