export type HillclawSeverity = "critical" | "high" | "medium" | "low";

export type HillclawSubsystem =
  | "config"
  | "session"
  | "gateway"
  | "agent"
  | "discord"
  | "instrumentation"
  | "state-store"
  | "task-ledger"
  | "credential";

export class HillclawError extends Error {
  readonly code: string;
  readonly subsystem: HillclawSubsystem;
  readonly severity: HillclawSeverity;
  override readonly cause?: Error;
  readonly sessionKey?: string;
  readonly agentId?: string;
  readonly timestamp: number;

  constructor(params: {
    code: string;
    subsystem: HillclawSubsystem;
    severity: HillclawSeverity;
    message: string;
    cause?: Error;
    sessionKey?: string;
    agentId?: string;
  }) {
    super(params.message, { cause: params.cause });
    this.name = "HillclawError";
    this.code = params.code;
    this.subsystem = params.subsystem;
    this.severity = params.severity;
    this.cause = params.cause;
    this.sessionKey = params.sessionKey;
    this.agentId = params.agentId;
    this.timestamp = Date.now();
  }
}

export function isHillclawError(err: unknown): err is HillclawError {
  return err instanceof HillclawError;
}

// Common error codes as constants
export const ErrorCodes = {
  CONFIG_WRITE_FAILED: "CONFIG_WRITE_FAILED",
  CONFIG_BACKUP_FAILED: "CONFIG_BACKUP_FAILED",
  CONFIG_ENV_REF_LOST: "CONFIG_ENV_REF_LOST",
  CONFIG_AUDIT_FAILED: "CONFIG_AUDIT_FAILED",
  SESSION_STORE_READ_FAILED: "SESSION_STORE_READ_FAILED",
  SESSION_DELIVERY_FAILED: "SESSION_DELIVERY_FAILED",
  SESSION_LOCK_FAILED: "SESSION_LOCK_FAILED",
  SESSION_ROTATION_FAILED: "SESSION_ROTATION_FAILED",
  GATEWAY_PARSE_ERROR: "GATEWAY_PARSE_ERROR",
  GATEWAY_BOOT_GUARD_FAILED: "GATEWAY_BOOT_GUARD_FAILED",
  GATEWAY_RESTART_FAILED: "GATEWAY_RESTART_FAILED",
  AGENT_TOOL_DELIVERY_FAILED: "AGENT_TOOL_DELIVERY_FAILED",
  AGENT_MEMORY_FLUSH_FAILED: "AGENT_MEMORY_FLUSH_FAILED",
  AGENT_TOKEN_PERSIST_FAILED: "AGENT_TOKEN_PERSIST_FAILED",
  DISCORD_SEND_FAILED: "DISCORD_SEND_FAILED",
  DISCORD_CHANNEL_ERROR: "DISCORD_CHANNEL_ERROR",
  UNCAUGHT_EXCEPTION: "UNCAUGHT_EXCEPTION",
  UNHANDLED_REJECTION: "UNHANDLED_REJECTION",
} as const;
