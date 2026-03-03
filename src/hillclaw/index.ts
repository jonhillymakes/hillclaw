export {
  HILLCLAW_ALLOWED_CHANNELS,
  enforceDiscordOnly,
  validateDiscordOnly,
} from "./channel-guard.js";
export type { HillclawAllowedChannel } from "./channel-guard.js";

export {
  validateConfigPatch,
  ConfigWriteRateLimiter,
  getConfigWriteRateLimiter,
  resetConfigWriteRateLimiterForTest,
} from "./config-rpc-guard.js";
export type { ConfigWriteResult } from "./config-rpc-guard.js";

export { atomicWriteFile, testAtomicRenameSupport } from "./atomic-write.js";
export type { AtomicWriteOptions } from "./atomic-write.js";

export {
  backupBasePath,
  backupGenPath,
  rotateBackups,
} from "./backup-rotation.js";
export type { BackupRotationOptions, BackupRotationResult } from "./backup-rotation.js";

export { startUsageSubscriber, getUsageReport, formatUsageReport } from "./instrumentation/index.js";
export type { UsageSubscriberOptions, UsageReport } from "./instrumentation/index.js";

export { acquireBootGuard, isGatewayRunning } from "./boot-guard.js";
export type { BootGuardHandle, BootGuardOptions } from "./boot-guard.js";

export {
  checkAndRecoverStaleLocks,
  cleanupOrphanedLocks,
} from "./session-lock-hardener.js";
export type { LockInfo } from "./session-lock-hardener.js";

export { DiscordErrorReporter } from "./discord-error-reporter/index.js";
export type {
  DiscordErrorReporterOptions,
  DiscordEmbed,
} from "./discord-error-reporter/index.js";

export {
  TaskLedger,
  getTaskLedger,
  resetTaskLedgerForTest,
  canTransition,
  assertTransition,
  isTerminalStatus,
  TERMINAL_STATUSES,
} from "./task-ledger/index.js";
export type {
  Task,
  TaskStatus,
  TaskReceipt,
  CreateTaskParams,
  UpdateTaskParams,
} from "./task-ledger/index.js";
