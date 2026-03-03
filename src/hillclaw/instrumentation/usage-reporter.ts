import { getStateStore } from "../state-store/singleton.js";
import type { UsageSummary } from "../state-store/store.js";

export interface UsageReport {
  summary: UsageSummary;
  recordCount: number;
  timeRange: { from: number; to: number };
  formatted: string;
}

/**
 * Get a human-readable usage report for a time period.
 */
export function getUsageReport(opts?: {
  since?: number;
  sessionKey?: string;
}): UsageReport {
  const store = getStateStore();
  const summary = store.getUsageSummary({ since: opts?.since });
  const records = store.queryModelUsage({
    since: opts?.since,
    sessionKey: opts?.sessionKey,
    limit: 1000,
  });

  return {
    summary,
    recordCount: records.length,
    timeRange: {
      from: opts?.since ?? (records.length > 0 ? records[records.length - 1]!.ts : Date.now()),
      to: Date.now(),
    },
    formatted: formatUsageReport(summary),
  };
}

export function formatUsageReport(summary: UsageSummary): string {
  const lines: string[] = [];
  lines.push(`--- Usage Report ---`);
  lines.push(`Total calls: ${summary.totalCalls}`);
  lines.push(
    `Total tokens: ${summary.totalTokens.toLocaleString()} (in: ${summary.totalInputTokens.toLocaleString()}, out: ${summary.totalOutputTokens.toLocaleString()})`,
  );
  lines.push(`Total cost: $${summary.totalCostUsd.toFixed(4)}`);

  if (Object.keys(summary.byProvider).length > 0) {
    lines.push(`\nBy provider:`);
    for (const [provider, stats] of Object.entries(summary.byProvider)) {
      lines.push(
        `  ${provider}: ${stats.calls} calls, ${stats.tokens.toLocaleString()} tokens, $${stats.costUsd.toFixed(4)}`,
      );
    }
  }

  if (Object.keys(summary.byModel).length > 0) {
    lines.push(`\nBy model:`);
    for (const [model, stats] of Object.entries(summary.byModel)) {
      lines.push(
        `  ${model}: ${stats.calls} calls, ${stats.tokens.toLocaleString()} tokens, $${stats.costUsd.toFixed(4)}`,
      );
    }
  }

  return lines.join("\n");
}
