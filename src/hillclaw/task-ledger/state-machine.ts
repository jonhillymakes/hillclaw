import type { TaskStatus } from "./types.js";
import { HillclawError } from "../../infra/hillclaw-error.js";

/**
 * Valid state transitions for the task lifecycle:
 *
 * pending -> assigned -> running -> validating -> completed
 *                                             -> failed
 *                                -> failed
 *                     -> failed
 *         -> failed
 *
 * Any state except completed/failed/timed_out -> timed_out
 */
const VALID_TRANSITIONS: Record<TaskStatus, TaskStatus[]> = {
  pending:    ["assigned", "failed", "timed_out"],
  assigned:   ["running", "failed", "timed_out"],
  running:    ["validating", "completed", "failed", "timed_out"],
  validating: ["completed", "failed", "timed_out"],
  completed:  [], // terminal
  failed:     [], // terminal
  timed_out:  [], // terminal
};

export function canTransition(from: TaskStatus, to: TaskStatus): boolean {
  return VALID_TRANSITIONS[from].includes(to);
}

export function assertTransition(from: TaskStatus, to: TaskStatus, taskId: string): void {
  if (!canTransition(from, to)) {
    throw new HillclawError({
      code: "INVALID_TASK_TRANSITION",
      subsystem: "task-ledger",
      severity: "high",
      message: `Invalid task transition: ${from} -> ${to} for task ${taskId}`,
    });
  }
}

export function isTerminalStatus(status: TaskStatus): boolean {
  return VALID_TRANSITIONS[status].length === 0;
}

export const TERMINAL_STATUSES: readonly TaskStatus[] = ["completed", "failed", "timed_out"];
