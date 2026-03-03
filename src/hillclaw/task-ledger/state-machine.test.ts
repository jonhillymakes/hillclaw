import { describe, expect, it } from "vitest";
import {
  canTransition,
  assertTransition,
  isTerminalStatus,
  TERMINAL_STATUSES,
} from "./state-machine.js";
import { HillclawError } from "../../infra/hillclaw-error.js";
import type { TaskStatus } from "./types.js";

// All statuses for exhaustive checks
const ALL_STATUSES: TaskStatus[] = [
  "pending", "assigned", "running", "validating", "completed", "failed", "timed_out",
];

const TERMINAL: TaskStatus[] = ["completed", "failed", "timed_out"];
const NON_TERMINAL: TaskStatus[] = ["pending", "assigned", "running", "validating"];

// Encoded valid transitions (from -> to[])
const VALID: [TaskStatus, TaskStatus[]][] = [
  ["pending",    ["assigned", "failed", "timed_out"]],
  ["assigned",   ["running", "failed", "timed_out"]],
  ["running",    ["validating", "completed", "failed", "timed_out"]],
  ["validating", ["completed", "failed", "timed_out"]],
  ["completed",  []],
  ["failed",     []],
  ["timed_out",  []],
];

describe("canTransition - valid transitions", () => {
  for (const [from, tos] of VALID) {
    for (const to of tos) {
      it(`${from} -> ${to} returns true`, () => {
        expect(canTransition(from, to)).toBe(true);
      });
    }
  }
});

describe("canTransition - invalid transitions", () => {
  for (const [from, validTos] of VALID) {
    const invalidTos = ALL_STATUSES.filter(s => !validTos.includes(s) && s !== from);
    for (const to of invalidTos) {
      it(`${from} -> ${to} returns false`, () => {
        expect(canTransition(from, to)).toBe(false);
      });
    }
  }
});

describe("canTransition - self transitions are invalid", () => {
  for (const status of ALL_STATUSES) {
    it(`${status} -> ${status} returns false`, () => {
      expect(canTransition(status, status)).toBe(false);
    });
  }
});

describe("assertTransition - valid transitions do not throw", () => {
  for (const [from, tos] of VALID) {
    for (const to of tos) {
      it(`${from} -> ${to} does not throw`, () => {
        expect(() => assertTransition(from, to, "task-123")).not.toThrow();
      });
    }
  }
});

describe("assertTransition - invalid transitions throw HillclawError", () => {
  const invalidCases: [TaskStatus, TaskStatus][] = [
    ["completed", "running"],
    ["completed", "assigned"],
    ["completed", "pending" as TaskStatus],
    ["failed",    "running"],
    ["failed",    "pending" as TaskStatus],
    ["timed_out", "running"],
    ["timed_out", "assigned"],
    ["pending",   "running"],
    ["pending",   "completed"],
    ["pending",   "validating"],
    ["assigned",  "completed"],
    ["assigned",  "validating"],
  ];

  for (const [from, to] of invalidCases) {
    it(`${from} -> ${to} throws INVALID_TASK_TRANSITION`, () => {
      let caught: HillclawError | undefined;
      try {
        assertTransition(from, to, "task-abc");
      } catch (e) {
        caught = e as HillclawError;
      }
      expect(caught).toBeInstanceOf(HillclawError);
      expect(caught!.code).toBe("INVALID_TASK_TRANSITION");
      expect(caught!.subsystem).toBe("task-ledger");
      expect(caught!.severity).toBe("high");
      expect(caught!.message).toContain("task-abc");
      expect(caught!.message).toContain(from);
      expect(caught!.message).toContain(to);
    });
  }
});

describe("isTerminalStatus", () => {
  for (const status of TERMINAL) {
    it(`${status} is terminal`, () => {
      expect(isTerminalStatus(status)).toBe(true);
    });
  }

  for (const status of NON_TERMINAL) {
    it(`${status} is not terminal`, () => {
      expect(isTerminalStatus(status)).toBe(false);
    });
  }
});

describe("TERMINAL_STATUSES constant", () => {
  it("contains exactly completed, failed, timed_out", () => {
    expect([...TERMINAL_STATUSES].sort()).toEqual(["completed", "failed", "timed_out"].sort());
  });

  it("every entry passes isTerminalStatus", () => {
    for (const s of TERMINAL_STATUSES) {
      expect(isTerminalStatus(s)).toBe(true);
    }
  });

  it("no non-terminal status is in TERMINAL_STATUSES", () => {
    for (const s of NON_TERMINAL) {
      expect(TERMINAL_STATUSES).not.toContain(s);
    }
  });
});
