import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  emitDiagnosticEvent,
  resetDiagnosticEventsForTest,
} from "../../infra/diagnostic-events.js";
import { DiscordErrorReporter } from "./reporter.js";
import type { DiscordEmbed, DiscordErrorReporterOptions } from "./reporter.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeOpts(overrides: Partial<DiscordErrorReporterOptions> = {}): DiscordErrorReporterOptions {
  return {
    sendEmbed: vi.fn().mockResolvedValue(undefined),
    sendMessage: vi.fn().mockResolvedValue(undefined),
    ...overrides,
  };
}

function emitError(
  overrides: Partial<{
    code: string;
    subsystem: string;
    severity: string;
    message: string;
    sessionKey: string;
    agentId: string;
    stack: string;
    cause: string;
  }> = {},
) {
  emitDiagnosticEvent({
    type: "hillclaw.error",
    code: overrides.code ?? "TEST_ERROR",
    subsystem: overrides.subsystem ?? "gateway",
    severity: overrides.severity ?? "high",
    message: overrides.message ?? "Something went wrong",
    sessionKey: overrides.sessionKey,
    agentId: overrides.agentId,
    stack: overrides.stack,
    cause: overrides.cause,
  });
}

// Flush all pending microtasks/promises so async listener bodies complete.
// Under vi.useFakeTimers(), setTimeout is mocked so we must use
// vi.runAllTimersAsync() to pump both the timer queue and the microtask queue.
async function flush(): Promise<void> {
  await vi.runAllTimersAsync();
}

// ---------------------------------------------------------------------------
// Setup / teardown
// ---------------------------------------------------------------------------

let tempDir: string;
let fallbackLogPath: string;

beforeEach(() => {
  resetDiagnosticEventsForTest();
  vi.useFakeTimers();
  tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "hillclaw-err-reporter-"));
  fallbackLogPath = path.join(tempDir, "fallback.log");
});

afterEach(() => {
  vi.useRealTimers();
  resetDiagnosticEventsForTest();
  try {
    fs.rmSync(tempDir, { recursive: true, force: true });
  } catch {
    // ignore
  }
});

// ---------------------------------------------------------------------------
// Embed color / severity mapping
// ---------------------------------------------------------------------------

describe("severity colors", () => {
  it.each([
    ["critical", 0xff0000],
    ["high", 0xff6600],
    ["medium", 0xffcc00],
    ["low", 0x3399ff],
  ] as const)("%s maps to correct color 0x%s", async (severity, expectedColor) => {
    const opts = makeOpts({ fallbackLogPath });
    const reporter = new DiscordErrorReporter(opts);
    reporter.start();

    emitError({ severity });
    await flush();

    expect(opts.sendEmbed).toHaveBeenCalledOnce();
    const embed = (opts.sendEmbed as ReturnType<typeof vi.fn>).mock.calls[0][0] as DiscordEmbed;
    expect(embed.color).toBe(expectedColor);

    reporter.stop();
  });
});

// ---------------------------------------------------------------------------
// Embed content
// ---------------------------------------------------------------------------

