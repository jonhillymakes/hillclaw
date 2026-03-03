# Hillclaw Credential Isolation Audit — Phase 0

**Date:** 2026-03-02
**Scope:** Full codebase credential inventory
**Base fork:** OpenClaw (TypeScript ESM monorepo, Node 22+, pnpm, Vitest)

---

## Summary

- Total credentials found: 43
- High-risk (would cause damage if leaked to worker): 12
- Medium-risk (limited scope but sensitive): 22
- Low-risk (public or read-only): 9

**Credential storage systems identified:**

1. `auth-profiles.json` — primary runtime credential store (`~/.pi/agent/auth-profiles.json` for main agent, `<agentDir>/auth-profiles.json` per sub-agent)
2. `openclaw.json` — static config file; some fields accept inline credential strings or `SecretRef` pointers
3. Environment variables — fallback resolution for most providers
4. External CLI credential files — synced from Claude CLI, Codex CLI, Qwen CLI, MiniMax CLI
5. `credentials/github-copilot.token.json` — Copilot short-lived token cache in state dir

---

## Credential Catalog

### 1. Anthropic API Key

- **Type:** API key
- **Config path:** `auth.profiles.<id>.key` (mode: `api_key`, provider: `anthropic`) in `auth-profiles.json`; or `models.providers.anthropic.apiKey` in `openclaw.json`
- **Env var:** `ANTHROPIC_API_KEY`
- **Consumers:** `src/config/defaults.ts`, `src/agents/model-auth.ts`, `src/agents/auth-profiles/oauth.ts`
- **Current scope:** Global — shared across all agents unless per-agent `agentDir` store overrides
- **Risk level:** HIGH — full API billing access; rate limits and charges apply per key
- **Phase 1 recommendation:** Should be per-agent. Each agent gets its own auth profile so billing is isolated per agent identity.

---

### 2. Anthropic OAuth Token (Claude Pro / Max)

- **Type:** OAuth access+refresh token (auto-refreshed)
- **Config path:** `auth.profiles.<id>` (mode: `oauth`, provider: `anthropic`) in `auth-profiles.json`
- **Env var:** `ANTHROPIC_OAUTH_TOKEN` (legacy fallback detection only)
- **Consumers:** `src/config/defaults.ts`, `src/agents/auth-profiles/oauth.ts`, `src/agents/cli-credentials.ts`
- **Storage:** `auth-profiles.json`; also synced from `~/.claude/.credentials.json` (Claude CLI) and system keychain (`CLAUDE_CLI_KEYCHAIN_SERVICE = "Claude Code-credentials"`)
- **Current scope:** Global (main agent); sub-agents inherit via store merge
- **Risk level:** HIGH — provides LLM access tied to a user account; refresh token allows unlimited re-auth
- **Phase 1 recommendation:** Cannot be split by design (single user account). Isolate via channel abstraction; do not expose to sandboxed workers.

---

### 3. OpenAI API Key

- **Type:** API key
- **Config path:** `auth.profiles.<id>.key` (provider: `openai`) or `models.providers.openai.apiKey`
- **Env var:** `OPENAI_API_KEY`
- **Consumers:** `src/agents/model-auth.ts`, `src/tts/tts.ts`, `src/secrets/provider-env-vars.ts`
- **Current scope:** Global
- **Risk level:** HIGH — billing access; GPT-4 charges apply per token
- **Phase 1 recommendation:** Per-agent allocation desirable for cost isolation.

---

### 4. GitHub Copilot OAuth Token / PAT

- **Type:** OAuth token (device-flow) → exchanged for short-lived Copilot API bearer token
- **Config path:** `auth.profiles.<id>` (provider: `github-copilot`, mode: `token`) in `auth-profiles.json`
- **Env var:** `COPILOT_GITHUB_TOKEN` (used in test harness; also synced from `~/.config/github-copilot/hosts.json` and `~/.codex/auth.json` via Codex CLI sync)
- **Storage:** `credentials/github-copilot.token.json` (cached short-lived token, expires ~30 min)
- **Consumers:** `src/providers/github-copilot-auth.ts`, `src/providers/github-copilot-token.ts`
- **Current scope:** Global
- **Risk level:** HIGH — access to GitHub Copilot API; tied to the authenticated GitHub account
- **Phase 1 recommendation:** Cannot be per-agent (tied to single GitHub identity). Manage via channel abstraction.

---

### 5. Google Gemini API Key / OAuth Token

- **Type:** API key OR OAuth access token (google-gemini-cli provider uses JWT with projectId)
- **Config path:** `auth.profiles.<id>` (provider: `google` or `google-gemini-cli`); `models.providers.google.apiKey`
- **Env var:** `GEMINI_API_KEY`; also read as web search fallback in `src/agents/tools/web-search.ts`
- **Consumers:** `src/agents/model-auth.ts`, `src/agents/tools/web-search.ts`, `src/memory/embeddings-gemini.ts`, `src/infra/gemini-auth.ts`
- **Current scope:** Global
- **Risk level:** HIGH — billing access; Gemini API charges per token
- **Phase 1 recommendation:** Per-agent allocation for cost isolation; web-search tool use should be bounded per agent.

