import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { HillclawError } from "../infra/hillclaw-error.js";
import { atomicWriteFile, testAtomicRenameSupport } from "./atomic-write.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function uniqueDir(): string {
  return path.join(os.tmpdir(), `hillclaw-atomic-test-${process.pid}-${Date.now()}-${Math.random().toString(36).slice(2)}`);
}

async function listTmpFiles(dir: string): Promise<string[]> {
  try {
    const entries = await fs.promises.readdir(dir);
    return entries.filter((f) => f.startsWith(".tmp."));
  } catch {
    return [];
  }
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("atomicWriteFile", () => {
  let testDir: string;

  beforeEach(async () => {
    testDir = uniqueDir();
    await fs.promises.mkdir(testDir, { recursive: true });
  });

  afterEach(async () => {
    await fs.promises.rm(testDir, { recursive: true, force: true });
  });

  it("writes content correctly", async () => {
    const filePath = path.join(testDir, "target.json");
    const content = JSON.stringify({ hello: "world" });
    await atomicWriteFile(filePath, content);
    const read = await fs.promises.readFile(filePath, "utf8");
    expect(read).toBe(content);
  });

  it("content is never partially written — file is complete after write", async () => {
    const filePath = path.join(testDir, "complete.json");
    const content = "a".repeat(8192); // 8 KB to exercise buffering
    await atomicWriteFile(filePath, content);
    const read = await fs.promises.readFile(filePath, "utf8");
    expect(read).toBe(content);
    expect(read.length).toBe(8192);
  });

  it("cleans up temp file on rename failure", async () => {
    const filePath = path.join(testDir, "target.json");

    // Force rename to always fail
    const origRename = fs.promises.rename;
    vi.spyOn(fs.promises, "rename").mockRejectedValue(
      Object.assign(new Error("rename EBUSY"), { code: "EBUSY" }),
    );

    await expect(
      atomicWriteFile(filePath, "content", { maxRetries: 1 }),
    ).rejects.toBeInstanceOf(HillclawError);

    vi.spyOn(fs.promises, "rename").mockRestore?.();
    // Restore manually in case mockRestore is unavailable on this vi version
    fs.promises.rename = origRename;

    const tmpFiles = await listTmpFiles(testDir);
    expect(tmpFiles).toHaveLength(0);
  });

  it("throws HillclawError on failure", async () => {
    const filePath = path.join(testDir, "target.json");

    const origRename = fs.promises.rename;
    vi.spyOn(fs.promises, "rename").mockRejectedValue(new Error("forced failure"));

    let caught: unknown;
    try {
      await atomicWriteFile(filePath, "data", { maxRetries: 1 });
    } catch (err) {
      caught = err;
    } finally {
      fs.promises.rename = origRename;
    }

    expect(caught).toBeInstanceOf(HillclawError);
    expect((caught as HillclawError).code).toBe("CONFIG_WRITE_FAILED");
    expect((caught as HillclawError).subsystem).toBe("config");
    expect((caught as HillclawError).severity).toBe("critical");
  });

  it("respects file mode", async () => {
    // Mode enforcement is best-effort on Windows; skip stat check there.
    if (process.platform === "win32") {
      const filePath = path.join(testDir, "mode.json");
      await atomicWriteFile(filePath, "data", { mode: 0o644 });
      const stat = await fs.promises.stat(filePath);
      expect(stat.isFile()).toBe(true);
      return;
    }

    const filePath = path.join(testDir, "mode.json");
    await atomicWriteFile(filePath, "data", { mode: 0o644 });
    const stat = await fs.promises.stat(filePath);
    // Lower 9 bits: rwxrwxrwx
    expect(stat.mode & 0o777).toBe(0o644);
  });

  it("retries on rename failure and succeeds on subsequent attempt", async () => {
    const filePath = path.join(testDir, "retry.json");
    const content = "retry-content";

    let callCount = 0;
    const origRename = fs.promises.rename;

    vi.spyOn(fs.promises, "rename").mockImplementation(async (src, dest) => {
      callCount++;
      if (callCount < 2) {
        throw Object.assign(new Error("EBUSY transient"), { code: "EBUSY" });
      }
      return origRename(src, dest);
    });

    try {
      await atomicWriteFile(filePath, content, { maxRetries: 3, retryDelayMs: 1 });
    } finally {
      fs.promises.rename = origRename;
    }

    expect(callCount).toBeGreaterThanOrEqual(2);
    const read = await fs.promises.readFile(filePath, "utf8");
    expect(read).toBe(content);
  });

  it("does not leave temp files behind on success", async () => {
    const filePath = path.join(testDir, "clean.json");
    await atomicWriteFile(filePath, "clean");
    const tmpFiles = await listTmpFiles(testDir);
    expect(tmpFiles).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------

describe("testAtomicRenameSupport", () => {
  let testDir: string;

  beforeEach(async () => {
    testDir = uniqueDir();
    await fs.promises.mkdir(testDir, { recursive: true });
  });

  afterEach(async () => {
    await fs.promises.rm(testDir, { recursive: true, force: true });
  });

  it("returns true on a working filesystem", async () => {
    const result = await testAtomicRenameSupport(testDir);
    expect(result).toBe(true);
  });

  it("cleans up both src and dest test files", async () => {
    await testAtomicRenameSupport(testDir);
    const entries = await fs.promises.readdir(testDir);
    const leftover = entries.filter((f) => f.startsWith(".atomic-test-"));
    expect(leftover).toHaveLength(0);
  });

  it("returns false when rename throws", async () => {
    const origRename = fs.promises.rename;
    vi.spyOn(fs.promises, "rename").mockRejectedValue(new Error("no rename"));
    try {
      const result = await testAtomicRenameSupport(testDir);
      expect(result).toBe(false);
    } finally {
      fs.promises.rename = origRename;
    }
  });
});
