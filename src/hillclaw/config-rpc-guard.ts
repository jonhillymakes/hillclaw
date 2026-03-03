/**
 * Guards for config RPC calls: merge-patch validation and write-rate enforcement.
 *
 * config.patch  — merge-patch semantics; requires baseHash for optimistic concurrency.
 * config.apply  — full replace; also benefits from baseHash but is a separate call path.
 *
 * The platform enforces ~3 config writes per 60 s. ConfigWriteRateLimiter mirrors
 * that limit so callers can gate before issuing the RPC and surface useful wait times.
 */

/**
 * Result shape returned by guarded config write helpers (informational; not yet
 * wired to the actual RPC layer — that is a later step).
 */
export interface ConfigWriteResult {
  success: boolean;
  hash?: string;
  error?: string;
  rateLimited?: boolean;
}

/**
 * Validates that a config.patch call uses merge-patch semantics correctly.
 *
 * Checks:
 * - baseHash is provided (required for optimistic concurrency — omitting it risks
 *   clobbering concurrent writes).
 * - patch is a non-null, non-array plain object.
 */
export function validateConfigPatch(params: {
  patch: Record<string, unknown>;
  baseHash?: string;
}): { valid: boolean; errors: string[] } {
  const errors: string[] = [];

  if (!params.baseHash) {
    errors.push(
      "baseHash is required for optimistic concurrency — omitting it risks clobbering concurrent writes",
    );
  }

  if (
    !params.patch ||
    typeof params.patch !== "object" ||
    Array.isArray(params.patch)
  ) {
    errors.push("patch must be a non-null object");
  }

  return { valid: errors.length === 0, errors };
}

/**
 * Sliding-window rate limiter for config writes.
 *
 * Tracks write timestamps and enforces a maximum of `maxWrites` within any
 * rolling `windowMs` period, mirroring the platform's own ~3/60 s limit.
 */
export class ConfigWriteRateLimiter {
  private timestamps: number[] = [];

  constructor(
    private readonly maxWrites: number = 3,
    private readonly windowMs: number = 60_000,
  ) {}

  /** Returns true if a write is allowed right now (does not record the write). */
  canWrite(): boolean {
    this.prune();
    return this.timestamps.length < this.maxWrites;
  }

  /** Records that a write just occurred. Call after a successful RPC. */
  recordWrite(): void {
    this.timestamps.push(Date.now());
  }

  /** How many more writes are allowed in the current window. */
  remainingWrites(): number {
    this.prune();
    return Math.max(0, this.maxWrites - this.timestamps.length);
  }

  /**
   * Milliseconds until the next write slot opens.
   * Returns 0 if a write is currently allowed.
   */
  nextWriteAvailableIn(): number {
    this.prune();
    if (this.timestamps.length < this.maxWrites) return 0;
    const oldest = this.timestamps[0]!;
    return Math.max(0, oldest + this.windowMs - Date.now());
  }

  /** Drops timestamps that have fallen outside the rolling window. */
  private prune(): void {
    const cutoff = Date.now() - this.windowMs;
    this.timestamps = this.timestamps.filter((t) => t > cutoff);
  }

  /** Resets state. Intended for use in tests only. */
  reset(): void {
    this.timestamps = [];
  }
}

// ---------------------------------------------------------------------------
// Singleton accessor
// ---------------------------------------------------------------------------

let _rateLimiter: ConfigWriteRateLimiter | null = null;

/** Returns the process-level singleton ConfigWriteRateLimiter. */
export function getConfigWriteRateLimiter(): ConfigWriteRateLimiter {
  if (!_rateLimiter) {
    _rateLimiter = new ConfigWriteRateLimiter();
  }
  return _rateLimiter;
}

/**
 * Resets (and discards) the singleton rate limiter.
 * Call from `afterEach` / `beforeEach` in tests to avoid cross-test pollution.
 */
export function resetConfigWriteRateLimiterForTest(): void {
  _rateLimiter?.reset();
  _rateLimiter = null;
}