---

### 6. AWS Bedrock Credentials

- **Type:** Access key+secret, bearer token, or named profile (three accepted auth modes)
- **Config path:** `auth` mode `aws-sdk` in `models.providers.<name>.auth`
- **Env vars:** `AWS_ACCESS_KEY_ID` + `AWS_SECRET_ACCESS_KEY`, `AWS_BEARER_TOKEN_BEDROCK`, or `AWS_PROFILE`
- **Consumers:** `src/agents/model-auth.ts` (`resolveAwsSdkEnvVarName`, `resolveAwsSdkAuthInfo`)
- **Current scope:** Global (process env); no per-agent override mechanism
- **Risk level:** HIGH — AWS IAM credentials; potential for data access beyond Bedrock if scope is too broad
- **Phase 1 recommendation:** Restrict to named profile with Bedrock-only IAM policy. Per-agent isolation is not currently supported without per-agent env injection.

---

### 7. Discord Bot Token

- **Type:** Bot authentication token
- **Config path:** `channels.discord.accounts.<name>.token` or `channels.discord.token` in `openclaw.json`
- **Env var:** `DISCORD_BOT_TOKEN`
- **Consumers:** `src/discord/token.ts`, `src/channels/plugins/onboarding/discord.ts`, `extensions/discord/src/channel.ts`
- **Current scope:** Global — single bot identity shared by all agents
- **Risk level:** HIGH — full bot access; can read and send messages in all guilds the bot is a member of; guild admin actions if bot has elevated permissions
- **Phase 1 recommendation:** Cannot be per-agent (single bot identity). Isolate via channel abstraction layer; enforce per-agent message routing at the application level.

---

### 8. Telegram Bot Token

- **Type:** Bot authentication token (HTTP Bot API)
- **Config path:** `channels.telegram.accounts.<name>.botToken` or `channels.telegram.botToken`; also `channels.telegram.accounts.<name>.tokenFile` for file-based storage
- **Env var:** `TELEGRAM_BOT_TOKEN`
- **Consumers:** `src/telegram/token.ts`, `extensions/telegram/src/channel.ts`, `src/channels/plugins/onboarding/telegram.ts`
- **Current scope:** Global per account; multi-account supported
- **Risk level:** HIGH — full bot control; can send to any chat the bot is a member of
- **Phase 1 recommendation:** Multi-account design already present. Can assign different bot accounts per agent in Phase 1.

---

### 9. Slack Bot Token + App Token + User Token

- **Type:** Bearer tokens (xoxb-, xapp-, xoxp- prefixed)
- **Config path:** `channels.slack.accounts.<name>.botToken`, `appToken`, `userToken`; also `channels.slack.signingSecret` (webhook mode)
- **Env vars:** `SLACK_BOT_TOKEN`, `SLACK_APP_TOKEN`, `SLACK_USER_TOKEN`
- **Consumers:** `src/slack/accounts.ts`, `extensions/slack/src/channel.ts`, `src/channels/plugins/onboarding/slack.ts`
- **Current scope:** Global per account; multi-account supported
- **Risk level:** HIGH — bot token grants write access to all channels the bot is in; user token grants full user-level access
- **Phase 1 recommendation:** Multi-account design present. Separate bot accounts per agent family desirable.

---

### 10. Slack Signing Secret

- **Type:** Webhook validation secret (HMAC-SHA256)
- **Config path:** `channels.slack.signingSecret` (required when `mode = "http"`); `channels.slack.accounts.<name>.signingSecret`
- **Env var:** None observed; config-only
- **Consumers:** `src/config/zod-schema.providers-core.ts` (validation), Slack HTTP monitor
- **Current scope:** Global per account
- **Risk level:** MEDIUM — enables webhook signature forgery if leaked; attacker can inject messages as Slack
- **Phase 1 recommendation:** Should stay global (tied to the Slack app registration); rotate if compromised.

---

### 11. Gateway Auth Token

- **Type:** Static bearer token for the OpenClaw HTTP gateway
- **Config path:** `gateway.auth.token` in `openclaw.json`
- **Env var:** `OPENCLAW_GATEWAY_TOKEN` (also legacy `CLAWDBOT_GATEWAY_TOKEN`)
- **Consumers:** `src/commands/configure.wizard.ts`, `src/commands/dashboard.ts`, `src/browser/extension-relay-auth.ts`, `src/cli/daemon-cli/install.ts`, `src/tui/gateway-chat.ts`, `src/node-host/runner.ts`
- **Current scope:** Global — single token for the entire gateway
- **Risk level:** HIGH — grants full control over the gateway (session management, config, model calls)
- **Phase 1 recommendation:** Must remain global (guards the gateway). Workers should not receive this token. Phase 1: ensure sandboxed workers cannot read `OPENCLAW_GATEWAY_TOKEN` from their process environment.

