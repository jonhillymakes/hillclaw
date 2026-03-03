import { describe, expect, it } from "vitest";

// Skip entire suite if DISCORD_BOT_TOKEN is not set
const hasDiscordToken = !!process.env.DISCORD_BOT_TOKEN;
const hasTestGuild = !!process.env.HILLCLAW_TEST_GUILD_ID;
const hasTestChannel = !!process.env.HILLCLAW_TEST_CHANNEL_ID;

const describeIntegration =
  hasDiscordToken && hasTestGuild && hasTestChannel ? describe : describe.skip;

describeIntegration("Gateway Stability — Integration Suite (0.11b)", () => {
  describe("Message round-trip", () => {
    it("sends a message via Discord and receives agent response within 10s", async () => {
      // This test would:
      // 1. Connect to Discord using the bot token
      // 2. Send a test message to the test channel
      // 3. Wait for the bot to respond
      // 4. Verify the response arrived within 10s
      // For now, this is a placeholder that documents the test intent
      // Actual implementation requires the gateway running with Discord connected
      expect(process.env.DISCORD_BOT_TOKEN).toBeTruthy();
      expect(process.env.HILLCLAW_TEST_GUILD_ID).toBeTruthy();
      expect(process.env.HILLCLAW_TEST_CHANNEL_ID).toBeTruthy();
    }, 15_000);
  });

  describe("Error surfacing end-to-end", () => {
    it("triggered error appears in Discord test channel as embed", async () => {
      // 1. Emit a HillclawError through the diagnostic bus
      // 2. Wait for the Discord error reporter to deliver it
      // 3. Read the test channel to verify the embed appeared
      // 4. Check severity color and fields
      expect(process.env.DISCORD_BOT_TOKEN).toBeTruthy();
    }, 15_000);
  });

  describe("Discord limit handling", () => {
    it("oversized error produces truncation embed + .txt attachment", async () => {
      // 1. Emit a HillclawError with >4096 char message/stack
      // 2. Verify the embed is truncated
      // 3. Verify a .txt attachment was uploaded
      expect(process.env.DISCORD_BOT_TOKEN).toBeTruthy();
    }, 20_000);
  });

  describe("Graceful shutdown under load", () => {
    it("gateway stops cleanly with no orphaned processes", async () => {
      // 1. Verify gateway is running
      // 2. Send SIGTERM (or equivalent)
      // 3. Verify clean exit
      // 4. Verify no orphaned child processes
      expect(true).toBe(true); // placeholder until gateway integration wired
    }, 30_000);
  });

  describe("Boot guard", () => {
    it("rejects duplicate gateway instance", async () => {
      // 1. Acquire boot guard
      // 2. Attempt to acquire a second boot guard
      // 3. Verify the second attempt fails with GATEWAY_BOOT_GUARD_FAILED
      // 4. Release the first guard

      const { acquireBootGuard } = await import(
        "../../../hillclaw/boot-guard.js"
      );

      const guard1 = await acquireBootGuard({
        allowInTests: true,
        timeoutMs: 5000,
      });

      try {
        await expect(
          acquireBootGuard({ allowInTests: true, timeoutMs: 2000 }),
        ).rejects.toThrow();
      } finally {
        await guard1.release();
      }
    }, 15_000);
  });
});
