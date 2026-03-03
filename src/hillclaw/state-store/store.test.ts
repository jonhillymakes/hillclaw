import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { AuditLogEntry, ErrorLogEntry, ModelUsageRecord } from "./store.js";
import { HillclawStateStore } from "./store.js";
import { closeStateStore, getStateStore, resetStateStoreForTest } from "./singleton.js";

// Helper: create a unique temp db path for each test
let tempDirs: string[] = [];

function makeTempDbPath(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "hillclaw-test-"));
  tempDirs.push(dir);
  return path.join(dir, "test.db");
}

afterEach(() => {
  // Clean up temp dirs
  for (const dir of tempDirs) {
    try {
      fs.rmSync(dir, { recursive: true, force: true });
    } catch {
      // ignore
    }
  }
  tempDirs = [];
});

// --- Construction and schema ---

describe("HillclawStateStore construction", () => {
  it("creates the database file on disk", () => {
    const dbPath = makeTempDbPath();
    const store = new HillclawStateStore({ dbPath });
    expect(fs.existsSync(dbPath)).toBe(true);
    store.close();
  });

  it("creates parent directories that do not exist", () => {
    const base = fs.mkdtempSync(path.join(os.tmpdir(), "hillclaw-test-"));
    tempDirs.push(base);
    const dbPath = path.join(base, "nested", "deep", "test.db");
    const store = new HillclawStateStore({ dbPath });
    expect(fs.existsSync(dbPath)).toBe(true);
    store.close();
  });

  it("enables WAL mode by default", () => {
    const store = new HillclawStateStore({ dbPath: makeTempDbPath() });
    const row = store.db.pragma("journal_mode", { simple: true });
    expect(row).toBe("wal");
    store.close();
  });

  it("skips WAL mode when walMode: false", () => {
    const store = new HillclawStateStore({ dbPath: makeTempDbPath(), walMode: false });
    const row = store.db.pragma("journal_mode", { simple: true });
    expect(row).toBe("delete");
    store.close();
  });

  it("initializes all expected tables", () => {
    const store = new HillclawStateStore({ dbPath: makeTempDbPath() });
    const tables = store.db
      .prepare("SELECT name FROM sqlite_master WHERE type='table' ORDER BY name")
      .all() as { name: string }[];
    const names = tables.map((t) => t.name);
    expect(names).toContain("model_usage");
    expect(names).toContain("tasks");
    expect(names).toContain("audit_log");
    expect(names).toContain("error_log");
    expect(names).toContain("schema_version");
    store.close();
  });

  it("records schema version 1 on first init", () => {
    const store = new HillclawStateStore({ dbPath: makeTempDbPath() });
    const row = store.db
      .prepare("SELECT version FROM schema_version WHERE version = 1")
      .get() as { version: number } | undefined;
    expect(row?.version).toBe(1);
    store.close();
  });

  it("is idempotent: opening the same DB twice does not error", () => {
    const dbPath = makeTempDbPath();
    const s1 = new HillclawStateStore({ dbPath });
    s1.close();
    const s2 = new HillclawStateStore({ dbPath });
    s2.close();
  });

  it("close() works cleanly", () => {
    const store = new HillclawStateStore({ dbPath: makeTempDbPath() });
    expect(() => store.close()).not.toThrow();
  });
});

// --- Model usage ---

