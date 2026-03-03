# Hillclaw Integration Test Guide

## Prerequisites

- Discord bot token with access to a test guild
- A dedicated test channel in the guild
- Node.js 22+, pnpm installed

## Environment Variables

| Variable | Required | Description |
|----------|----------|-------------|
| `DISCORD_BOT_TOKEN` | Yes | Bot token for the test Discord account |
| `HILLCLAW_TEST_GUILD_ID` | Yes | Guild (server) ID for integration tests |
| `HILLCLAW_TEST_CHANNEL_ID` | Yes | Channel ID for test message delivery |

## Running

```bash
# Set environment variables
export DISCORD_BOT_TOKEN="your-bot-token"
export HILLCLAW_TEST_GUILD_ID="your-guild-id"
export HILLCLAW_TEST_CHANNEL_ID="your-channel-id"

# Run integration tests
pnpm test:hillclaw-integration
```

## What the tests verify

1. **Message round-trip** — Send via Discord, receive response within 10s
2. **Error surfacing** — HillclawError appears as embed in test channel
3. **Discord limits** — Oversized errors truncate + attach .txt file
4. **Graceful shutdown** — Gateway stops cleanly under load
5. **Boot guard** — Duplicate instance is rejected

## CI Integration

These tests should run in a secrets-gated GitHub Actions environment:

```yaml
jobs:
  integration-tests:
    runs-on: ubuntu-latest
    environment: discord-integration  # Requires approval
    steps:
      - uses: actions/checkout@v4
      - uses: pnpm/action-setup@v4
      - uses: actions/setup-node@v4
        with:
          node-version: 22
          cache: pnpm
      - run: pnpm install
      - run: pnpm test:hillclaw-integration
        env:
          DISCORD_BOT_TOKEN: ${{ secrets.DISCORD_BOT_TOKEN }}
          HILLCLAW_TEST_GUILD_ID: ${{ secrets.HILLCLAW_TEST_GUILD_ID }}
          HILLCLAW_TEST_CHANNEL_ID: ${{ secrets.HILLCLAW_TEST_CHANNEL_ID }}
```

## Notes

- Tests skip automatically if `DISCORD_BOT_TOKEN` is not set
- Never commit bot tokens or channel IDs to the repository
- The boot guard test runs with `allowInTests: true` to enable lock acquisition in Vitest
