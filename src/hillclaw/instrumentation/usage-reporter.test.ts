import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { resetDiagnosticEventsForTest } from "../../infra/diagnostic-events.js";
import { getStateStore, resetStateStoreForTest } from "../state-store/singleton.js";
import { formatUsageReport, getUsageReport } from "./usage-reporter.js";

// --- Temp DB helpers ---

let tempDirs: string[] = [];

function makeTempDbPath(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "hillclaw-reporter-test-"));
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

beforeEach(() => {
  resetDiagnosticEventsForTest();
  resetStateStoreForTest();
  getStateStore({ dbPath: makeTempDbPath() });
});

afterEach(() => {
  resetDiagnosticEventsForTest();
  resetStateStoreForTest();
});

// --- getUsageReport ---

describe("getUsageReport", () => {
  it("returns zero totals for an empty store", () => {
    const report = getUsageReport();
    expect(report.summary.totalCalls).toBe(0);
    expect(report.summary.totalTokens).toBe(0);
    expect(report.summary.totalInputTokens).toBe(0);
    expect(report.summary.totalOutputTokens).toBe(0);
    expect(report.summary.totalCostUsd).toBe(0);
    expect(report.recordCount).toBe(0);
    expect(report.summary.byProvider).toEqual({});
    expect(report.summary.byModel).toEqual({});
  });

  it("returns correct totals when records exist", () => {
    const store = getStateStore();
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

    const report = getUsageReport();
    expect(report.summary.totalCalls).toBe(2);
    expect(report.summary.totalTokens).toBe(500);
    expect(report.summary.totalInputTokens).toBe(150);
    expect(report.summary.totalOutputTokens).toBe(350);
    expect(report.summary.totalCostUsd).toBeCloseTo(0.015);
    expect(report.recordCount).toBe(2);
  });

  it("filters records by since timestamp", () => {
    const store = getStateStore();
    store.insertModelUsage({ ts: 500, totalTokens: 1000, costUsd: 1.0 });
    store.insertModelUsage({ ts: 2_000, totalTokens: 200, costUsd: 0.02 });

    const report = getUsageReport({ since: 1_000 });
    expect(report.summary.totalCalls).toBe(1);
    expect(report.summary.totalTokens).toBe(200);
    expect(report.recordCount).toBe(1);
  });

  it("filters records by sessionKey", () => {
    const store = getStateStore();
    store.insertModelUsage({ ts: 1_000, sessionKey: "s1", totalTokens: 100 });
    store.insertModelUsage({ ts: 2_000, sessionKey: "s2", totalTokens: 200 });
    store.insertModelUsage({ ts: 3_000, sessionKey: "s1", totalTokens: 300 });

    const report = getUsageReport({ sessionKey: "s1" });
    // recordCount filtered by sessionKey, summary covers all (no sessionKey filter on summary)
    expect(report.recordCount).toBe(2);
  });

  it("includes timeRange.to close to now", () => {
    const before = Date.now();
    const report = getUsageReport();
    const after = Date.now();
    expect(report.timeRange.to).toBeGreaterThanOrEqual(before);
    expect(report.timeRange.to).toBeLessThanOrEqual(after);
  });

  it("timeRange.from uses since when provided", () => {
    const since = 1_700_000_000_000;
    const report = getUsageReport({ since });
    expect(report.timeRange.from).toBe(since);
  });

  it("timeRange.from uses oldest record ts when since not provided and records exist", () => {
    const store = getStateStore();
    store.insertModelUsage({ ts: 1_000 });
    store.insertModelUsage({ ts: 5_000 });

    const report = getUsageReport();
    // queryModelUsage returns desc order, so last element is oldest
    expect(report.timeRange.from).toBe(1_000);
  });

  it("includes formatted string in output", () => {
    const report = getUsageReport();
    expect(report.formatted).toContain("--- Usage Report ---");
    expect(report.formatted).toContain("Total calls:");
    expect(report.formatted).toContain("Total tokens:");
    expect(report.formatted).toContain("Total cost:");
  });

  it("byProvider and byModel are populated correctly", () => {
    const store = getStateStore();
    store.insertModelUsage({
      ts: 1_000,
      provider: "anthropic",
      model: "claude-3-5-sonnet",
      totalTokens: 300,
      costUsd: 0.01,
    });

    const report = getUsageReport();
    expect(report.summary.byProvider["anthropic"]).toBeDefined();
    expect(report.summary.byProvider["anthropic"].calls).toBe(1);
    expect(report.summary.byModel["claude-3-5-sonnet"]).toBeDefined();
    expect(report.summary.byModel["claude-3-5-sonnet"].tokens).toBe(300);
  });
});

