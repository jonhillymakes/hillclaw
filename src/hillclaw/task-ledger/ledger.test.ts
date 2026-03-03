import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { HillclawStateStore } from "../state-store/store.js";
import { getStateStore, resetStateStoreForTest } from "../state-store/singleton.js";
import { TaskLedger, resetTaskLedgerForTest } from "./ledger.js";
import { HillclawError } from "../../infra/hillclaw-error.js";

// --- Test helpers ---

let tempDirs: string[] = [];

function makeTempDbPath(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "hillclaw-ledger-test-"));
  tempDirs.push(dir);
  return path.join(dir, "test.db");
}

let ledger: TaskLedger;

beforeEach(() => {
  resetStateStoreForTest();
  resetTaskLedgerForTest();
  // Point the singleton at a fresh temp DB via env var, then let ledger create it lazily
  const dbPath = makeTempDbPath();
  process.env.OPENCLAW_STATE_DIR = path.dirname(dbPath);
  // Open the store once to verify it works, then close so the singleton can re-open it
  new HillclawStateStore({ dbPath }).close();
  ledger = new TaskLedger();
});

afterEach(() => {
  resetStateStoreForTest();
  resetTaskLedgerForTest();
  delete process.env.OPENCLAW_STATE_DIR;
  for (const dir of tempDirs) {
    try {
      fs.rmSync(dir, { recursive: true, force: true });
    } catch {
      // ignore
    }
  }
  tempDirs = [];
});

// --- Creation ---

describe("TaskLedger.create", () => {
  it("creates a task with all fields populated", () => {
    const task = ledger.create({
      title: "My Task",
      description: "A description",
      assignedTo: "agent-1",
      priority: 5,
      createdBy: "orchestrator",
      timeoutMs: 30000,
      metadata: { key: "value" },
    });

    expect(task.id).toMatch(/^[0-9a-f-]{36}$/);
    expect(task.title).toBe("My Task");
    expect(task.description).toBe("A description");
    expect(task.assignedTo).toBe("agent-1");
    expect(task.priority).toBe(5);
    expect(task.createdBy).toBe("orchestrator");
    expect(task.timeoutMs).toBe(30000);
    expect(task.metadata).toEqual({ key: "value" });
    expect(task.status).toBe("pending");
    expect(task.createdAt).toBeGreaterThan(0);
    expect(task.updatedAt).toBeGreaterThan(0);
    expect(task.startedAt).toBeUndefined();
    expect(task.completedAt).toBeUndefined();
    expect(task.receipt).toEqual({
      inputTokens: 0,
      outputTokens: 0,
      totalTokens: 0,
      costUsd: 0,
      durationMs: 0,
      modelCalls: 0,
    });
  });

  it("creates a task with minimal fields using defaults", () => {
    const task = ledger.create({ title: "Minimal" });
    expect(task.title).toBe("Minimal");
    expect(task.priority).toBe(0);
    expect(task.status).toBe("pending");
    expect(task.description).toBeUndefined();
    expect(task.parentId).toBeUndefined();
    expect(task.assignedTo).toBeUndefined();
    expect(task.createdBy).toBeUndefined();
    expect(task.timeoutMs).toBeUndefined();
    expect(task.metadata).toBeUndefined();
  });

  it("assigns a unique ID to each task", () => {
    const t1 = ledger.create({ title: "A" });
    const t2 = ledger.create({ title: "B" });
    expect(t1.id).not.toBe(t2.id);
  });

  it("createdAt and updatedAt are set at creation time", () => {
    const before = Date.now();
    const task = ledger.create({ title: "T" });
    const after = Date.now();
    expect(task.createdAt).toBeGreaterThanOrEqual(before);
    expect(task.createdAt).toBeLessThanOrEqual(after);
    expect(task.updatedAt).toBeGreaterThanOrEqual(before);
    expect(task.updatedAt).toBeLessThanOrEqual(after);
  });

  it("throws TASK_PARENT_NOT_FOUND when parentId does not exist", () => {
    let caught: HillclawError | undefined;
    try {
      ledger.create({ title: "Child", parentId: "non-existent-id" });
    } catch (e) {
      caught = e as HillclawError;
    }
    expect(caught).toBeInstanceOf(HillclawError);
    expect(caught!.code).toBe("TASK_PARENT_NOT_FOUND");
  });

  it("creates a child task linked to a parent", () => {
    const parent = ledger.create({ title: "Parent" });
    const child = ledger.create({ title: "Child", parentId: parent.id });
    expect(child.parentId).toBe(parent.id);
  });
});

// --- Get ---

