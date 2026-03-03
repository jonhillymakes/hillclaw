import Database from "better-sqlite3";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

export interface StateStoreOptions {
  /** Path to the SQLite database file. Default: ~/.openclaw/hillclaw-state.db */
  dbPath?: string;
  /** Enable WAL mode. Default: true */
  walMode?: boolean;
}

export interface ModelUsageRecord {
  id?: number;
  ts: number;
  sessionKey?: string;
  sessionId?: string;
  channel?: string;
  provider?: string;
  model?: string;
  inputTokens?: number;
  outputTokens?: number;
  cacheReadTokens?: number;
  cacheWriteTokens?: number;
  totalTokens?: number;
  costUsd?: number;
  durationMs?: number;
  contextLimit?: number;
  contextUsed?: number;
  rawEvent?: string;
}

export interface UsageSummary {
  totalInputTokens: number;
  totalOutputTokens: number;
  totalTokens: number;
  totalCostUsd: number;
  totalCalls: number;
  byProvider: Record<string, { tokens: number; costUsd: number; calls: number }>;
  byModel: Record<string, { tokens: number; costUsd: number; calls: number }>;
}

export interface AuditLogEntry {
  id?: number;
  ts: number;
  eventType: string;
  subsystem?: string;
  severity?: string;
  sessionKey?: string;
  agentId?: string;
  details?: string;
}

export interface ErrorLogEntry {
  id?: number;
  ts: number;
  code: string;
  subsystem: string;
  severity: string;
  message: string;
  stack?: string;
  cause?: string;
  sessionKey?: string;
  agentId?: string;
}

// Row shapes returned from SQLite (snake_case column names)
interface ModelUsageRow {
  id: number;
  ts: number;
  session_key: string | null;
  session_id: string | null;
  channel: string | null;
  provider: string | null;
  model: string | null;
  input_tokens: number | null;
  output_tokens: number | null;
  cache_read_tokens: number | null;
  cache_write_tokens: number | null;
  total_tokens: number | null;
  cost_usd: number | null;
  duration_ms: number | null;
  context_limit: number | null;
  context_used: number | null;
  raw_event: string | null;
}

interface UsageSummaryRow {
  total_input_tokens: number;
  total_output_tokens: number;
  total_tokens: number;
  total_cost_usd: number;
  total_calls: number;
}

interface ProviderSummaryRow {
  provider: string | null;
  tokens: number;
  cost_usd: number;
  calls: number;
}

interface ModelSummaryRow {
  model: string | null;
  tokens: number;
  cost_usd: number;
  calls: number;
}

interface AuditLogRow {
  id: number;
  ts: number;
  event_type: string;
  subsystem: string | null;
  severity: string | null;
  session_key: string | null;
  agent_id: string | null;
  details: string | null;
}

interface ErrorLogRow {
  id: number;
  ts: number;
  code: string;
  subsystem: string;
  severity: string;
  message: string;
  stack: string | null;
  cause: string | null;
  session_key: string | null;
  agent_id: string | null;
}

export class HillclawStateStore {
  readonly db: Database.Database;
  readonly dbPath: string;

  // Prepared statements for performance-critical inserts
  private readonly stmtInsertModelUsage: Database.Statement;
  private readonly stmtInsertAuditLog: Database.Statement;
  private readonly stmtInsertErrorLog: Database.Statement;

  constructor(opts?: StateStoreOptions) {
    this.dbPath = opts?.dbPath ?? resolveDefaultDbPath();

    // Ensure directory exists
    fs.mkdirSync(path.dirname(this.dbPath), { recursive: true });

    this.db = new Database(this.dbPath);

    if (opts?.walMode !== false) {
      this.db.pragma("journal_mode = WAL");
    }
    this.db.pragma("busy_timeout = 5000");
    this.db.pragma("synchronous = NORMAL");
    this.db.pragma("foreign_keys = ON");

    this.initSchema();

    // Prepare statements after schema is initialized
    this.stmtInsertModelUsage = this.db.prepare(`
      INSERT INTO model_usage (
        ts, session_key, session_id, channel, provider, model,
        input_tokens, output_tokens, cache_read_tokens, cache_write_tokens,
        total_tokens, cost_usd, duration_ms, context_limit, context_used, raw_event
      ) VALUES (
        @ts, @sessionKey, @sessionId, @channel, @provider, @model,
        @inputTokens, @outputTokens, @cacheReadTokens, @cacheWriteTokens,
        @totalTokens, @costUsd, @durationMs, @contextLimit, @contextUsed, @rawEvent
      )
    `);

    this.stmtInsertAuditLog = this.db.prepare(`
      INSERT INTO audit_log (ts, event_type, subsystem, severity, session_key, agent_id, details)
      VALUES (@ts, @eventType, @subsystem, @severity, @sessionKey, @agentId, @details)
    `);

    this.stmtInsertErrorLog = this.db.prepare(`
      INSERT INTO error_log (ts, code, subsystem, severity, message, stack, cause, session_key, agent_id)
      VALUES (@ts, @code, @subsystem, @severity, @message, @stack, @cause, @sessionKey, @agentId)
    `);
  }