---

### 12. Gateway Auth Password

- **Type:** Shared password (password auth mode)
- **Config path:** `gateway.auth.password` in `openclaw.json`
- **Env var:** `OPENCLAW_GATEWAY_PASSWORD`
- **Consumers:** `src/commands/configure.wizard.ts`, `src/commands/gateway-status/helpers.ts`, `src/tui/gateway-chat.ts`, `src/node-host/runner.ts`
- **Current scope:** Global
- **Risk level:** HIGH — same risk as gateway token
- **Phase 1 recommendation:** Same as gateway token. Strip from sandboxed worker environments.

---

### 13. ElevenLabs API Key

- **Type:** API key
- **Config path:** `tts.elevenlabs.apiKey` in `openclaw.json` (marked `sensitive`)
- **Env vars:** `ELEVENLABS_API_KEY`, `XI_API_KEY` (legacy alias)
- **Consumers:** `src/tts/tts.ts`
- **Current scope:** Global
- **Risk level:** MEDIUM — TTS billing; character quota per account
- **Phase 1 recommendation:** Per-agent allocation if TTS is per-agent; otherwise shared is acceptable with usage monitoring.

---

### 14. ElevenLabs / OpenAI TTS via OpenAI API Key

- **Type:** API key (shared with general OpenAI key)
- **Config path:** `tts.openai.apiKey` (marked `sensitive`)
- **Env var:** `OPENAI_API_KEY`
- **Consumers:** `src/tts/tts.ts`
- **Current scope:** Global (same pool as LLM key)
- **Risk level:** MEDIUM — charged against OpenAI billing
- **Phase 1 recommendation:** Separate TTS-only key possible via config override.

---

### 15. Brave Search API Key

- **Type:** API key
- **Config path:** Agent tool config (web search settings)
- **Env var:** `BRAVE_API_KEY`
- **Consumers:** `src/agents/tools/web-search.ts`, `src/wizard/onboarding.finalize.ts`
- **Current scope:** Global
- **Risk level:** MEDIUM — paid search queries; rate limit and billing impact
- **Phase 1 recommendation:** Per-agent rate limiting preferable; shared key acceptable with monitoring.

---

### 16. Firecrawl API Key

- **Type:** API key
- **Config path:** Web fetch tool settings
- **Env var:** `FIRECRAWL_API_KEY`
- **Consumers:** `src/agents/tools/web-fetch.ts`
- **Current scope:** Global
- **Risk level:** MEDIUM — paid web scraping credits
- **Phase 1 recommendation:** Shared acceptable; monitor per-agent usage.

---

### 17. Perplexity API Key

- **Type:** API key
- **Config path:** Web search tool settings
- **Env var:** `PERPLEXITY_API_KEY`
- **Consumers:** `src/agents/tools/web-search.ts`
- **Current scope:** Global
- **Risk level:** MEDIUM — billing per query
- **Phase 1 recommendation:** Same as Brave.

---

### 18. OpenRouter API Key

- **Type:** API key
- **Config path:** `models.providers.openrouter.apiKey`; also read from env for web-search fallback
- **Env var:** `OPENROUTER_API_KEY`
- **Consumers:** `src/agents/tools/web-search.ts`, `src/agents/model-auth.ts`, `src/secrets/provider-env-vars.ts`
- **Current scope:** Global
- **Risk level:** MEDIUM — billing; multi-model passthrough key
- **Phase 1 recommendation:** Per-agent desirable since OpenRouter charges per call.

---

### 19. xAI API Key

- **Type:** API key
- **Config path:** `models.providers.xai.apiKey`
- **Env var:** `XAI_API_KEY`
- **Consumers:** `src/agents/tools/web-search.ts`, `src/agents/model-auth.ts`
- **Current scope:** Global
- **Risk level:** MEDIUM — billing
- **Phase 1 recommendation:** Per-agent allocation.

---

### 20. Moonshot / Kimi API Key

- **Type:** API key
- **Config path:** `models.providers.moonshot.apiKey` or `kimi-coding`
- **Env vars:** `MOONSHOT_API_KEY`, `KIMI_API_KEY`, `KIMICODE_API_KEY`
- **Consumers:** `src/agents/tools/web-search.ts`, `src/agents/model-auth.ts`
- **Current scope:** Global
- **Risk level:** MEDIUM — billing
- **Phase 1 recommendation:** Per-agent allocation.

---

### 21. Deepgram API Key

- **Type:** API key (audio transcription)
- **Config path:** `models.providers.deepgram.apiKey`
- **Env var:** `DEEPGRAM_API_KEY`
- **Consumers:** `src/agents/model-auth.ts`, `src/media-understanding/providers/deepgram/audio.ts`
- **Current scope:** Global
- **Risk level:** MEDIUM — billing per audio minute
- **Phase 1 recommendation:** Shared acceptable; per-agent if high audio volume expected.

---

### 22. Voyage AI API Key (Embeddings)

