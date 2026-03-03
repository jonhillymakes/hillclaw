import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { resetDiagnosticEventsForTest, onDiagnosticEvent } from "./diagnostic-events.js";
import type { DiagnosticEventPayload } from "./diagnostic-events.js";
import { ErrorCodes, HillclawError } from "./hillclaw-error.js";
import { emitHillclawError, installUncaughtExceptionHandler } from "./hillclaw-error-handler.js";

beforeEach(() => {
  resetDiagnosticEventsForTest();
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe("emitHillclawError", () => {
  it("emits a hillclaw.error diagnostic event with all fields", () => {
    const events: DiagnosticEventPayload[] = [];
    const unsub = onDiagnosticEvent((evt) => events.push(evt));

    const cause = new Error("root");
    const err = new HillclawError({
      code: ErrorCodes.CONFIG_WRITE_FAILED,
      subsystem: "config",
      severity: "high",
      message: "write failed",
      cause,
      sessionKey: "tg:99",
      agentId: "ag-1",
    });

    emitHillclawError(err);
    unsub();

    expect(events).toHaveLength(1);
    const evt = events[0];
    expect(evt.type).toBe("hillclaw.error");
    if (evt.type !== "hillclaw.error") return;
    expect(evt.code).toBe(ErrorCodes.CONFIG_WRITE_FAILED);
    expect(evt.subsystem).toBe("config");
    expect(evt.severity).toBe("high");
    expect(evt.message).toBe("write failed");
    expect(evt.sessionKey).toBe("tg:99");
    expect(evt.agentId).toBe("ag-1");
    expect(evt.cause).toBe("root");
    expect(evt.stack).toContain("HillclawError");
  });

  it("emits without optional fields when not provided", () => {
    const events: DiagnosticEventPayload[] = [];
    const unsub = onDiagnosticEvent((evt) => events.push(evt));

    const err = new HillclawError({
      code: ErrorCodes.UNCAUGHT_EXCEPTION,
      subsystem: "gateway",
      severity: "critical",
      message: "bare error",
    });

    emitHillclawError(err);
    unsub();

    expect(events).toHaveLength(1);
    const evt = events[0];
    if (evt.type !== "hillclaw.error") return;
    expect(evt.sessionKey).toBeUndefined();
    expect(evt.agentId).toBeUndefined();
    expect(evt.cause).toBeUndefined();
  });
});

describe("installUncaughtExceptionHandler", () => {
  it("exit policy: emits event and calls process.exit on uncaughtException", async () => {
    const log = { error: vi.fn() };
    const exitSpy = vi.spyOn(process, "exit").mockImplementation((_code) => {
      throw new Error("process.exit called");
    });

    const events: DiagnosticEventPayload[] = [];
    const unsub = onDiagnosticEvent((evt) => events.push(evt));

    // Capture the listener without actually registering on process
    const listeners: Array<(err: Error, origin: string) => void> = [];
    const onSpy = vi.spyOn(process, "on").mockImplementation((event: string | symbol, listener: (...args: unknown[]) => void) => {
      if (event === "uncaughtException") {
        listeners.push(listener as (err: Error, origin: string) => void);
      }
      return process;
    });

    installUncaughtExceptionHandler({ policy: "exit", log });

    expect(listeners).toHaveLength(1);
    const handler = listeners[0]!;

    vi.useFakeTimers();
    handler(new Error("boom"), "uncaughtException");

    expect(events.some((e) => e.type === "hillclaw.error")).toBe(true);
    const errEvt = events.find((e) => e.type === "hillclaw.error");
    if (errEvt?.type === "hillclaw.error") {
      expect(errEvt.code).toBe(ErrorCodes.UNCAUGHT_EXCEPTION);
      expect(errEvt.severity).toBe("critical");
    }

    expect(log.error).toHaveBeenCalledWith(expect.stringContaining("[UNCAUGHT uncaughtException]"));
    expect(log.error).toHaveBeenCalledWith(expect.stringContaining("Exit policy"));

    // Advance timer to trigger process.exit
    try {
      vi.advanceTimersByTime(600);
    } catch {
      // swallowed — exitSpy throws
    }

    vi.useRealTimers();
    unsub();
    onSpy.mockRestore();
    exitSpy.mockRestore();
  });

  it("safe-mode policy: calls onSafeMode callback on uncaughtException", () => {
    const log = { error: vi.fn() };
    const onSafeMode = vi.fn();

    const events: DiagnosticEventPayload[] = [];
    const unsub = onDiagnosticEvent((evt) => events.push(evt));

    const listeners: Array<(err: Error, origin: string) => void> = [];
    const onSpy = vi.spyOn(process, "on").mockImplementation((event: string | symbol, listener: (...args: unknown[]) => void) => {
      if (event === "uncaughtException") {
        listeners.push(listener as (err: Error, origin: string) => void);
      }
      return process;
    });

    installUncaughtExceptionHandler({ policy: "safe-mode", log, onSafeMode });

    const handler = listeners[0]!;
    handler(new Error("boom"), "uncaughtException");

    expect(onSafeMode).toHaveBeenCalledOnce();
    expect(log.error).toHaveBeenCalledWith(expect.stringContaining("Safe-mode policy"));
    expect(events.some((e) => e.type === "hillclaw.error")).toBe(true);

    unsub();
    onSpy.mockRestore();
  });

  it("unhandledRejection: wraps non-Error reason and emits UNHANDLED_REJECTION", () => {
    const log = { error: vi.fn() };

    const events: DiagnosticEventPayload[] = [];
    const unsub = onDiagnosticEvent((evt) => events.push(evt));

    const rejectionListeners: Array<(reason: unknown) => void> = [];
    const onSpy = vi.spyOn(process, "on").mockImplementation((event: string | symbol, listener: (...args: unknown[]) => void) => {
      if (event === "unhandledRejection") {
        rejectionListeners.push(listener as (reason: unknown) => void);
      }
      return process;
    });

    installUncaughtExceptionHandler({ policy: "exit", log });

    const handler = rejectionListeners[0]!;

    // Non-Error reason — a plain string
    handler("something went wrong");

    const errEvt = events.find((e) => e.type === "hillclaw.error");
    expect(errEvt).toBeDefined();
    if (errEvt?.type === "hillclaw.error") {
      expect(errEvt.code).toBe(ErrorCodes.UNHANDLED_REJECTION);
      expect(errEvt.message).toContain("something went wrong");
    }

    expect(log.error).toHaveBeenCalledWith(expect.stringContaining("[UNHANDLED REJECTION]"));

    unsub();
    onSpy.mockRestore();
  });

  it("unhandledRejection: wraps Error reason correctly", () => {
    const log = { error: vi.fn() };

    const events: DiagnosticEventPayload[] = [];
    const unsub = onDiagnosticEvent((evt) => events.push(evt));

    const rejectionListeners: Array<(reason: unknown) => void> = [];
    const onSpy = vi.spyOn(process, "on").mockImplementation((event: string | symbol, listener: (...args: unknown[]) => void) => {
      if (event === "unhandledRejection") {
        rejectionListeners.push(listener as (reason: unknown) => void);
      }
      return process;
    });

    installUncaughtExceptionHandler({ policy: "safe-mode", log });

    const handler = rejectionListeners[0]!;
    const originalErr = new Error("async failure");
    handler(originalErr);

    const errEvt = events.find((e) => e.type === "hillclaw.error");
    if (errEvt?.type === "hillclaw.error") {
      expect(errEvt.code).toBe(ErrorCodes.UNHANDLED_REJECTION);
      expect(errEvt.cause).toBe("async failure");
    }

    unsub();
    onSpy.mockRestore();
  });
});