  private initSchema(): void {
    this.db.exec(`
      -- Model usage / instrumentation log (Step 0.7)
      CREATE TABLE IF NOT EXISTS model_usage (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        ts INTEGER NOT NULL,
        session_key TEXT,
        session_id TEXT,
        channel TEXT,
        provider TEXT,
        model TEXT,
        input_tokens INTEGER,
        output_tokens INTEGER,
        cache_read_tokens INTEGER,
        cache_write_tokens INTEGER,
        total_tokens INTEGER,
        cost_usd REAL,
        duration_ms INTEGER,
        context_limit INTEGER,
        context_used INTEGER,
        raw_event TEXT
      );

      CREATE INDEX IF NOT EXISTS idx_model_usage_ts ON model_usage(ts);
      CREATE INDEX IF NOT EXISTS idx_model_usage_session ON model_usage(session_key, ts);
      CREATE INDEX IF NOT EXISTS idx_model_usage_provider ON model_usage(provider, ts);

      -- Task ledger (Step 0.8)
      CREATE TABLE IF NOT EXISTS tasks (
        id TEXT PRIMARY KEY,
        parent_id TEXT REFERENCES tasks(id),
        status TEXT NOT NULL DEFAULT 'pending'
          CHECK(status IN ('pending', 'assigned', 'running', 'validating', 'completed', 'failed', 'timed_out')),
        title TEXT NOT NULL,
        description TEXT,
        assigned_to TEXT,
        priority INTEGER DEFAULT 0,

        created_at INTEGER NOT NULL,
        created_by TEXT,

        updated_at INTEGER NOT NULL,
        started_at INTEGER,
        completed_at INTEGER,
        timeout_ms INTEGER,

        receipt_input_tokens INTEGER DEFAULT 0,
        receipt_output_tokens INTEGER DEFAULT 0,
        receipt_total_tokens INTEGER DEFAULT 0,
        receipt_cost_usd REAL DEFAULT 0,
        receipt_duration_ms INTEGER DEFAULT 0,
        receipt_model_calls INTEGER DEFAULT 0,

        metadata TEXT,
        result TEXT,
        error TEXT
      );

      CREATE INDEX IF NOT EXISTS idx_tasks_parent ON tasks(parent_id);
      CREATE INDEX IF NOT EXISTS idx_tasks_status ON tasks(status);
      CREATE INDEX IF NOT EXISTS idx_tasks_created ON tasks(created_at);

      -- Audit log (append-only)
      CREATE TABLE IF NOT EXISTS audit_log (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        ts INTEGER NOT NULL,
        event_type TEXT NOT NULL,
        subsystem TEXT,
        severity TEXT,
        session_key TEXT,
        agent_id TEXT,
        details TEXT
      );

      CREATE INDEX IF NOT EXISTS idx_audit_ts ON audit_log(ts);
      CREATE INDEX IF NOT EXISTS idx_audit_type ON audit_log(event_type, ts);

      -- Error log (for HillclawError events)
      CREATE TABLE IF NOT EXISTS error_log (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        ts INTEGER NOT NULL,
        code TEXT NOT NULL,
        subsystem TEXT NOT NULL,
        severity TEXT NOT NULL,
        message TEXT NOT NULL,
        stack TEXT,
        cause TEXT,
        session_key TEXT,
        agent_id TEXT
      );

      CREATE INDEX IF NOT EXISTS idx_error_code ON error_log(code, ts);
      CREATE INDEX IF NOT EXISTS idx_error_severity ON error_log(severity, ts);

      -- Schema version tracking
      CREATE TABLE IF NOT EXISTS schema_version (
        version INTEGER PRIMARY KEY,
        applied_at INTEGER NOT NULL
      );

      INSERT OR IGNORE INTO schema_version (version, applied_at) VALUES (1, ${Date.now()});
    `);
  }

  // --- Model Usage methods ---