describe("model usage: insertModelUsage / queryModelUsage", () => {
  let store: HillclawStateStore;

  beforeEach(() => {
    store = new HillclawStateStore({ dbPath: makeTempDbPath() });
  });

  afterEach(() => {
    store.close();
  });

  it("inserts and retrieves a full record", () => {
    const record: ModelUsageRecord = {
      ts: 1_700_000_000_000,
      sessionKey: "sk-abc",
      sessionId: "sid-123",
      channel: "discord",
      provider: "anthropic",
      model: "claude-3-5-sonnet",
      inputTokens: 100,
      outputTokens: 200,
      cacheReadTokens: 50,
      cacheWriteTokens: 10,
      totalTokens: 300,
      costUsd: 0.005,
      durationMs: 1500,
      contextLimit: 200_000,
      contextUsed: 5000,
      rawEvent: JSON.stringify({ type: "model_usage" }),
    };

    store.insertModelUsage(record);
    const results = store.queryModelUsage({});

    expect(results).toHaveLength(1);
    const r = results[0];
    expect(r.ts).toBe(record.ts);
    expect(r.sessionKey).toBe("sk-abc");
    expect(r.provider).toBe("anthropic");
    expect(r.model).toBe("claude-3-5-sonnet");
    expect(r.inputTokens).toBe(100);
    expect(r.outputTokens).toBe(200);
    expect(r.totalTokens).toBe(300);
    expect(r.costUsd).toBe(0.005);
    expect(r.rawEvent).toBe(JSON.stringify({ type: "model_usage" }));
    expect(r.id).toBeTypeOf("number");
  });

  it("inserts a minimal record with only required ts field", () => {
    store.insertModelUsage({ ts: 1_000 });
    const results = store.queryModelUsage({});
    expect(results).toHaveLength(1);
    expect(results[0].ts).toBe(1_000);
    expect(results[0].provider).toBeUndefined();
  });

  it("filters by since timestamp", () => {
    store.insertModelUsage({ ts: 1_000, provider: "a" });
    store.insertModelUsage({ ts: 2_000, provider: "b" });
    store.insertModelUsage({ ts: 3_000, provider: "c" });

    const results = store.queryModelUsage({ since: 2_000 });
    expect(results).toHaveLength(2);
    expect(results.map((r) => r.provider).sort()).toEqual(["b", "c"]);
  });

  it("filters by sessionKey", () => {
    store.insertModelUsage({ ts: 1_000, sessionKey: "s1" });
    store.insertModelUsage({ ts: 2_000, sessionKey: "s2" });

    const results = store.queryModelUsage({ sessionKey: "s1" });
    expect(results).toHaveLength(1);
    expect(results[0].sessionKey).toBe("s1");
  });

  it("filters by provider", () => {
    store.insertModelUsage({ ts: 1_000, provider: "anthropic" });
    store.insertModelUsage({ ts: 2_000, provider: "openai" });

    const results = store.queryModelUsage({ provider: "openai" });
    expect(results).toHaveLength(1);
    expect(results[0].provider).toBe("openai");
  });

  it("applies limit", () => {
    for (let i = 0; i < 10; i++) {
      store.insertModelUsage({ ts: i * 1_000 });
    }
    const results = store.queryModelUsage({ limit: 3 });
    expect(results).toHaveLength(3);
  });

  it("returns results in descending ts order", () => {
    store.insertModelUsage({ ts: 1_000 });
    store.insertModelUsage({ ts: 3_000 });
    store.insertModelUsage({ ts: 2_000 });

    const results = store.queryModelUsage({});
    expect(results[0].ts).toBe(3_000);
    expect(results[1].ts).toBe(2_000);
    expect(results[2].ts).toBe(1_000);
  });

  it("returns empty array when no records match", () => {
    const results = store.queryModelUsage({ provider: "nobody" });
    expect(results).toEqual([]);
  });
});

// --- Usage summary ---

