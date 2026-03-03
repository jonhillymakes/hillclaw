# Hillclaw — Build Plan

> This document breaks the GROUNDING.md vision into individually reviewable build steps.
> Each step is designed to be reviewed by a three-agent panel (Claude/GPT/Gemini) before
> implementation begins. Steps are sequential unless noted otherwise.
>
> **How to use this document:**
> 1. Read a step
> 2. Run it through your three-model review
> 3. Incorporate corrections
> 4. Mark it approved
> 5. Move to the next step
>
> Reference: [GROUNDING.md](GROUNDING.md)

---

## Phase 0: Foundation Hardening + Instrumentation

**Goal:** Stop the platform from breaking, and make failures visible from day one.

**Phase 0 exits when:**
- Gateway runs for 7 days without crashing or corrupting state
- Config file survives 100 write cycles without corruption
- All errors surface to Discord (no silent failures in logs only)
- Every model call logs: tokens, cost, latency, outcome

---

### Step 0.1: Strip to Discord-Only Channel

**Why first:** Every subsequent step benefits from a smaller attack surface. Disabling
unused channels means fewer moving parts to break while we harden the foundation.

**What:**
- Identify all channel extensions currently enabled in the fork
- Disable every channel except Discord (remove from build/config, not delete source)
- Ensure the gateway starts cleanly with only Discord active
- Verify no other channel code runs at boot or on message dispatch

**Inputs:**
- Current `openclaw.json` config (or equivalent) listing active channels
- `extensions/` directory structure showing all channel packages
- Gateway boot sequence code (where channels are loaded/initialized)

**Outputs:**
- Modified config that only loads the Discord channel
- A list of all disabled channels (for future re-enablement reference)
- Gateway boots cleanly with zero channel-related errors in logs

**Acceptance criteria:**
- [ ] Gateway starts with only Discord channel loaded
- [ ] No references to other channels in active config
- [ ] Sending a message via Discord works end-to-end (user -> agent -> response)
- [ ] Boot logs show zero errors related to missing/disabled channels
- [ ] Disabled channels are documented (which ones, where they were disabled)

**Risks:**
- Some core code may assume certain channels exist at boot
- Shared utilities between channels may have side effects when channels are removed
- Discord channel may have implicit dependencies on shared channel infrastructure

**Review questions for the panel:**
1. Is "disable in config" the right approach, or should we also remove channel packages from the build?
2. Should we keep channel health monitoring active for Discord only, or strip that too?
3. Are there any boot-time registrations that would fail if expected channels are missing?

---

### Step 0.2: Audit and Map Error Handling

**Why:** Before we can fix error handling, we need to know where it's broken. This step
produces the map; the next step fixes what the map reveals.

**What:**
- Search the codebase for all silent error swallowing patterns:
  - `catch {}` (empty catch blocks)
  - `catch (e) { /* ignored */ }` or equivalent
  - `.catch(() => {})` (swallowed promise rejections)
  - `try/catch` where the catch only logs but doesn't propagate
- Categorize each site by severity:
  - **Critical:** Errors in config writes, credential operations, session management
  - **High:** Errors in message dispatch, agent spawning, health checks
  - **Medium:** Errors in skill loading, plugin initialization
  - **Low:** Errors in optional features, cosmetic operations
- Produce a catalog: file, line, pattern, severity, what the error was about

**Inputs:**
- Full source tree (src/, extensions/discord/, skills/)
- Knowledge of which subsystems are critical path for the Foreman

**Outputs:**
- `docs/audit/error-handling-catalog.md` — every silent catch site cataloged
- Summary: count by severity, count by subsystem
- Recommended fix priority (which to address in Step 0.3)

**Acceptance criteria:**
- [ ] Every `catch` site in critical-path code is cataloged
- [ ] Each entry has: file path, line number, pattern type, severity, description
- [ ] Summary shows total count and breakdown by severity
- [ ] No critical-path catch site is missed (verified by grep + manual review)

**Risks:**
- Some "silent" catches may be intentional (e.g., best-effort cleanup)
- The codebase is large; automated grep may miss non-obvious patterns
- Some error handling may be in dependencies, not our source

**Review questions for the panel:**
1. What grep/AST patterns should we use to find all error swallowing? Are there patterns beyond try/catch?
2. Should we also audit `process.on('unhandledRejection')` and `process.on('uncaughtException')` handlers?
3. How do we distinguish intentional "swallow and continue" from bugs?

---

### Step 0.3: Fix Critical Error Propagation + Error Envelope

**Why:** With the catalog from Step 0.2, we now fix the critical and high-severity sites.
Errors must propagate up to where they can be handled or surfaced. We also define a
minimal error envelope so that downstream consumers (Discord surfacing, rate limiting,
cost receipts) have stable fields to key on.