  insertModelUsage(event: ModelUsageRecord): void {
    this.stmtInsertModelUsage.run({
      ts: event.ts,
      sessionKey: event.sessionKey ?? null,
      sessionId: event.sessionId ?? null,
      channel: event.channel ?? null,
      provider: event.provider ?? null,
      model: event.model ?? null,
      inputTokens: event.inputTokens ?? null,
      outputTokens: event.outputTokens ?? null,
      cacheReadTokens: event.cacheReadTokens ?? null,
      cacheWriteTokens: event.cacheWriteTokens ?? null,
      totalTokens: event.totalTokens ?? null,
      costUsd: event.costUsd ?? null,
      durationMs: event.durationMs ?? null,
      contextLimit: event.contextLimit ?? null,
      contextUsed: event.contextUsed ?? null,
      rawEvent: event.rawEvent ?? null,
    });
  }

  queryModelUsage(opts: {
    since?: number;
    sessionKey?: string;
    provider?: string;
    limit?: number;
  }): ModelUsageRecord[] {
    const conditions: string[] = [];
    const params: Record<string, unknown> = {};

    if (opts.since !== undefined) {
      conditions.push("ts >= @since");
      params.since = opts.since;
    }
    if (opts.sessionKey !== undefined) {
      conditions.push("session_key = @sessionKey");
      params.sessionKey = opts.sessionKey;
    }
    if (opts.provider !== undefined) {
      conditions.push("provider = @provider");
      params.provider = opts.provider;
    }

    const where = conditions.length > 0 ? `WHERE ${conditions.join(" AND ")}` : "";
    const limitClause = opts.limit !== undefined ? `LIMIT ${opts.limit}` : "";
    const sql = `SELECT * FROM model_usage ${where} ORDER BY ts DESC ${limitClause}`;

    const rows = this.db.prepare(sql).all(params) as ModelUsageRow[];
    return rows.map(rowToModelUsageRecord);
  }

  getUsageSummary(opts: { since?: number }): UsageSummary {
    const whereClause = opts.since !== undefined ? "WHERE ts >= @since" : "";
    const params: Record<string, unknown> = opts.since !== undefined ? { since: opts.since } : {};

    const summary = this.db
      .prepare(
        `SELECT
          COALESCE(SUM(input_tokens), 0) AS total_input_tokens,
          COALESCE(SUM(output_tokens), 0) AS total_output_tokens,
          COALESCE(SUM(total_tokens), 0) AS total_tokens,
          COALESCE(SUM(cost_usd), 0) AS total_cost_usd,
          COUNT(*) AS total_calls
        FROM model_usage ${whereClause}`,
      )
      .get(params) as UsageSummaryRow;

    const providerRows = this.db
      .prepare(
        `SELECT
          provider,
          COALESCE(SUM(total_tokens), 0) AS tokens,
          COALESCE(SUM(cost_usd), 0) AS cost_usd,
          COUNT(*) AS calls
        FROM model_usage ${whereClause}
        GROUP BY provider`,
      )
      .all(params) as ProviderSummaryRow[];

    const modelRows = this.db
      .prepare(
        `SELECT
          model,
          COALESCE(SUM(total_tokens), 0) AS tokens,
          COALESCE(SUM(cost_usd), 0) AS cost_usd,
          COUNT(*) AS calls
        FROM model_usage ${whereClause}
        GROUP BY model`,
      )
      .all(params) as ModelSummaryRow[];

    const byProvider: UsageSummary["byProvider"] = {};
    for (const row of providerRows) {
      const key = row.provider ?? "(unknown)";
      byProvider[key] = { tokens: row.tokens, costUsd: row.cost_usd, calls: row.calls };
    }

    const byModel: UsageSummary["byModel"] = {};
    for (const row of modelRows) {
      const key = row.model ?? "(unknown)";
      byModel[key] = { tokens: row.tokens, costUsd: row.cost_usd, calls: row.calls };
    }

    return {
      totalInputTokens: summary.total_input_tokens,
      totalOutputTokens: summary.total_output_tokens,
      totalTokens: summary.total_tokens,
      totalCostUsd: summary.total_cost_usd,
      totalCalls: summary.total_calls,
      byProvider,
      byModel,
    };
  }

  // --- Audit Log methods ---

  appendAuditLog(entry: AuditLogEntry): void {
    this.stmtInsertAuditLog.run({
      ts: entry.ts,
      eventType: entry.eventType,
      subsystem: entry.subsystem ?? null,
      severity: entry.severity ?? null,
      sessionKey: entry.sessionKey ?? null,
      agentId: entry.agentId ?? null,
      details: entry.details ?? null,
    });
  }

