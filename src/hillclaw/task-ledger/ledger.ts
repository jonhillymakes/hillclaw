import crypto from "node:crypto";
import { getStateStore } from "../state-store/singleton.js";
import { assertTransition, isTerminalStatus } from "./state-machine.js";
import type { Task, TaskStatus, TaskReceipt, CreateTaskParams, UpdateTaskParams } from "./types.js";
import { HillclawError } from "../../infra/hillclaw-error.js";

export class TaskLedger {

  /**
   * Create a new task. All immutable fields are set here and cannot be modified later.
   */
  create(params: CreateTaskParams): Task {
    const store = getStateStore();
    const now = Date.now();
    const id = crypto.randomUUID();

    // Verify parent exists if provided
    if (params.parentId) {
      const parent = this.get(params.parentId);
      if (!parent) {
        throw new HillclawError({
          code: "TASK_PARENT_NOT_FOUND",
          subsystem: "task-ledger",
          severity: "high",
          message: `Parent task ${params.parentId} not found`,
        });
      }
    }

    store.db.prepare(`
      INSERT INTO tasks (id, parent_id, status, title, description, assigned_to, priority,
        created_at, created_by, updated_at, timeout_ms, metadata,
        receipt_input_tokens, receipt_output_tokens, receipt_total_tokens,
        receipt_cost_usd, receipt_duration_ms, receipt_model_calls)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 0, 0, 0, 0, 0, 0)
    `).run(
      id, params.parentId ?? null, "pending", params.title, params.description ?? null,
      params.assignedTo ?? null, params.priority ?? 0,
      now, params.createdBy ?? null, now, params.timeoutMs ?? null,
      params.metadata ? JSON.stringify(params.metadata) : null,
    );

    return this.get(id)!;
  }

  /**
   * Get a task by ID.
   */
  get(id: string): Task | undefined {
    const store = getStateStore();
    const row = store.db.prepare("SELECT * FROM tasks WHERE id = ?").get(id) as Record<string, unknown> | undefined;
    return row ? this.rowToTask(row) : undefined;
  }

  /**
   * Transition a task to a new status. Enforces the state machine.
   */
  transition(id: string, newStatus: TaskStatus, updates?: { result?: Record<string, unknown>; error?: Record<string, unknown> }): Task {
    const task = this.get(id);
    if (!task) {
      throw new HillclawError({
        code: "TASK_NOT_FOUND",
        subsystem: "task-ledger",
        severity: "high",
        message: `Task ${id} not found`,
      });
    }

    assertTransition(task.status, newStatus, id);

    const now = Date.now();
    const store = getStateStore();

    const cols: Record<string, unknown> = { status: newStatus, updated_at: now };

    if (newStatus === "running" && !task.startedAt) {
      cols.started_at = now;
    }
    if (isTerminalStatus(newStatus)) {
      cols.completed_at = now;
    }
    if (updates?.result) {
      cols.result = JSON.stringify(updates.result);
    }
    if (updates?.error) {
      cols.error = JSON.stringify(updates.error);
    }

    const setClauses = Object.keys(cols).map(k => `${k} = ?`).join(", ");
    store.db.prepare(`UPDATE tasks SET ${setClauses} WHERE id = ?`).run(...Object.values(cols), id);

    // Re-aggregate parent receipt if this task is now terminal
    const updated = this.get(id)!;
    if (isTerminalStatus(newStatus) && updated.parentId) {
      this.aggregateParentReceipt(updated.parentId);
    }

    return this.get(id)!;
  }

  /**
   * Update mutable fields on a task. Cannot change immutable fields (id, createdAt, createdBy).
   */
  update(id: string, params: UpdateTaskParams): Task {
    const task = this.get(id);
    if (!task) {
      throw new HillclawError({
        code: "TASK_NOT_FOUND",
        subsystem: "task-ledger",
        severity: "high",
        message: `Task ${id} not found`,
      });
    }

    if (isTerminalStatus(task.status)) {
      throw new HillclawError({
        code: "TASK_IMMUTABLE",
        subsystem: "task-ledger",
        severity: "medium",
        message: `Cannot update task ${id} in terminal status ${task.status}`,
      });
    }

    const store = getStateStore();
    const now = Date.now();
    const cols: Record<string, unknown> = { updated_at: now };

    if (params.assignedTo !== undefined) cols.assigned_to = params.assignedTo;
    if (params.priority !== undefined) cols.priority = params.priority;
    if (params.timeoutMs !== undefined) cols.timeout_ms = params.timeoutMs;
    if (params.metadata !== undefined) cols.metadata = JSON.stringify(params.metadata);
    if (params.result !== undefined) cols.result = JSON.stringify(params.result);
    if (params.error !== undefined) cols.error = JSON.stringify(params.error);

    const setClauses = Object.keys(cols).map(k => `${k} = ?`).join(", ");
    store.db.prepare(`UPDATE tasks SET ${setClauses} WHERE id = ?`).run(...Object.values(cols), id);

    return this.get(id)!;
  }