describe("model usage: getUsageSummary", () => {
  let store: HillclawStateStore;

  beforeEach(() => {
    store = new HillclawStateStore({ dbPath: makeTempDbPath() });
  });

  afterEach(() => {
    store.close();
  });

  it("returns zero summary when no records exist", () => {
    const summary = store.getUsageSummary({});
    expect(summary.totalInputTokens).toBe(0);
    expect(summary.totalOutputTokens).toBe(0);
    expect(summary.totalTokens).toBe(0);
    expect(summary.totalCostUsd).toBe(0);
    expect(summary.totalCalls).toBe(0);
    expect(summary.byProvider).toEqual({});
    expect(summary.byModel).toEqual({});
  });

  it("aggregates totals correctly", () => {
    store.insertModelUsage({
      ts: 1_000,
      provider: "anthropic",
      model: "claude-3-5-sonnet",
      inputTokens: 100,
      outputTokens: 200,
      totalTokens: 300,
      costUsd: 0.01,
    });
    store.insertModelUsage({
      ts: 2_000,
      provider: "openai",
      model: "gpt-4o",
      inputTokens: 50,
      outputTokens: 150,
      totalTokens: 200,
      costUsd: 0.005,
    });

    const summary = store.getUsageSummary({});
    expect(summary.totalInputTokens).toBe(150);
    expect(summary.totalOutputTokens).toBe(350);
    expect(summary.totalTokens).toBe(500);
    expect(summary.totalCostUsd).toBeCloseTo(0.015);
    expect(summary.totalCalls).toBe(2);
  });

  it("groups byProvider correctly", () => {
    store.insertModelUsage({
      ts: 1_000,
      provider: "anthropic",
      model: "claude-3-5-sonnet",
      totalTokens: 300,
      costUsd: 0.01,
    });
    store.insertModelUsage({
      ts: 2_000,
      provider: "anthropic",
      model: "claude-3-haiku",
      totalTokens: 100,
      costUsd: 0.001,
    });
    store.insertModelUsage({
      ts: 3_000,
      provider: "openai",
      model: "gpt-4o",
      totalTokens: 200,
      costUsd: 0.005,
    });

    const summary = store.getUsageSummary({});
    expect(summary.byProvider["anthropic"].tokens).toBe(400);
    expect(summary.byProvider["anthropic"].calls).toBe(2);
    expect(summary.byProvider["openai"].tokens).toBe(200);
    expect(summary.byProvider["openai"].calls).toBe(1);
  });

  it("groups byModel correctly", () => {
    store.insertModelUsage({
      ts: 1_000,
      provider: "anthropic",
      model: "claude-3-5-sonnet",
      totalTokens: 300,
      costUsd: 0.01,
    });
    store.insertModelUsage({
      ts: 2_000,
      provider: "anthropic",
      model: "claude-3-5-sonnet",
      totalTokens: 100,
      costUsd: 0.003,
    });

    const summary = store.getUsageSummary({});
    expect(summary.byModel["claude-3-5-sonnet"].tokens).toBe(400);
    expect(summary.byModel["claude-3-5-sonnet"].calls).toBe(2);
  });

  it("filters summary by since timestamp", () => {
    store.insertModelUsage({ ts: 500, totalTokens: 1000, costUsd: 1.0 });
    store.insertModelUsage({ ts: 2_000, totalTokens: 200, costUsd: 0.02 });

    const summary = store.getUsageSummary({ since: 1_000 });
    expect(summary.totalTokens).toBe(200);
    expect(summary.totalCalls).toBe(1);
  });
});

// --- Audit log ---

describe("audit log: appendAuditLog / queryAuditLog", () => {
  let store: HillclawStateStore;

  beforeEach(() => {
    store = new HillclawStateStore({ dbPath: makeTempDbPath() });
  });

  afterEach(() => {
    store.close();
  });

  it("appends and retrieves a full entry", () => {
    const entry: AuditLogEntry = {
      ts: 1_700_000_000_000,
      eventType: "session.start",
      subsystem: "gateway",
      severity: "info",
      sessionKey: "sk-abc",
      agentId: "agent-1",
      details: JSON.stringify({ foo: "bar" }),
    };

    store.appendAuditLog(entry);
    const results = store.queryAuditLog({});

    expect(results).toHaveLength(1);
    const r = results[0];
    expect(r.ts).toBe(entry.ts);
    expect(r.eventType).toBe("session.start");
    expect(r.subsystem).toBe("gateway");
    expect(r.severity).toBe("info");
    expect(r.sessionKey).toBe("sk-abc");
    expect(r.agentId).toBe("agent-1");
    expect(r.details).toBe(JSON.stringify({ foo: "bar" }));
    expect(r.id).toBeTypeOf("number");
  });

  it("appends a minimal entry with only required fields", () => {
    store.appendAuditLog({ ts: 1_000, eventType: "noop" });
    const results = store.queryAuditLog({});
    expect(results).toHaveLength(1);
    expect(results[0].eventType).toBe("noop");
    expect(results[0].subsystem).toBeUndefined();
  });

  it("filters by since timestamp", () => {
    store.appendAuditLog({ ts: 1_000, eventType: "a" });
    store.appendAuditLog({ ts: 2_000, eventType: "b" });
    store.appendAuditLog({ ts: 3_000, eventType: "c" });

    const results = store.queryAuditLog({ since: 2_000 });
    expect(results).toHaveLength(2);
    const types = results.map((r) => r.eventType).sort();
    expect(types).toEqual(["b", "c"]);
  });

  it("filters by eventType", () => {
    store.appendAuditLog({ ts: 1_000, eventType: "session.start" });
    store.appendAuditLog({ ts: 2_000, eventType: "session.end" });
    store.appendAuditLog({ ts: 3_000, eventType: "session.start" });

    const results = store.queryAuditLog({ eventType: "session.start" });
    expect(results).toHaveLength(2);
    expect(results.every((r) => r.eventType === "session.start")).toBe(true);
  });

  it("applies limit", () => {
    for (let i = 0; i < 10; i++) {
      store.appendAuditLog({ ts: i * 1_000, eventType: "tick" });
    }
    const results = store.queryAuditLog({ limit: 4 });
    expect(results).toHaveLength(4);
  });

  it("returns results in descending ts order", () => {
    store.appendAuditLog({ ts: 1_000, eventType: "a" });
    store.appendAuditLog({ ts: 3_000, eventType: "c" });
    store.appendAuditLog({ ts: 2_000, eventType: "b" });

    const results = store.queryAuditLog({});
    expect(results[0].ts).toBe(3_000);
    expect(results[2].ts).toBe(1_000);
  });

  it("returns empty array when no records match", () => {
    const results = store.queryAuditLog({ eventType: "ghost" });
    expect(results).toEqual([]);
  });
});

