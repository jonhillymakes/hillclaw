# Disabled Channels in Hillclaw

Hillclaw is a hardened, Discord-only fork of OpenClaw. All channel plugins
except Discord are disabled at the gateway level.

## Disabled Channels

| Channel ID    | OpenClaw Plugin     | Status in Hillclaw |
|---------------|---------------------|--------------------|
| slack         | extensions/slack    | Disabled           |
| telegram      | extensions/telegram | Disabled           |
| whatsapp      | extensions/whatsapp | Disabled           |
| signal        | extensions/signal   | Disabled           |
| imessage      | extensions/imessage | Disabled           |
| bluebubbles   | extensions/bluebubbles | Disabled        |
| msteams       | extensions/msteams  | Disabled           |
| irc           | extensions/irc      | Disabled           |
| googlechat    | extensions/googlechat | Disabled         |
| webchat       | extensions/webchat  | Disabled           |
| browser       | extensions/browser  | Disabled           |
| line          | extensions/line     | Disabled           |

## Why Are These Channels Disabled?

**Foundation hardening.** Hillclaw Phase 0 establishes a minimal, auditable
surface area. Each channel integration adds:

- Additional authentication flows and token management
- Platform-specific webhook/socket handling
- Third-party dependencies and their transitive supply chain
- More attack vectors for credential theft and message injection

Disabling all non-Discord channels reduces that surface to what can actually
be reviewed, tested, and hardened in this phase.

**Smaller attack surface.** A gateway that speaks only Discord is easier to
reason about from a security standpoint. Multi-channel support can be
re-introduced incrementally once each channel has been audited.

## How the Guard Works

Two layers enforce Discord-only operation:

1. `enforceDiscordOnly(config)` in `src/hillclaw/channel-guard.ts` — called
   at config-load time, it pins `plugins.allow` to `["discord"]` before the
   plugin system starts.

2. `validateDiscordOnly(registry)` in the same module — called after plugins
   finish loading, it throws if any non-Discord channel plugin has been
   registered, preventing a misconfigured boot from proceeding silently.

## Re-enabling a Channel in a Future Phase

When a channel has been audited and is ready for Hillclaw:

1. Add its ID to `HILLCLAW_ALLOWED_CHANNELS` in
   `src/hillclaw/channel-guard.ts`.
2. Update `enforceDiscordOnly` to include the new ID in the allowlist it
   writes.
3. Update `validateDiscordOnly` to not reject the new channel.
4. Add integration tests covering the channel's auth flow under Hillclaw
   constraints.
5. Update this document to move the channel from "Disabled" to "Enabled".

Do not re-enable channels by simply removing the guard — update the guard to
explicitly permit the new channel so the allow-list remains the authoritative
source of truth.
