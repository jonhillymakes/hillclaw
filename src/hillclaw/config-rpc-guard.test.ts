import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  ConfigWriteRateLimiter,
  getConfigWriteRateLimiter,
  resetConfigWriteRateLimiterForTest,
  validateConfigPatch,
} from "./config-rpc-guard.js";

// ---------------------------------------------------------------------------
// validateConfigPatch
// ---------------------------------------------------------------------------

describe("validateConfigPatch", () => {
  it("rejects when baseHash is missing", () => {
    const result = validateConfigPatch({ patch: { key: "value" } });
    expect(result.valid).toBe(false);
    expect(result.errors).toHaveLength(1);
    expect(result.errors[0]).toMatch(/baseHash.*required/i);
  });

  it("error message mentions optimistic concurrency", () => {
    const { errors } = validateConfigPatch({ patch: { a: 1 } });
    expect(errors[0]).toMatch(/optimistic concurrency/i);
  });

  it("rejects when patch is an array", () => {
    const result = validateConfigPatch({
      patch: [] as unknown as Record<string, unknown>,
      baseHash: "abc123",
    });
    expect(result.valid).toBe(false);
    expect(result.errors.some((e) => /non-null object/.test(e))).toBe(true);
  });

  it("rejects when patch is null", () => {
    const result = validateConfigPatch({
      patch: null as unknown as Record<string, unknown>,
      baseHash: "abc123",
    });
    expect(result.valid).toBe(false);
    expect(result.errors.some((e) => /non-null object/.test(e))).toBe(true);
  });

  it("rejects when patch is a primitive string", () => {
    const result = validateConfigPatch({
      patch: "bad" as unknown as Record<string, unknown>,
      baseHash: "abc123",
    });
    expect(result.valid).toBe(false);
    expect(result.errors.some((e) => /non-null object/.test(e))).toBe(true);
  });

  it("accepts a valid patch with baseHash", () => {
    const result = validateConfigPatch({
      patch: { theme: "dark", language: "en" },
      baseHash: "abc123",
    });
    expect(result.valid).toBe(true);
    expect(result.errors).toHaveLength(0);
  });

  it("accepts an empty patch object with baseHash", () => {
    const result = validateConfigPatch({ patch: {}, baseHash: "deadbeef" });
    expect(result.valid).toBe(true);
    expect(result.errors).toHaveLength(0);
  });

  it("accumulates both errors when patch and baseHash are both invalid", () => {
    const result = validateConfigPatch({
      patch: null as unknown as Record<string, unknown>,
    });
    expect(result.valid).toBe(false);
    expect(result.errors).toHaveLength(2);
  });
});

// ---------------------------------------------------------------------------
// ConfigWriteRateLimiter — basic behaviour
// ---------------------------------------------------------------------------