// --- Error log ---

describe("error log: logError / queryErrors", () => {
  let store: HillclawStateStore;

  beforeEach(() => {
    store = new HillclawStateStore({ dbPath: makeTempDbPath() });
  });

  afterEach(() => {
    store.close();
  });

  it("logs and retrieves a full error entry", () => {
    const entry: ErrorLogEntry = {
      ts: 1_700_000_000_000,
      code: "ERR_GATEWAY_TIMEOUT",
      subsystem: "gateway",
      severity: "error",
      message: "Request timed out",
      stack: "Error: ...\n  at foo (bar.ts:10)",
      cause: JSON.stringify({ upstream: "anthropic" }),
      sessionKey: "sk-abc",
      agentId: "agent-1",
    };

    store.logError(entry);
    const results = store.queryErrors({});

    expect(results).toHaveLength(1);
    const r = results[0];
    expect(r.ts).toBe(entry.ts);
    expect(r.code).toBe("ERR_GATEWAY_TIMEOUT");
    expect(r.subsystem).toBe("gateway");
    expect(r.severity).toBe("error");
    expect(r.message).toBe("Request timed out");
    expect(r.stack).toContain("Error:");
    expect(r.cause).toBe(JSON.stringify({ upstream: "anthropic" }));
    expect(r.sessionKey).toBe("sk-abc");
    expect(r.agentId).toBe("agent-1");
    expect(r.id).toBeTypeOf("number");
  });

  it("logs a minimal error entry with only required fields", () => {
    store.logError({
      ts: 1_000,
      code: "ERR_UNKNOWN",
      subsystem: "core",
      severity: "warning",
      message: "Something went wrong",
    });
    const results = store.queryErrors({});
    expect(results).toHaveLength(1);
    expect(results[0].code).toBe("ERR_UNKNOWN");
    expect(results[0].stack).toBeUndefined();
  });

  it("filters by since timestamp", () => {
    store.logError({ ts: 1_000, code: "A", subsystem: "s", severity: "info", message: "m" });
    store.logError({ ts: 2_000, code: "B", subsystem: "s", severity: "info", message: "m" });
    store.logError({ ts: 3_000, code: "C", subsystem: "s", severity: "info", message: "m" });

    const results = store.queryErrors({ since: 2_000 });
    expect(results).toHaveLength(2);
    const codes = results.map((r) => r.code).sort();
    expect(codes).toEqual(["B", "C"]);
  });

  it("filters by code", () => {
    store.logError({ ts: 1_000, code: "ERR_A", subsystem: "s", severity: "error", message: "m" });
    store.logError({ ts: 2_000, code: "ERR_B", subsystem: "s", severity: "error", message: "m" });

    const results = store.queryErrors({ code: "ERR_A" });
    expect(results).toHaveLength(1);
    expect(results[0].code).toBe("ERR_A");
  });

  it("filters by severity", () => {
    store.logError({ ts: 1_000, code: "X", subsystem: "s", severity: "warning", message: "m" });
    store.logError({ ts: 2_000, code: "Y", subsystem: "s", severity: "error", message: "m" });
    store.logError({ ts: 3_000, code: "Z", subsystem: "s", severity: "error", message: "m" });

    const results = store.queryErrors({ severity: "error" });
    expect(results).toHaveLength(2);
    expect(results.every((r) => r.severity === "error")).toBe(true);
  });

  it("applies limit", () => {
    for (let i = 0; i < 8; i++) {
      store.logError({ ts: i * 1_000, code: "E", subsystem: "s", severity: "info", message: "m" });
    }
    const results = store.queryErrors({ limit: 3 });
    expect(results).toHaveLength(3);
  });

  it("returns results in descending ts order", () => {
    store.logError({ ts: 1_000, code: "A", subsystem: "s", severity: "info", message: "m" });
    store.logError({ ts: 3_000, code: "C", subsystem: "s", severity: "info", message: "m" });
    store.logError({ ts: 2_000, code: "B", subsystem: "s", severity: "info", message: "m" });

    const results = store.queryErrors({});
    expect(results[0].ts).toBe(3_000);
    expect(results[1].ts).toBe(2_000);
    expect(results[2].ts).toBe(1_000);
  });

  it("returns empty array when no records match", () => {
    const results = store.queryErrors({ code: "ERR_NONEXISTENT" });
    expect(results).toEqual([]);
  });
});