- **Type:** API key
- **Config path:** `models.providers.voyage.apiKey`
- **Env var:** `VOYAGE_API_KEY`
- **Consumers:** `src/agents/model-auth.ts`, `src/memory/embeddings-voyage.ts`
- **Current scope:** Global
- **Risk level:** MEDIUM — billing per embedding call
- **Phase 1 recommendation:** Shared acceptable for memory/embeddings infrastructure.

---

### 23. Mistral API Key

- **Type:** API key
- **Config path:** `models.providers.mistral.apiKey`; also onboarding flag `--mistral-api-key`
- **Env var:** `MISTRAL_API_KEY`
- **Consumers:** `src/agents/model-auth.ts`, `src/memory/embeddings-mistral.ts`, `src/secrets/provider-env-vars.ts`
- **Current scope:** Global
- **Risk level:** MEDIUM — billing
- **Phase 1 recommendation:** Per-agent allocation.

---

### 24. HuggingFace Token

- **Type:** Hub token (PAT)
- **Config path:** `models.providers.huggingface.apiKey`; onboarding flow
- **Env vars:** `HUGGINGFACE_HUB_TOKEN`, `HF_TOKEN`
- **Consumers:** `src/agents/model-auth.ts`, `src/agents/huggingface-models.ts`
- **Current scope:** Global
- **Risk level:** MEDIUM — private model access; can push to HuggingFace repos if write-scoped
- **Phase 1 recommendation:** Read-only token preferred; per-agent if writing is needed.

---

### 25. MiniMax API Key / OAuth Token

- **Type:** API key or OAuth token (portal flow)
- **Config path:** `models.providers.minimax.apiKey`
- **Env vars:** `MINIMAX_API_KEY`, `MINIMAX_CODE_PLAN_KEY`, `MINIMAX_OAUTH_TOKEN`
- **Consumers:** `src/infra/provider-usage.auth.ts`, `src/agents/model-auth.ts`, `src/agents/cli-credentials.ts` (CLI sync from `~/.minimax/oauth_creds.json`)
- **Current scope:** Global
- **Risk level:** MEDIUM — billing; portal OAuth synced from local CLI
- **Phase 1 recommendation:** Per-agent allocation.

---

### 26. Qwen Portal OAuth Token

- **Type:** OAuth access+refresh token
- **Config path:** `auth.profiles.<id>` (provider: `qwen-portal`) in `auth-profiles.json`
- **Storage:** Synced from `~/.qwen/oauth_creds.json` (Qwen Code CLI)
- **Consumers:** `src/agents/chutes-oauth.ts`, `src/agents/auth-profiles/oauth.ts`, `src/providers/qwen-portal-oauth.ts`, `src/agents/cli-credentials.ts`
- **Current scope:** Global (synced from CLI)
- **Risk level:** MEDIUM — LLM billing under Qwen account
- **Phase 1 recommendation:** Per-agent desirable; requires OAuth token per identity.

---

### 27. Chutes OAuth Tokens (Client ID + Client Secret)

- **Type:** OAuth client credentials + access/refresh tokens
- **Config path:** `auth.profiles.<id>` (provider: `chutes`) in `auth-profiles.json`; `clientId` stored with credential
- **Env vars:** `CHUTES_CLIENT_ID`, `CHUTES_CLIENT_SECRET`, `CHUTES_OAUTH_REDIRECT_URI`, `CHUTES_OAUTH_SCOPES`
- **Consumers:** `src/agents/chutes-oauth.ts`, `src/commands/auth-choice.apply.oauth.ts`
- **Current scope:** Global
- **Risk level:** MEDIUM — LLM/API billing under Chutes account
- **Phase 1 recommendation:** Client secret should remain server-side only. Per-agent token scoping may be possible.

---

### 28. ZAI / Z-AI API Key

- **Type:** API key
- **Config path:** `models.providers.zai.apiKey`
- **Env vars:** `ZAI_API_KEY`, `Z_AI_API_KEY` (aliased at startup)
- **Storage:** Also read from `~/.pi/agent/auth.json` as fallback
- **Consumers:** `src/infra/provider-usage.auth.ts`, `src/infra/env.ts`
- **Current scope:** Global
- **Risk level:** MEDIUM — billing
- **Phase 1 recommendation:** Per-agent allocation.

---

### 29. Groq API Key

- **Type:** API key
- **Config path:** `models.providers.groq.apiKey`
- **Env var:** `GROQ_API_KEY`
- **Consumers:** `src/agents/model-auth.ts`
- **Current scope:** Global
- **Risk level:** MEDIUM — billing
- **Phase 1 recommendation:** Per-agent allocation.

---

### 30. Volcengine / BytePlus API Keys

- **Type:** API key
- **Config paths:** `models.providers.volcengine.apiKey`, `models.providers.byteplus.apiKey`
- **Env vars:** `VOLCANO_ENGINE_API_KEY`, `BYTEPLUS_API_KEY`
- **Consumers:** `src/agents/model-auth.ts`, `src/secrets/provider-env-vars.ts`
- **Current scope:** Global
- **Risk level:** MEDIUM — billing
- **Phase 1 recommendation:** Per-agent allocation.

