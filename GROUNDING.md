# Hillclaw — Vision & Grounding Document

> *Working name. The project name is a placeholder and will be finalized later.*

---

## What This Is

Hillclaw is a fork of [OpenClaw](https://github.com/openclaw/openclaw), rebuilt around a
single idea: **you talk to one agent, and it handles everything.**

No human-edited config files. No debugging heartbeats. No "works on my machine."
You speak to the Foreman, and the Foreman gets it done — by creating, coordinating,
and managing a fleet of specialized agents that work on your behalf.

The Foreman owns all persisted state. Config files, credentials, session data, and
agent definitions exist on disk (they must), but no human ever touches them directly.
The Foreman reads, writes, migrates, and repairs its own state.

---

## The Problem

OpenClaw is powerful software with a brutal learning curve. It supports 20+ messaging
channels, multi-agent routing, voice, canvas, browser control, skills, and more.
But in practice:

- It breaks. Heartbeats die, configs corrupt, sessions collide.
- It's expensive. Running frontier models through API keys burns money fast.
- It's fragile. Silent error swallowing means things fail invisibly.
- It's complex. Configuration requires deep knowledge of a 40+ subsystem codebase.
- It doesn't self-heal. When something goes wrong, *you* have to fix it.

The result: a system that works brilliantly for its creators and frustrates everyone else.

---

## The Vision

### The Internet Is Becoming Agentic

People will stop surfing the internet. They will stop clicking through websites.
Instead, they will talk to their agents, who will:

- Go out and gather data from **nodes** (the new websites — API/MCP endpoints,
  data containers that agents plug into)
- Bring it back for the user to see or for other agents to process
- Execute tasks across services, tools, and platforms
- Coordinate with each other to get complex work done

This is not workflow automation (n8n, Zapier). Those are rigid: "when X, do Y."
This is adaptive: "figure out how to get this done."

### Where Hillclaw Fits

```
Agent OS (kernel, scheduling, memory)     <- not our lane
Communication Layer (protocols, mesh)     <- not our lane
AGENT PLATFORM (orchestration, tools)     <- THIS IS HILLCLAW
Nodes (MCP servers, APIs, data stores)    <- we consume these
```

Hillclaw is the **agent platform layer** — the place where agents live, reason,
collaborate, and act. It is not an operating system. It is not a protocol.
It is the thing that makes agents useful to a single human being.

---

## Core Architecture: The Foreman Pattern

```
YOU (Discord, web, voice, mobile — any channel)
  |
  v
THE FOREMAN (mid-tier model: orchestration reliability matters)
  |  One agent. Your single point of contact.
  |  Understands your intent.
  |  Knows what agents exist and what they can do.
  |  Can CREATE, DESTROY, MODIFY, and COORDINATE agents.
  |  Routes tasks to the cheapest effective model.
  |  Monitors health. Fixes things before you notice.
  |  Owns all persisted state (config, creds, agent registry).
  |
  v
THE MESH (agent fleet — hub-and-spoke by default)
  |-- Research Agent --> web nodes, APIs, MCPs
  |-- Content Agent --> writing, social, marketing
  |-- Dev Agent --> code, test, deploy
  |-- Comms Agent --> email, scheduling, outreach
  |-- [any agent the Foreman creates on demand]
  |
  |-- Phase 1-2: strict hub-and-spoke (all spawning through Foreman)
  |-- Phase 2+: optional hierarchical tree (maxSpawnDepth >= 2, Foreman-enabled)
  |-- Workers COMPLETE via announce chain (platform delivers result to parent)
  |-- Parent POLLS via sessions_history when announce is unavailable
  |-- Foreman ROUTES verification tasks to validator agents
  '-- workers REPORT back to their parent (Foreman or delegated orchestrator)
        |
        v
      YOU (results delivered through your channel)
```

### Why the Foreman Runs Mid-Tier (Not Cheap)

Orchestration is harder than execution. The Foreman must:
- Decompose ambiguous requests into concrete subtasks
- Route tasks to the right agent with the right model
- Detect when cheap consensus fails and escalate
- Make safe self-healing decisions without human input

A cheap model failing here creates expensive cascades (wrong routing, wasted
parallel calls, undetected errors). Start mid-tier, graduate to cheaper routing
once telemetry shows where heuristics suffice.

### How It Differs From Stock OpenClaw

| Aspect | OpenClaw | Hillclaw |
|--------|----------|----------|
| Agent creation | Edit JSON config, restart | "Foreman, create an agent for X" |
| Agent coordination | Manual routing bindings | Foreman auto-routes based on capability |
| Error recovery | Run `openclaw doctor`, hope | Foreman detects and self-heals |
| Model selection | Set in config per agent | Cost-aware routing: cheapest that works |
| New capability | Install skill, configure, test | "Foreman, add the ability to do X" |
| Monitoring | Check logs, run status commands | Foreman tells you if something needs attention |
| State management | Human edits openclaw.json | Foreman owns all config via `config.patch`/`config.apply` RPCs |

---

## Cost Strategy: Cheap Models + Swarm = Frontier Quality

Running frontier models (Claude Opus, GPT-4) through API keys is expensive.
Cheaper models (MiniMax, z.ai, Gemini Flash) score well on benchmarks but
lag behind in real-world agent tasks.

**Hillclaw's approach: make cheap models perform like expensive ones.**

### Mixture of Agents (MoA)

Instead of one expensive model doing everything, multiple cheap models collaborate:

```
Task: "Research competitors and write a summary"

FOREMAN (mid-tier) -> decomposes task, assigns models
  |
  |-> Agent A (cheap) -> researches source 1  -+
  |-> Agent B (cheap) -> researches source 2   +-> parallel
  |-> Agent C (cheap) -> researches source 3  -+
  |
  v
VALIDATOR (cheap) -> cross-checks all findings, flags conflicts
  |
  v
SYNTHESIZER (cheap) -> writes the summary
  |
  v
REVIEWER (cheap) -> checks quality, sends back if needed
  |
  v
FOREMAN -> delivers to you with cost receipt + conflict notes
```

Six cheap calls working together, verifying each other, catching mistakes —
producing output that rivals one expensive frontier call. Faster too,
because research agents run in parallel.

**Cost accounting is mandatory, not optional.** Every task returns a receipt:
tokens used, USD cost, model breakdown, latency. This is how we prove the
strategy works and how we tune it.

### Smart Model Routing

| Task Type | Model Tier | Why |
|-----------|-----------|-----|
| Routing, dispatch, triage | Cheapest (haiku-tier) | Just needs to understand intent |
| Research, data gathering | Cheap x parallel | Volume + cross-verification |
| Content writing | Medium, reviewed by cheap | Quality matters, but validator catches issues |
| Code generation | Medium + cheap test runner | Code must work; tests are cheap verification |
| Critical decisions | Frontier (escalate) | Only when stakes justify cost |
| Verification | Always cheap | Checking work is simpler than doing work |
| Foreman orchestration | Mid-tier | Orchestration errors are the most expensive |

### Escalation Contract

Escalation from cheap to expensive models is not vibes. It follows explicit triggers:

1. **Validator disagreement**: 2+ validators flag contradictory findings -> escalate to mid-tier
2. **Retry ceiling**: Task fails 2x on cheap model -> escalate one tier
3. **Confidence threshold**: Agent self-reports low confidence -> escalate
4. **Complexity signal**: Task decomposition produces 5+ subtasks -> Foreman uses mid-tier for synthesis
5. **User override**: "Use the best model for this" -> frontier, no questions asked
6. **Cost ceiling**: If escalation would exceed per-task budget -> ask user before proceeding

### Guardrails Layer

Every agent output passes through pluggable validators before delivery:

```
Agent Output
  -> Format guardrail (valid JSON/markdown/etc?)
  -> Safety guardrail (no harmful content?)
  -> Quality guardrail (actually answers the question?)
  -> Fact-check guardrail (cross-reference with other agents/sources)
  -> PASS -> deliver
  -> FAIL -> retry with feedback (max 2 retries), then escalate model tier
```

Guardrails are cheap and catch most "this model isn't frontier" problems.

**Guardrail policy (deterministic, not discretionary):**

| Task Risk Level | Guardrails Applied | Max Overhead |
|----------------|-------------------|-------------|
| Low (internal, non-public) | Format only | 10% of task cost |
| Medium (research, drafts) | Format + quality | 20% of task cost |
| High (publishing, code, external) | Format + quality + safety + fact-check | 30% of task cost |
| Critical (financial, credentials) | All guardrails + human review | No cap (user decides) |

When overhead hits the cap for a tier, collapse remaining guardrails into a single
combined validator pass. Never silently skip — log the collapse in the cost receipt.

---

## Target User

### Phase 1: The Builder (You)

- One person running a cloud VPS
- Talks to the Foreman through Discord
- Uses agents for: research & analysis, content & marketing, software development
- Has access to multiple AI providers (Anthropic, OpenAI, Google, MiniMax, z.ai, others)
- Technical ability comes from AI tooling (Claude), not from being a developer
- Wants it to just work. If it breaks, the Foreman should fix it.

### Phase 2: Power Users

- People who want a personal AI workforce but don't want to learn a platform
- Onboarding should be: install, connect Discord, talk to Foreman
- The Foreman handles all setup, configuration, and agent management
- Zero human-edited config files

### Phase 3: The Platform

- Other builders deploy Hillclaw for their own use cases
- Skill/agent marketplace potential
- Node ecosystem (MCP servers) that agents can discover and use
- The Foreman becomes a product, not a project

---

## Primary Channel: Discord

While OpenClaw supports 20+ channels, Hillclaw starts with **Discord only**.

Why:
- It's the daily driver
- Rich interaction model (threads, reactions, embeds, voice, slash commands)
- Community-ready when Phase 2 arrives
- Reduces surface area for bugs (no WhatsApp credential corruption, no Signal SSE issues)

Other channels can be re-enabled later once the core is bulletproof.

### Discord Delivery Strategy

Discord imposes limits: 4096 chars per embed description, 6000 chars combined across
embeds, 2000 chars per regular message. Agent outputs will routinely exceed these.

| Output Size | Delivery Method |
|-------------|----------------|
| Small (<2000 chars) | Single message or embed |
| Medium (2000-6000 chars) | Chunked embeds in a thread |
| Large (>6000 chars) | Summary embed + full output as `.md` file attachment |
| Structured (tables, code) | Thread with typed sections (embed per section) |

**Thread-per-task model:** Every Foreman task creates a Discord thread. The thread
contains the task's progress, results, cost receipt, and any conflict notes. This
keeps the main channel clean and gives each task a self-contained conversation.

**Attachment fallback:** When output exceeds embed limits, the Foreman uploads the
full result as a markdown or text file attachment with a summary embed linking to it.

---

## Use Cases (Day One)

### 1. Research & Analysis
> "Foreman, research the top 5 competitors in [space] and give me a comparison table."

The Foreman spawns parallel research agents, a validator to cross-check,
and a synthesizer to produce the final output. Delivered to your Discord channel
with a cost receipt and any conflict notes.

### 2. Content & Marketing
> "Foreman, write 3 LinkedIn post variations about [topic], optimized for engagement."

The Foreman spawns a content agent, a reviewer for quality, and presents options.
You pick the best one. Foreman can post it if you have a connected node.

### 3. Software Development
> "Foreman, add dark mode to the dashboard. Run the tests when you're done."

The Foreman assigns a dev agent, monitors progress, runs tests via a test agent,
and reports back with results. If tests fail, the dev agent fixes and retries.

---

## Non-Goals (What Hillclaw Is NOT)

- **Not an operating system.** It runs on one. It doesn't replace one.
- **Not a protocol layer.** It uses WebSockets, HTTP, MCP. It doesn't define new protocols.
- **Not a workflow tool.** No drag-and-drop flowcharts. Agents reason, they don't follow rails.
- **Not multi-tenant.** One Foreman, one human. This is a personal AI workforce.
- **Not a model trainer.** We use models. We route them smartly. We don't fine-tune them.

---

## Build Phases

### Phase 0: Foundation Hardening + Instrumentation
**Goal:** Stop the platform from breaking, and make failures visible from day one.

- [ ] Config writes via `config.patch`/`config.apply` RPCs (baseHash optimistic concurrency,
      rate-limited). Atomic file write (tmp+rename) as fallback when RPC is unavailable.
- [ ] Error propagation: audit silent catch sites, replace with logged + surfaced errors
- [ ] Session lock hardening (prevent concurrent write corruption, fix Windows PID detection)
- [ ] Strip down to Discord-only channel (reduce attack surface)
- [ ] Establish test baseline for gateway stability
- [ ] Canonical state store: decide format (SQLite or JSONL), enforce atomicity, schema
      versioning, and migrations-on-boot for all Foreman-managed state
- [ ] Per-call instrumentation: tokens, USD cost, latency, model, outcome
      (hook into diagnostic event bus and OTEL metrics if available)
- [ ] Task ledger: first-class schema (see Appendix D), stored in canonical state store
- [ ] Visible error surfacing: errors delivered to Discord, not just log files
- [ ] Credential isolation audit: map which credentials are global vs per-agent-scoped

### Phase 1: The Foreman + Basic MCP
**Goal:** A single agent you talk to through Discord that manages everything.

**The smallest impressive demo:**
Discord command -> Foreman spawns 3 research workers + validator + synthesizer
-> returns result + conflict notes + cost receipt. All via existing session primitives.

- [ ] Foreman agent with meta-capabilities (create/destroy/modify agents)
- [ ] Dynamic agent registry backed by Foreman-managed config (no human JSON editing)
- [ ] Intent understanding and task decomposition
- [ ] Agent-to-Foreman result flow: announce chain (default) + sessions_history polling (fallback)
- [ ] Health monitoring with bounded self-healing (explicit contract for what Foreman can fix)
- [ ] Basic MCP read-only support: discovery + calling a small set of trusted nodes
- [ ] Per-agent credential scoping (secrets isolated per agent, not global)
- [ ] Tool allowlist per agent (Foreman controls what each agent can access)
- [ ] Audit log: every Foreman action recorded (create, destroy, modify, self-heal)

### Phase 2: The Mesh (Hub-and-Spoke → Hierarchical Tree)
**Goal:** Foreman-coordinated parallel work with cross-verification.

**Architecture constraint (OpenClaw reality):** Sub-agents cannot call `sessions_spawn`
by default. Worker agents do not have session tools unless explicitly enabled.
Phase 2 starts as strict hub-and-spoke (all spawning through Foreman).

**Hierarchical tree (opt-in):** OpenClaw supports `maxSpawnDepth >= 2`, meaning the
Foreman can grant select orchestrator agents the ability to spawn their own workers.
This enables delegation patterns (e.g., a Research Lead agent that manages its own
research workers). The Foreman must explicitly enable this per-agent via config, and
the total spawn tree depth is capped to prevent runaway nesting.

**`sessions_send` cost awareness:** Each `sessions_send` call can trigger a reply
chain (announce step + ping-pong). A single "send" may produce multiple model turns.
Budget for 2-3x the expected call count when estimating mesh task costs.

- [ ] Parallel dispatch (Foreman spawns multiple workers simultaneously via `sessions_spawn`)
- [ ] Result collection: announce chain (default), `sessions_history` polling (fallback), timeout after 60s
- [ ] Cross-verification (Foreman routes output from worker A to validator B)
- [ ] Disagreement protocol: majority wins, tie -> escalate model, unresolvable -> ask user
- [ ] Worker session tools: explicitly enabled for select agents that need collaboration (scoped visibility)
- [ ] Hierarchical tree (opt-in): allow Foreman to grant `sessions_spawn` to orchestrator agents with capped `maxSpawnDepth`
- [ ] Ping-pong budget: cap reply chains per `sessions_send` call to prevent runaway costs

### Phase 3: Cost Intelligence
**Goal:** Make cheap models perform like expensive ones, with proof.

- [ ] Cost-aware model routing (match task complexity to model price)
- [ ] Escalation policy with explicit triggers (not vibes — see Escalation Contract above)
- [ ] Guardrails framework (pluggable validators on every agent output)
- [ ] Usage tracking and cost reporting through Foreman (per-task receipts to Discord)
- [ ] Guardrail cost monitoring (flag when validation overhead exceeds 30% of task cost)
- [ ] A/B comparison: same task on cheap-swarm vs frontier, quality + cost comparison

### Phase 4: Full Node Connectivity
**Goal:** Agents can plug into the outside world at scale.

- [ ] Full MCP client support (agents discover and use MCP servers dynamically)
- [ ] Tool/skill marketplace with trust scoring (not blind install)
- [ ] External service authentication (OAuth flows managed by Foreman)
- [ ] Data persistence (agents remember what they've learned)
- [ ] Node allowlist: Foreman controls which external nodes agents can access

### Phase 5: Polish & Expand
**Goal:** Ready for other people to use.

- [ ] Zero-config onboarding (install -> connect Discord -> talk to Foreman)
- [ ] Self-updating (Foreman manages its own upgrades)
- [ ] Re-enable additional channels (Telegram, Slack, etc.) as stable plugins
- [ ] Documentation generated by the Foreman itself

---

## Principles

1. **Talk, don't configure.** If a human has to edit a config file, we failed.
   The Foreman owns all persisted state.
2. **Cheap by default, smart when needed.** Use the minimum model that gets the job done.
   But the Foreman itself runs mid-tier because orchestration errors cascade.
3. **Fail visibly.** Never swallow an error. If something breaks, the Foreman tells you
   through Discord, not a log file.
4. **Self-heal within bounds.** The Foreman can restart agents, refresh credentials,
   and repair config. It cannot delete user data or change security boundaries without asking.
5. **One conversation.** You talk to one agent. Everything else is behind the scenes.
6. **Agents are disposable.** Create them, use them, destroy them. No precious state.
7. **Verify everything.** No agent output is trusted until another agent checks it.
   Disagreements are resolved by protocol, not ignored.
8. **Ship working software.** Every phase produces something usable, not just plumbing.
9. **Instrument from day one.** Every call is tracked: tokens, cost, latency, outcome.
   You can't optimize what you can't measure.
10. **Security is architecture, not a feature.** Credentials are scoped per-agent.
    Tools are allowlisted. Actions are audited. This is embedded in the design,
    not bolted on later.

---

## Technical Foundation (Inherited from OpenClaw)

- **Runtime:** Node.js 22+, TypeScript (ESM)
- **Build:** tsdown + Oxlint/Oxfmt
- **Testing:** Vitest
- **Gateway:** WebSocket control plane (ws://127.0.0.1:18789)
- **Agent Runtime:** Pi agent (RPC mode) with tool streaming
- **Deployment:** Cloud VPS (always-on)
- **Package Manager:** pnpm
- **Monorepo:** apps/ (mobile), extensions/ (channels), skills/, src/ (core)

### Existing Infrastructure We Build On

These are signals and hooks we intend to leverage. Exact availability depends on
the fork's state at build time — we verify before relying on each.

| System | What We Expect | What We Add |
|--------|---------------|-------------|
| Diagnostic event bus | Global pub/sub for model usage, webhooks, sessions | Foreman-level events, task ledger writes |
| OTEL extension | Metrics/traces/logs export (if diagnostics-otel enabled) | Per-task cost receipt aggregation |
| Logging (tslog) | Structured file + console logging, per-subsystem | Error surfacing to Discord channel |
| Health RPC | `/health` method, channel health monitor | Foreman-triggered self-heal hooks |
| Security audit | Audit report generation, per-subsystem checks | Per-agent credential scoping enforcement |
| Session tools | sessions_spawn, sessions_send, sessions_list, sessions_history | Foreman orchestration layer (hub-and-spoke, hierarchical tree opt-in) |

---

## Success Criteria

Phase 0 is done when:
- Gateway runs for 7 days without crashing or corrupting state
- Config file survives 100 write cycles without corruption
- All errors surface to Discord (no silent failures in logs only)
- Every model call logs: tokens, cost, latency, outcome

Phase 1 is done when:
- You can say "create an agent that does X" in Discord and it works
- You can say "what agents do I have?" and get an accurate answer
- The Foreman restarts a crashed agent without being asked
- The smallest impressive demo works: research task -> parallel agents -> result + cost receipt
- Credential scoping: agents only see their own secrets

Phase 2 is done when:
- A research task spawns 3+ parallel agents and synthesizes their output
- Agents can flag disagreements and resolve them via consensus protocol
- Task completion time is measurably faster than single-agent execution

Phase 3 is done when:
- 90% of tasks complete successfully on cheap models
- Cost per task is <20% of what a single frontier model call would cost
- Quality (measured by user satisfaction) is within 90% of frontier-only output
- Cost receipts are delivered with every task result

---

## Appendix A: Definitions & State Model

### What Is an "Agent"?

In OpenClaw, an **agent is a configuration entry, not a process**. It defines:
- An ID (lowercase alphanumeric + dash)
- A model configuration (primary + fallbacks)
- A workspace directory
- Skill allowlists
- Sandbox settings
- Tool permissions

Agents live in `agents.list[]` in `openclaw.json`. They do not run persistently.
When work arrives, the gateway creates a **session** bound to an agent config.

### What Is a "Session"?

A **session is the unit of work**. It is created when:
- A user sends a message (main session)
- An agent spawns a sub-agent (`sessions_spawn`)
- A cron job fires
- A heartbeat triggers

Sessions have:
- A unique key: `agent:{agentId}:acp:{uuid}` (or subagent/group/thread variants)
- State: idle, running, error
- A parent chain: `spawnedBy` tracks who created whom
- Spawn depth: 0 = main, 1 = sub-agent, 2+ = nested
- Credentials: global by default, overridable per-session

### What Persists on Disk?

| Data | Location | Who Manages |
|------|----------|-------------|
| Main config | `~/.openclaw/openclaw.json` | Foreman (not human) |
| Credentials | `~/.openclaw/credentials/` | Foreman + auth profiles |
| Session state | `~/.openclaw/sessions/` | Gateway session store |
| Agent workspaces | `~/.openclaw/workspace/` | Per-agent, Foreman-managed |
| Skills | `~/.openclaw/skills/` (managed) + `workspace/skills/` | Foreman can install/remove |
| Logs | `~/.openclaw/openclaw-YYYY-MM-DD.log` | Gateway logger |
| Audit trail | `~/.openclaw/audit/` | Foreman action log (new) |

### Session Visibility Boundaries

| Mode | What a Session Can See |
|------|----------------------|
| `self` | Only its own agent's sessions |
| `tree` | Own agent + spawned children (default) |
| `agent` | All sessions for same agent ID |
| `all` | All sessions globally |

The Foreman operates at `all` visibility. Worker agents default to `tree`.

### Credential Scoping

**Current state (OpenClaw):** Credentials are global. All agents share the same
secrets config and auth profiles.

**Hillclaw target:** Per-agent credential isolation.
- Each agent gets a scoped credential set
- The Foreman controls which agent gets which credentials
- Worker agents cannot access credentials they don't need
- Auth profiles support per-session overrides (mechanism already exists)

---

## Appendix B: Security Architecture

Security is not a phase. It is embedded in every phase.

### Threat Model

| Threat | Source | Mitigation |
|--------|--------|------------|
| Credential theft via malicious skills | Skill marketplace, third-party SKILL.md | Tool/skill allowlists per agent, trusted-only in early phases |
| Prompt injection via external data | Web scraping, MCP responses, user input | Guardrail validators, sandboxed execution, output review |
| Credential leakage across agents | Shared global secrets | Per-agent credential scoping (Phase 1) |
| Self-healing overreach | Foreman auto-fixing things it shouldn't | Bounded self-heal contract (see below) |
| Supply chain compromise | npm dependencies, skill installs | Lockfile pinning, no auto-install without Foreman approval |

### Foreman Self-Healing Contract

The Foreman CAN (without asking):
- Restart a crashed agent session
- Refresh an expired auth token (using existing refresh flow)
- Retry a failed task on a different model
- Repair a corrupted config from backup
- Log and surface errors to Discord

The Foreman CANNOT (must ask the user):
- Delete any user data or session history
- Change security boundaries (sandbox mode, credential access)
- Install new skills or tools from untrusted sources
- Grant an agent access to credentials it doesn't currently have
- Modify network exposure (ports, Tailscale, TLS settings)

### Audit Trail

Every Foreman action is logged:
```
{ timestamp, action, target, params, outcome, costUsd }
```

Actions: agent.create, agent.destroy, agent.modify, session.spawn, session.kill,
config.write, credential.rotate, self-heal.restart, self-heal.repair, escalate.model

The audit log is append-only and the Foreman cannot delete it.

---

## Appendix C: Mapping to OpenClaw Primitives

The Foreman is not a rewrite. It is an orchestration layer on top of existing primitives.

| Hillclaw Concept | OpenClaw Primitive | How It Maps |
|-----------------|-------------------|-------------|
| Foreman | Agent config entry + main session | A privileged agent with `all` session visibility |
| Create agent | Write to `agents.list[]` + gateway reload | Foreman uses `config.patch` RPC (baseHash concurrency, rate-limited) |
| Spawn worker | `sessions_spawn(task, agentId, mode)` | Returns childSessionKey + runId |
| Message agent | `sessions_send(sessionKey, message)` | Existing inter-session messaging |
| List agents | `sessions_list(kinds, activeMinutes)` | Existing session listing |
| Check history | `sessions_history(sessionKey, limit)` | Existing transcript access |
| Health check | `/health` RPC + channel health monitor | Existing health probes |
| Cost tracking | DiagnosticUsageEvent + OTEL metrics | Existing token/cost tracking |
| Task ledger | NEW: Foreman-managed task store | Not in OpenClaw — we build this |
| Guardrails | NEW: pluggable output validators | Not in OpenClaw — we build this |
| Cost receipts | NEW: per-task cost aggregation | Built on existing usage events |

### Shortest Path to Phase 1 Demo

1. Register Foreman as an agent in `agents.list[]` with `all` visibility + mid-tier model
2. Give Foreman access to session tools: `sessions_spawn`, `sessions_send`, `sessions_list`
3. Create a task ledger in canonical state store (see Appendix D)
4. On user message: Foreman decomposes -> spawns workers via `sessions_spawn` ->
   collects results (announce chain = default, `sessions_history` polling = fallback) ->
   synthesizes -> delivers to Discord with cost receipt
5. This uses zero new runtime code. It's orchestration via existing tools.

**Result collection pattern** (accounting for async `sessions_spawn`):
- `sessions_spawn` returns immediately with `childSessionKey` + `runId`
- **Default: announce chain.** When a worker session completes, the platform delivers
  the result to the Foreman automatically (no explicit `sessions_send` required).
- **Fallback: `sessions_history` polling.** If announce delivery fails or the worker
  is long-running, the Foreman polls `sessions_history(childSessionKey)` every 5s, max 60s.
- `sessions_send` is reserved for **explicit inter-session messaging** (e.g., Foreman
  sending mid-task instructions to a worker), not for routine result collection.
- Timeout: if no result in 60s via either path, Foreman marks task as timed-out in ledger.

---

## Appendix D: Task Ledger Schema

The Task Ledger is the one truly new primitive Hillclaw adds beyond OpenClaw.
It is the Foreman's operational backbone.

### Storage

Stored in the canonical state store (SQLite or JSONL — decided in Phase 0).
Must support:
- Atomic writes (concurrent workers completing simultaneously)
- Schema versioning (migrations on boot)
- Append-only audit semantics (completed tasks are never deleted, only archived)

### Task Record

**Immutable fields** (set at creation, never change):

| Field | Type | Description |
|-------|------|-------------|
| `taskId` | string (UUID) | Unique task identifier |
| `parentTaskId` | string or null | Parent task (for subtask decomposition) |
| `createdAt` | ISO 8601 timestamp | When the Foreman created this task |
| `createdBy` | string | Session key of the creator (always Foreman) |
| `intent` | string | Original user request or decomposed subtask description |
| `taskType` | enum | `research`, `content`, `code`, `verify`, `synthesize`, `custom` |
| `riskLevel` | enum | `low`, `medium`, `high`, `critical` (determines guardrail tier) |

**Mutable fields** (updated during lifecycle):

| Field | Type | Description |
|-------|------|-------------|
| `status` | enum | `pending`, `assigned`, `running`, `validating`, `completed`, `failed`, `timed_out` |
| `assignedAgent` | string or null | Agent ID of the worker |
| `assignedSession` | string or null | Session key of the worker session |
| `assignedModel` | string or null | Model used for this task |
| `startedAt` | timestamp or null | When work began |
| `completedAt` | timestamp or null | When work finished (success or failure) |
| `result` | string or null | Worker output (truncated if large) |
| `error` | string or null | Error message if failed |
| `escalatedFrom` | string or null | Model that failed before escalation |
| `retryCount` | number | Times this task has been retried (max 2 before escalate) |

**Receipt fields** (aggregated on completion):

| Field | Type | Description |
|-------|------|-------------|
| `tokensInput` | number | Total input tokens across all calls for this task |
| `tokensOutput` | number | Total output tokens |
| `costUsd` | number | Total USD cost |
| `latencyMs` | number | Wall-clock time from creation to completion |
| `guardrailCostUsd` | number | USD spent on validation/guardrails specifically |
| `modelBreakdown` | array | Per-model token/cost split |

### Task Lifecycle

```
pending -> assigned -> running -> validating -> completed
                         |            |
                         |            '-> failed (validation) -> retry or escalate
                         '-> failed (execution) -> retry or escalate
                         '-> timed_out -> retry or escalate
```

### Parent-Child Linkage

A user request becomes a root task. Decomposition creates child tasks:

```
Root Task: "Research competitors and write a summary"
  |-- Child 1: research source A (type: research)
  |-- Child 2: research source B (type: research)
  |-- Child 3: research source C (type: research)
  |-- Child 4: validate findings (type: verify, depends on 1-3)
  '-- Child 5: synthesize summary (type: synthesize, depends on 4)
```

The root task is `completed` only when all children are `completed`.
The root task's receipt is the sum of all children's receipts.

---

## Appendix E: Canonical State Store

### The Decision

All Foreman-managed state lives in a single canonical store. This prevents the
"random JSON files everywhere" problem that makes OpenClaw fragile.

**Format decision (made in Phase 0):** SQLite or JSONL.

| Criterion | SQLite | JSONL |
|-----------|--------|-------|
| Atomicity | Built-in (WAL mode) | Requires write-tmp-rename per entry |
| Concurrent access | Built-in locking | Manual file locking |
| Querying | Full SQL | Scan entire file |
| Schema migration | ALTER TABLE + versioning | Parse + rewrite |
| Tooling | sqlite3 CLI, DB browsers | cat, grep, jq |
| Simplicity | Moderate (needs better-sqlite3) | Simple (just files) |

**Recommendation:** SQLite (WAL mode) for the task ledger and audit log.
JSONL for simple append-only logs where queryability isn't needed.
OpenClaw's `openclaw.json` stays as-is (Foreman writes via `config.patch`/`config.apply`
RPCs with baseHash optimistic concurrency; atomic file tmp+rename as fallback).

### Invariants

1. **Atomic writes only.** No partial writes survive a crash.
2. **Schema versioned.** Every store has a `schema_version` field. Boot checks version
   and runs migrations before any reads/writes.
3. **Migrations before work.** Gateway boot sequence: check store versions -> migrate
   if needed -> proceed. Never serve requests against an outdated schema.
4. **Foreman is sole writer.** Workers never write to the canonical store directly.
   They report results to the Foreman, who updates the store.
5. **Human-readable backup.** Periodic export to JSONL for disaster recovery and
   portability. The Foreman manages this automatically.

---

## Appendix F: Operational Spec

### Boot Sequence

```
1. Check canonical state store schema versions
2. Run pending migrations (if any)
3. Validate openclaw.json (Foreman repairs from backup if corrupted)
4. Start gateway WebSocket server
5. Start Discord channel
6. Foreman main session initializes
7. Foreman checks health of all registered agents
8. Foreman reports status to Discord: "Online. N agents ready."
```

### Recovery Modes

| Mode | Trigger | Behavior |
|------|---------|----------|
| **Normal** | Clean boot, all checks pass | Full operation |
| **Degraded** | Agent(s) unhealthy, but gateway + Foreman ok | Foreman reports degraded agents, attempts self-heal |
| **Safe mode** | Config corrupted or state store migration failed | Gateway starts, Foreman starts read-only, reports to Discord, waits for human |
| **Offline** | Gateway fails to start | CLI-only diagnostics via `openclaw doctor` |

### Safe Mode Contract

In safe mode, the Foreman operates **read-only** with one exception:

The Foreman CAN:
- Read state and report status
- Deliver error messages to Discord

The Foreman CANNOT:
- Spawn workers or process tasks
- Write to the canonical state store
- Modify agent configurations

**Repair escalation (one-shot):** The Foreman may attempt a single config repair
from backup. This is not a normal safe-mode operation — it is a guarded transition:
1. Foreman detects corruption and enters safe mode
2. Foreman reports the issue to Discord
3. Foreman attempts one repair from the most recent `.bak` file
4. If repair succeeds and all health checks pass -> exit safe mode, resume normal operation
5. If repair fails -> remain in safe mode, wait for human intervention via CLI

The repair attempt is logged in the audit trail regardless of outcome.

### Backup Strategy

- **Config:** Atomic writes produce a `.bak` before each write. Keep last 5 backups.
- **State store:** Daily JSONL export. Keep last 7 days.
- **Audit log:** Append-only, never pruned. Archive monthly to compressed JSONL.
- **Credentials:** Backed up alongside config (encrypted at rest if platform supports).

---

*Document version: 2.2*
*Created: 2026-03-02*
*Last updated: 2026-03-02*

*Revision history:*
- *v1.0 — Initial vision, architecture, build phases, principles.*
- *v2.0 — Incorporated multi-model research findings: definitions, security architecture,
  instrumentation, escalation contracts, mapping to OpenClaw primitives.*
- *v2.1 — Corrected mesh to hub-and-spoke, added canonical state store, formal Task Ledger
  schema, deterministic guardrail policy, operational spec, softened repo-dependent claims,
  sessions_send ping-pong cost awareness.*
- *v2.2 — Surgical correctness patch: announce chain as default result collection (not
  sessions_send), hierarchical tree topology option (maxSpawnDepth >= 2), config.patch/
  config.apply RPCs as preferred config management, Discord delivery strategy (thread-per-task
  + chunking + attachment fallback), Safe Mode repair escalation contract.*