describe("embed content", () => {
  it("includes code, subsystem, message in description", async () => {
    const opts = makeOpts({ fallbackLogPath });
    const reporter = new DiscordErrorReporter(opts);
    reporter.start();

    emitError({ code: "MY_CODE", subsystem: "session", message: "test message" });
    await flush();

    const embed = (opts.sendEmbed as ReturnType<typeof vi.fn>).mock.calls[0][0] as DiscordEmbed;
    expect(embed.description).toContain("`MY_CODE`");
    expect(embed.description).toContain("session");
    expect(embed.description).toContain("test message");

    reporter.stop();
  });

  it("title contains severity and code", async () => {
    const opts = makeOpts({ fallbackLogPath });
    const reporter = new DiscordErrorReporter(opts);
    reporter.start();

    emitError({ severity: "critical", code: "BOOT_FAIL" });
    await flush();

    const embed = (opts.sendEmbed as ReturnType<typeof vi.fn>).mock.calls[0][0] as DiscordEmbed;
    expect(embed.title).toContain("CRITICAL");
    expect(embed.title).toContain("BOOT_FAIL");

    reporter.stop();
  });

  it("embed has a timestamp", async () => {
    const opts = makeOpts({ fallbackLogPath });
    const reporter = new DiscordErrorReporter(opts);
    reporter.start();

    emitError({});
    await flush();

    const embed = (opts.sendEmbed as ReturnType<typeof vi.fn>).mock.calls[0][0] as DiscordEmbed;
    expect(embed.timestamp).toBeDefined();
    expect(() => new Date(embed.timestamp!)).not.toThrow();

    reporter.stop();
  });

  it("footer text is 'Hillclaw Error Reporter'", async () => {
    const opts = makeOpts({ fallbackLogPath });
    const reporter = new DiscordErrorReporter(opts);
    reporter.start();

    emitError({});
    await flush();

    const embed = (opts.sendEmbed as ReturnType<typeof vi.fn>).mock.calls[0][0] as DiscordEmbed;
    expect(embed.footer?.text).toBe("Hillclaw Error Reporter");

    reporter.stop();
  });

  it("includes session field when sessionKey is present", async () => {
    const opts = makeOpts({ fallbackLogPath });
    const reporter = new DiscordErrorReporter(opts);
    reporter.start();

    emitError({ sessionKey: "tg:12345" });
    await flush();

    const embed = (opts.sendEmbed as ReturnType<typeof vi.fn>).mock.calls[0][0] as DiscordEmbed;
    const sessionField = embed.fields?.find((f) => f.name === "Session");
    expect(sessionField).toBeDefined();
    expect(sessionField?.value).toBe("tg:12345");

    reporter.stop();
  });

  it("includes agent field when agentId is present", async () => {
    const opts = makeOpts({ fallbackLogPath });
    const reporter = new DiscordErrorReporter(opts);
    reporter.start();

    emitError({ agentId: "agent-xyz" });
    await flush();

    const embed = (opts.sendEmbed as ReturnType<typeof vi.fn>).mock.calls[0][0] as DiscordEmbed;
    const agentField = embed.fields?.find((f) => f.name === "Agent");
    expect(agentField).toBeDefined();
    expect(agentField?.value).toBe("agent-xyz");

    reporter.stop();
  });

  it("omits session/agent fields when not provided", async () => {
    const opts = makeOpts({ fallbackLogPath });
    const reporter = new DiscordErrorReporter(opts);
    reporter.start();

    emitError({});
    await flush();

    const embed = (opts.sendEmbed as ReturnType<typeof vi.fn>).mock.calls[0][0] as DiscordEmbed;
    expect(embed.fields?.find((f) => f.name === "Session")).toBeUndefined();
    expect(embed.fields?.find((f) => f.name === "Agent")).toBeUndefined();

    reporter.stop();
  });
});

// ---------------------------------------------------------------------------
// Truncation
// ---------------------------------------------------------------------------

describe("truncation", () => {
  it("sends truncated embed + .txt attachment when description > 4096 chars", async () => {
    const opts = makeOpts({ fallbackLogPath });
    const reporter = new DiscordErrorReporter(opts);
    reporter.start();

    const longStack = "x".repeat(5000);
    emitError({ stack: longStack });
    await flush();

    // sendMessage called first with attachment
    expect(opts.sendMessage).toHaveBeenCalledOnce();
    const [, attachment] = (opts.sendMessage as ReturnType<typeof vi.fn>).mock.calls[0] as [
      string,
      { name: string; content: string },
    ];
    expect(attachment).toBeDefined();
    expect(attachment.name).toMatch(/^error-TEST_ERROR-\d+\.txt$/);
    expect(attachment.content).toContain(longStack);

    // sendEmbed also called
    expect(opts.sendEmbed).toHaveBeenCalledOnce();
    const embed = (opts.sendEmbed as ReturnType<typeof vi.fn>).mock.calls[0][0] as DiscordEmbed;
    expect(embed.description).toContain("[truncated");
    expect(embed.description.length).toBeLessThanOrEqual(4096);

    reporter.stop();
  });

  it("does not send attachment when description is within limit", async () => {
    const opts = makeOpts({ fallbackLogPath });
    const reporter = new DiscordErrorReporter(opts);
    reporter.start();

    emitError({ message: "short message" });
    await flush();

    expect(opts.sendMessage).not.toHaveBeenCalled();
    expect(opts.sendEmbed).toHaveBeenCalledOnce();

    reporter.stop();
  });
});