**What:**
- Define a **minimal error envelope** — not a deep class hierarchy, but a stable shape:
  ```
  {
    code: string        // machine-readable (e.g., "CONFIG_WRITE_FAILED", "SESSION_LOCK_TIMEOUT")
    subsystem: string   // which part of the system (e.g., "config", "session", "gateway", "agent")
    severity: enum      // "critical" | "high" | "medium" | "low"
    message: string     // human-readable description
    cause?: Error       // original error (preserved for stack traces)
    sessionKey?: string // if error occurred within a session context
    agentId?: string    // if error is associated with an agent
  }
  ```
- Wrapping strategy: native `Error` subclass with metadata fields, not a parallel
  error system. One class (`HillclawError`) with the envelope fields above. No deep
  hierarchy — subsystem + code + severity is enough to route, rate-limit, and surface.
- For each **critical** catalog entry: replace silent catch with throw/emit using envelope
- For each **high** catalog entry: add structured logging + propagation using envelope
- Pattern for fixes:
  - If the caller can handle it: throw `HillclawError` with code + severity
  - If no caller can handle it: log structured error + emit diagnostic event with envelope
  - Never: silently swallow and continue
- Add a diagnostic event type for surfaced errors (if one doesn't exist)
- Register a `process.on('unhandledRejection')` handler that wraps unhandled rejections
  in the envelope and emits them (prevents silent promise deaths)
- Register a `process.on('uncaughtException')` handler with an explicit exit policy:
  - Wrap exception in envelope and emit to diagnostic bus
  - Log full stack to structured logs
  - **Policy decision:** uncaught exceptions leave the process in undefined state.
    The handler must choose one of:
    - **Exit + restart** (safest): log, emit, then `process.exit(1)` — rely on process
      manager (systemd/pm2) to restart. This is the recommended default.
    - **Safe mode transition**: if the gateway supports it, enter safe mode (read-only)
      instead of full exit. Only viable if the exception didn't corrupt in-memory state.
  - Document the chosen policy. Do not silently continue after uncaught exceptions.

**Inputs:**
- Error handling catalog from Step 0.2
- Existing diagnostic event bus API
- Existing logging (tslog) patterns

**Outputs:**
- `HillclawError` class with envelope fields (code, subsystem, severity, cause)
- Fixed error handling at all critical and high sites using the envelope
- New or updated diagnostic event type for error surfacing
- `process.on('unhandledRejection')` handler
- `process.on('uncaughtException')` handler with documented exit policy
- Test coverage: at least one test per critical fix proving the error now propagates

**Acceptance criteria:**
- [ ] `HillclawError` class exists with: code, subsystem, severity, message, cause
- [ ] Every critical/high fix uses the envelope (not bare `throw new Error("...")`)
- [ ] Error codes are stable strings (documented in a codes table)
- [ ] Zero empty catch blocks in critical-path code
- [ ] All critical fixes have a corresponding test
- [ ] Errors that previously died silently now appear in structured logs with envelope fields
- [ ] Diagnostic event bus emits error events with full envelope for critical failures
- [ ] `process.on('unhandledRejection')` catches and wraps unhandled promise rejections
- [ ] `process.on('uncaughtException')` handler exists with documented exit policy (exit+restart or safe mode)
- [ ] Uncaught exception handler logs full envelope before exit (never silently continues)
- [ ] Existing tests still pass (no regressions from error propagation changes)

**Risks:**
- Propagating errors that were previously swallowed may surface new crashes
- Some code may rely on errors being swallowed (brittle but functional)
- Adding throws to previously-silent paths changes control flow
- Over-engineering the error system early could create maintenance burden

**Review questions for the panel:**
1. Is the envelope shape (code + subsystem + severity + cause) sufficient, or are there missing fields?
2. Should error codes follow a naming convention (e.g., `SUBSYSTEM_VERB_NOUN`)?
3. How do we handle the case where propagating an error would crash the gateway?
   (Suggested: gateway-level catch that wraps in envelope and emits, never crashes)

---

### Step 0.4: Config Write Safety

**Why:** Config corruption is one of the top fragility complaints. This step makes config
writes safe before the Foreman starts owning config. The work splits naturally into two
concerns: (a) RPC-level semantics and (b) underlying disk atomicity. Testing them together
conflates rate-limiter behavior with file integrity — so we separate them.

**Upstream reality:** OpenClaw already provides `config.patch` (merge-patch semantics)
and `config.apply` (full replace) RPCs. These use `baseHash` optimistic concurrency
(obtained from `config.get`) and are rate-limited to ~3 writes per 60 seconds. There
are also known historical config corruption patterns upstream (e.g., config set wipe bugs).

#### Step 0.4a: Verify Upstream Fixes + RPC Semantics

**What:**
- **Verify fork baseline:** Check whether the fork includes upstream config safety fixes
  (e.g., config set overwrite/wipe bugs). Record the upstream commit baseline. If critical
  fixes are missing, cherry-pick them before proceeding.
- Audit the current config write paths:
  - Map every code site that writes to `openclaw.json` (RPC handlers, direct file writes, CLI tools)
  - Verify `config.patch` uses merge-patch semantics correctly
  - Verify `config.apply` uses full-replace semantics correctly
  - Confirm `baseHash` optimistic concurrency works (stale hash -> rejection, not silent overwrite)
  - Confirm rate limiter behavior (writes beyond limit -> clear error, not silent drop)
- Write RPC-level tests:
  - `config.patch` with valid baseHash -> succeeds
  - `config.patch` with stale baseHash -> rejected with conflict error
  - `config.apply` replaces full config correctly
  - Rate limit: 4th write within 60s -> rate-limited error (not silent failure)
  - Concurrent `config.patch` calls: first wins, second gets conflict

**Inputs:**
- Current config management code (RPC handlers, file writers)
- Upstream OpenClaw commit history for config-related fixes
- Gateway RPC handler code

**Outputs:**
- Verified fork includes critical upstream config safety fixes (documented which commits)
- Map of all config write sites
- RPC semantics test suite (baseHash, rate limits, conflict handling)

**Acceptance criteria:**
- [ ] Fork baseline verified: critical upstream config fixes present (or cherry-picked)
- [ ] All config write sites mapped (RPC, direct file, CLI)
- [ ] baseHash conflict test: stale hash is rejected, not silently applied
- [ ] Rate limit test: exceeding limit produces a clear error
- [ ] Concurrent config.patch: conflict detection works (no silent overwrites)
- [ ] All Hillclaw config writes routed through RPCs (no direct file writes outside RPC layer)

#### Step 0.4b: Disk Atomicity + Backup Rotation

**What:**
- Ensure the underlying disk write (beneath the RPC layer) uses atomic tmp+rename:
  - Write to `openclaw.json.tmp`
  - `fsync` the temp file
  - `rename` to `openclaw.json` (atomic on POSIX; verify behavior on Windows/NTFS)
- Add `.bak` rotation: before each write, copy current file to `.bak` (keep last 5)
- Write disk-level tests (these bypass the RPC rate limiter, testing only file integrity):
  - 100 sequential writes via the atomic writer: file is valid JSON after each
  - Simulated crash (kill mid-write): `.tmp` file exists but main file is intact
  - `.bak` rotation: after 6 writes, only 5 `.bak` files exist

**Inputs:**
- File system utilities in the codebase
- Target platforms: Linux VPS (production), Windows NTFS (development)

**Outputs:**
- Atomic file writer module (tmp + fsync + rename)
- `.bak` rotation (last 5 backups)
- Disk atomicity test suite (separate from RPC tests)

**Acceptance criteria:**
- [ ] Atomic writer: tmp + fsync + rename pattern implemented
- [ ] 100 sequential writes: valid JSON after every write
- [ ] Simulated crash: main file never corrupted (tmp may be orphaned)
- [ ] `.bak` rotation: last 5 backups retained, older ones cleaned up
- [ ] **Windows empirical gate:** run the 100-write + concurrent-write tests on Windows NTFS.
      If native `fs.rename()` passes: document and ship. If it fails (EBUSY, non-atomic
      overwrite, or data loss): fall back to `write-file-atomic` or equivalent proven library.
      Decision is test-driven, not philosophical.
- [ ] Atomic writer is wired into the RPC disk-write path (not a separate code path)

**Risks (both sub-steps):**
- Changing the write path could break hot-reload if the gateway watches the file
- Windows `fs.rename()` may not be atomic on all NTFS configurations (empirical gate addresses this)
- Cherry-picking upstream fixes may introduce merge conflicts
- Rate limiter means the Foreman can only make ~3 config changes per minute
  (sufficient for Phase 1, but may need revisiting for Phase 2 batch operations)

**Review questions for the panel:**
1. Is the 3-writes-per-60s rate limit sufficient for Foreman operations, or will we need to
   request an upstream increase or local override?
2. On Windows NTFS, should we use `fs.rename()` or a library like `write-file-atomic`?
3. Should the `.bak` rotation be timestamped (config.bak.2026-03-02T12:00:00) or numbered (config.bak.1)?

---

### Step 0.5: Session Lock Hardening

**Why:** Concurrent session writes can corrupt state. This is a top real-world instability
source — recurring incidents show persistent `.lock` files, lock timeouts, and orphaned
locks after restarts. Especially broken on Windows where PID detection for lock ownership
doesn't work correctly.

**What:**
- **Single-gateway boot guard:** Before any lock work, prevent the most common cause of
  lock contention — two gateway processes pointing at the same state directory.
  - On boot, acquire an exclusive lock on a pidfile (e.g., `~/.openclaw/gateway.pid`)
  - If the pidfile is already locked by a live process, abort with a clear error:
    "Another gateway is already running (PID: N). Stop it first or use a different state dir."
  - This eliminates an entire category of "mysterious lock timeout" incidents.
- **Dual lock layer audit:** OpenClaw session persistence has two lock layers:
  1. **Global metadata lock:** `sessions.json.lock` (protects the session index/metadata store)
  2. **Per-session transcript locks:** `{sessionKey}.jsonl.lock` (protects individual session transcripts)
  - Both layers must be audited and hardened. Global metadata contention can masquerade as
    per-session issues, so fixing only one layer leaves the other as a corruption source.
- Audit the session store lock mechanism (both layers):
  - How are session files locked? (file locks, PID files, advisory locks)
  - Is the session store file-per-session or a single file?
  - What happens when two sessions write simultaneously?
  - How does lock ownership work (PID-based? file-based?)
  - What happens to locks during SIGUSR1 restart (graceful reload)?
- Fix the three known lock failure modes (applied to both lock layers):
  1. **Stale locks:** Process dies without releasing lock -> `.lock` file persists ->
     all subsequent writes time out. Fix: lock must include PID + timestamp; on timeout,
     check if owning PID is still alive; if dead, reclaim lock.
  2. **PID reuse:** Process dies, OS reuses PID for a different process -> stale lock
     looks "alive." Fix: lock file must include process start time (or a nonce/epoch)
     in addition to PID, so PID reuse is detected.
  3. **Restart orphans:** SIGUSR1 restart creates a new process but old lock files
     may not be cleaned up. Fix: on boot, scan for lock files owned by the previous
     gateway PID (from a pidfile or similar) and release them.
- Fix Windows PID detection (known issue from GROUNDING.md)
- Implement or harden lock acquisition:
  - Lock must be exclusive during writes
  - Lock must have a configurable timeout (default: 5s)
  - Stale lock detection uses PID + epoch, not just PID
- Evaluate library vs custom:
  - If `proper-lockfile` (or similar) covers the three failure modes above, use it
  - If OpenClaw's existing lock has custom semantics we must preserve, harden in-place
  - Document the decision and rationale

**Inputs:**
- Session store code (where sessions are persisted)
- Lock management code (current implementation)
- Known Windows PID detection issues
- Incident patterns: persistent `.lock` files, lock timeout errors

**Outputs:**
- Single-gateway boot guard (pidfile-based)
- Hardened session locking (both global metadata and per-session transcript layers)
- Cross-platform behavior (Windows + Linux)
- Concurrent-write test + restart scenario test + duplicate-instance test

**Acceptance criteria:**
- [ ] **Single-gateway guard:** second gateway instance on same state dir fails with clear error
- [ ] **Dual lock layers:** both `sessions.json.lock` and `{session}.jsonl.lock` are hardened
- [ ] Session locks work correctly on Windows and Linux
- [ ] **Stale lock recovery:** if owning process is dead, lock is reclaimed (not permanent timeout)
- [ ] **PID reuse detection:** lock includes epoch/nonce, not just PID; PID reuse doesn't trick the detector
- [ ] **Restart cleanup:** on gateway boot, orphaned locks from previous process are released
- [ ] Concurrent write test: two simultaneous session writes don't corrupt state
- [ ] Lock acquisition has a configurable timeout (default: 5s)
- [ ] No deadlocks under normal operation (tested with parallel session spawns)
- [ ] **Restart scenario test:** simulate SIGUSR1 restart, verify no orphaned locks persist
- [ ] **Duplicate instance test:** start two gateways on same state dir, second is rejected
- [ ] Library vs custom decision documented with rationale

**Risks:**
- Changing lock semantics could break existing session management
- Cross-platform file locking is notoriously tricky
- Aggressive stale-lock cleanup could kill active sessions
- PID + epoch approach may not work on all platforms (Windows process start time resolution)

**Review questions for the panel:**
1. Does OpenClaw use SIGUSR1 for graceful restart? If so, what is the lock cleanup path during restart?
2. Is `proper-lockfile` compatible with OpenClaw's session store layout, or would it require refactoring?
3. Should we add a lock health metric (count of stale lock reclaims) for observability?

---

### Step 0.6: Canonical State Store Setup

**Why:** The Foreman needs a reliable place to store the task ledger and audit log.
This step creates the store infrastructure before any data goes into it.

**What:**
- Decide: SQLite (WAL mode) vs JSONL based on actual codebase constraints
  - Does the project already depend on `better-sqlite3` or similar?
  - Is there a native addon build pipeline?
  - What's the deployment story for SQLite on the target VPS?
- Implement the chosen store with:
  - Schema versioning (`schema_version` table/field)
  - Migration runner (check version on boot, run pending migrations)
  - Atomic write guarantees
  - Read/write API that the task ledger and audit log will use
- Create migration 001: initial schema (empty tables for task ledger + audit log)

**Inputs:**
- GROUNDING.md Appendix D (Task Ledger schema) and Appendix E (State Store invariants)
- Current project dependencies (check for existing SQLite usage)
- Deployment target constraints

**Outputs:**
- State store module with read/write API
- Schema versioning and migration runner
- Migration 001: creates task_ledger and audit_log tables/collections
- Boot integration: migrations run before gateway accepts requests

**Acceptance criteria:**
- [ ] State store initializes on first boot (creates file + schema)
- [ ] Schema version is tracked and checked on every boot
- [ ] Migration 001 creates the expected tables/structure
- [ ] Atomic write test: crash during write doesn't corrupt the store
- [ ] Store survives gateway restart (data persists)
- [ ] API is clean: `createTask()`, `updateTask()`, `getTask()`, `appendAudit()`

**Risks:**
- SQLite native addon may complicate builds (especially cross-platform)
- If JSONL is chosen, we lose querying capability (acceptable for Phase 0?)
- Migration runner must be bulletproof — a failed migration could block boot

**Review questions for the panel:**
1. SQLite or JSONL — which is the right call given the deployment target and build pipeline?
2. Should the migration runner support rollbacks, or just forward-only?
3. What's the right API surface for the store? Too generic = complex, too specific = rigid.

---

### Step 0.7: Per-Call Instrumentation (Subscribe + Persist)

**Why:** "You can't optimize what you can't measure." Every model call must be tracked
before we build cost routing or receipts.

**Upstream reality:** OpenClaw already emits `model.usage` diagnostic events containing
most of the fields we need: model/provider, token counts (input/output), `costUsd`,
`durationMs`, and session identifiers. The expensive-to-derive parts (token counting,
cost calculation) are already done by the upstream runtime. Our job is not to *invent*
telemetry but to make it **durable and queryable**.

**What:**
- **Subscribe** to the existing diagnostic event bus for `model.usage` events
- **Persist** each event into the canonical state store (instrumentation table)
- **Correlate outcome:** `model.usage` may not include a success/failure flag.
  Correlate with other diagnostic events (session completion, error events from Step 0.3)
  to determine whether the call's task succeeded or failed.
- **Verify coverage:** confirm that all model call paths emit `model.usage`. If any
  paths are missing (e.g., tool calls, streaming responses), add emission points.
- If OTEL extension is available, also export as OTEL metrics (this is likely already
  wired — verify and enable, not build from scratch)

**Inputs:**
- Existing `DiagnosticUsageEvent` schema (verify fields: model, provider, tokens, costUsd, durationMs)
- Diagnostic event bus subscription API
- Canonical state store API from Step 0.6
- OTEL extension (if present — verify, don't assume)

**Outputs:**
- Event subscriber that persists every `model.usage` event to the state store
- Outcome correlation logic (success/failure/timeout per call)
- Verified coverage: all model call paths emit telemetry
- State store migration for instrumentation table
- Optional OTEL export (verified/enabled if extension exists)

**Acceptance criteria:**
- [ ] Subscriber captures every `model.usage` event (verified by comparing store count to bus emission count)
- [ ] Persisted record includes: model, provider, tokens_in, tokens_out, cost_usd, duration_ms, agent_id, session_key
- [ ] Outcome field populated via correlation (success, error, timeout)
- [ ] All model call paths emit `model.usage` (no silent calls — verified by audit)
- [ ] Telemetry records are stored in the canonical state store and queryable
- [ ] Zero performance regression from subscription (< 5ms overhead per event)
- [ ] OTEL export verified working if extension is present (or documented as absent)

**Not in scope (deferred):**
- Custom pricing table (upstream `costUsd` is already calculated — trust it for now)
- Retention policy (address when store grows; premature optimization for Phase 0)

**Risks:**
- Some model call paths may not emit `model.usage` (streaming, tool calls)
- Upstream `costUsd` may be inaccurate for some providers (verify against provider billing)
- High-volume calls could bloat the state store (retention policy deferred but noted)

**Review questions for the panel:**
1. Does `model.usage` cover streaming responses and tool calls, or only standard completions?
2. Is the upstream `costUsd` field reliable enough to trust, or should we add our own pricing table as a cross-check?
3. What's the right correlation strategy for outcome — match by session key + timestamp window?

---

### Step 0.8: Task Ledger Implementation

**Why:** The Task Ledger is the Foreman's operational backbone. It needs to exist before
the Foreman can track any work.

**What:**
- Implement the full Task Ledger schema from GROUNDING.md Appendix D
- Create the state store migration for the task ledger tables
- Implement the lifecycle state machine:
  `pending -> assigned -> running -> validating -> completed/failed/timed_out`
- Implement parent-child linkage (root tasks decompose into subtasks)
- Implement receipt aggregation (sum children's receipts into parent)
- Write tests for every state transition and edge case

**Inputs:**
- GROUNDING.md Appendix D (full schema)
- Canonical state store API from Step 0.6
- Instrumentation data from Step 0.7 (for receipt fields)

**Outputs:**
- Task Ledger module with full CRUD + lifecycle management
- State machine enforced (invalid transitions rejected)
- Receipt aggregation (parent receipt = sum of children)
- Comprehensive test suite

**Acceptance criteria:**
- [ ] All immutable fields set at creation, cannot be modified after
- [ ] All mutable fields update correctly through lifecycle
- [ ] State machine rejects invalid transitions (e.g., `completed` -> `running`)
- [ ] Parent-child linkage works: creating a child links it to parent
- [ ] Receipt aggregation: parent's receipt equals sum of children's receipts
- [ ] Timeout: tasks can transition to `timed_out` after configurable duration
- [ ] Test coverage: every valid transition, every invalid transition, parent-child, receipts

**Risks:**
- The schema may need fields we haven't anticipated (discovered during Foreman implementation)
- Receipt aggregation with concurrent child completions needs careful handling
- The state machine may be too rigid for edge cases we haven't considered

**Review questions for the panel:**
1. Is the schema in Appendix D complete, or are there missing fields?
2. Should the ledger support task cancellation as a status? (Not in current schema)
3. How should we handle partial receipt aggregation (some children complete, others fail)?

---

### Step 0.9: Visible Error Surfacing to Discord

**Why:** Errors must reach the user, not just the log file. This step wires error events
to the Discord channel so the user always knows when something breaks. Discord embed limits
are strict enough that stack traces and multi-error summaries will routinely exceed them —
so truncation and attachment fallback are correctness concerns, not polish.

**What:**
- Create a Discord error reporter module:
  - Subscribes to diagnostic error events from Step 0.3 (keyed on `HillclawError` envelope)
  - Formats errors as Discord embeds (severity color-coded, timestamp, subsystem, description)
  - Delivers to a configurable Discord channel (or thread)
- **Discord limit handling** (this is correctness, not cosmetic):
  - Embed description: max 4096 chars. If error + stack trace exceeds this:
    1. Truncate stack trace to fit within 4096 chars
    2. Append "[truncated — full trace in attachment]"
    3. Upload full error as `.txt` file attachment alongside the embed
  - Combined embeds: max 6000 chars. If multiple embeds in one message exceed this,
    split across messages.
  - Regular messages: max 2000 chars. Same truncate + attach pattern.
- **Rate limiting** using error envelope `code` field (from Step 0.3):
  - Max 1 error message per 10 seconds per error `code`
  - After 5 errors with the same `code` in 60 seconds, collapse into summary:
    "CONFIG_WRITE_FAILED occurred 5 times in the last 60s. Latest: [details]"
  - Rate limit interval configurable (default: 10s)
- **Severity filtering** (configurable: show all, or only critical+high)
- **Discord-down fallback:**
  - If the Discord error reporter fails to deliver (Discord API error, timeout, channel unreachable):
    1. Log the delivery failure to structured logs (tslog) with full error details
    2. Write error to a local fallback file: `~/.openclaw/error-surface-fallback.log`
    3. On next successful Discord delivery, append a notice:
       "While Discord was unreachable, N errors were logged to fallback. Check gateway logs."
  - The fallback file is append-only, rotated daily, kept for 7 days.

**Inputs:**
- Diagnostic event bus with `HillclawError` envelope events (from Step 0.3)
- Discord channel extension API (how to send messages/embeds/attachments programmatically)
- Discord limits: 4096 embed description, 6000 combined embeds, 2000 regular message
- Error envelope fields: code, subsystem, severity (for rate limiting keys)

**Outputs:**
- Error reporter module with Discord delivery + limit handling + rate limiting
- Truncation + attachment fallback for oversized errors
- Discord-down fallback (local file + recovery notice)
- Configurable severity filter and rate limit interval

**Acceptance criteria:**
- [ ] Critical errors appear in Discord within 5 seconds
- [ ] Error embeds include: severity (color-coded), timestamp, subsystem, error code, description
- [ ] **Truncation:** errors exceeding 4096 chars are truncated with full trace as `.txt` attachment
- [ ] **Attachment:** oversized errors produce a readable embed + downloadable attachment
- [ ] Rate limiter caps at 1 message per 10s per error `code` (using envelope field)
- [ ] Cascade detection: 5+ same-code errors in 60s collapse into summary message
- [ ] **Discord-down fallback:** delivery failure writes to local fallback file
- [ ] **Recovery notice:** after Discord reconnects, user is notified of missed errors
- [ ] Error messages never exceed Discord limits (no silent truncation without indication)
- [ ] Severity filter works: can suppress low-severity errors from Discord
- [ ] Rate limit interval is configurable

**Risks:**
- Fallback file could grow if Discord is down for extended periods (mitigated by daily rotation)
- Rate limiting could hide a new, different error if it shares the same code
- Attachment upload adds latency to error delivery
- Recovery notice could itself be rate-limited if many errors accumulated

**Review questions for the panel:**
1. Should the fallback file path be configurable, or is `~/.openclaw/error-surface-fallback.log` sufficient?
2. Should the recovery notice include a count of missed errors per severity level?
3. Is there a risk that the attachment upload (for oversized errors) hits Discord rate limits on file uploads?

---

### Step 0.10: Credential Isolation Audit

**Why:** Before the Foreman manages per-agent credentials (Phase 1), we need to know
exactly what the current credential landscape looks like.

**What:**
- Map every credential/secret in the system:
  - Where is it stored? (`credentials/` dir, environment variables, config file)
  - What accesses it? (which agents, which subsystems)
  - Is it global or scoped?
  - What type is it? (API key, OAuth token, bot token, webhook secret)
- Identify which credentials would be dangerous if leaked to a worker agent
- Produce a credential map with scoping recommendations for Phase 1

**Inputs:**
- `~/.openclaw/credentials/` directory structure
- `openclaw.json` secrets/auth configuration
- Source code: all `getCredential`, `getSecret`, auth profile usage

**Outputs:**
- `docs/audit/credential-map.md` — every credential cataloged
- Each entry: name, type, storage location, current scope (global/scoped), consumers, risk level
- Scoping recommendations: which credentials should be per-agent in Phase 1

**Acceptance criteria:**
- [ ] Every credential in the system is cataloged
- [ ] Each entry has: name, type, location, scope, consumers, risk level
- [ ] High-risk credentials identified (would cause damage if leaked to a worker)
- [ ] Scoping recommendations produced for Phase 1 implementation
- [ ] No credentials are accidentally logged or exposed during the audit

**Risks:**
- Credentials may be in unexpected places (env vars, hardcoded, third-party config)
- The audit itself must not expose sensitive values in its output
- Some credentials may be dynamically generated (OAuth refresh flows)

**Review questions for the panel:**
1. Should the credential map include credential values (encrypted), or just metadata?
2. Are there credentials that absolutely cannot be scoped per-agent (e.g., the Discord bot token)?
3. How should we handle OAuth tokens that are refreshed automatically — scope the refresh token or the access token?

---

### Step 0.11: Test Baseline for Gateway Stability

**Why:** We need a baseline test suite that proves the gateway is stable before and
after every change. This is the "7 days without crashing" foundation. The suite must
be split into two tiers: a **unit suite** that runs in CI with no external dependencies,
and an **integration suite** that exercises real Discord end-to-end. Mixing the two
creates flaky CI and unreliable baselines.

**What:**

#### Step 0.11a — Unit Suite (CI-safe, mocked Discord)

All tests run with mocked Discord (no network, no bot token). CI runs this suite
on every push.

- **Boot lifecycle test:** gateway starts with mock transport, emits `ready`, shuts down
  cleanly — no orphaned handles (detect with `--detectOpenHandles` or equivalent)
- **Config write cycle (disk-level integrity, references Step 0.4b tests):** write config
  N times via direct `fs` path (not RPC), verify file integrity after each write.
  This tests the atomic-write + backup-rotation layer in isolation.
- **Config RPC semantics (references Step 0.4a tests):** call `config.patch`/`config.apply`
  via RPC, verify merge-patch semantics, `baseHash` optimistic concurrency rejection,
  and rate-limiter error envelope (`CONFIG_WRITE_RATE_LIMITED`). These tests use the
  mock transport — no real gateway needed.
- **Session spawn cycle:** spawn 10 sessions against mock runtime, verify all complete
  or timeout cleanly with zero orphans
- **Error propagation:** emit a `HillclawError`, verify it reaches the diagnostic bus
  with correct envelope fields (code, subsystem, severity)
- **State store CRUD:** exercise canonical state store (Step 0.6) — insert, query, update,
  lifecycle transitions, invalid transition rejection
- **Lock hardening (references Step 0.5 tests):** stale-lock recovery, PID-reuse detection,
  dual lock layers (`sessions.json.lock` + per-session `.jsonl.lock`)

#### Step 0.11b — Integration Suite (real Discord, secrets-gated)

These tests require `DISCORD_BOT_TOKEN` and a test guild. They run **manually** or in
a secrets-gated CI job (e.g., GitHub Actions environment with required reviewers).
Never run automatically on every push.

- **Message round-trip:** send message via real Discord, receive agent response, verify
  content and latency (< 10 seconds)
- **Error surfacing end-to-end:** trigger an error, verify it appears in the Discord
  test channel as an embed with correct severity color and fields
- **Discord limit handling:** send an oversized error (> 4096 chars), verify truncation
  embed + `.txt` attachment appear correctly
- **Graceful shutdown under load:** start gateway, spawn sessions, send `SIGTERM`,
  verify clean exit with no orphaned processes and no Discord "bot offline" errors
- **Boot guard test:** attempt to start a second gateway instance, verify it is rejected
  by the pidfile-based single-gateway boot guard (Step 0.5)

#### Baseline

- Run both suites, record pass/fail per test. This is the "before" snapshot.
- Unit suite baseline must be green before any Phase 0 implementation PR merges.
- Integration suite baseline establishes the real-world stability floor.

**Inputs:**
- All work from Steps 0.1-0.10
- Existing Vitest test infrastructure
- Mock Discord transport (for 0.11a)
- Discord test guild + bot token (for 0.11b)

**Outputs:**
- Unit test suite (0.11a): runs in CI, < 2 minutes, zero external dependencies
- Integration test suite (0.11b): secrets-gated, documents manual run procedure
- Baseline results documented (pass/fail per test, per suite)

**Acceptance criteria:**
- [ ] **0.11a (unit):** all tests pass with mocked Discord, no network calls
- [ ] **0.11a:** config tests clearly separated — disk-level integrity (0.4b) vs RPC semantics (0.4a)
- [ ] **0.11a:** boot lifecycle completes in < 10 seconds, no open handles
- [ ] **0.11a:** suite runs in < 2 minutes total
- [ ] **0.11a:** CI runs unit suite on every push (GitHub Actions or equivalent)
- [ ] **0.11b (integration):** all tests pass with real Discord connection
- [ ] **0.11b:** message round-trip completes in < 10 seconds
- [ ] **0.11b:** error surfacing delivers correct embed to Discord channel
- [ ] **0.11b:** oversized error produces truncation embed + `.txt` attachment
- [ ] **0.11b:** graceful shutdown leaves no orphaned processes
- [ ] **0.11b:** boot guard rejects duplicate gateway instance
- [ ] **0.11b:** suite is gated on secrets (does not run without `DISCORD_BOT_TOKEN`)
- [ ] **0.11b:** manual run procedure documented in repo
- [ ] Baseline recorded for both suites

**Risks:**
- Integration tests are inherently flaky (Discord API latency, rate limits)
- Mock transport may not perfectly replicate Discord behavior — integration tests catch the gaps
- Secrets-gating adds friction to running integration tests (mitigated by clear docs)
- Test environment may differ from production VPS (mitigated by documenting expected environment)

**Review questions for the panel:**
1. Is the unit/integration split at the right boundary, or should any integration tests move to unit?
2. Should the integration suite have a "smoke" subset that runs faster for quick validation?
3. What's the right flakiness threshold — should integration tests retry once on failure before marking red?

---

## Phase 0 Complete Checklist

When all steps are approved and implemented:

- [ ] Step 0.1: Discord-only channel (approved / implemented / tested)
- [ ] Step 0.2: Error handling audit (approved / implemented)
- [ ] Step 0.3: Error propagation fixes (approved / implemented / tested)
- [ ] Step 0.4a: Config RPC semantics + upstream fix verification (approved / implemented / tested)
- [ ] Step 0.4b: Disk atomicity + backup rotation (approved / implemented / tested)
- [ ] Step 0.5: Session lock hardening (approved / implemented / tested)
- [ ] Step 0.6: Canonical state store (approved / implemented / tested)
- [ ] Step 0.7: Per-call instrumentation (approved / implemented / tested)
- [ ] Step 0.8: Task ledger (approved / implemented / tested)
- [ ] Step 0.9: Error surfacing to Discord (approved / implemented / tested)
- [ ] Step 0.10: Credential isolation audit (approved / implemented)
- [ ] Step 0.11a: Unit test suite — CI-safe (approved / implemented / passing)
- [ ] Step 0.11b: Integration test suite — real Discord (approved / implemented / passing)

**Then Phase 0 exits when the success criteria from GROUNDING.md are met:**
- Gateway runs for 7 days without crashing or corrupting state
- Config file survives 100 write cycles without corruption
- All errors surface to Discord (no silent failures in logs only)
- Every model call logs: tokens, cost, latency, outcome

---

*Next: Phase 1 steps will be written after Phase 0 is approved and under way.*

---

*Document version: 0.3*
*Created: 2026-03-02*
*Last updated: 2026-03-02*
*Covers: Phase 0 (Foundation Hardening + Instrumentation)*
*Review status: Pending three-model review per step*

*Revision history:*
- *v0.1 — Initial Phase 0 breakdown into 11 reviewable steps.*
- *v0.2 — Three-model review corrections: Step 0.3 gains HillclawError envelope (code +
  subsystem + severity) for deterministic rate limiting and routing. Step 0.4 split into
  0.4a (RPC semantics + upstream fix verification) and 0.4b (disk atomicity + backup rotation)
  to avoid conflating rate-limiter behavior with file integrity. Step 0.5 promotes stale-lock
  recovery, PID-reuse detection, and restart orphan cleanup to explicit acceptance criteria
  with restart scenario test. Step 0.7 re-scoped from "build instrumentation" to "subscribe
  + persist existing model.usage events" — upstream already emits tokens/cost/duration. Step
  0.9 adds Discord limit handling (truncation + attachment fallback), rate limiting keyed on
  error codes, and Discord-down fallback (local file + recovery notice).*
- *v0.3 — Second three-model review corrections: Step 0.3 adds `uncaughtException` handler
  with explicit exit policy (exit+restart default, safe mode alternative). Step 0.5 adds
  single-gateway boot guard (pidfile-based exclusive lock) and dual lock layer coverage
  (`sessions.json.lock` + per-session `.jsonl.lock`). Step 0.4b changes Windows NTFS atomicity
  from prescriptive to empirical gate — test on Windows, ship native if it passes, fall back
  to `write-file-atomic` if it fails. Step 0.11 split into 0.11a (unit suite, CI-safe, mocked
  Discord) and 0.11b (integration suite, real Discord, secrets-gated) with config tests
  clearly separated into disk-level integrity (0.4b) vs RPC semantics (0.4a).*