describe("TaskLedger.get", () => {
  it("returns the task by id", () => {
    const created = ledger.create({ title: "Find me" });
    const found = ledger.get(created.id);
    expect(found).toBeDefined();
    expect(found!.id).toBe(created.id);
    expect(found!.title).toBe("Find me");
  });

  it("returns undefined for unknown id", () => {
    expect(ledger.get("does-not-exist")).toBeUndefined();
  });
});

// --- Immutability of createdAt, createdBy, id ---

describe("immutable fields", () => {
  it("id cannot be changed via update", () => {
    const task = ledger.create({ title: "T", createdBy: "me" });
    const originalId = task.id;
    // update does not expose id as a param — verify it stays the same
    ledger.update(task.id, { assignedTo: "agent-2" });
    const after = ledger.get(originalId);
    expect(after).toBeDefined();
    expect(after!.id).toBe(originalId);
  });

  it("createdAt does not change after update", () => {
    const task = ledger.create({ title: "T" });
    const originalCreatedAt = task.createdAt;
    ledger.update(task.id, { priority: 99 });
    const after = ledger.get(task.id)!;
    expect(after.createdAt).toBe(originalCreatedAt);
  });

  it("createdBy does not change after update", () => {
    const task = ledger.create({ title: "T", createdBy: "original-creator" });
    ledger.update(task.id, { assignedTo: "someone" });
    const after = ledger.get(task.id)!;
    expect(after.createdBy).toBe("original-creator");
  });
});

// --- State machine transitions ---

describe("TaskLedger.transition - valid transitions", () => {
  it("pending -> assigned", () => {
    const task = ledger.create({ title: "T" });
    const updated = ledger.transition(task.id, "assigned");
    expect(updated.status).toBe("assigned");
  });

  it("pending -> failed", () => {
    const task = ledger.create({ title: "T" });
    const updated = ledger.transition(task.id, "failed");
    expect(updated.status).toBe("failed");
  });

  it("pending -> timed_out", () => {
    const task = ledger.create({ title: "T" });
    const updated = ledger.transition(task.id, "timed_out");
    expect(updated.status).toBe("timed_out");
  });

  it("assigned -> running sets startedAt", () => {
    const task = ledger.create({ title: "T" });
    ledger.transition(task.id, "assigned");
    const updated = ledger.transition(task.id, "running");
    expect(updated.status).toBe("running");
    expect(updated.startedAt).toBeDefined();
    expect(updated.startedAt).toBeGreaterThan(0);
  });

  it("assigned -> failed", () => {
    const task = ledger.create({ title: "T" });
    ledger.transition(task.id, "assigned");
    const updated = ledger.transition(task.id, "failed");
    expect(updated.status).toBe("failed");
  });

  it("assigned -> timed_out", () => {
    const task = ledger.create({ title: "T" });
    ledger.transition(task.id, "assigned");
    const updated = ledger.transition(task.id, "timed_out");
    expect(updated.status).toBe("timed_out");
  });

  it("running -> validating", () => {
    const task = ledger.create({ title: "T" });
    ledger.transition(task.id, "assigned");
    ledger.transition(task.id, "running");
    const updated = ledger.transition(task.id, "validating");
    expect(updated.status).toBe("validating");
  });

  it("running -> completed sets completedAt", () => {
    const task = ledger.create({ title: "T" });
    ledger.transition(task.id, "assigned");
    ledger.transition(task.id, "running");
    const updated = ledger.transition(task.id, "completed");
    expect(updated.status).toBe("completed");
    expect(updated.completedAt).toBeDefined();
    expect(updated.completedAt).toBeGreaterThan(0);
  });

  it("running -> failed", () => {
    const task = ledger.create({ title: "T" });
    ledger.transition(task.id, "assigned");
    ledger.transition(task.id, "running");
    const updated = ledger.transition(task.id, "failed");
    expect(updated.status).toBe("failed");
  });

  it("running -> timed_out", () => {
    const task = ledger.create({ title: "T" });
    ledger.transition(task.id, "assigned");
    ledger.transition(task.id, "running");
    const updated = ledger.transition(task.id, "timed_out");
    expect(updated.status).toBe("timed_out");
  });

  it("validating -> completed", () => {
    const task = ledger.create({ title: "T" });
    ledger.transition(task.id, "assigned");
    ledger.transition(task.id, "running");
    ledger.transition(task.id, "validating");
    const updated = ledger.transition(task.id, "completed");
    expect(updated.status).toBe("completed");
  });

  it("validating -> failed", () => {
    const task = ledger.create({ title: "T" });
    ledger.transition(task.id, "assigned");
    ledger.transition(task.id, "running");
    ledger.transition(task.id, "validating");
    const updated = ledger.transition(task.id, "failed");
    expect(updated.status).toBe("failed");
  });

  it("validating -> timed_out", () => {
    const task = ledger.create({ title: "T" });
    ledger.transition(task.id, "assigned");
    ledger.transition(task.id, "running");
    ledger.transition(task.id, "validating");
    const updated = ledger.transition(task.id, "timed_out");
    expect(updated.status).toBe("timed_out");
  });

  it("sets result on transition to completed", () => {
    const task = ledger.create({ title: "T" });
    ledger.transition(task.id, "assigned");
    ledger.transition(task.id, "running");
    const updated = ledger.transition(task.id, "completed", { result: { output: "done" } });
    expect(updated.result).toEqual({ output: "done" });
  });

  it("sets error on transition to failed", () => {
    const task = ledger.create({ title: "T" });
    const updated = ledger.transition(task.id, "failed", { error: { msg: "oops" } });
    expect(updated.error).toEqual({ msg: "oops" });
  });

  it("sets completedAt on any terminal transition", () => {
    const task = ledger.create({ title: "T" });
    const updated = ledger.transition(task.id, "failed");
    expect(updated.completedAt).toBeGreaterThan(0);
  });
});