// ---------------------------------------------------------------------------
// Rate limiting
// ---------------------------------------------------------------------------

describe("rate limiting", () => {
  it("suppresses second same-code event within rateLimitMs window", async () => {
    const opts = makeOpts({ fallbackLogPath, rateLimitMs: 10_000 });
    const reporter = new DiscordErrorReporter(opts);
    reporter.start();

    emitError({ code: "CODE_A" });
    await flush();
    emitError({ code: "CODE_A" }); // within window
    await flush();

    expect(opts.sendEmbed).toHaveBeenCalledOnce();

    reporter.stop();
  });

  it("allows event after rateLimitMs window expires", async () => {
    const opts = makeOpts({ fallbackLogPath, rateLimitMs: 10_000 });
    const reporter = new DiscordErrorReporter(opts);
    reporter.start();

    emitError({ code: "CODE_A" });
    await flush();

    vi.advanceTimersByTime(11_000);

    emitError({ code: "CODE_A" });
    await flush();

    expect(opts.sendEmbed).toHaveBeenCalledTimes(2);

    reporter.stop();
  });

  it("rate limiting is per-code — different codes are independent", async () => {
    const opts = makeOpts({ fallbackLogPath, rateLimitMs: 10_000 });
    const reporter = new DiscordErrorReporter(opts);
    reporter.start();

    emitError({ code: "CODE_A" });
    await flush();
    emitError({ code: "CODE_B" }); // different code, should go through
    await flush();

    expect(opts.sendEmbed).toHaveBeenCalledTimes(2);

    reporter.stop();
  });
});

// ---------------------------------------------------------------------------
// Cascade detection
// ---------------------------------------------------------------------------

