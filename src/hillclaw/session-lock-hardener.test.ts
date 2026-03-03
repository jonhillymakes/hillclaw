import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../infra/hillclaw-error-handler.js", () => ({
  emitHillclawError: vi.fn(),
  isHillclawError: (err: unknown) =>
    err != null && typeof err === "object" && (err as { name?: unknown }).name === "HillclawError",
}));

import {
  checkAndRecoverStaleLocks,
  cleanupOrphanedLocks,
  type LockInfo,
} from "./session-lock-hardener.js";

// A PID that is guaranteed to be dead: use 1 on Linux/macOS (init, not killable
// from user space), or we simply pick a very large number and rely on the fact
// that kill(pid, 0) will fail with ESRCH.
const DEAD_PID = 2_000_000_000;

async function writeLockFile(lockPath: string, payload: object): Promise<void> {
  await fs.mkdir(path.dirname(lockPath), { recursive: true });
  await fs.writeFile(lockPath, JSON.stringify(payload), "utf8");
}

async function writeBinaryLockFile(lockPath: string): Promise<void> {
  await fs.mkdir(path.dirname(lockPath), { recursive: true });
  await fs.writeFile(lockPath, "not-json", "utf8");
}

describe("checkAndRecoverStaleLocks", () => {
  let sessionsDir: string;

  beforeEach(async () => {
    sessionsDir = await fs.mkdtemp(path.join(os.tmpdir(), "session-lock-hardener-test-"));
  });

  afterEach(async () => {
    vi.clearAllMocks();
    try {
      await fs.rm(sessionsDir, { recursive: true, force: true });
    } catch {
      // best effort
    }
  });

  it("returns empty results when sessions directory does not exist", async () => {
    const missing = path.join(os.tmpdir(), `nonexistent-${Date.now()}`);
    const result = await checkAndRecoverStaleLocks({ sessionsDir: missing });
    expect(result.recovered).toHaveLength(0);
    expect(result.active).toHaveLength(0);
    expect(result.errors).toHaveLength(0);
  });

  it("returns empty results when directory has no lock files", async () => {
    await fs.writeFile(path.join(sessionsDir, "sessions.json"), "{}", "utf8");
    const result = await checkAndRecoverStaleLocks({ sessionsDir });
    expect(result.recovered).toHaveLength(0);
    expect(result.active).toHaveLength(0);
    expect(result.errors).toHaveLength(0);
  });

  it("identifies a stale .jsonl.lock with a dead PID", async () => {
    const lockPath = path.join(sessionsDir, "session-abc.jsonl.lock");
    await writeLockFile(lockPath, {
      pid: DEAD_PID,
      createdAt: new Date(Date.now() - 60_000).toISOString(),
    });

    const result = await checkAndRecoverStaleLocks({
      sessionsDir,
      staleMs: 30_000,
      dryRun: true,
    });

    expect(result.recovered).toHaveLength(1);
    expect(result.recovered[0].isStale).toBe(true);
    expect(result.recovered[0].lockPath).toBe(lockPath);
    // dryRun: file should still exist
    await expect(fs.access(lockPath)).resolves.toBeUndefined();
  });

  it("identifies a stale sessions.json.lock with a dead PID", async () => {
    const lockPath = path.join(sessionsDir, "sessions.json.lock");
    await writeLockFile(lockPath, {
      pid: DEAD_PID,
      createdAt: new Date(Date.now() - 60_000).toISOString(),
    });

    const result = await checkAndRecoverStaleLocks({
      sessionsDir,
      staleMs: 30_000,
      dryRun: true,
    });

    expect(result.recovered).toHaveLength(1);
    expect(result.recovered[0].lockPath).toBe(lockPath);
    expect(result.recovered[0].isStale).toBe(true);
  });

  it("handles both .jsonl.lock and .json.lock in the same directory", async () => {
    const lockA = path.join(sessionsDir, "session-a.jsonl.lock");
    const lockB = path.join(sessionsDir, "sessions.json.lock");
    await writeLockFile(lockA, { pid: DEAD_PID, createdAt: new Date(Date.now() - 60_000).toISOString() });
    await writeLockFile(lockB, { pid: DEAD_PID, createdAt: new Date(Date.now() - 60_000).toISOString() });

    const result = await checkAndRecoverStaleLocks({
      sessionsDir,
      staleMs: 30_000,
      dryRun: true,
    });

    expect(result.recovered).toHaveLength(2);
  });

  it("preserves active locks (current process PID)", async () => {
    const lockPath = path.join(sessionsDir, "session-live.jsonl.lock");
    // Write a lock that looks fresh and belongs to the current process
    await writeLockFile(lockPath, {
      pid: process.pid,
      createdAt: new Date().toISOString(),
    });

    const result = await checkAndRecoverStaleLocks({
      sessionsDir,
      staleMs: 30_000,
      dryRun: false,
    });

    expect(result.active).toHaveLength(1);
    expect(result.active[0].lockPath).toBe(lockPath);
    expect(result.active[0].isStale).toBe(false);
    // File must still exist
    await expect(fs.access(lockPath)).resolves.toBeUndefined();
  });

  it("dryRun=false removes stale lock files", async () => {
    const lockPath = path.join(sessionsDir, "session-stale.jsonl.lock");
    await writeLockFile(lockPath, {
      pid: DEAD_PID,
      createdAt: new Date(Date.now() - 60_000).toISOString(),
    });

    const result = await checkAndRecoverStaleLocks({
      sessionsDir,
      staleMs: 30_000,
      dryRun: false,
    });

    expect(result.recovered).toHaveLength(1);
    await expect(fs.access(lockPath)).rejects.toThrow();
  });

  it("dryRun=true does NOT remove stale lock files", async () => {
    const lockPath = path.join(sessionsDir, "session-nodry.jsonl.lock");
    await writeLockFile(lockPath, {
      pid: DEAD_PID,
      createdAt: new Date(Date.now() - 60_000).toISOString(),
    });

    await checkAndRecoverStaleLocks({
      sessionsDir,
      staleMs: 30_000,
      dryRun: true,
    });

    await expect(fs.access(lockPath)).resolves.toBeUndefined();
  });

  it("handles malformed (non-JSON) lock files without crashing", async () => {
    const lockPath = path.join(sessionsDir, "bad.jsonl.lock");
    await writeBinaryLockFile(lockPath);

    const result = await checkAndRecoverStaleLocks({
      sessionsDir,
      staleMs: 30_000,
      dryRun: true,
    });

    // Non-JSON lock: no PID, so falls back to age check only.
    // The file was just written so it should not be stale by age.
    expect(result.errors).toHaveLength(0);
    // Either active (young) or recovered (old) — both are valid outcomes
    expect(result.recovered.length + result.active.length).toBe(1);
  });

  it("identifies a stale lock by age alone when no PID is present", async () => {
    const lockPath = path.join(sessionsDir, "ageless.jsonl.lock");
    await writeBinaryLockFile(lockPath);

    // Backdate the mtime to look old
    const oldTime = new Date(Date.now() - 120_000);
    await fs.utimes(lockPath, oldTime, oldTime);

    const result = await checkAndRecoverStaleLocks({
      sessionsDir,
      staleMs: 30_000,
      dryRun: true,
    });

    expect(result.recovered).toHaveLength(1);
    expect(result.recovered[0].isStale).toBe(true);
  });

  it("emits a HillclawError when a stale lock is removed (dryRun=false)", async () => {
    const { emitHillclawError } = await import("../infra/hillclaw-error-handler.js");
    const lockPath = path.join(sessionsDir, "emit-test.jsonl.lock");
    await writeLockFile(lockPath, {
      pid: DEAD_PID,
      createdAt: new Date(Date.now() - 60_000).toISOString(),
    });

    await checkAndRecoverStaleLocks({ sessionsDir, staleMs: 30_000, dryRun: false });
    expect(emitHillclawError).toHaveBeenCalledOnce();
  });

  it("does NOT emit a HillclawError in dryRun mode", async () => {
    const { emitHillclawError } = await import("../infra/hillclaw-error-handler.js");
    const lockPath = path.join(sessionsDir, "emit-dry.jsonl.lock");
    await writeLockFile(lockPath, {
      pid: DEAD_PID,
      createdAt: new Date(Date.now() - 60_000).toISOString(),
    });

    await checkAndRecoverStaleLocks({ sessionsDir, staleMs: 30_000, dryRun: true });
    expect(emitHillclawError).not.toHaveBeenCalled();
  });
});