---

### 31. Miscellaneous Provider API Keys

These providers follow the same pattern (config `apiKey` field + env var fallback, all global scope, medium risk):

| Provider | Env Var(s) | Config Path | Risk |
|----------|-----------|-------------|------|
| NVIDIA | `NVIDIA_API_KEY` | `models.providers.nvidia.apiKey` | MEDIUM |
| Together AI | `TOGETHER_API_KEY` | `models.providers.together.apiKey` | MEDIUM |
| Cerebras | `CEREBRAS_API_KEY` | `models.providers.cerebras.apiKey` | MEDIUM |
| Venice AI | `VENICE_API_KEY` | `models.providers.venice.apiKey` | MEDIUM |
| LiteLLM | `LITELLM_API_KEY` | `models.providers.litellm.apiKey` | MEDIUM |
| vLLM | `VLLM_API_KEY` | `models.providers.vllm.apiKey` | LOW (self-hosted) |
| Ollama | `OLLAMA_API_KEY` | `models.providers.ollama.apiKey` | LOW (local) |
| Kilocode | `KILOCODE_API_KEY` | `models.providers.kilocode.apiKey` | MEDIUM |
| Qianfan | `QIANFAN_API_KEY` | `models.providers.qianfan.apiKey` | MEDIUM |
| Synthetic | `SYNTHETIC_API_KEY` | `models.providers.synthetic.apiKey` | LOW (testing) |
| OpenCode | `OPENAI_API_KEY`, `OPENCODE_API_KEY`, `OPENCODE_ZEN_API_KEY` | — | MEDIUM |
| Vercel AI Gateway | `AI_GATEWAY_API_KEY` | `models.providers.vercel-ai-gateway.apiKey` | MEDIUM |
| Cloudflare AI Gateway | `CLOUDFLARE_AI_GATEWAY_API_KEY` | `models.providers.cloudflare-ai-gateway.apiKey` | MEDIUM |
| Xiaomi | `XIAOMI_API_KEY` | `models.providers.xiaomi.apiKey` | MEDIUM |

---

### 32. MS Teams Bot Credentials

- **Type:** Azure Bot App ID + App Password (client secret)
- **Config path:** `channels.msteams.appId`, `channels.msteams.appPassword` (marked `sensitive`), `channels.msteams.tenantId`
- **Env var:** None observed; config-only
- **Consumers:** `src/config/types.msteams.ts`, `src/config/zod-schema.providers-core.ts`
- **Current scope:** Global (single bot registration)
- **Risk level:** HIGH — App Password grants bot impersonation in all registered Teams tenants
- **Phase 1 recommendation:** Cannot be per-agent (single Azure Bot registration). Isolate via channel abstraction.

---

### 33. IRC Server Password + NickServ Password

- **Type:** Plaintext passwords
- **Config paths:** `channels.irc.accounts.<name>.password` (marked `sensitive`), `channels.irc.accounts.<name>.passwordFile`, `channels.irc.accounts.<name>.nickserv.password` (marked `sensitive`), `channels.irc.accounts.<name>.nickserv.passwordFile`
- **Env var:** None observed
- **Consumers:** `src/config/types.irc.ts`, `src/config/zod-schema.providers-core.ts`
- **Current scope:** Per-account (IRC supports multi-account already)
- **Risk level:** MEDIUM — IRC account impersonation if leaked
- **Phase 1 recommendation:** Already per-account. Prefer `passwordFile` over inline plaintext.

---

### 34. Telegram Webhook Secret

- **Type:** HMAC validation secret (for inbound webhook mode)
- **Config path:** `channels.telegram.webhookSecret`; `channels.telegram.accounts.<name>.webhookSecret`
- **Env var:** None observed; config-only
- **Consumers:** `src/config/zod-schema.providers-core.ts`, Telegram webhook handler
- **Current scope:** Per-account
- **Risk level:** MEDIUM — enables webhook forgery if leaked; attacker can inject messages
- **Phase 1 recommendation:** Already per-account. Store in secrets provider rather than inline config.

---

### 35. Slack Signing Secret (per-account)

- See entry 10. Multi-account instances each have their own `signingSecret` under `accounts.<name>`.
- **Risk level:** MEDIUM per account
- **Phase 1 recommendation:** Per-account already supported; ensure secrets provider is used.

---

### 36. Cron Webhook Bearer Token

- **Type:** Static bearer token attached to outbound cron webhook POST requests
- **Config path:** `cron.webhookToken` (marked `sensitive`)
- **Env var:** None observed; config-only
- **Consumers:** `src/config/types.cron.ts`, cron delivery subsystem
- **Current scope:** Global (single cron subsystem)
- **Risk level:** MEDIUM — enables spoofing of cron-triggered webhooks if leaked
- **Phase 1 recommendation:** Per-agent cron targets could have separate tokens. Rotate regularly.

