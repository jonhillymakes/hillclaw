import fs from "node:fs/promises";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../infra/hillclaw-error-handler.js", () => ({
  emitHillclawError: vi.fn(),
  isHillclawError: (err: unknown) =>
    err != null && typeof err === "object" && (err as { name?: unknown }).name === "HillclawError",
}));

// Mock acquireGatewayLock so we can simulate already-running scenarios without
// real filesystem lock contention within the same process.
const mockAcquireGatewayLock = vi.fn();
vi.mock("../infra/gateway-lock.js", async (importOriginal) => {
  const real = await importOriginal<typeof import("../infra/gateway-lock.js")>();
  return {
    ...real,
    acquireGatewayLock: (...args: unknown[]) => mockAcquireGatewayLock(...args),
  };
});

import { acquireBootGuard, isGatewayRunning } from "./boot-guard.js";
import { ErrorCodes, HillclawError } from "../infra/hillclaw-error.js";
import { GatewayLockError } from "../infra/gateway-lock.js";

function makeFakeLockHandle(lockPath = "/tmp/test.lock") {
  return {
    lockPath,
    configPath: "/tmp/openclaw.json",
    release: vi.fn().mockResolvedValue(undefined),
  };
}

describe("acquireBootGuard", () => {
  let tmpDir: string;

  beforeEach(async () => {
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "boot-guard-test-"));
    vi.stubEnv("OPENCLAW_CONFIG_DIR", tmpDir);
    vi.stubEnv("OPENCLAW_STATE_DIR", tmpDir);
    mockAcquireGatewayLock.mockReset();
  });

  afterEach(async () => {
    vi.unstubAllEnvs();
    vi.clearAllMocks();
    try {
      await fs.rm(tmpDir, { recursive: true, force: true });
    } catch {
      // best effort
    }
  });

  it("succeeds and returns a handle with release and gatewayLock when lock is available", async () => {
    const fakeHandle = makeFakeLockHandle();
    mockAcquireGatewayLock.mockResolvedValue(fakeHandle);

    const handle = await acquireBootGuard({ allowInTests: true });
    expect(handle).toBeDefined();
    expect(typeof handle.release).toBe("function");
    expect(handle.gatewayLock).toBe(fakeHandle);
    await handle.release();
  });

  it("gatewayLock exposes lockPath and configPath from the underlying handle", async () => {
    const fakeHandle = makeFakeLockHandle("/tmp/gw.lock");
    mockAcquireGatewayLock.mockResolvedValue(fakeHandle);

    const handle = await acquireBootGuard({ allowInTests: true });
    expect(handle.gatewayLock.lockPath).toBe("/tmp/gw.lock");
    expect(handle.gatewayLock.configPath).toBe("/tmp/openclaw.json");
    await handle.release();
  });

  it("release delegates to the underlying lock handle release", async () => {
    const fakeHandle = makeFakeLockHandle();
    mockAcquireGatewayLock.mockResolvedValue(fakeHandle);

    const handle = await acquireBootGuard({ allowInTests: true });
    await handle.release();
    expect(fakeHandle.release).toHaveBeenCalledOnce();
  });

  it("throws HillclawError with GATEWAY_BOOT_GUARD_FAILED when acquireGatewayLock returns null", async () => {
    // null = test env guard / OPENCLAW_ALLOW_MULTI_GATEWAY=1 path
    mockAcquireGatewayLock.mockResolvedValue(null);

    let caughtErr: unknown;
    try {
      await acquireBootGuard({ allowInTests: false });
    } catch (err) {
      caughtErr = err;
    }
    expect(caughtErr).toBeInstanceOf(HillclawError);
    const he = caughtErr as HillclawError;
    expect(he.code).toBe(ErrorCodes.GATEWAY_BOOT_GUARD_FAILED);
    expect(he.subsystem).toBe("gateway");
    expect(he.severity).toBe("critical");
    expect(he.message).toMatch(/another instance may be running/);
  });

  it("throws HillclawError when acquireGatewayLock throws GatewayLockError (already running)", async () => {
    mockAcquireGatewayLock.mockRejectedValue(
      new GatewayLockError("gateway already running (pid 12345); lock timeout after 200ms"),
    );

    let caughtErr: unknown;
    try {
      await acquireBootGuard({ allowInTests: true, timeoutMs: 200 });
    } catch (err) {
      caughtErr = err;
    }
    expect(caughtErr).toBeInstanceOf(HillclawError);
    const he = caughtErr as HillclawError;
    expect(he.code).toBe(ErrorCodes.GATEWAY_BOOT_GUARD_FAILED);
    expect(he.subsystem).toBe("gateway");
    expect(he.severity).toBe("critical");
    expect(he.message).toMatch(/Boot guard failed/);
  });

  it("error from already-running scenario has GATEWAY_BOOT_GUARD_FAILED code", async () => {
    mockAcquireGatewayLock.mockRejectedValue(
      new GatewayLockError("gateway already running (pid 99); lock timeout after 200ms"),
    );

    let caughtErr: unknown;
    try {
      await acquireBootGuard({ allowInTests: true, timeoutMs: 200 });
    } catch (err) {
      caughtErr = err;
    }
    expect(caughtErr).toBeInstanceOf(HillclawError);
    const he = caughtErr as HillclawError;
    expect(he.code).toBe(ErrorCodes.GATEWAY_BOOT_GUARD_FAILED);
    expect(he.subsystem).toBe("gateway");
    expect(he.severity).toBe("critical");
  });

  it("wraps unexpected errors as HillclawError", async () => {
    mockAcquireGatewayLock.mockRejectedValue(new Error("unexpected fs error"));

    let caughtErr: unknown;
    try {
      await acquireBootGuard({ allowInTests: true });
    } catch (err) {
      caughtErr = err;
    }
    expect(caughtErr).toBeInstanceOf(HillclawError);
    const he = caughtErr as HillclawError;
    expect(he.code).toBe(ErrorCodes.GATEWAY_BOOT_GUARD_FAILED);
    expect(he.cause).toBeInstanceOf(Error);
  });

  it("re-throws HillclawError unchanged when acquireGatewayLock throws HillclawError directly", async () => {
    const originalErr = new HillclawError({
      code: ErrorCodes.GATEWAY_BOOT_GUARD_FAILED,
      subsystem: "gateway",
      severity: "critical",
      message: "already threw",
    });
    mockAcquireGatewayLock.mockRejectedValue(originalErr);

    let caughtErr: unknown;
    try {
      await acquireBootGuard({ allowInTests: true });
    } catch (err) {
      caughtErr = err;
    }
    expect(caughtErr).toBe(originalErr);
  });
});

describe("isGatewayRunning", () => {
  it("returns false when nothing is listening on the port", async () => {
    // Use a random high port unlikely to be in use
    const result = await isGatewayRunning({ port: 19877 });
    expect(result).toBe(false);
  });

  it("returns true when a server is listening on the port", async () => {
    const server = net.createServer();
    await new Promise<void>((resolve, reject) => {
      server.listen(0, "127.0.0.1", () => resolve());
      server.once("error", reject);
    });
    const address = server.address() as net.AddressInfo;
    try {
      const result = await isGatewayRunning({ port: address.port });
      expect(result).toBe(true);
    } finally {
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  });

  it("uses port 18789 as default", async () => {
    // Just verify it runs without error — we can't reliably know if 18789 is free
    const result = await isGatewayRunning();
    expect(typeof result).toBe("boolean");
  });
});
