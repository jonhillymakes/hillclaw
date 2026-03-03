import type { OpenClawConfig } from "../config/config.js";
import type { PluginRegistry } from "../plugins/registry.js";

/** The only channel permitted in Hillclaw. */
export const HILLCLAW_ALLOWED_CHANNELS = ["discord"] as const;

export type HillclawAllowedChannel = (typeof HILLCLAW_ALLOWED_CHANNELS)[number];

/**
 * Enforces Discord-only operation by locking the plugins.allow list to
 * ["discord"]. If the config already has other channels in the allowlist,
 * a warning is logged and they are stripped.
 */
export function enforceDiscordOnly(config: OpenClawConfig): OpenClawConfig {
  const existingAllow = config.plugins?.allow ?? [];

  const nonDiscord = existingAllow.filter(
    (id) => !HILLCLAW_ALLOWED_CHANNELS.includes(id as HillclawAllowedChannel),
  );

  if (nonDiscord.length > 0) {
    console.warn(
      `[hillclaw] enforceDiscordOnly: stripping non-Discord channels from plugins.allow: ${nonDiscord.join(", ")}`,
    );
  }

  return {
    ...config,
    plugins: {
      ...config.plugins,
      allow: [...HILLCLAW_ALLOWED_CHANNELS],
    },
  };
}

/**
 * Validates that the active plugin registry contains no non-Discord channel
 * plugins. Throws if any non-Discord channel plugin is found.
 *
 * Intended as a boot-time guard called after plugin loading completes.
 */
export function validateDiscordOnly(registry: Pick<PluginRegistry, "channels">): void {
  const nonDiscord = registry.channels.filter(
    (ch) =>
      !HILLCLAW_ALLOWED_CHANNELS.includes(ch.plugin.id as HillclawAllowedChannel),
  );

  if (nonDiscord.length > 0) {
    const ids = nonDiscord.map((ch) => ch.plugin.id).join(", ");
    throw new Error(
      `[hillclaw] Non-Discord channel plugins detected: ${ids}. Only Discord is permitted in Hillclaw.`,
    );
  }
}