---

### 37. LINE Channel Access Token + Channel Secret

- **Type:** Access token (message delivery) + secret (webhook validation)
- **Config path:** `channels.line.accounts.<name>.channelAccessToken`, `channels.line.accounts.<name>.channelSecret`
- **Env vars:** `LINE_CHANNEL_ACCESS_TOKEN`, `LINE_CHANNEL_SECRET`
- **Consumers:** `src/line/accounts.ts`, `extensions/line/src/channel.ts`
- **Current scope:** Global per channel (env vars apply to default account only)
- **Risk level:** MEDIUM — sends messages and validates inbound webhooks for LINE
- **Phase 1 recommendation:** Multi-account already supported; per-agent assignment feasible.

---

### 38. Mattermost Bot Token

- **Type:** Bot personal access token
- **Config path:** `channels.mattermost.accounts.<name>.botToken`
- **Env var:** `MATTERMOST_BOT_TOKEN` (default account only)
- **Consumers:** `extensions/mattermost/src/mattermost/accounts.ts`, `extensions/mattermost/src/mattermost/monitor.ts`
- **Current scope:** Per-account (multi-account supported)
- **Risk level:** MEDIUM — full bot write access to all Mattermost channels the token belongs to
- **Phase 1 recommendation:** Already per-account. Assign separate bot accounts per agent if isolation is required.

---

### 39. Zalo Bot Token + Webhook Secret

- **Type:** Bot token (message delivery) + webhook validation secret
- **Config path:** `channels.zalo.accounts.<name>.botToken`, `channels.zalo.accounts.<name>.tokenFile`, `channels.zalo.accounts.<name>.webhookSecret`
- **Env var:** `ZALO_BOT_TOKEN` (default account only)
- **Consumers:** `extensions/zalo/src/token.ts`, `extensions/zalo/src/channel.ts`, `extensions/zalo/src/config-schema.ts`
- **Current scope:** Per-account
- **Risk level:** MEDIUM — message delivery access
- **Phase 1 recommendation:** Per-account already supported.

---

### 40. Claude Web Session Key (Provider Usage Tracking)

- **Type:** Session cookie / bearer token for claude.ai web session
- **Config path:** None (env only)
- **Env vars:** `CLAUDE_AI_SESSION_KEY`, `CLAUDE_WEB_SESSION_KEY` (alias)
- **Consumers:** `src/infra/provider-usage.fetch.claude.ts`
- **Current scope:** Global
- **Risk level:** HIGH — full web account access if leaked; used only for usage analytics, not model calls
- **Phase 1 recommendation:** Should not exist in a worker environment. Strip from sandboxed worker environments.

---

### 41. WhatsApp Auth State (Baileys multi-device)

- **Type:** Multi-file session state (keys, session, auth info — not a single token)
- **Config path:** `channels.whatsapp.accounts.<name>.authDir` (path to auth state directory)
- **Env var:** None; path-based
- **Consumers:** WhatsApp channel provider (Baileys library), `src/config/zod-schema.providers-whatsapp.ts`
- **Current scope:** Per-account; each account has its own `authDir`
- **Risk level:** HIGH — Baileys auth state is equivalent to WhatsApp login; stealing the auth directory is equivalent to account hijack
- **Phase 1 recommendation:** Auth directory must never be readable by sandboxed workers. Filesystem isolation is mandatory.

---

### 42. GitHub Copilot OAuth Client ID (Hardcoded)

- **Type:** Public OAuth client ID (not secret, but notable)
- **Location:** `src/providers/github-copilot-auth.ts:9` — `const CLIENT_ID = "Iv1.b507a08c87ecfe98"`
- **Env var:** None
- **Consumers:** GitHub device-flow OAuth initiation
- **Current scope:** Hardcoded; shared across all installs (this is standard for public OAuth clients)
- **Risk level:** LOW — client IDs are public by design in device-flow OAuth; the secret is the user's token, not the client ID
- **Phase 1 recommendation:** No action needed; this is the expected pattern.

---

### 43. Secrets Subsystem Provider Credentials (exec/file/env sources)

- **Type:** Any credential type, resolved at runtime from configurable backends
- **Config path:** `secrets.providers.<name>` — supports `env`, `file` (JSON or singleValue), `exec` (arbitrary command) sources
- **Env var:** Determined by `secrets.providers.default.allowlist` or resolved dynamically
- **Consumers:** `src/secrets/runtime.ts`, `src/secrets/resolve.ts`, `src/secrets/configure.ts`, `src/agents/auth-profiles/oauth.ts`
- **Current scope:** Global secrets providers; `SecretRef` pointers can appear in any `apiKey`, `botToken`, or credential field
- **Risk level:** HIGH — `exec` source can run arbitrary commands; file source can read any accessible path; allowlist enforcement is critical
- **Phase 1 recommendation:** Exec provider must be restricted to trusted paths. Workers must not have access to the host secrets provider config. Per-agent secret scoping requires separate `secrets.providers` config blocks.

