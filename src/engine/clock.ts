/** The engine's only source of time, so tests can run on a virtual one. */
export interface Clock {
  /** Milliseconds since the Unix epoch. */
  now(): number;
}

export const systemClock: Clock = { now: () => Date.now() };

export class VirtualClock implements Clock {
  constructor(private t = 0) {}

  now(): number {
    return this.t;
  }

  advance(ms: number): void {
    if (!Number.isFinite(ms) || ms < 0) {
      throw new Error("a clock cannot advance by a negative amount");
    }
    this.t += ms;
  }

  set(ms: number): void {
    if (!Number.isFinite(ms)) throw new Error("a clock needs a finite time");
    this.t = ms;
  }
}
