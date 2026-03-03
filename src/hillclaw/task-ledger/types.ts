export type TaskStatus = "pending" | "assigned" | "running" | "validating" | "completed" | "failed" | "timed_out";

export interface TaskReceipt {
  inputTokens: number;
  outputTokens: number;
  totalTokens: number;
  costUsd: number;
  durationMs: number;
  modelCalls: number;
}

export interface Task {
  id: string;
  parentId?: string;
  status: TaskStatus;
  title: string;
  description?: string;
  assignedTo?: string;
  priority: number;

  // Immutable (set at creation)
  createdAt: number;
  createdBy?: string;

  // Mutable
  updatedAt: number;
  startedAt?: number;
  completedAt?: number;
  timeoutMs?: number;

  // Receipt
  receipt: TaskReceipt;

  // Metadata
  metadata?: Record<string, unknown>;
  result?: Record<string, unknown>;
  error?: Record<string, unknown>;
}

export interface CreateTaskParams {
  title: string;
  description?: string;
  parentId?: string;
  assignedTo?: string;
  priority?: number;
  createdBy?: string;
  timeoutMs?: number;
  metadata?: Record<string, unknown>;
}

export interface UpdateTaskParams {
  assignedTo?: string;
  priority?: number;
  timeoutMs?: number;
  metadata?: Record<string, unknown>;
  result?: Record<string, unknown>;
  error?: Record<string, unknown>;
}