---

## Scoping Recommendations for Phase 1

### Must remain global (shared by design)

- Discord bot token — single bot identity; routing must be application-level
- MS Teams App ID + App Password — single Azure Bot registration
- Anthropic OAuth token — tied to single user/org account
- GitHub Copilot OAuth token — tied to single GitHub account
- Gateway auth token + password — guards the gateway itself; workers must not receive these
- WhatsApp auth directory — per-account already; must be filesystem-isolated from workers

### Should be per-agent

- LLM provider API keys (Anthropic key, OpenAI, Google Gemini, OpenRouter, etc.) — each agent should have a budget and billing identity
- Chutes, Qwen Portal, MiniMax OAuth tokens — per-agent identity enables attribution and rate limiting
- Web search tool API keys (Brave, Perplexity, xAI) — per-agent rate limiting

### Already scoped (per-account / per-channel)

- Telegram bot token — multi-account supported in config
- Slack bot/app/user tokens — multi-account supported
- LINE channel access token — multi-account supported
- Mattermost bot token — multi-account supported
- Zalo bot token — multi-account supported
- IRC server/NickServ passwords — per-account in config
- Telegram webhook secret — per-account in config

### Recommend secrets provider rather than inline config

- Any field marked `sensitive` in the Zod schema should be migrated to `SecretRef` pattern (`${ENV_VAR}` template or explicit `{ source, provider, id }` object) rather than plaintext in `openclaw.json`

---

## Environment Variable Credentials

| Variable | Purpose | Risk |
|----------|---------|------|
| `ANTHROPIC_API_KEY` | Anthropic LLM API access | HIGH |
| `ANTHROPIC_OAUTH_TOKEN` | Legacy Anthropic OAuth detection | HIGH |
| `OPENAI_API_KEY` | OpenAI LLM + TTS access | HIGH |
| `GEMINI_API_KEY` | Google Gemini LLM + embeddings + web search | HIGH |
| `AWS_ACCESS_KEY_ID` | AWS Bedrock authentication | HIGH |
| `AWS_SECRET_ACCESS_KEY` | AWS Bedrock authentication | HIGH |
| `AWS_BEARER_TOKEN_BEDROCK` | AWS Bedrock bearer auth | HIGH |
| `AWS_PROFILE` | AWS named profile | HIGH |
| `DISCORD_BOT_TOKEN` | Discord bot auth | HIGH |
| `TELEGRAM_BOT_TOKEN` | Telegram bot auth | HIGH |
| `SLACK_BOT_TOKEN` | Slack bot auth | HIGH |
| `SLACK_APP_TOKEN` | Slack socket mode auth | HIGH |
| `SLACK_USER_TOKEN` | Slack user-level auth | HIGH |
| `OPENCLAW_GATEWAY_TOKEN` | Gateway API bearer token | HIGH |
| `CLAWDBOT_GATEWAY_TOKEN` | Legacy gateway token alias | HIGH |
| `OPENCLAW_GATEWAY_PASSWORD` | Gateway password auth | HIGH |
| `CLAUDE_AI_SESSION_KEY` | Claude.ai web session (usage tracking) | HIGH |
| `CLAUDE_WEB_SESSION_KEY` | Alias for above | HIGH |
| `COPILOT_GITHUB_TOKEN` | GitHub Copilot OAuth token | HIGH |
| `CHUTES_CLIENT_ID` | Chutes OAuth client ID | MEDIUM |
| `CHUTES_CLIENT_SECRET` | Chutes OAuth client secret | MEDIUM |
| `CHUTES_OAUTH_REDIRECT_URI` | Chutes OAuth flow config | LOW |
| `CHUTES_OAUTH_SCOPES` | Chutes OAuth flow config | LOW |
| `BRAVE_API_KEY` | Brave web search API | MEDIUM |
| `FIRECRAWL_API_KEY` | Firecrawl web fetch API | MEDIUM |
| `PERPLEXITY_API_KEY` | Perplexity web search API | MEDIUM |
| `OPENROUTER_API_KEY` | OpenRouter multi-model API | MEDIUM |
| `XAI_API_KEY` | xAI / Grok API | MEDIUM |
| `MOONSHOT_API_KEY` | Moonshot AI API | MEDIUM |
| `KIMI_API_KEY` | Kimi Coding API | MEDIUM |
| `KIMICODE_API_KEY` | Kimi Code alternative key | MEDIUM |
| `DEEPGRAM_API_KEY` | Deepgram audio transcription | MEDIUM |
| `VOYAGE_API_KEY` | Voyage AI embeddings | MEDIUM |
| `MISTRAL_API_KEY` | Mistral AI API | MEDIUM |
| `HUGGINGFACE_HUB_TOKEN` | HuggingFace model access | MEDIUM |
| `HF_TOKEN` | HuggingFace alias | MEDIUM |
| `MINIMAX_API_KEY` | MiniMax AI API | MEDIUM |
| `MINIMAX_CODE_PLAN_KEY` | MiniMax code plan key | MEDIUM |
| `MINIMAX_OAUTH_TOKEN` | MiniMax portal OAuth | MEDIUM |
| `ZAI_API_KEY` | ZAI / Z-AI API | MEDIUM |
| `Z_AI_API_KEY` | ZAI alias (normalized at startup) | MEDIUM |
| `GROQ_API_KEY` | Groq API | MEDIUM |
| `NVIDIA_API_KEY` | NVIDIA NIM API | MEDIUM |
| `TOGETHER_API_KEY` | Together AI API | MEDIUM |
| `CEREBRAS_API_KEY` | Cerebras API | MEDIUM |
| `VENICE_API_KEY` | Venice AI API | MEDIUM |
| `LITELLM_API_KEY` | LiteLLM proxy API | MEDIUM |
| `VLLM_API_KEY` | vLLM self-hosted API | LOW |
| `OLLAMA_API_KEY` | Ollama local API | LOW |
| `KILOCODE_API_KEY` | Kilocode API | MEDIUM |
| `QIANFAN_API_KEY` | Baidu Qianfan API | MEDIUM |
| `XIAOMI_API_KEY` | Xiaomi AI API | MEDIUM |
| `SYNTHETIC_API_KEY` | Synthetic test provider | LOW |
| `OPENCODE_API_KEY` | OpenCode API | MEDIUM |
| `OPENCODE_ZEN_API_KEY` | OpenCode Zen variant | MEDIUM |
| `AI_GATEWAY_API_KEY` | Vercel AI Gateway API | MEDIUM |
| `CLOUDFLARE_AI_GATEWAY_API_KEY` | Cloudflare AI Gateway API | MEDIUM |
| `BYTEPLUS_API_KEY` | BytePlus API | MEDIUM |
| `VOLCANO_ENGINE_API_KEY` | Volcengine API | MEDIUM |
| `ELEVENLABS_API_KEY` | ElevenLabs TTS API | MEDIUM |
| `XI_API_KEY` | ElevenLabs legacy alias | MEDIUM |
| `LINE_CHANNEL_ACCESS_TOKEN` | LINE messaging access | MEDIUM |
| `LINE_CHANNEL_SECRET` | LINE webhook validation | MEDIUM |
| `MATTERMOST_BOT_TOKEN` | Mattermost bot auth | MEDIUM |
| `ZALO_BOT_TOKEN` | Zalo messaging bot | MEDIUM |
| `OPENCLAW_AUTH_STORE_READONLY` | Control flag (not a credential — prevents store writes) | LOW |