describe("TaskLedger.transition - invalid transitions", () => {
  it("completed -> running throws INVALID_TASK_TRANSITION", () => {
    const task = ledger.create({ title: "T" });
    ledger.transition(task.id, "assigned");
    ledger.transition(task.id, "running");
    ledger.transition(task.id, "completed");
    let caught: HillclawError | undefined;
    try {
      ledger.transition(task.id, "running");
    } catch (e) {
      caught = e as HillclawError;
    }
    expect(caught).toBeInstanceOf(HillclawError);
    expect(caught!.code).toBe("INVALID_TASK_TRANSITION");
  });

  it("completed -> assigned throws", () => {
    const task = ledger.create({ title: "T" });
    ledger.transition(task.id, "assigned");
    ledger.transition(task.id, "running");
    ledger.transition(task.id, "completed");
    expect(() => ledger.transition(task.id, "assigned")).toThrow(HillclawError);
  });

  it("failed -> pending throws", () => {
    const task = ledger.create({ title: "T" });
    ledger.transition(task.id, "failed");
    expect(() => ledger.transition(task.id, "pending" as never)).toThrow(HillclawError);
  });

  it("timed_out -> running throws", () => {
    const task = ledger.create({ title: "T" });
    ledger.transition(task.id, "timed_out");
    expect(() => ledger.transition(task.id, "running")).toThrow(HillclawError);
  });

  it("pending -> running throws (skipping assigned)", () => {
    const task = ledger.create({ title: "T" });
    expect(() => ledger.transition(task.id, "running")).toThrow(HillclawError);
  });

  it("pending -> validating throws", () => {
    const task = ledger.create({ title: "T" });
    expect(() => ledger.transition(task.id, "validating")).toThrow(HillclawError);
  });

  it("pending -> completed throws", () => {
    const task = ledger.create({ title: "T" });
    expect(() => ledger.transition(task.id, "completed")).toThrow(HillclawError);
  });

  it("throws TASK_NOT_FOUND for unknown task id", () => {
    let caught: HillclawError | undefined;
    try {
      ledger.transition("no-such-id", "assigned");
    } catch (e) {
      caught = e as HillclawError;
    }
    expect(caught).toBeInstanceOf(HillclawError);
    expect(caught!.code).toBe("TASK_NOT_FOUND");
  });
});

// --- Update ---

