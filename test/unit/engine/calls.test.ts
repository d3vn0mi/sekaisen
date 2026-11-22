import { describe, expect, it } from "vitest";
import { eachLimit } from "../../../src/engine/calls.js";

describe("eachLimit", () => {
  it("finishes every item before it rethrows the first error", async () => {
    const done: number[] = [];
    const run = eachLimit([1, 2, 3, 4, 5], 2, async (n) => {
      await new Promise((r) => setImmediate(r));
      if (n === 1) throw new Error("first");
      if (n === 3) throw new Error("second");
      done.push(n);
    });
    await expect(run).rejects.toThrow("first");
    expect(done.sort()).toEqual([2, 4, 5]);
  });

  it("keeps at most `limit` calls in flight", async () => {
    let open = 0;
    let most = 0;
    await eachLimit([1, 2, 3, 4, 5, 6], 3, async () => {
      open += 1;
      most = Math.max(most, open);
      await new Promise((r) => setImmediate(r));
      open -= 1;
    });
    expect(most).toBe(3);
  });
});