---

## Credential File Locations

| File | Contents | Risk |
|------|----------|------|
| `~/.pi/agent/auth-profiles.json` | Main agent credential store (all provider tokens/keys) | HIGH |
| `<agentDir>/auth-profiles.json` | Per-sub-agent credential store | HIGH |
| `~/.claude/.credentials.json` | Claude CLI OAuth credentials (synced on startup) | HIGH |
| `~/.config/github-copilot/hosts.json` | Codex/Copilot CLI OAuth credentials | HIGH |
| `~/.codex/auth.json` | Codex CLI auth (synced) | HIGH |
| `~/.qwen/oauth_creds.json` | Qwen CLI OAuth credentials (synced) | MEDIUM |
| `~/.minimax/oauth_creds.json` | MiniMax CLI OAuth credentials (synced) | MEDIUM |
| `<stateDir>/credentials/github-copilot.token.json` | Cached short-lived Copilot API token | MEDIUM |

---

## Key Architectural Observations

1. **`auth-profiles.json` is the central credential store.** All provider credentials (api keys, OAuth tokens, bearer tokens) flow through this file. Sub-agents inherit from the main agent's store, with their own overlay. Phase 1 isolation must ensure workers cannot read the main store.

2. **`SecretRef` indirection exists but is not enforced.** The `sensitive` schema annotation marks fields for redaction in snapshots, but does not prevent inline plaintext. Fields marked `sensitive` in the Zod schema include: `botToken` (Discord, Telegram, Mattermost), `token` (gateway), `apiKey` (model providers, TTS), `password` (IRC, gateway, MS Teams), `signingSecret` (Slack), `appPassword` (MS Teams), `webhookToken` (cron). All of these should use `SecretRef` in production deployments.

3. **Process environment leakage is a primary risk.** Because many credentials fall back to `process.env`, any worker that inherits the host process environment receives all credentials. Phase 1 must implement environment scrubbing before spawning sandboxed workers.

4. **CLI credential sync happens at startup.** Claude CLI, Codex CLI, Qwen CLI, and MiniMax CLI credentials are automatically synced from disk into `auth-profiles.json`. A sandboxed worker with filesystem access to these CLI config directories can extract live credentials.

5. **WhatsApp auth directory is equivalent to a session credential.** The Baileys multi-file auth state is not a token — it is the full authentication state. Filesystem isolation of `authDir` is as critical as token isolation.