describe("cleanupOrphanedLocks", () => {
  let sessionsDir: string;

  beforeEach(async () => {
    sessionsDir = await fs.mkdtemp(path.join(os.tmpdir(), "cleanup-orphan-test-"));
  });

  afterEach(async () => {
    vi.clearAllMocks();
    try {
      await fs.rm(sessionsDir, { recursive: true, force: true });
    } catch {
      // best effort
    }
  });

  it("returns 0 when there are no stale locks", async () => {
    const count = await cleanupOrphanedLocks(sessionsDir);
    expect(count).toBe(0);
  });

  it("removes stale locks and returns their count", async () => {
    const lockA = path.join(sessionsDir, "a.jsonl.lock");
    const lockB = path.join(sessionsDir, "b.jsonl.lock");
    await writeLockFile(lockA, { pid: DEAD_PID, createdAt: new Date(Date.now() - 60_000).toISOString() });
    await writeLockFile(lockB, { pid: DEAD_PID, createdAt: new Date(Date.now() - 60_000).toISOString() });

    const count = await cleanupOrphanedLocks(sessionsDir);
    expect(count).toBe(2);

    await expect(fs.access(lockA)).rejects.toThrow();
    await expect(fs.access(lockB)).rejects.toThrow();
  });

  it("returns 0 when directory does not exist", async () => {
    const missing = path.join(os.tmpdir(), `no-dir-${Date.now()}`);
    const count = await cleanupOrphanedLocks(missing);
    expect(count).toBe(0);
  });

  it("preserves active locks belonging to the current process", async () => {
    const lockPath = path.join(sessionsDir, "live.jsonl.lock");
    await writeLockFile(lockPath, {
      pid: process.pid,
      createdAt: new Date().toISOString(),
    });

    const count = await cleanupOrphanedLocks(sessionsDir);
    expect(count).toBe(0);
    await expect(fs.access(lockPath)).resolves.toBeUndefined();
  });
});
