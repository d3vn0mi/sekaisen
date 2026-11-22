import { describe, expect, it } from "vitest";
import { systemClock, VirtualClock } from "../../../src/engine/clock.js";
import { newRunId, newStageRunId } from "../../../src/engine/ids.js";
import {
  assertTransition,
  IllegalTransition,
  STAGE_RUN_TRANSITIONS,
} from "../../../src/engine/lifecycle.js";
import type { StageRunState } from "../../../src/store/types.js";

const STATES: StageRunState[] = [
  "submitted",
  "working",
  "input_required",
  "completed",
  "failed",
  "canceled",
  "rejected",
];

const LEGAL = new Set([
  "submitted>working",
  "submitted>input_required",
  "submitted>completed",
  "submitted>failed",
  "submitted>canceled",
  "submitted>rejected",
  "working>working",
  "working>completed",
  "working>failed",
  "working>canceled",
  "working>submitted",
  "input_required>completed",
  "input_required>failed",
  "input_required>canceled",
]);

describe("stage run transitions", () => {
  for (const from of STATES) {
    for (const to of STATES) {
      const legal = LEGAL.has(`${from}>${to}`);
      it(`${from} -> ${to} is ${legal ? "legal" : "illegal"}`, () => {
        if (legal) {
          expect(() => assertTransition(from, to)).not.toThrow();
        } else {
          expect(() => assertTransition(from, to)).toThrow(IllegalTransition);
        }
      });
    }
  }

  it("the table covers every state and terminal states have no exits", () => {
    expect(Object.keys(STAGE_RUN_TRANSITIONS).sort()).toEqual(
      [...STATES].sort(),
    );
    for (const s of ["completed", "failed", "canceled", "rejected"] as const) {
      expect(STAGE_RUN_TRANSITIONS[s]).toEqual([]);
    }
  });

  it("the error names both states", () => {
    expect(() => assertTransition("completed", "working")).toThrow(
      "illegal stage run transition completed -> working",
    );
  });
});

describe("clock", () => {
  it("the virtual clock moves only when told to", () => {
    const c = new VirtualClock(100);
    expect(c.now()).toBe(100);
    c.advance(50);
    expect(c.now()).toBe(150);
    c.set(7);
    expect(c.now()).toBe(7);
    expect(() => c.advance(-1)).toThrow();
    expect(() => c.set(Number.NaN)).toThrow();
    expect(() => c.set(Number.POSITIVE_INFINITY)).toThrow();
  });

  it("the system clock reads real time", () => {
    expect(Math.abs(systemClock.now() - Date.now())).toBeLessThan(1000);
  });
});

describe("ids", () => {
  it("are prefixed Crockford base32 and do not repeat", () => {
    const r = newRunId();
    const s = newStageRunId();
    expect(r).toMatch(/^r_[0-9A-HJKMNP-TV-Z]{12}$/);
    expect(s).toMatch(/^s_[0-9A-HJKMNP-TV-Z]{12}$/);
    expect(new Set(Array.from({ length: 500 }, newRunId)).size).toBe(500);
  });
});