describe("cascade detection", () => {
  it("sends summary message when same code fires >= cascadeThreshold times", async () => {
    const opts = makeOpts({
      fallbackLogPath,
      cascadeThreshold: 5,
      cascadeWindowMs: 60_000,
      rateLimitMs: 1, // very short so events go through normally
    });
    const reporter = new DiscordErrorReporter(opts);
    reporter.start();

    // Fire 5 events spread out so rate limiting doesn't block them
    for (let i = 0; i < 5; i++) {
      vi.advanceTimersByTime(100);
      emitError({ code: "BURST_CODE", message: `event ${i}` });
      await flush();
    }

    // 6th event triggers cascade (5 already recorded >= threshold 5)
    vi.advanceTimersByTime(100);
    emitError({ code: "BURST_CODE", message: "cascade trigger" });
    await flush();

    // At least one cascade summary message sent
    const sendMessage = opts.sendMessage as ReturnType<typeof vi.fn>;
    const cascadeCall = sendMessage.mock.calls.find((args: unknown[]) => {
      const text = args[0];
      return typeof text === "string" && text.includes("BURST_CODE") && text.includes("times");
    });
    expect(cascadeCall).toBeDefined();

    reporter.stop();
  });

  it("cascade summary contains the latest message", async () => {
    const opts = makeOpts({
      fallbackLogPath,
      cascadeThreshold: 3,
      cascadeWindowMs: 60_000,
      rateLimitMs: 1,
    });
    const reporter = new DiscordErrorReporter(opts);
    reporter.start();

    // Fire 3 events to build up the count (cascade fires when inWindow.length >= threshold)
    for (let i = 0; i < 3; i++) {
      vi.advanceTimersByTime(100);
      emitError({ code: "CASC_CODE", message: `event ${i}` });
      await flush();
    }

    // 4th event triggers cascade (3 already recorded >= threshold 3)
    vi.advanceTimersByTime(100);
    emitError({ code: "CASC_CODE", message: "the cascade trigger message" });
    await flush();

    const sendMessage = opts.sendMessage as ReturnType<typeof vi.fn>;
    const cascadeCall = sendMessage.mock.calls.find((args: unknown[]) => {
      const text = args[0];
      return typeof text === "string" && text.includes("the cascade trigger message");
    });
    expect(cascadeCall).toBeDefined();

    reporter.stop();
  });

  it("cascade summary is truncated to 2000 chars", async () => {
    const opts = makeOpts({
      fallbackLogPath,
      cascadeThreshold: 3,
      cascadeWindowMs: 60_000,
      rateLimitMs: 1,
    });
    const reporter = new DiscordErrorReporter(opts);
    reporter.start();

    const longMsg = "m".repeat(2500);
    // Fire 3 events to reach threshold
    for (let i = 0; i < 3; i++) {
      vi.advanceTimersByTime(100);
      emitError({ code: "CASC_CODE2", message: "short" });
      await flush();
    }

    // 4th triggers cascade with long message
    vi.advanceTimersByTime(100);
    emitError({ code: "CASC_CODE2", message: longMsg });
    await flush();

    const sendMessage = opts.sendMessage as ReturnType<typeof vi.fn>;
    for (const args of sendMessage.mock.calls as unknown[][]) {
      const text = args[0];
      if (typeof text === "string") {
        expect(text.length).toBeLessThanOrEqual(2000);
      }
    }

    reporter.stop();
  });
});

// ---------------------------------------------------------------------------
// Severity filter
// ---------------------------------------------------------------------------

describe("severity filter", () => {
  it("filters out low-severity events when minSeverity is 'high'", async () => {
    const opts = makeOpts({ fallbackLogPath, minSeverity: "high" });
    const reporter = new DiscordErrorReporter(opts);
    reporter.start();

    emitError({ severity: "low" });
    await flush();
    emitError({ severity: "medium" });
    await flush();

    expect(opts.sendEmbed).not.toHaveBeenCalled();

    reporter.stop();
  });

  it("passes high and critical when minSeverity is 'high'", async () => {
    const opts = makeOpts({ fallbackLogPath, minSeverity: "high" });
    const reporter = new DiscordErrorReporter(opts);
    reporter.start();

    emitError({ severity: "high", code: "H1" });
    await flush();
    emitError({ severity: "critical", code: "C1" });
    await flush();

    expect(opts.sendEmbed).toHaveBeenCalledTimes(2);

    reporter.stop();
  });

  it("allows all when minSeverity is not set", async () => {
    const opts = makeOpts({ fallbackLogPath });
    const reporter = new DiscordErrorReporter(opts);
    reporter.start();

    emitError({ severity: "low", code: "L1" });
    await flush();
    emitError({ severity: "medium", code: "M1" });
    await flush();
    emitError({ severity: "high", code: "H1" });
    await flush();
    emitError({ severity: "critical", code: "CR1" });
    await flush();

    expect(opts.sendEmbed).toHaveBeenCalledTimes(4);

    reporter.stop();
  });
});

// ---------------------------------------------------------------------------
// Delivery failure / fallback
// ---------------------------------------------------------------------------