describe("TaskLedger.update", () => {
  it("updates mutable fields", () => {
    const task = ledger.create({ title: "T" });
    const updated = ledger.update(task.id, {
      assignedTo: "agent-X",
      priority: 10,
      timeoutMs: 5000,
      metadata: { foo: "bar" },
    });
    expect(updated.assignedTo).toBe("agent-X");
    expect(updated.priority).toBe(10);
    expect(updated.timeoutMs).toBe(5000);
    expect(updated.metadata).toEqual({ foo: "bar" });
  });

  it("updates updatedAt when fields change", () => {
    const task = ledger.create({ title: "T" });
    const before = task.updatedAt;
    const updated = ledger.update(task.id, { priority: 3 });
    expect(updated.updatedAt).toBeGreaterThanOrEqual(before);
  });

  it("throws TASK_NOT_FOUND for unknown id", () => {
    let caught: HillclawError | undefined;
    try {
      ledger.update("no-such", { priority: 1 });
    } catch (e) {
      caught = e as HillclawError;
    }
    expect(caught).toBeInstanceOf(HillclawError);
    expect(caught!.code).toBe("TASK_NOT_FOUND");
  });

  it("throws TASK_IMMUTABLE when task is completed", () => {
    const task = ledger.create({ title: "T" });
    ledger.transition(task.id, "assigned");
    ledger.transition(task.id, "running");
    ledger.transition(task.id, "completed");
    let caught: HillclawError | undefined;
    try {
      ledger.update(task.id, { priority: 1 });
    } catch (e) {
      caught = e as HillclawError;
    }
    expect(caught).toBeInstanceOf(HillclawError);
    expect(caught!.code).toBe("TASK_IMMUTABLE");
  });

  it("throws TASK_IMMUTABLE when task is failed", () => {
    const task = ledger.create({ title: "T" });
    ledger.transition(task.id, "failed");
    expect(() => ledger.update(task.id, { priority: 1 })).toThrow(HillclawError);
  });

  it("throws TASK_IMMUTABLE when task is timed_out", () => {
    const task = ledger.create({ title: "T" });
    ledger.transition(task.id, "timed_out");
    expect(() => ledger.update(task.id, { priority: 1 })).toThrow(HillclawError);
  });
});

// --- Receipt ---

describe("TaskLedger.addReceipt", () => {
  it("accumulates receipt fields across multiple calls", () => {
    const task = ledger.create({ title: "T" });
    ledger.addReceipt(task.id, { inputTokens: 100, outputTokens: 50, totalTokens: 150, costUsd: 0.01, durationMs: 200, modelCalls: 1 });
    ledger.addReceipt(task.id, { inputTokens: 200, outputTokens: 100, totalTokens: 300, costUsd: 0.02, durationMs: 400, modelCalls: 2 });
    const updated = ledger.get(task.id)!;
    expect(updated.receipt.inputTokens).toBe(300);
    expect(updated.receipt.outputTokens).toBe(150);
    expect(updated.receipt.totalTokens).toBe(450);
    expect(updated.receipt.costUsd).toBeCloseTo(0.03);
    expect(updated.receipt.durationMs).toBe(600);
    expect(updated.receipt.modelCalls).toBe(3);
  });

  it("partial receipt update uses 0 for missing fields", () => {
    const task = ledger.create({ title: "T" });
    ledger.addReceipt(task.id, { modelCalls: 5 });
    const updated = ledger.get(task.id)!;
    expect(updated.receipt.modelCalls).toBe(5);
    expect(updated.receipt.inputTokens).toBe(0);
    expect(updated.receipt.costUsd).toBe(0);
  });

  it("throws TASK_NOT_FOUND for unknown id", () => {
    let caught: HillclawError | undefined;
    try {
      ledger.addReceipt("no-such", { modelCalls: 1 });
    } catch (e) {
      caught = e as HillclawError;
    }
    expect(caught).toBeInstanceOf(HillclawError);
    expect(caught!.code).toBe("TASK_NOT_FOUND");
  });
});

// --- Receipt aggregation: parent receipt = sum of children ---

describe("receipt aggregation", () => {
  it("aggregates child receipts into parent when child reaches terminal status", () => {
    const parent = ledger.create({ title: "Parent" });
    const child1 = ledger.create({ title: "Child1", parentId: parent.id });
    const child2 = ledger.create({ title: "Child2", parentId: parent.id });

    ledger.addReceipt(child1.id, { inputTokens: 100, outputTokens: 50, totalTokens: 150, costUsd: 0.01, durationMs: 100, modelCalls: 1 });
    ledger.addReceipt(child2.id, { inputTokens: 200, outputTokens: 100, totalTokens: 300, costUsd: 0.02, durationMs: 200, modelCalls: 2 });

    // Complete child1 — triggers aggregation of all children (including pending child2)
    ledger.transition(child1.id, "assigned");
    ledger.transition(child1.id, "running");
    ledger.transition(child1.id, "completed");

    // Aggregation sums ALL children regardless of status, so parent sees both
    const afterChild1 = ledger.get(parent.id)!;
    expect(afterChild1.receipt.inputTokens).toBe(300);

    // Complete child2 — triggers aggregation again
    ledger.transition(child2.id, "assigned");
    ledger.transition(child2.id, "running");
    ledger.transition(child2.id, "completed");

    const afterChild2 = ledger.get(parent.id)!;
    expect(afterChild2.receipt.inputTokens).toBe(300);
    expect(afterChild2.receipt.outputTokens).toBe(150);
    expect(afterChild2.receipt.totalTokens).toBe(450);
    expect(afterChild2.receipt.costUsd).toBeCloseTo(0.03);
    expect(afterChild2.receipt.durationMs).toBe(300);
    expect(afterChild2.receipt.modelCalls).toBe(3);
  });
});

