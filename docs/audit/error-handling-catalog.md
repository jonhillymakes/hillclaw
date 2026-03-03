# Hillclaw Error Handling Audit — Phase 0

**Date:** 2026-03-02
**Scope:** Full codebase silent-failure audit (`.catch(() => {})`, swallowed errors, wrong log levels)
**Total findings:** 24 — 5 HIGH, 10 MEDIUM, 9 LOW

---

## Summary

| Severity | Count | Primary Area |
|----------|-------|--------------|
| HIGH     | 5     | Config write path, credential ops, session management |
| MEDIUM   | 10    | Message dispatch, agent spawning, health checks |
| LOW      | 9     | Optional features, cleanup ops, cosmetic logging |

**Notable:** No completely empty catch blocks (`catch (_) {}` with zero body) were found. The codebase avoids the worst anti-pattern — all swallowed errors have at least a no-op closure. This audit targets cases where silent failure causes data loss, security gaps, or unobservable behavioral changes.

---

## HIGH — Config Writes, Credential Ops, Session Management

These must be fixed before any production deployment. Silent failures in this tier can expose secrets, lose configuration, or silently drop sessions.

| # | File | Lines | Pattern | Description | Fix Priority |
|---|------|-------|---------|-------------|--------------|
| 1 | `src/config/io.ts` | 1064–1066 | `.catch(() => {})` | Env-ref map parse failure silently nullifies `${VAR}` restoration on config write. Raw secrets may be written to disk instead of env-var references. | P0 |
| 2 | `src/config/io.ts` | 1109–1111 | `.catch(() => {})` | Current config read failure silently bypasses env-ref restoration. Same secret exposure risk as #1, different code path. | P0 |
| 3 | `src/config/io.ts` | 533–535 | `.catch(() => {})` | Config write audit log silently fails. Write operations have audit gaps with no indication to the caller. | P1 |
| 4 | `src/config/backup-rotation.ts` | 15–25 | Three `.catch(() => {})` | All three backup rotation operations (move, rename, cleanup) swallow errors. A rename failure leaves no safety backup before the next write. | P0 |
| 5 | `src/config/sessions/delivery-info.ts` | 53–55 | `.catch(() => {})` | Session store read failure silently returns no delivery context, causing silent no-op message routing with no diagnostic. | P1 |

---

## MEDIUM — Message Dispatch, Agent Spawning, Health Checks

Fix after HIGH items. These cause observable behavioral failures (missing replies, wrong policies, hanging RPCs) but do not directly expose secrets.

| # | File | Lines | Pattern | Description | Fix Priority |
|---|------|-------|---------|-------------|--------------|
| 6  | `src/config/io.ts` | 1245–1247 | `.catch(() => {})` | Backup copy before atomic write swallowed. No safety copy is made, no diagnostic emitted on failure. | P1 |
| 7  | `src/config/sessions/store.ts` | 434–436 | `.catch(() => {})` | `loadConfig()` failure silently applies default maintenance policy instead of the operator-configured policy. | P1 |
| 8  | `src/config/sessions/store.ts` | 599–601, 622–624 | `.catch(() => {})` | Session file rotation and backup cleanup failures silently skipped. Rotation state becomes inconsistent. | P2 |
| 9  | `src/gateway/client.ts` | 404–406 | Debug-level log | Gateway WebSocket parse error logged only at debug level. Pending RPC hangs with no causal trace visible in normal log levels. | P1 |
| 10 | `src/auto-reply/reply/agent-runner-execution.ts` | 417–420 | Verbose-level log | Tool result delivery failure logged only at verbose level. User sees no reply; failure is unobservable in default logging. | P1 |
| 11 | `src/auto-reply/reply/agent-runner-memory.ts` | 387–389, 531–536 | `.catch(() => {})` | Token accounting and memory flush failures silently lost. Memory usage reporting becomes inaccurate. | P2 |
| 12 | `src/gateway/config-reload.ts` | 300–304 | Error logged, no throw | Config restart failure logged at error level but caller receives no signal. Reload appears to succeed when it did not. | P2 |
| 13 | `src/infra/bonjour.ts` | 268–276 | `.catch(() => {})` | mDNS shutdown errors swallowed. Stale service records persist on the local network. | P2 |
| 14 | `src/config/sessions/disk-budget.ts` | 161 | `.catch(() => {})` | Eviction delete swallowed. Freed size is counted in the budget even if the file still exists on disk. | P2 |

---

## LOW — Optional Features, Cleanup Ops, Cosmetic Logging