describe("delivery failure fallback", () => {
  it("writes to fallback log when sendEmbed throws", async () => {
    const opts = makeOpts({
      fallbackLogPath,
      sendEmbed: vi.fn().mockRejectedValue(new Error("Discord down")),
    });
    const reporter = new DiscordErrorReporter(opts);
    reporter.start();

    emitError({ code: "ERR_DOWN" });
    await flush();

    expect(fs.existsSync(fallbackLogPath)).toBe(true);
    const contents = fs.readFileSync(fallbackLogPath, "utf-8");
    const parsed = JSON.parse(contents.trim());
    expect(parsed.event.code).toBe("ERR_DOWN");
    expect(parsed.deliveryError).toContain("Discord down");

    reporter.stop();
  });

  it("includes recovery notice in next successful send after fallback", async () => {
    const sendEmbed = vi
      .fn()
      .mockRejectedValueOnce(new Error("Discord down"))
      .mockResolvedValue(undefined);

    const opts = makeOpts({ fallbackLogPath, sendEmbed, rateLimitMs: 1 });
    const reporter = new DiscordErrorReporter(opts);
    reporter.start();

    // First event fails -> goes to fallback
    emitError({ code: "FAIL_CODE" });
    await flush();

    vi.advanceTimersByTime(100);

    // Second event (different code so no rate limit) succeeds -> recovery notice
    emitError({ code: "OK_CODE" });
    await flush();

    const sendMessage = opts.sendMessage as ReturnType<typeof vi.fn>;
    const recoveryCall = sendMessage.mock.calls.find((args: unknown[]) => {
      const text = args[0];
      return typeof text === "string" && text.includes("fallback");
    });
    expect(recoveryCall).toBeDefined();

    reporter.stop();
  });

  it("increments fallbackCount for each delivery failure", async () => {
    const sendEmbed = vi.fn().mockRejectedValue(new Error("Discord down"));
    const opts = makeOpts({ fallbackLogPath, sendEmbed, rateLimitMs: 1 });
    const reporter = new DiscordErrorReporter(opts);
    reporter.start();

    emitError({ code: "E1" });
    await flush();
    vi.advanceTimersByTime(100);
    emitError({ code: "E2" });
    await flush();

    const lines = fs.readFileSync(fallbackLogPath, "utf-8").trim().split("\n");
    expect(lines).toHaveLength(2);

    reporter.stop();
  });
});

// ---------------------------------------------------------------------------
// Start / stop lifecycle
// ---------------------------------------------------------------------------

describe("start/stop lifecycle", () => {
  it("does not receive events before start()", async () => {
    const opts = makeOpts({ fallbackLogPath });
    const reporter = new DiscordErrorReporter(opts);

    emitError({});
    await flush();

    expect(opts.sendEmbed).not.toHaveBeenCalled();
  });

  it("stops receiving events after stop()", async () => {
    const opts = makeOpts({ fallbackLogPath });
    const reporter = new DiscordErrorReporter(opts);
    reporter.start();

    emitError({ code: "BEFORE" });
    await flush();

    reporter.stop();

    emitError({ code: "AFTER" });
    await flush();

    expect(opts.sendEmbed).toHaveBeenCalledOnce();
    const embed = (opts.sendEmbed as ReturnType<typeof vi.fn>).mock.calls[0][0] as DiscordEmbed;
    expect(embed.title).toContain("BEFORE");
  });

  it("calling stop() before start() does not throw", () => {
    const opts = makeOpts({ fallbackLogPath });
    const reporter = new DiscordErrorReporter(opts);
    expect(() => reporter.stop()).not.toThrow();
  });

  it("calling stop() twice does not throw", () => {
    const opts = makeOpts({ fallbackLogPath });
    const reporter = new DiscordErrorReporter(opts);
    reporter.start();
    reporter.stop();
    expect(() => reporter.stop()).not.toThrow();
  });
});

// ---------------------------------------------------------------------------
// Non-hillclaw.error events are ignored
// ---------------------------------------------------------------------------

describe("event filtering", () => {
  it("ignores non-hillclaw.error events", async () => {
    const opts = makeOpts({ fallbackLogPath });
    const reporter = new DiscordErrorReporter(opts);
    reporter.start();

    emitDiagnosticEvent({
      type: "model.usage",
      usage: { input: 100, output: 50 },
    });
    await flush();

    expect(opts.sendEmbed).not.toHaveBeenCalled();
    expect(opts.sendMessage).not.toHaveBeenCalled();

    reporter.stop();
  });
});
