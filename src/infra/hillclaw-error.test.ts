import { describe, expect, it } from "vitest";
import { ErrorCodes, HillclawError, isHillclawError } from "./hillclaw-error.js";

describe("HillclawError", () => {
  it("constructs with all required fields", () => {
    const err = new HillclawError({
      code: "CONFIG_WRITE_FAILED",
      subsystem: "config",
      severity: "high",
      message: "Failed to write config",
    });

    expect(err.code).toBe("CONFIG_WRITE_FAILED");
    expect(err.subsystem).toBe("config");
    expect(err.severity).toBe("high");
    expect(err.message).toBe("Failed to write config");
    expect(err.name).toBe("HillclawError");
  });

  it("constructs with optional fields", () => {
    const cause = new Error("underlying cause");
    const err = new HillclawError({
      code: "SESSION_LOCK_FAILED",
      subsystem: "session",
      severity: "critical",
      message: "Lock failed",
      cause,
      sessionKey: "tg:12345",
      agentId: "agent-abc",
    });

    expect(err.cause).toBe(cause);
    expect(err.sessionKey).toBe("tg:12345");
    expect(err.agentId).toBe("agent-abc");
  });

  it("sets timestamp automatically", () => {
    const before = Date.now();
    const err = new HillclawError({
      code: "UNCAUGHT_EXCEPTION",
      subsystem: "gateway",
      severity: "critical",
      message: "uncaught",
    });
    const after = Date.now();

    expect(err.timestamp).toBeGreaterThanOrEqual(before);
    expect(err.timestamp).toBeLessThanOrEqual(after);
  });

  it("is an instance of Error", () => {
    const err = new HillclawError({
      code: "DISCORD_SEND_FAILED",
      subsystem: "discord",
      severity: "medium",
      message: "send failed",
    });

    expect(err).toBeInstanceOf(Error);
    expect(err).toBeInstanceOf(HillclawError);
  });

  it("propagates cause chain correctly", () => {
    const root = new Error("root cause");
    const err = new HillclawError({
      code: "GATEWAY_RESTART_FAILED",
      subsystem: "gateway",
      severity: "high",
      message: "restart failed",
      cause: root,
    });

    expect(err.cause).toBe(root);
    expect(err.cause?.message).toBe("root cause");
  });

  it("has a stack trace", () => {
    const err = new HillclawError({
      code: "CONFIG_AUDIT_FAILED",
      subsystem: "config",
      severity: "low",
      message: "audit failed",
    });

    expect(err.stack).toBeDefined();
    expect(err.stack).toContain("HillclawError");
  });
});

describe("isHillclawError", () => {
  it("returns true for HillclawError instances", () => {
    const err = new HillclawError({
      code: "UNHANDLED_REJECTION",
      subsystem: "gateway",
      severity: "critical",
      message: "unhandled",
    });

    expect(isHillclawError(err)).toBe(true);
  });

  it("returns false for plain Error", () => {
    expect(isHillclawError(new Error("plain"))).toBe(false);
  });

  it("returns false for non-error values", () => {
    expect(isHillclawError(null)).toBe(false);
    expect(isHillclawError(undefined)).toBe(false);
    expect(isHillclawError("string")).toBe(false);
    expect(isHillclawError(42)).toBe(false);
    expect(isHillclawError({})).toBe(false);
  });
});

describe("ErrorCodes", () => {
  it("all values are unique strings", () => {
    const values = Object.values(ErrorCodes);
    const unique = new Set(values);
    expect(unique.size).toBe(values.length);
  });

  it("all values are non-empty strings", () => {
    for (const value of Object.values(ErrorCodes)) {
      expect(typeof value).toBe("string");
      expect(value.length).toBeGreaterThan(0);
    }
  });

  it("contains expected codes", () => {
    expect(ErrorCodes.CONFIG_WRITE_FAILED).toBe("CONFIG_WRITE_FAILED");
    expect(ErrorCodes.UNCAUGHT_EXCEPTION).toBe("UNCAUGHT_EXCEPTION");
    expect(ErrorCodes.UNHANDLED_REJECTION).toBe("UNHANDLED_REJECTION");
    expect(ErrorCodes.SESSION_DELIVERY_FAILED).toBe("SESSION_DELIVERY_FAILED");
  });
});
