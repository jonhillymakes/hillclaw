import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { emitDiagnosticEvent, resetDiagnosticEventsForTest } from "../../infra/diagnostic-events.js";
import { getStateStore, resetStateStoreForTest } from "../state-store/singleton.js";
import { startUsageSubscriber } from "./usage-subscriber.js";

// --- Temp DB helpers ---

let tempDirs: string[] = [];

function makeTempDbPath(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "hillclaw-sub-test-"));
  tempDirs.push(dir);
  return path.join(dir, "test.db");
}

afterEach(() => {
  for (const dir of tempDirs) {
    try {
      fs.rmSync(dir, { recursive: true, force: true });
    } catch {
      // ignore
    }
  }
  tempDirs = [];
});

// --- Shared setup ---

let dbPath: string;

beforeEach(() => {
  dbPath = makeTempDbPath();
  resetDiagnosticEventsForTest();
  resetStateStoreForTest();
  // Pre-initialize the singleton with our temp db
  getStateStore({ dbPath });
});

afterEach(() => {
  resetDiagnosticEventsForTest();
  resetStateStoreForTest();
});

// --- Helpers ---

function emitUsage(overrides: Partial<{
  sessionKey: string;
  sessionId: string;
  channel: string;
  provider: string;
  model: string;
  inputTokens: number;
  outputTokens: number;
  cacheRead: number;
  cacheWrite: number;
  total: number;
  costUsd: number;
  durationMs: number;
  contextLimit: number;
  contextUsed: number;
}> = {}) {
  emitDiagnosticEvent({
    type: "model.usage",
    sessionKey: overrides.sessionKey ?? "sk-test",
    sessionId: overrides.sessionId ?? "sid-test",
    channel: overrides.channel ?? "discord",
    provider: overrides.provider ?? "anthropic",
    model: overrides.model ?? "claude-3-5-sonnet",
    usage: {
      input: overrides.inputTokens ?? 100,
      output: overrides.outputTokens ?? 200,
      cacheRead: overrides.cacheRead,
      cacheWrite: overrides.cacheWrite,
      total: overrides.total ?? 300,
    },
    costUsd: overrides.costUsd ?? 0.005,
    durationMs: overrides.durationMs ?? 1500,
    context: {
      limit: overrides.contextLimit ?? 200_000,
      used: overrides.contextUsed ?? 5000,
    },
  });
}

// --- Direct (non-batch) mode ---

describe("startUsageSubscriber: direct mode", () => {
  it("persists a model.usage event to SQLite", () => {
    const unsubscribe = startUsageSubscriber();

    emitUsage({ provider: "anthropic", model: "claude-3-5-sonnet", total: 300, costUsd: 0.005 });

    const records = getStateStore().queryModelUsage({});
    expect(records).toHaveLength(1);
    expect(records[0].provider).toBe("anthropic");
    expect(records[0].model).toBe("claude-3-5-sonnet");
    expect(records[0].totalTokens).toBe(300);
    expect(records[0].costUsd).toBeCloseTo(0.005);

    unsubscribe();
  });

  it("ignores non-model.usage events", () => {
    const unsubscribe = startUsageSubscriber();

    emitDiagnosticEvent({
      type: "webhook.received",
      channel: "discord",
      updateType: "message",
    });
    emitDiagnosticEvent({
      type: "session.state",
      state: "idle",
    });

    const records = getStateStore().queryModelUsage({});
    expect(records).toHaveLength(0);

    unsubscribe();
  });

  it("maps all diagnostic event fields to ModelUsageRecord correctly", () => {
    const unsubscribe = startUsageSubscriber();

    emitDiagnosticEvent({
      type: "model.usage",
      sessionKey: "sk-abc",
      sessionId: "sid-xyz",
      channel: "telegram",
      provider: "openai",
      model: "gpt-4o",
      usage: {
        input: 111,
        output: 222,
        cacheRead: 33,
        cacheWrite: 44,
        total: 333,
      },
      costUsd: 0.012,
      durationMs: 2500,
      context: { limit: 128_000, used: 7000 },
    });

    const records = getStateStore().queryModelUsage({});
    expect(records).toHaveLength(1);
    const r = records[0];
    expect(r.sessionKey).toBe("sk-abc");
    expect(r.sessionId).toBe("sid-xyz");
    expect(r.channel).toBe("telegram");
    expect(r.provider).toBe("openai");
    expect(r.model).toBe("gpt-4o");
    expect(r.inputTokens).toBe(111);
    expect(r.outputTokens).toBe(222);
    expect(r.cacheReadTokens).toBe(33);
    expect(r.cacheWriteTokens).toBe(44);
    expect(r.totalTokens).toBe(333);
    expect(r.costUsd).toBeCloseTo(0.012);
    expect(r.durationMs).toBe(2500);
    expect(r.contextLimit).toBe(128_000);
    expect(r.contextUsed).toBe(7000);
    expect(r.rawEvent).toContain('"type":"model.usage"');

    unsubscribe();
  });

  it("falls back to promptTokens for totalTokens when total is absent", () => {
    const unsubscribe = startUsageSubscriber();

    emitDiagnosticEvent({
      type: "model.usage",
      usage: {
        input: 50,
        output: 75,
        promptTokens: 125,
      },
    });

    const records = getStateStore().queryModelUsage({});
    expect(records[0].totalTokens).toBe(125);

    unsubscribe();
  });

  it("stops listening after unsubscribe", () => {
    const unsubscribe = startUsageSubscriber();
    emitUsage({ total: 100 });
    unsubscribe();

    // Events emitted after unsubscribe should not be stored
    emitUsage({ total: 200 });

    const records = getStateStore().queryModelUsage({});
    expect(records).toHaveLength(1);
    expect(records[0].totalTokens).toBe(100);
  });

  it("persists multiple events", () => {
    const unsubscribe = startUsageSubscriber();

    emitUsage({ provider: "anthropic", total: 100 });
    emitUsage({ provider: "openai", total: 200 });
    emitUsage({ provider: "anthropic", total: 300 });

    const records = getStateStore().queryModelUsage({});
    expect(records).toHaveLength(3);

    unsubscribe();
  });

  it("does not crash when insertModelUsage throws", () => {
    // Close the real store to force an error on insert
    resetStateStoreForTest();
    // Re-initialize with a bad path that will be closed immediately
    const store = getStateStore({ dbPath });
    store.close();
    resetStateStoreForTest();
    // Open a fresh store so the singleton exists but we'll close it mid-flight
    const freshPath = makeTempDbPath();
    getStateStore({ dbPath: freshPath });
    getStateStore().db.close(); // close the underlying db, inserts will throw

    const unsubscribe = startUsageSubscriber();

    // Should not throw — errors are swallowed
    expect(() => emitUsage()).not.toThrow();

    unsubscribe();
  });
});

