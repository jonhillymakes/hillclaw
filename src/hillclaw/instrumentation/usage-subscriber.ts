import {
  onDiagnosticEvent,
  type DiagnosticUsageEvent,
} from "../../infra/diagnostic-events.js";
import { getStateStore } from "../state-store/singleton.js";
import type { ModelUsageRecord } from "../state-store/store.js";

export interface UsageSubscriberOptions {
  /** Enable batching for high-throughput scenarios. Default: false */
  batchMode?: boolean;
  /** Batch flush interval in ms. Default: 5000 */
  batchFlushMs?: number;
  /** Max batch size before forced flush. Default: 100 */
  maxBatchSize?: number;
}

function eventToRecord(event: DiagnosticUsageEvent): ModelUsageRecord {
  return {
    ts: event.ts,
    sessionKey: event.sessionKey,
    sessionId: event.sessionId,
    channel: event.channel,
    provider: event.provider,
    model: event.model,
    inputTokens: event.usage?.input,
    outputTokens: event.usage?.output,
    cacheReadTokens: event.usage?.cacheRead,
    cacheWriteTokens: event.usage?.cacheWrite,
    totalTokens: event.usage?.total ?? event.usage?.promptTokens,
    costUsd: event.costUsd,
    durationMs: event.durationMs,
    contextLimit: event.context?.limit,
    contextUsed: event.context?.used,
    rawEvent: JSON.stringify(event),
  };
}

/**
 * Subscribes to model.usage diagnostic events and persists them to the
 * canonical SQLite state store.
 *
 * The upstream platform already emits model.usage events with all the fields
 * we need — this subscriber just catches them and writes to SQLite.
 *
 * @returns An unsubscribe function to stop listening
 */
export function startUsageSubscriber(opts?: UsageSubscriberOptions): () => void {
  const batchMode = opts?.batchMode ?? false;
  const batchFlushMs = opts?.batchFlushMs ?? 5000;
  const maxBatchSize = opts?.maxBatchSize ?? 100;

  let batch: ModelUsageRecord[] = [];
  let flushTimer: ReturnType<typeof setInterval> | null = null;

  const flush = (): void => {
    if (batch.length === 0) return;
    const store = getStateStore();
    const toFlush = batch;
    batch = [];
    for (const record of toFlush) {
      try {
        store.insertModelUsage(record);
      } catch (err) {
        // Log but don't crash — instrumentation should never break the app
        console.error("[hillclaw:usage-subscriber] Failed to persist usage record:", err);
      }
    }
  };

  if (batchMode) {
    flushTimer = setInterval(flush, batchFlushMs);
    // Don't keep the process alive just for flushing
    if (flushTimer.unref) flushTimer.unref();
  }

  const unsubscribe = onDiagnosticEvent((event) => {
    if (event.type !== "model.usage") return;

    const record = eventToRecord(event);

    if (batchMode) {
      batch.push(record);
      if (batch.length >= maxBatchSize) flush();
    } else {
      const store = getStateStore();
      try {
        store.insertModelUsage(record);
      } catch (err) {
        console.error("[hillclaw:usage-subscriber] Failed to persist usage record:", err);
      }
    }
  });

  return (): void => {
    unsubscribe();
    if (flushTimer) {
      clearInterval(flushTimer);
      flushTimer = null;
    }
    // Final flush for batch mode
    if (batchMode) flush();
  };
}