describe("ConfigWriteRateLimiter", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("allows writes within the limit", () => {
    const limiter = new ConfigWriteRateLimiter(3, 60_000);
    expect(limiter.canWrite()).toBe(true);
    limiter.recordWrite();
    expect(limiter.canWrite()).toBe(true);
    limiter.recordWrite();
    expect(limiter.canWrite()).toBe(true);
  });

  it("blocks writes at the limit", () => {
    const limiter = new ConfigWriteRateLimiter(3, 60_000);
    limiter.recordWrite();
    limiter.recordWrite();
    limiter.recordWrite();
    expect(limiter.canWrite()).toBe(false);
  });

  it("allows writes again after the window expires", () => {
    const limiter = new ConfigWriteRateLimiter(3, 60_000);
    limiter.recordWrite();
    limiter.recordWrite();
    limiter.recordWrite();
    expect(limiter.canWrite()).toBe(false);

    vi.advanceTimersByTime(60_001);
    expect(limiter.canWrite()).toBe(true);
  });

  it("window is sliding — oldest entry drops off individually", () => {
    const limiter = new ConfigWriteRateLimiter(3, 60_000);

    // Write at t=0, t=10s, t=20s  →  limit reached
    limiter.recordWrite();
    vi.advanceTimersByTime(10_000);
    limiter.recordWrite();
    vi.advanceTimersByTime(10_000);
    limiter.recordWrite();
    expect(limiter.canWrite()).toBe(false);

    // Advance to t=60_001ms total: write at t=0 exits the 60 s window.
    // Remaining in-window: writes at t=10_000 and t=20_000 (2 of 3).
    vi.advanceTimersByTime(40_001);
    expect(limiter.canWrite()).toBe(true);

    // Record the 4th write (now at t≈60_001) → 3 writes in window → limit hit.
    limiter.recordWrite();
    expect(limiter.canWrite()).toBe(false);

    // Advance past t=10_000+60_000=70_000ms so the second write leaves the window.
    // Current time ≈ 60_001; need to reach > 70_000 → advance ~10_000ms.
    vi.advanceTimersByTime(10_001);
    // Now only writes at t≈20_000 and t≈60_001 are in window (2 of 3).
    expect(limiter.canWrite()).toBe(true);
  });

  describe("remainingWrites", () => {
    it("returns max when no writes have occurred", () => {
      const limiter = new ConfigWriteRateLimiter(3, 60_000);
      expect(limiter.remainingWrites()).toBe(3);
    });

    it("decrements as writes are recorded", () => {
      const limiter = new ConfigWriteRateLimiter(3, 60_000);
      limiter.recordWrite();
      expect(limiter.remainingWrites()).toBe(2);
      limiter.recordWrite();
      expect(limiter.remainingWrites()).toBe(1);
      limiter.recordWrite();
      expect(limiter.remainingWrites()).toBe(0);
    });

    it("does not go below zero", () => {
      const limiter = new ConfigWriteRateLimiter(1, 60_000);
      limiter.recordWrite();
      limiter.recordWrite(); // extra — should not underflow
      expect(limiter.remainingWrites()).toBe(0);
    });

    it("recovers after window expires", () => {
      const limiter = new ConfigWriteRateLimiter(3, 60_000);
      limiter.recordWrite();
      limiter.recordWrite();
      limiter.recordWrite();
      expect(limiter.remainingWrites()).toBe(0);

      vi.advanceTimersByTime(60_001);
      expect(limiter.remainingWrites()).toBe(3);
    });
  });

  describe("nextWriteAvailableIn", () => {
    it("returns 0 when writes are still available", () => {
      const limiter = new ConfigWriteRateLimiter(3, 60_000);
      limiter.recordWrite();
      expect(limiter.nextWriteAvailableIn()).toBe(0);
    });

    it("returns a positive wait time when at the limit", () => {
      const limiter = new ConfigWriteRateLimiter(3, 60_000);
      limiter.recordWrite();
      limiter.recordWrite();
      limiter.recordWrite();
      const wait = limiter.nextWriteAvailableIn();
      expect(wait).toBeGreaterThan(0);
      expect(wait).toBeLessThanOrEqual(60_000);
    });

    it("decreases as time passes", () => {
      const limiter = new ConfigWriteRateLimiter(3, 60_000);
      limiter.recordWrite();
      limiter.recordWrite();
      limiter.recordWrite();
      const waitBefore = limiter.nextWriteAvailableIn();
      vi.advanceTimersByTime(10_000);
      const waitAfter = limiter.nextWriteAvailableIn();
      expect(waitAfter).toBeLessThan(waitBefore);
    });

    it("returns 0 once the window has expired", () => {
      const limiter = new ConfigWriteRateLimiter(3, 60_000);
      limiter.recordWrite();
      limiter.recordWrite();
      limiter.recordWrite();
      vi.advanceTimersByTime(60_001);
      expect(limiter.nextWriteAvailableIn()).toBe(0);
    });
  });

  describe("reset", () => {
    it("allows writes again after reset", () => {
      const limiter = new ConfigWriteRateLimiter(1, 60_000);
      limiter.recordWrite();
      expect(limiter.canWrite()).toBe(false);
      limiter.reset();
      expect(limiter.canWrite()).toBe(true);
    });

    it("restores remainingWrites to max after reset", () => {
      const limiter = new ConfigWriteRateLimiter(3, 60_000);
      limiter.recordWrite();
      limiter.recordWrite();
      limiter.reset();
      expect(limiter.remainingWrites()).toBe(3);
    });
  });
});

// ---------------------------------------------------------------------------
// Singleton accessor
// ---------------------------------------------------------------------------

describe("getConfigWriteRateLimiter", () => {
  afterEach(() => {
    resetConfigWriteRateLimiterForTest();
  });

  it("returns the same instance on repeated calls", () => {
    const a = getConfigWriteRateLimiter();
    const b = getConfigWriteRateLimiter();
    expect(a).toBe(b);
  });

  it("returned instance is a ConfigWriteRateLimiter", () => {
    expect(getConfigWriteRateLimiter()).toBeInstanceOf(ConfigWriteRateLimiter);
  });
});

// ---------------------------------------------------------------------------
// resetConfigWriteRateLimiterForTest
// ---------------------------------------------------------------------------

describe("resetConfigWriteRateLimiterForTest", () => {
  afterEach(() => {
    resetConfigWriteRateLimiterForTest();
  });

  it("causes getConfigWriteRateLimiter to return a fresh instance", () => {
    const before = getConfigWriteRateLimiter();
    resetConfigWriteRateLimiterForTest();
    const after = getConfigWriteRateLimiter();
    expect(after).not.toBe(before);
  });

  it("fresh instance has all writes available", () => {
    const limiter = getConfigWriteRateLimiter();
    limiter.recordWrite();
    limiter.recordWrite();
    limiter.recordWrite();
    expect(limiter.canWrite()).toBe(false);

    resetConfigWriteRateLimiterForTest();
    expect(getConfigWriteRateLimiter().canWrite()).toBe(true);
  });
});