// --- formatUsageReport ---

describe("formatUsageReport", () => {
  it("produces readable output with all sections", () => {
    const formatted = formatUsageReport({
      totalCalls: 5,
      totalInputTokens: 1000,
      totalOutputTokens: 2000,
      totalTokens: 3000,
      totalCostUsd: 0.1234,
      byProvider: {
        anthropic: { calls: 3, tokens: 2000, costUsd: 0.08 },
        openai: { calls: 2, tokens: 1000, costUsd: 0.0434 },
      },
      byModel: {
        "claude-3-5-sonnet": { calls: 3, tokens: 2000, costUsd: 0.08 },
        "gpt-4o": { calls: 2, tokens: 1000, costUsd: 0.0434 },
      },
    });

    expect(formatted).toContain("--- Usage Report ---");
    expect(formatted).toContain("Total calls: 5");
    expect(formatted).toContain("Total tokens: 3,000");
    expect(formatted).toContain("in: 1,000");
    expect(formatted).toContain("out: 2,000");
    expect(formatted).toContain("$0.1234");
    expect(formatted).toContain("By provider:");
    expect(formatted).toContain("anthropic:");
    expect(formatted).toContain("openai:");
    expect(formatted).toContain("By model:");
    expect(formatted).toContain("claude-3-5-sonnet:");
    expect(formatted).toContain("gpt-4o:");
  });

  it("omits By provider section when byProvider is empty", () => {
    const formatted = formatUsageReport({
      totalCalls: 0,
      totalInputTokens: 0,
      totalOutputTokens: 0,
      totalTokens: 0,
      totalCostUsd: 0,
      byProvider: {},
      byModel: {},
    });

    expect(formatted).not.toContain("By provider:");
    expect(formatted).not.toContain("By model:");
  });

  it("formats cost to 4 decimal places", () => {
    const formatted = formatUsageReport({
      totalCalls: 1,
      totalInputTokens: 0,
      totalOutputTokens: 0,
      totalTokens: 0,
      totalCostUsd: 0.0001,
      byProvider: {},
      byModel: {},
    });

    expect(formatted).toContain("$0.0001");
  });

  it("formats large token counts with locale separators", () => {
    const formatted = formatUsageReport({
      totalCalls: 10,
      totalInputTokens: 1_000_000,
      totalOutputTokens: 500_000,
      totalTokens: 1_500_000,
      totalCostUsd: 15.0,
      byProvider: {},
      byModel: {},
    });

    // toLocaleString in Node produces commas for en locale
    expect(formatted).toMatch(/1[,.]?500[,.]?000|1500000/);
  });

  it("each line in provider section includes calls, tokens, and cost", () => {
    const formatted = formatUsageReport({
      totalCalls: 2,
      totalInputTokens: 0,
      totalOutputTokens: 0,
      totalTokens: 500,
      totalCostUsd: 0.05,
      byProvider: {
        anthropic: { calls: 2, tokens: 500, costUsd: 0.05 },
      },
      byModel: {},
    });

    expect(formatted).toContain("anthropic: 2 calls");
    expect(formatted).toContain("tokens");
    expect(formatted).toContain("$0.0500");
  });
});