// --- Schema version ---

describe("schema_version table", () => {
  it("tracks version 1 on init", () => {
    const store = new HillclawStateStore({ dbPath: makeTempDbPath() });
    const row = store.db
      .prepare("SELECT version, applied_at FROM schema_version")
      .get() as { version: number; applied_at: number };
    expect(row.version).toBe(1);
    expect(row.applied_at).toBeGreaterThan(0);
    store.close();
  });

  it("does not duplicate schema_version row on re-open", () => {
    const dbPath = makeTempDbPath();
    const s1 = new HillclawStateStore({ dbPath });
    s1.close();
    const s2 = new HillclawStateStore({ dbPath });
    const rows = s2.db.prepare("SELECT * FROM schema_version").all();
    expect(rows).toHaveLength(1);
    s2.close();
  });
});

// --- Concurrent read (WAL) ---

describe("WAL concurrent access", () => {
  it("allows two instances to open the same WAL database", () => {
    const dbPath = makeTempDbPath();
    const s1 = new HillclawStateStore({ dbPath });
    const s2 = new HillclawStateStore({ dbPath });

    s1.insertModelUsage({ ts: 1_000, provider: "a" });
    // s2 can read what s1 wrote (WAL checkpoint)
    const results = s2.queryModelUsage({});
    expect(results.length).toBeGreaterThanOrEqual(1);

    s1.close();
    s2.close();
  });
});

// --- Singleton ---

describe("singleton: getStateStore / closeStateStore / resetStateStoreForTest", () => {
  afterEach(() => {
    resetStateStoreForTest();
  });

  it("returns the same instance on repeated calls", () => {
    const dbPath = makeTempDbPath();
    const s1 = getStateStore({ dbPath });
    const s2 = getStateStore({ dbPath });
    expect(s1).toBe(s2);
  });

  it("closeStateStore closes the db and clears the singleton", () => {
    const dbPath = makeTempDbPath();
    const store = getStateStore({ dbPath });
    expect(store).toBeInstanceOf(HillclawStateStore);
    closeStateStore();
    // After closing, calling getStateStore with a fresh path creates a new instance
    const dbPath2 = makeTempDbPath();
    const store2 = getStateStore({ dbPath: dbPath2 });
    expect(store2).not.toBe(store);
    closeStateStore();
  });

  it("resetStateStoreForTest is safe to call when no store exists", () => {
    expect(() => resetStateStoreForTest()).not.toThrow();
  });

  it("getStateStore creates a new instance after reset", () => {
    const dbPath1 = makeTempDbPath();
    const s1 = getStateStore({ dbPath: dbPath1 });
    resetStateStoreForTest();
    const dbPath2 = makeTempDbPath();
    const s2 = getStateStore({ dbPath: dbPath2 });
    expect(s2).not.toBe(s1);
    resetStateStoreForTest();
  });
});
