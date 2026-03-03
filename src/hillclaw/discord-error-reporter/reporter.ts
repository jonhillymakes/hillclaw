import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { onDiagnosticEvent } from "../../infra/diagnostic-events.js";
import type { DiagnosticHillclawErrorEvent } from "../../infra/diagnostic-events.js";
import type { HillclawSeverity } from "../../infra/hillclaw-error.js";

export interface DiscordErrorReporterOptions {
  /** Function to send a Discord embed message */
  sendEmbed: (embed: DiscordEmbed) => Promise<void>;
  /** Function to send a Discord text message with optional file attachment */
  sendMessage: (text: string, attachment?: { name: string; content: string }) => Promise<void>;
  /** Minimum severity to report. Default: all */
  minSeverity?: HillclawSeverity;
  /** Max 1 message per N ms per error code. Default: 10000 */
  rateLimitMs?: number;
  /** Cascade threshold: N same-code errors in window triggers summary. Default: 5 */
  cascadeThreshold?: number;
  /** Cascade window in ms. Default: 60000 */
  cascadeWindowMs?: number;
  /** Fallback log path. Default: ~/.openclaw/error-surface-fallback.log */
  fallbackLogPath?: string;
}

export interface DiscordEmbed {
  title: string;
  description: string;
  color: number; // Decimal color
  fields?: Array<{ name: string; value: string; inline?: boolean }>;
  timestamp?: string;
  footer?: { text: string };
}

const SEVERITY_COLORS: Record<HillclawSeverity, number> = {
  critical: 0xff0000, // Red
  high: 0xff6600, // Orange
  medium: 0xffcc00, // Yellow
  low: 0x3399ff, // Blue
};

const SEVERITY_ORDER: Record<HillclawSeverity, number> = {
  critical: 0,
  high: 1,
  medium: 2,
  low: 3,
};

const MAX_EMBED_DESCRIPTION = 4096;
const MAX_MESSAGE_LENGTH = 2000;

export class DiscordErrorReporter {
  /** Tracks timestamps within rateLimitMs window for rate-limiting. */
  private rateMap = new Map<string, number[]>();
  /** Tracks timestamps within cascadeWindowMs for cascade detection (separate from rateMap). */
  private cascadeMap = new Map<string, number[]>();
  private fallbackCount = 0;
  private unsubscribe: (() => void) | null = null;

  constructor(private readonly opts: DiscordErrorReporterOptions) {}

  /**
   * Start listening for HillclawError events.
   */
  start(): void {
    this.unsubscribe = onDiagnosticEvent(async (event) => {
      if (event.type !== "hillclaw.error") return;

      const errorEvent = event as DiagnosticHillclawErrorEvent;

      // Severity filter
      if (this.opts.minSeverity !== undefined) {
        const minOrder = SEVERITY_ORDER[this.opts.minSeverity];
        const eventOrder =
          SEVERITY_ORDER[errorEvent.severity as HillclawSeverity] ?? SEVERITY_ORDER.low;
        if (eventOrder > minOrder) return;
      }

      const code = errorEvent.code;

      // Cascade detection uses its own map so it is not affected by rate-limit pruning.
      if (this.isCascade(code)) {
        this.recordCascade(code);
        await this.sendCascadeSummary(code, errorEvent);
        return;
      }

      // Rate limiting
      if (this.isRateLimited(code)) {
        this.recordCascade(code);
        return;
      }

      this.recordEvent(code);
      this.recordCascade(code);

      // Build and send
      await this.sendErrorEmbed(errorEvent);
    });
  }

  /**
   * Stop listening.
   */
  stop(): void {
    this.unsubscribe?.();
    this.unsubscribe = null;
  }

  private isRateLimited(code: string): boolean {
    const rateLimitMs = this.opts.rateLimitMs ?? 10_000;
    const timestamps = this.rateMap.get(code) ?? [];
    const now = Date.now();
    const recent = timestamps.filter((t) => now - t < rateLimitMs);
    this.rateMap.set(code, recent);
    return recent.length > 0;
  }

  private isCascade(code: string): boolean {
    const threshold = this.opts.cascadeThreshold ?? 5;
    const windowMs = this.opts.cascadeWindowMs ?? 60_000;
    const timestamps = this.cascadeMap.get(code) ?? [];
    const now = Date.now();
    const inWindow = timestamps.filter((t) => now - t < windowMs);
    // Update map to drop stale entries
    this.cascadeMap.set(code, inWindow);
    return inWindow.length >= threshold;
  }