  queryAuditLog(opts: {
    since?: number;
    eventType?: string;
    limit?: number;
  }): AuditLogEntry[] {
    const conditions: string[] = [];
    const params: Record<string, unknown> = {};

    if (opts.since !== undefined) {
      conditions.push("ts >= @since");
      params.since = opts.since;
    }
    if (opts.eventType !== undefined) {
      conditions.push("event_type = @eventType");
      params.eventType = opts.eventType;
    }

    const where = conditions.length > 0 ? `WHERE ${conditions.join(" AND ")}` : "";
    const limitClause = opts.limit !== undefined ? `LIMIT ${opts.limit}` : "";
    const sql = `SELECT * FROM audit_log ${where} ORDER BY ts DESC ${limitClause}`;

    const rows = this.db.prepare(sql).all(params) as AuditLogRow[];
    return rows.map(rowToAuditLogEntry);
  }

  // --- Error Log methods ---

  logError(error: ErrorLogEntry): void {
    this.stmtInsertErrorLog.run({
      ts: error.ts,
      code: error.code,
      subsystem: error.subsystem,
      severity: error.severity,
      message: error.message,
      stack: error.stack ?? null,
      cause: error.cause ?? null,
      sessionKey: error.sessionKey ?? null,
      agentId: error.agentId ?? null,
    });
  }

  queryErrors(opts: {
    since?: number;
    code?: string;
    severity?: string;
    limit?: number;
  }): ErrorLogEntry[] {
    const conditions: string[] = [];
    const params: Record<string, unknown> = {};

    if (opts.since !== undefined) {
      conditions.push("ts >= @since");
      params.since = opts.since;
    }
    if (opts.code !== undefined) {
      conditions.push("code = @code");
      params.code = opts.code;
    }
    if (opts.severity !== undefined) {
      conditions.push("severity = @severity");
      params.severity = opts.severity;
    }

    const where = conditions.length > 0 ? `WHERE ${conditions.join(" AND ")}` : "";
    const limitClause = opts.limit !== undefined ? `LIMIT ${opts.limit}` : "";
    const sql = `SELECT * FROM error_log ${where} ORDER BY ts DESC ${limitClause}`;

    const rows = this.db.prepare(sql).all(params) as ErrorLogRow[];
    return rows.map(rowToErrorLogEntry);
  }

  // --- Lifecycle ---

  close(): void {
    this.db.close();
  }
}

// --- Row mapping helpers ---

function rowToModelUsageRecord(row: ModelUsageRow): ModelUsageRecord {
  return {
    id: row.id,
    ts: row.ts,
    sessionKey: row.session_key ?? undefined,
    sessionId: row.session_id ?? undefined,
    channel: row.channel ?? undefined,
    provider: row.provider ?? undefined,
    model: row.model ?? undefined,
    inputTokens: row.input_tokens ?? undefined,
    outputTokens: row.output_tokens ?? undefined,
    cacheReadTokens: row.cache_read_tokens ?? undefined,
    cacheWriteTokens: row.cache_write_tokens ?? undefined,
    totalTokens: row.total_tokens ?? undefined,
    costUsd: row.cost_usd ?? undefined,
    durationMs: row.duration_ms ?? undefined,
    contextLimit: row.context_limit ?? undefined,
    contextUsed: row.context_used ?? undefined,
    rawEvent: row.raw_event ?? undefined,
  };
}

function rowToAuditLogEntry(row: AuditLogRow): AuditLogEntry {
  return {
    id: row.id,
    ts: row.ts,
    eventType: row.event_type,
    subsystem: row.subsystem ?? undefined,
    severity: row.severity ?? undefined,
    sessionKey: row.session_key ?? undefined,
    agentId: row.agent_id ?? undefined,
    details: row.details ?? undefined,
  };
}

function rowToErrorLogEntry(row: ErrorLogRow): ErrorLogEntry {
  return {
    id: row.id,
    ts: row.ts,
    code: row.code,
    subsystem: row.subsystem,
    severity: row.severity,
    message: row.message,
    stack: row.stack ?? undefined,
    cause: row.cause ?? undefined,
    sessionKey: row.session_key ?? undefined,
    agentId: row.agent_id ?? undefined,
  };
}

function resolveDefaultDbPath(): string {
  const stateDir = process.env.OPENCLAW_STATE_DIR ?? path.join(os.homedir(), ".openclaw");
  return path.join(stateDir, "hillclaw-state.db");
}