  /**
   * Add to a task's receipt (accumulate token/cost/call counts).
   */
  addReceipt(id: string, receipt: Partial<TaskReceipt>): Task {
    const task = this.get(id);
    if (!task) {
      throw new HillclawError({
        code: "TASK_NOT_FOUND",
        subsystem: "task-ledger",
        severity: "high",
        message: `Task ${id} not found`,
      });
    }

    const store = getStateStore();
    const now = Date.now();

    store.db.prepare(`
      UPDATE tasks SET
        receipt_input_tokens = receipt_input_tokens + ?,
        receipt_output_tokens = receipt_output_tokens + ?,
        receipt_total_tokens = receipt_total_tokens + ?,
        receipt_cost_usd = receipt_cost_usd + ?,
        receipt_duration_ms = receipt_duration_ms + ?,
        receipt_model_calls = receipt_model_calls + ?,
        updated_at = ?
      WHERE id = ?
    `).run(
      receipt.inputTokens ?? 0,
      receipt.outputTokens ?? 0,
      receipt.totalTokens ?? 0,
      receipt.costUsd ?? 0,
      receipt.durationMs ?? 0,
      receipt.modelCalls ?? 0,
      now,
      id,
    );

    return this.get(id)!;
  }

  /**
   * Get all children of a task.
   */
  getChildren(parentId: string): Task[] {
    const store = getStateStore();
    const rows = store.db.prepare("SELECT * FROM tasks WHERE parent_id = ? ORDER BY created_at").all(parentId) as Record<string, unknown>[];
    return rows.map(r => this.rowToTask(r));
  }

  /**
   * Query tasks by status.
   */
  queryByStatus(status: TaskStatus, limit?: number): Task[] {
    const store = getStateStore();
    const rows = store.db.prepare(
      `SELECT * FROM tasks WHERE status = ? ORDER BY priority DESC, created_at ASC LIMIT ?`
    ).all(status, limit ?? 100) as Record<string, unknown>[];
    return rows.map(r => this.rowToTask(r));
  }

  /**
   * Aggregate children's receipts into parent's receipt.
   */
  private aggregateParentReceipt(parentId: string): void {
    const store = getStateStore();

    const agg = store.db.prepare(`
      SELECT
        COALESCE(SUM(receipt_input_tokens), 0) as input_tokens,
        COALESCE(SUM(receipt_output_tokens), 0) as output_tokens,
        COALESCE(SUM(receipt_total_tokens), 0) as total_tokens,
        COALESCE(SUM(receipt_cost_usd), 0) as cost_usd,
        COALESCE(SUM(receipt_duration_ms), 0) as duration_ms,
        COALESCE(SUM(receipt_model_calls), 0) as model_calls
      FROM tasks WHERE parent_id = ?
    `).get(parentId) as Record<string, number> | undefined;

    if (agg) {
      store.db.prepare(`
        UPDATE tasks SET
          receipt_input_tokens = ?,
          receipt_output_tokens = ?,
          receipt_total_tokens = ?,
          receipt_cost_usd = ?,
          receipt_duration_ms = ?,
          receipt_model_calls = ?,
          updated_at = ?
        WHERE id = ?
      `).run(
        agg.input_tokens, agg.output_tokens, agg.total_tokens,
        agg.cost_usd, agg.duration_ms, agg.model_calls,
        Date.now(), parentId,
      );
    }
  }

  /**
   * Check for timed-out tasks and transition them.
   */
  checkTimeouts(): Task[] {
    const store = getStateStore();
    const now = Date.now();

    const rows = store.db.prepare(`
      SELECT * FROM tasks
      WHERE timeout_ms IS NOT NULL
        AND status NOT IN ('completed', 'failed', 'timed_out')
        AND (started_at IS NOT NULL AND ? - started_at > timeout_ms)
    `).all(now) as Record<string, unknown>[];

    const timedOut: Task[] = [];
    for (const row of rows) {
      const task = this.rowToTask(row);
      try {
        const updated = this.transition(task.id, "timed_out", {
          error: { reason: "timeout", timeoutMs: task.timeoutMs, elapsed: now - (task.startedAt ?? task.createdAt) },
        });
        timedOut.push(updated);
      } catch {
        // Skip if transition fails (e.g., concurrent modification)
      }
    }

    return timedOut;
  }

  private rowToTask(row: Record<string, unknown>): Task {
    return {
      id: row.id as string,
      parentId: row.parent_id != null ? (row.parent_id as string) : undefined,
      status: row.status as TaskStatus,
      title: row.title as string,
      description: row.description != null ? (row.description as string) : undefined,
      assignedTo: row.assigned_to != null ? (row.assigned_to as string) : undefined,
      priority: row.priority as number,
      createdAt: row.created_at as number,
      createdBy: row.created_by != null ? (row.created_by as string) : undefined,
      updatedAt: row.updated_at as number,
      startedAt: row.started_at != null ? (row.started_at as number) : undefined,
      completedAt: row.completed_at != null ? (row.completed_at as number) : undefined,
      timeoutMs: row.timeout_ms != null ? (row.timeout_ms as number) : undefined,
      receipt: {
        inputTokens: (row.receipt_input_tokens as number) ?? 0,
        outputTokens: (row.receipt_output_tokens as number) ?? 0,
        totalTokens: (row.receipt_total_tokens as number) ?? 0,
        costUsd: (row.receipt_cost_usd as number) ?? 0,
        durationMs: (row.receipt_duration_ms as number) ?? 0,
        modelCalls: (row.receipt_model_calls as number) ?? 0,
      },
      metadata: row.metadata != null ? JSON.parse(row.metadata as string) : undefined,
      result: row.result != null ? JSON.parse(row.result as string) : undefined,
      error: row.error != null ? JSON.parse(row.error as string) : undefined,
    };
  }
}

// Singleton
let _ledger: TaskLedger | null = null;

export function getTaskLedger(): TaskLedger {
  if (!_ledger) _ledger = new TaskLedger();
  return _ledger;
}

export function resetTaskLedgerForTest(): void {
  _ledger = null;
}