  private recordEvent(code: string): void {
    const timestamps = this.rateMap.get(code) ?? [];
    timestamps.push(Date.now());
    this.rateMap.set(code, timestamps);
  }

  private recordCascade(code: string): void {
    const timestamps = this.cascadeMap.get(code) ?? [];
    timestamps.push(Date.now());
    this.cascadeMap.set(code, timestamps);
  }

  private async sendErrorEmbed(event: DiagnosticHillclawErrorEvent): Promise<void> {
    const severity = event.severity as HillclawSeverity;
    const parts = [
      `**Code:** \`${event.code}\``,
      `**Subsystem:** ${event.subsystem}`,
      `**Message:** ${event.message}`,
      event.stack ? `\n**Stack:**\n\`\`\`\n${event.stack}\n\`\`\`` : "",
      event.cause ? `\n**Cause:** ${event.cause}` : "",
    ].filter(Boolean);
    const fullDescription = parts.join("\n");

    let description = fullDescription;
    let attachment: { name: string; content: string } | undefined;

    // Truncation + attachment fallback
    if (description.length > MAX_EMBED_DESCRIPTION) {
      const truncated = description.slice(0, MAX_EMBED_DESCRIPTION - 60);
      description = truncated + "\n\n[truncated — full trace in attachment]";
      attachment = {
        name: `error-${event.code}-${Date.now()}.txt`,
        content: fullDescription,
      };
    }

    const embed: DiscordEmbed = {
      title: `${severityEmoji(severity)} ${severity.toUpperCase()}: ${event.code}`,
      description,
      color: SEVERITY_COLORS[severity] ?? SEVERITY_COLORS.low,
      fields: [
        ...(event.sessionKey
          ? [{ name: "Session", value: event.sessionKey, inline: true }]
          : []),
        ...(event.agentId ? [{ name: "Agent", value: event.agentId, inline: true }] : []),
      ],
      timestamp: new Date(event.ts).toISOString(),
      footer: { text: "Hillclaw Error Reporter" },
    };

    try {
      if (attachment) {
        await this.opts.sendMessage("", attachment);
      }
      await this.opts.sendEmbed(embed);

      // Recovery notice if we had fallback errors
      if (this.fallbackCount > 0) {
        const count = this.fallbackCount;
        this.fallbackCount = 0;
        await this.opts.sendMessage(
          `While Discord was unreachable, ${count} error(s) were logged to fallback. Check gateway logs.`,
        );
      }
    } catch (deliveryErr) {
      this.handleDeliveryFailure(event, deliveryErr);
    }
  }

  private async sendCascadeSummary(
    code: string,
    latestEvent: DiagnosticHillclawErrorEvent,
  ): Promise<void> {
    const windowMs = this.opts.cascadeWindowMs ?? 60_000;
    const timestamps = this.cascadeMap.get(code) ?? [];
    const now = Date.now();
    const count = timestamps.filter((t) => now - t < windowMs).length;

    const text =
      `**${code}** occurred ${count + 1} times in the last ${Math.round(windowMs / 1000)}s. ` +
      `Latest: ${latestEvent.message}`;

    try {
      await this.opts.sendMessage(text.slice(0, MAX_MESSAGE_LENGTH));
    } catch (deliveryErr) {
      this.handleDeliveryFailure(latestEvent, deliveryErr);
    }

    this.recordEvent(code);
  }

  private handleDeliveryFailure(event: DiagnosticHillclawErrorEvent, deliveryErr: unknown): void {
    this.fallbackCount++;
    const fallbackPath =
      this.opts.fallbackLogPath ??
      path.join(
        process.env["OPENCLAW_STATE_DIR"] ?? path.join(os.homedir(), ".openclaw"),
        "error-surface-fallback.log",
      );

    try {
      fs.mkdirSync(path.dirname(fallbackPath), { recursive: true });
      const entry =
        JSON.stringify({
          ts: Date.now(),
          event,
          deliveryError:
            deliveryErr instanceof Error ? deliveryErr.message : String(deliveryErr),
        }) + "\n";
      fs.appendFileSync(fallbackPath, entry);
    } catch {
      // Last resort: console
      console.error("[hillclaw:error-reporter] Fallback write failed:", event);
    }
  }
}

function severityEmoji(severity: HillclawSeverity): string {
  switch (severity) {
    case "critical":
      return "🔴";
    case "high":
      return "🟠";
    case "medium":
      return "🟡";
    case "low":
      return "🔵";
  }
}