// --- Batch mode ---

describe("startUsageSubscriber: batch mode", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("does not persist immediately in batch mode", () => {
    const unsubscribe = startUsageSubscriber({ batchMode: true, batchFlushMs: 5000 });

    emitUsage({ total: 100 });

    // Nothing persisted yet — batch not flushed
    const records = getStateStore().queryModelUsage({});
    expect(records).toHaveLength(0);

    unsubscribe();
  });

  it("flushes batch after timer interval", () => {
    const unsubscribe = startUsageSubscriber({ batchMode: true, batchFlushMs: 5000 });

    emitUsage({ total: 111 });
    emitUsage({ total: 222 });

    expect(getStateStore().queryModelUsage({})).toHaveLength(0);

    vi.advanceTimersByTime(5000);

    const records = getStateStore().queryModelUsage({});
    expect(records).toHaveLength(2);

    unsubscribe();
  });

  it("forces flush when maxBatchSize is reached", () => {
    const unsubscribe = startUsageSubscriber({
      batchMode: true,
      batchFlushMs: 60_000,
      maxBatchSize: 3,
    });

    emitUsage({ total: 1 });
    emitUsage({ total: 2 });
    expect(getStateStore().queryModelUsage({})).toHaveLength(0);

    emitUsage({ total: 3 }); // triggers forced flush at size=3

    const records = getStateStore().queryModelUsage({});
    expect(records).toHaveLength(3);

    unsubscribe();
  });

  it("performs final flush on unsubscribe", () => {
    const unsubscribe = startUsageSubscriber({ batchMode: true, batchFlushMs: 60_000 });

    emitUsage({ total: 42 });
    expect(getStateStore().queryModelUsage({})).toHaveLength(0);

    unsubscribe(); // final flush should happen here

    const records = getStateStore().queryModelUsage({});
    expect(records).toHaveLength(1);
    expect(records[0].totalTokens).toBe(42);
  });

  it("stops listening after unsubscribe in batch mode", () => {
    const unsubscribe = startUsageSubscriber({ batchMode: true, batchFlushMs: 100 });

    emitUsage({ total: 10 });
    unsubscribe(); // flushes 1 record and detaches listener

    emitUsage({ total: 20 }); // should be ignored

    vi.advanceTimersByTime(200);

    const records = getStateStore().queryModelUsage({});
    expect(records).toHaveLength(1);
    expect(records[0].totalTokens).toBe(10);
  });

  it("does not crash in batch mode when insert fails", () => {
    const unsubscribe = startUsageSubscriber({ batchMode: true, batchFlushMs: 5000, maxBatchSize: 100 });

    emitUsage({ total: 99 });

    // Close the db before flush to force insert error
    getStateStore().db.close();

    expect(() => vi.advanceTimersByTime(5000)).not.toThrow();

    unsubscribe();
  });

  it("uses custom batchFlushMs interval", () => {
    const unsubscribe = startUsageSubscriber({ batchMode: true, batchFlushMs: 1000 });

    emitUsage({ total: 55 });

    vi.advanceTimersByTime(999);
    expect(getStateStore().queryModelUsage({})).toHaveLength(0);

    vi.advanceTimersByTime(1);
    expect(getStateStore().queryModelUsage({})).toHaveLength(1);

    unsubscribe();
  });
});
