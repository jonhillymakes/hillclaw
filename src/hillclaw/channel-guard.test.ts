import { describe, expect, it } from "vitest";
import type { OpenClawConfig } from "../config/config.js";
import type { PluginChannelRegistration } from "../plugins/registry.js";
import {
  HILLCLAW_ALLOWED_CHANNELS,
  enforceDiscordOnly,
  validateDiscordOnly,
} from "./channel-guard.js";

// Minimal stub for PluginChannelRegistration used by validateDiscordOnly.
function makeChannelReg(id: string): PluginChannelRegistration {
  return {
    pluginId: id,
    plugin: { id } as PluginChannelRegistration["plugin"],
    source: `extensions/${id}/index.js`,
  };
}

describe("HILLCLAW_ALLOWED_CHANNELS", () => {
  it("contains exactly one entry: discord", () => {
    expect(HILLCLAW_ALLOWED_CHANNELS).toEqual(["discord"]);
  });

  it("does not include any other channel", () => {
    const disallowed = [
      "slack",
      "telegram",
      "whatsapp",
      "signal",
      "imessage",
      "bluebubbles",
      "msteams",
      "irc",
      "googlechat",
      "webchat",
      "browser",
      "line",
    ];
    for (const ch of disallowed) {
      expect(HILLCLAW_ALLOWED_CHANNELS).not.toContain(ch);
    }
  });
});

describe("enforceDiscordOnly", () => {
  it("sets plugins.allow to ['discord'] when config has no allowlist", () => {
    const cfg: OpenClawConfig = {};
    const result = enforceDiscordOnly(cfg);
    expect(result.plugins?.allow).toEqual(["discord"]);
  });

  it("replaces a non-Discord allowlist with ['discord']", () => {
    const cfg: OpenClawConfig = {
      plugins: { allow: ["slack", "telegram"] },
    };
    const result = enforceDiscordOnly(cfg);
    expect(result.plugins?.allow).toEqual(["discord"]);
  });

  it("strips non-Discord entries even when discord is already present", () => {
    const cfg: OpenClawConfig = {
      plugins: { allow: ["discord", "slack"] },
    };
    const result = enforceDiscordOnly(cfg);
    expect(result.plugins?.allow).toEqual(["discord"]);
  });

  it("leaves a discord-only allowlist unchanged", () => {
    const cfg: OpenClawConfig = {
      plugins: { allow: ["discord"] },
    };
    const result = enforceDiscordOnly(cfg);
    expect(result.plugins?.allow).toEqual(["discord"]);
  });

  it("preserves other config fields", () => {
    const cfg: OpenClawConfig = {
      plugins: { allow: ["slack"], deny: ["signal"] },
    };
    const result = enforceDiscordOnly(cfg);
    expect(result.plugins?.deny).toEqual(["signal"]);
    expect(result.plugins?.allow).toEqual(["discord"]);
  });

  it("does not mutate the original config", () => {
    const cfg: OpenClawConfig = { plugins: { allow: ["slack"] } };
    enforceDiscordOnly(cfg);
    expect(cfg.plugins?.allow).toEqual(["slack"]);
  });
});

describe("validateDiscordOnly", () => {
  it("passes when no channels are registered", () => {
    expect(() => validateDiscordOnly({ channels: [] })).not.toThrow();
  });

  it("passes when only discord is registered", () => {
    expect(() =>
      validateDiscordOnly({ channels: [makeChannelReg("discord")] }),
    ).not.toThrow();
  });

  it("throws when a non-Discord channel is registered", () => {
    expect(() =>
      validateDiscordOnly({ channels: [makeChannelReg("slack")] }),
    ).toThrow(/Non-Discord channel plugins detected.*slack/);
  });

  it("throws listing all non-Discord channels", () => {
    expect(() =>
      validateDiscordOnly({
        channels: [makeChannelReg("slack"), makeChannelReg("telegram")],
      }),
    ).toThrow(/slack.*telegram|telegram.*slack/);
  });

  it("throws when non-Discord channel is present alongside discord", () => {
    expect(() =>
      validateDiscordOnly({
        channels: [makeChannelReg("discord"), makeChannelReg("whatsapp")],
      }),
    ).toThrow(/whatsapp/);
  });

  it("error message mentions 'hillclaw'", () => {
    expect(() =>
      validateDiscordOnly({ channels: [makeChannelReg("slack")] }),
    ).toThrow(/hillclaw/i);
  });
});
