import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { rotateBackups } from "./backup-rotation.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function uniqueDir(): string {
  return path.join(
    os.tmpdir(),
    `hillclaw-backup-test-${process.pid}-${Date.now()}-${Math.random().toString(36).slice(2)}`,
  );
}

async function writeFile(filePath: string, content: string): Promise<void> {
  await fs.promises.mkdir(path.dirname(filePath), { recursive: true });
  await fs.promises.writeFile(filePath, content, "utf8");
}

async function readFile(filePath: string): Promise<string | null> {
  try {
    return await fs.promises.readFile(filePath, "utf8");
  } catch {
    return null;
  }
}

async function exists(filePath: string): Promise<boolean> {
  try {
    await fs.promises.access(filePath);
    return true;
  } catch {
    return false;
  }
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("rotateBackups", () => {
  let testDir: string;
  let sourceFile: string;

  beforeEach(async () => {
    testDir = uniqueDir();
    await fs.promises.mkdir(testDir, { recursive: true });
    sourceFile = path.join(testDir, "config.json");
    await writeFile(sourceFile, JSON.stringify({ version: 1 }));
  });

  afterEach(async () => {
    await fs.promises.rm(testDir, { recursive: true, force: true });
  });

  it("creates a backup from the existing file", async () => {
    const result = await rotateBackups(sourceFile);
    expect(result.success).toBe(true);
    const backupContent = await readFile(`${sourceFile}.bak`);
    expect(backupContent).toBe(JSON.stringify({ version: 1 }));
  });

  it("shifts generations correctly: existing .bak becomes .bak.1", async () => {
    // Pre-seed a .bak
    await writeFile(`${sourceFile}.bak`, "gen0");
    await rotateBackups(sourceFile);
    const gen1 = await readFile(`${sourceFile}.bak.1`);
    expect(gen1).toBe("gen0");
  });

  it("shifts .bak.1 -> .bak.2 -> .bak.3 correctly", async () => {
    await writeFile(`${sourceFile}.bak`, "gen0");
    await writeFile(`${sourceFile}.bak.1`, "gen1");
    await writeFile(`${sourceFile}.bak.2`, "gen2");

    await rotateBackups(sourceFile);

    expect(await readFile(`${sourceFile}.bak.1`)).toBe("gen0");
    expect(await readFile(`${sourceFile}.bak.2`)).toBe("gen1");
    expect(await readFile(`${sourceFile}.bak.3`)).toBe("gen2");
  });

  it("deletes the oldest generation when at capacity", async () => {
    // Fill all 3 generations (default maxGenerations=3)
    await writeFile(`${sourceFile}.bak`, "gen0");
    await writeFile(`${sourceFile}.bak.1`, "gen1");
    await writeFile(`${sourceFile}.bak.2`, "gen2");
    await writeFile(`${sourceFile}.bak.3`, "gen3-oldest");

    await rotateBackups(sourceFile);

    // The original "gen3-oldest" content must be gone — .bak.3 now holds
    // whatever was shifted from .bak.2, not the old .bak.3 content.
    const bak3Content = await readFile(`${sourceFile}.bak.3`);
    expect(bak3Content).not.toBe("gen3-oldest");
    // .bak.3 now holds the shifted .bak.2 content
    expect(bak3Content).toBe("gen2");
  });

  it("reports errors without throwing", async () => {
    // Mock copyFile to fail so create-backup step errors
    const origCopyFile = fs.promises.copyFile;
    vi.spyOn(fs.promises, "copyFile").mockRejectedValue(
      Object.assign(new Error("EPERM: operation not permitted"), { code: "EPERM" }),
    );

    let result: Awaited<ReturnType<typeof rotateBackups>>;
    try {
      result = await rotateBackups(sourceFile);
    } finally {
      fs.promises.copyFile = origCopyFile;
    }

    expect(result!.success).toBe(false);
    expect(result!.errors.length).toBeGreaterThan(0);
    expect(result!.errors[0]).toMatch(/Failed to create backup/);
  });

  it("handles missing source file gracefully (no throw)", async () => {
    const missing = path.join(testDir, "nonexistent.json");
    // Should not throw; copyFile ENOENT is silently skipped
    const result = await rotateBackups(missing);
    // ENOENT is swallowed, so no errors array entry and no throw
    expect(result).toBeDefined();
  });

  it("respects maxGenerations option", async () => {
    // With maxGenerations=2, oldest to delete is .bak.2, then .bak.1 shifts into .bak.2
    await writeFile(`${sourceFile}.bak`, "gen0");
    await writeFile(`${sourceFile}.bak.1`, "gen1");
    await writeFile(`${sourceFile}.bak.2`, "gen2-oldest");

    await rotateBackups(sourceFile, { maxGenerations: 2 });

    // "gen2-oldest" content must be gone — .bak.2 now holds the shifted .bak.1 content
    expect(await readFile(`${sourceFile}.bak.2`)).toBe("gen1");
    // .bak.1 now holds the shifted .bak content
    expect(await readFile(`${sourceFile}.bak.1`)).toBe("gen0");
    // No generation spills beyond maxGenerations+1 slot
    expect(await exists(`${sourceFile}.bak.3`)).toBe(false);
  });

  it("counts backups kept correctly in result", async () => {
    // Start fresh: only the source file, no pre-existing backups
    const result = await rotateBackups(sourceFile);
    // After first rotation: .bak is created, no numbered ones
    expect(result.backupsKept).toBe(1);
  });

  it("counts multiple backup generations in result", async () => {
    // Pre-seed two generations
    await writeFile(`${sourceFile}.bak`, "gen0");
    await writeFile(`${sourceFile}.bak.1`, "gen1");

    const result = await rotateBackups(sourceFile);
    // After rotation: .bak (new), .bak.1 (old gen0), .bak.2 (old gen1) = 3
    expect(result.backupsKept).toBe(3);
  });

  it("returns success:true when no errors occur", async () => {
    const result = await rotateBackups(sourceFile);
    expect(result.success).toBe(true);
    expect(result.errors).toHaveLength(0);
  });

  it("new backup contains current source file content", async () => {
    const content = JSON.stringify({ updated: true, timestamp: 12345 });
    await writeFile(sourceFile, content);

    await rotateBackups(sourceFile);

    const backupContent = await readFile(`${sourceFile}.bak`);
    expect(backupContent).toBe(content);
  });
});