Address in a follow-up pass or opportunistically. These do not cause data loss or security issues but reduce debuggability.

| # | File | Lines | Pattern | Description | Fix Priority |
|---|------|-------|---------|-------------|--------------|
| 15 | `src/auto-reply/reply/agent-runner.ts` | 344–347 | `.catch(() => {})` | Transcript cleanup swallowed. Stale history may persist on disk. | P3 |
| 16 | `src/auto-reply/reply/agent-runner-execution.ts` | 527–529 | Overly broad catch | Corrupted transcript delete catches ALL errors, not just ENOENT. Unexpected errors masked. | P3 |
| 17 | `src/infra/agent-events.ts` | 74–76 | `.catch(() => {})` | Listener exceptions silently swallowed. Event handler bugs are completely unobservable. | P3 |
| 18 | `src/auto-reply/reply/agent-runner.ts` | 695–698 | `.catch(() => {})` | Post-compaction context read silently fails. Intentionally best-effort but worth a debug log. | P4 |
| 19 | `src/gateway/config-reload.ts` | 418, 429 | `.catch(() => {})` | File watcher close errors swallowed. Harmless on shutdown but hides fd leaks during tests. | P4 |
| 20 | `src/config/sessions/store.ts` | 618 | `.catch(() => {})` | Old backup deletion swallowed. Disk accumulates stale backup files silently. | P3 |
| 21 | `src/config/sessions/paths.ts` | 272–274 | Silent fallthrough | Session path resolution from stale metadata silently falls through to default path. | P3 |
| 22 | `src/auto-reply/reply/agent-runner-helpers.ts` | 28–30 | `.catch(() => {})` | Verbose-level read failure ignored. Logging level is misconfigured for the run with no indication. | P4 |
| 23 | `src/infra/bonjour-discovery.ts` | 308–310, 356–358 | `.catch(() => {})` | Discovery errors swallowed. Returns an empty result set with no degradation indication. | P3 |
| 24 | `src/infra/archive.ts` | 97–99 | Overly broad catch | Stat check catches all errors, not just ENOENT. Permissions errors masked as "file not found." | P3 |

---

## Recommended Fix Order for Step 0.3

### Phase A — Config Write Path (HIGH #1–4)

Fix all four `src/config/io.ts` and `src/config/backup-rotation.ts` items together. They share a common theme: writes to disk that must be safe, auditable, and recoverable.

- `backup-rotation.ts`: propagate rename errors; do not proceed with write if backup failed.
- `io.ts:1064` and `io.ts:1109`: log + rethrow on parse failure; do not silently drop env-ref map.
- `io.ts:533`: demote to warn and continue (audit log failure is not fatal) but do not swallow.
- `io.ts:1245`: log + rethrow if backup copy fails; the atomic write is unsafe without it.

### Phase B — Session Management (HIGH #5, MEDIUM #7–8, #20–21)

Group all session-related fixes. They share the `sessions/` package.

- `delivery-info.ts:53`: log + rethrow; callers must handle no-delivery-context explicitly.
- `store.ts:434`: log + rethrow from `loadConfig()`; apply default only as an explicit fallback with a warn.
- `store.ts:599, 622`, `store.ts:618`, `paths.ts:272`: add warn logs; rotation/cleanup failures are non-fatal but must be visible.

### Phase C — Message Dispatch Log Levels (MEDIUM #9–10)

Raise `src/gateway/client.ts:404` WebSocket parse error from debug to warn.
Raise `src/auto-reply/reply/agent-runner-execution.ts:417` tool delivery failure from verbose to error.

### Phase D — Remaining MEDIUM (#11–14)

Address memory accounting, config-reload signaling, mDNS shutdown, and disk-budget eviction as a batch.

### Phase E — LOW Items

Address in a cleanup pass or alongside related feature work. Items #16 and #24 (overly broad catches) are the highest value because they mask unexpected error classes.

---

## Fix Patterns Reference

| Pattern | Recommended replacement |
|---------|------------------------|
| `.catch(() => {})` on a critical path | `catch (err) { logger.error(..., err); throw err; }` |
| `.catch(() => {})` on a non-fatal path | `catch (err) { logger.warn(..., err); }` |
| `.catch(() => {})` on a genuinely best-effort path | `catch (err) { logger.debug(..., err); }` |
| Wrong log level (debug/verbose for user-visible failure) | Raise to `warn` or `error` |
| Overly broad catch masking ENOENT | `if (err.code !== 'ENOENT') throw err;` |
| Caller has no signal despite error log | Return error or throw; let caller decide |