// --- Parent-child ---

describe("parent-child relationships", () => {
  it("getChildren returns all children of a parent", () => {
    const parent = ledger.create({ title: "Parent" });
    const child1 = ledger.create({ title: "Child1", parentId: parent.id });
    const child2 = ledger.create({ title: "Child2", parentId: parent.id });
    const children = ledger.getChildren(parent.id);
    expect(children).toHaveLength(2);
    const ids = children.map(c => c.id);
    expect(ids).toContain(child1.id);
    expect(ids).toContain(child2.id);
  });

  it("getChildren returns empty array when no children", () => {
    const task = ledger.create({ title: "Lonely" });
    expect(ledger.getChildren(task.id)).toHaveLength(0);
  });

  it("children are ordered by created_at", () => {
    const parent = ledger.create({ title: "Parent" });
    const c1 = ledger.create({ title: "First", parentId: parent.id });
    const c2 = ledger.create({ title: "Second", parentId: parent.id });
    const children = ledger.getChildren(parent.id);
    expect(children[0].id).toBe(c1.id);
    expect(children[1].id).toBe(c2.id);
  });
});

// --- queryByStatus ---

describe("TaskLedger.queryByStatus", () => {
  it("returns tasks matching the given status", () => {
    const t1 = ledger.create({ title: "A" });
    const t2 = ledger.create({ title: "B" });
    ledger.create({ title: "C" });
    ledger.transition(t1.id, "assigned");
    ledger.transition(t2.id, "assigned");

    const assigned = ledger.queryByStatus("assigned");
    expect(assigned).toHaveLength(2);
    const pending = ledger.queryByStatus("pending");
    expect(pending).toHaveLength(1);
  });

  it("returns tasks sorted by priority DESC then created_at ASC", () => {
    const low = ledger.create({ title: "Low", priority: 1 });
    const high = ledger.create({ title: "High", priority: 10 });
    const mid = ledger.create({ title: "Mid", priority: 5 });

    const result = ledger.queryByStatus("pending");
    expect(result[0].id).toBe(high.id);
    expect(result[1].id).toBe(mid.id);
    expect(result[2].id).toBe(low.id);
  });

  it("respects the limit parameter", () => {
    ledger.create({ title: "A" });
    ledger.create({ title: "B" });
    ledger.create({ title: "C" });

    const result = ledger.queryByStatus("pending", 2);
    expect(result).toHaveLength(2);
  });

  it("returns empty array when no tasks match status", () => {
    ledger.create({ title: "T" });
    expect(ledger.queryByStatus("completed")).toHaveLength(0);
  });
});

// --- Timeout ---

describe("TaskLedger.checkTimeouts", () => {
  it("transitions overdue running tasks to timed_out", () => {
    const task = ledger.create({ title: "T", timeoutMs: 100 });
    ledger.transition(task.id, "assigned");
    ledger.transition(task.id, "running");

    // Backdate started_at to simulate elapsed time
    const s = getStateStore();
    s.db.prepare("UPDATE tasks SET started_at = ? WHERE id = ?").run(Date.now() - 5000, task.id);

    const timedOut = ledger.checkTimeouts();
    expect(timedOut).toHaveLength(1);
    expect(timedOut[0].id).toBe(task.id);
    expect(timedOut[0].status).toBe("timed_out");
    expect(timedOut[0].error).toMatchObject({ reason: "timeout" });
  });

  it("does not time out tasks without startedAt (not yet running)", () => {
    ledger.create({ title: "T", timeoutMs: 1 });
    // Task is pending — no started_at set
    const timedOut = ledger.checkTimeouts();
    expect(timedOut).toHaveLength(0);
  });

  it("does not time out tasks that are already terminal", () => {
    const task = ledger.create({ title: "T", timeoutMs: 1 });
    ledger.transition(task.id, "assigned");
    ledger.transition(task.id, "running");
    ledger.transition(task.id, "completed");
    const timedOut = ledger.checkTimeouts();
    expect(timedOut).toHaveLength(0);
  });

  it("does not time out tasks whose timeout has not elapsed", () => {
    const task = ledger.create({ title: "T", timeoutMs: 60000 });
    ledger.transition(task.id, "assigned");
    ledger.transition(task.id, "running");
    const timedOut = ledger.checkTimeouts();
    expect(timedOut).toHaveLength(0);
  });
});
