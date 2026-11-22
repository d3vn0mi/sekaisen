import { afterEach, describe, expect, it } from "vitest";
import { parseReset } from "../../../src/engine/classify.js";
import type { StageRunRow, Store } from "../../../src/store/types.js";
import {
  lastToken,
  type Rig,
  rig,
  tokenOf,
  variant,
} from "./engine-helpers.js";

const rigs: Rig[] = [];
async function make(): Promise<Rig> {
  const r = await rig();
  r.clock.set(NOW);
  r.adapter.caps = { ...r.adapter.caps, subscriptionProvider: "included" };
  rigs.push(r);
  return r;
}
afterEach(async () => {
  for (const r of rigs.splice(0)) {
    await r.engine.stop();
    r.store.close();
  }
});

const HOUR = 3_600_000;
/** 2026-11-22T12:00:00Z, a Sunday. */
const NOW = Date.UTC(2026, 10, 22, 12);

async function started(r: Rig): Promise<{ runId: string; token: string }> {
  const { runId } = await r.engine.startRun("review-loop", { topic: "rust" });
  await r.engine.tick();
  return { runId, token: lastToken(r.adapter) };
}

const rows = (store: Store, runId: string): StageRunRow[] =>
  store.tx((t) =>
    t.listStageRuns({ limit: 100 }).filter((s) => s.runId === runId),
  );

const limits = (r: Rig) => r.store.tx((t) => t.listLimits(r.clock.now()));

describe("parseReset", () => {
  const at = (iso: string) => Date.parse(iso);

  it("reads an ISO instant", () => {
    expect(
      parseReset("You've hit your limit · resets 2026-11-22T18:00:00Z", NOW),
    ).toBe(at("2026-11-22T18:00:00Z"));
    expect(parseReset("resets 2026-11-23T01:30:00+02:00", NOW)).toBe(
      at("2026-11-22T23:30:00Z"),
    );
  });

  it("reads a time of day as its next occurrence, in UTC by default", () => {
    expect(parseReset("You've hit your limit · resets 7pm", NOW)).toBe(
      at("2026-11-22T19:00:00Z"),
    );
    // 11am has already passed today: tomorrow.
    expect(parseReset("You've hit your limit · resets 11am", NOW)).toBe(
      at("2026-11-23T11:00:00Z"),
    );
    expect(parseReset("resets 12:30pm", NOW)).toBe(at("2026-11-22T12:30:00Z"));
    expect(parseReset("resets 12am", NOW)).toBe(at("2026-11-23T00:00:00Z"));
  });

  it("reads a time of day in a named time zone", () => {
    // 12:00Z is 13:00 in Berlin (CET, UTC+1).
    expect(parseReset("resets 7:30pm (Europe/Berlin)", NOW)).toBe(
      at("2026-11-22T18:30:00Z"),
    );
    expect(parseReset("resets 1pm (Europe/Berlin)", NOW)).toBe(
      at("2026-11-23T12:00:00Z"),
    );
    // Across a daylight-saving change: New York is UTC-4 now but UTC-5
    // after 2am on 2026-11-01.
    expect(
      parseReset(
        "resets 9am (America/New_York)",
        Date.parse("2026-10-31T20:00:00Z"),
      ),
    ).toBe(at("2026-11-01T14:00:00Z"));
  });

  it("reads a date and time in a named time zone", () => {
    const refusal =
      "Error: You've hit your weekly limit · resets Nov 1, 7pm (Europe/Berlin)";
    expect(parseReset(refusal, Date.parse("2026-10-30T09:00:00Z"))).toBe(
      at("2026-11-01T18:00:00Z"),
    );
    // Late December: January is next year.
    expect(
      parseReset(
        "resets Jan 2, 9:15am (UTC)",
        Date.parse("2026-12-30T10:00:00Z"),
      ),
    ).toBe(at("2027-01-02T09:15:00Z"));
    // Summer time: Berlin is UTC+2 in July.
    expect(
      parseReset(
        "resets Jul 4, 6am (Europe/Berlin)",
        Date.parse("2027-06-30T12:00:00Z"),
      ),
    ).toBe(at("2027-07-04T04:00:00Z"));
  });

  it("takes the phrase from the refusal line of a longer error", () => {
    const error =
      "turn failed\nYou've hit your usage limit · resets 9pm\nretrying never resets anything";
    expect(parseReset(error, NOW)).toBe(at("2026-11-22T21:00:00Z"));
  });

  it("anything unusable pauses one hour", () => {
    for (const error of [
      "",
      "You've hit your limit",
      "You've hit your limit · resets soon",
      "resets 7pm (Mars/Olympus)",
      "resets 13pm",
      "resets Foo 3, 7pm",
      "resets Feb 30, 7pm",
      "resets 2026-11-22T18:00:00",
      // A date already well past is stale, not a year away.
      "resets Nov 1, 7pm (Europe/Berlin)",
      "resets 2026-11-22T11:00:00Z",
    ]) {
      expect(parseReset(error, NOW), error).toBe(NOW + HOUR);
    }
  });
});

describe("usage limits", () => {
  it("refused turn pauses the provider until the parsed reset and does not consume a retry", async () => {
    const r = await make();
    const { runId, token } = await started(r);
    r.adapter.setOutcome("fr_1", {
      state: "ended",
      ending: "error",
      error: "You've hit your weekly limit · resets 2026-11-22T18:00:00Z",
      runtime: { provider: "included", model: "m1" },
    });
    await r.engine.tick();

    let [row, ...others] = rows(r.store, runId);
    expect(others).toEqual([]);
    expect(row).toMatchObject({
      attempt: 1,
      retryIndex: 0,
      state: "submitted",
      waitReason: "paused:provider:included",
      runtime: { provider: "included", model: "m1" },
      turnsUsed: 0,
      deadlineAt: null,
    });
    expect(row?.ending).toBeUndefined();
    expect(limits(r)).toEqual([
      {
        scope: "provider",
        key: "included",
        pausedUntil: Date.parse("2026-11-22T18:00:00Z"),
        reason: "You've hit your weekly limit · resets 2026-11-22T18:00:00Z",
        setAt: NOW,
      },
    ]);
    const ending = r.engine
      .status(runId)
      .transitions.filter((x) => x.event === "usage_limited");
    expect(ending.map((x) => [x.fromState, x.toState])).toEqual([
      ["working", "submitted"],
    ]);
    expect(ending[0]?.detail).toMatchObject({
      provider: "included",
      until: Date.parse("2026-11-22T18:00:00Z"),
    });

    // Held while the pause lasts.
    r.clock.set(Date.parse("2026-11-22T17:59:59Z"));
    await r.engine.tick();
    expect(r.adapter.calls).toHaveLength(1);

    // Resent after the reset: a new turn key, the same token, the full brief.
    r.clock.set(Date.parse("2026-11-22T18:00:00Z"));
    await r.engine.tick();
    expect(r.adapter.calls).toHaveLength(2);
    const resent = r.adapter.calls[1];
    expect(resent?.idempotencyKey).toBe(`${runId}:draft:1:2`);
    expect(tokenOf(resent?.message ?? "")).toBe(token);
    expect(resent?.message).toContain("Write a short draft");
    [row] = rows(r.store, runId);
    expect(row).toMatchObject({
      state: "working",
      attempt: 1,
      retryIndex: 0,
      dispatchSeq: 2,
      turnsUsed: 1,
      waitReason: null,
    });
    expect(row?.deadlineAt).toBe(Date.parse("2026-11-22T18:30:00Z"));
    expect(
      await r.engine.complete({
        token,
        outcome: "drafted",
        fields: { pr_url: "u" },
      }),
    ).toMatchObject({ ok: true });
  });

  it("unparseable reset pauses one hour", async () => {
    const r = await make();
    const { runId } = await started(r);
    r.adapter.setOutcome("fr_1", {
      state: "ended",
      ending: "killed",
      error: "You've hit your session limit",
    });
    await r.engine.tick();
    expect(limits(r)).toMatchObject([
      { scope: "provider", key: "included", pausedUntil: NOW + HOUR },
    ]);
    expect(rows(r.store, runId)[0]?.waitReason).toBe(
      "paused:provider:included",
    );
  });

  it("a refused turn with no provider anywhere pauses the default provider", async () => {
    const r = await make();
    r.adapter.caps = { ...r.adapter.caps, subscriptionProvider: undefined };
    await started(r);
    r.adapter.setOutcome("fr_1", {
      state: "ended",
      ending: "error",
      error: "You've hit your limit · resets 7pm",
    });
    await r.engine.tick();
    expect(limits(r)).toMatchObject([
      { key: "default", pausedUntil: Date.parse("2026-11-22T19:00:00Z") },
    ]);
  });

  it("fleet policy accepts a metered turn and records its provider", async () => {
    const r = await make();
    const { runId, token } = await started(r);
    await r.engine.complete({
      token,
      outcome: "drafted",
      fields: { pr_url: "u" },
    });
    r.adapter.setOutcome("fr_1", {
      state: "ended",
      ending: "ok",
      runtime: { provider: "metered-key", model: "m2" },
    });
    await r.engine.tick();

    const [draft, check] = rows(r.store, runId);
    expect(draft).toMatchObject({
      state: "completed",
      outcome: "drafted",
      runtime: { provider: "metered-key", model: "m2" },
      dispatchedAt: null,
    });
    expect(limits(r)).toEqual([]);
    expect(check).toMatchObject({ stage: "check", state: "working" });
    const ended = r.engine
      .status(runId)
      .transitions.find((x) => x.event === "turn_ended");
    expect(ended?.detail).toMatchObject({
      provider: "metered-key",
      degraded: false,
    });
    // The turn's end is read once.
    await r.engine.tick();
    expect(
      r.engine
        .status(runId)
        .transitions.filter((x) => x.event === "turn_ended"),
    ).toHaveLength(1);
  });

  it("subscription policy accepts the result but pauses later dispatches", async () => {
    const r = await make();
    r.source.defs.set(
      "review-loop",
      await variant("subscription", (def) => {
        def.providers = "subscription";
      }),
    );
    const { runId, token } = await started(r);
    expect(
      await r.engine.complete({
        token,
        outcome: "drafted",
        fields: { pr_url: "u" },
      }),
    ).toMatchObject({ ok: true, next: "check" });
    r.adapter.setOutcome("fr_1", {
      state: "ended",
      ending: "ok",
      runtime: { provider: "metered-key", model: "m2" },
    });
    await r.engine.tick();

    const [draft, check] = rows(r.store, runId);
    expect(draft).toMatchObject({
      state: "completed",
      outcome: "drafted",
      runtime: { provider: "metered-key", model: "m2" },
    });
    expect(limits(r)).toMatchObject([
      { scope: "provider", key: "included", pausedUntil: NOW + HOUR },
    ]);
    expect(check).toMatchObject({
      stage: "check",
      state: "submitted",
      waitReason: "paused:provider:included",
    });
    expect(r.adapter.calls).toHaveLength(1);
    const ended = r.engine
      .status(runId)
      .transitions.find((x) => x.event === "turn_ended");
    expect(ended?.detail).toMatchObject({
      provider: "metered-key",
      degraded: true,
      paused: "provider:included",
    });

    r.clock.advance(HOUR);
    await r.engine.tick();
    expect(r.adapter.calls).toHaveLength(2);
    expect(rows(r.store, runId)[1]).toMatchObject({
      state: "working",
      waitReason: null,
    });
  });

  it("a subscription turn on the subscription provider pauses nothing", async () => {
    const r = await make();
    r.source.defs.set(
      "review-loop",
      await variant("subscription", (def) => {
        def.providers = "subscription";
      }),
    );
    await started(r);
    r.adapter.setOutcome("fr_1", {
      state: "ended",
      ending: "ok",
      runtime: { provider: "included", model: "m1" },
    });
    await r.engine.tick();
    expect(limits(r)).toEqual([]);
  });

  it("an allow list pauses on a turn outside it", async () => {
    const r = await make();
    r.source.defs.set(
      "review-loop",
      await variant("allow", (def) => {
        def.providers = { allow: ["included", "key-1"] };
      }),
    );
    const { runId } = await started(r);
    r.adapter.setOutcome("fr_1", {
      state: "ended",
      ending: "ok",
      runtime: { provider: "key-1", model: "m" },
    });
    await r.engine.tick();
    expect(limits(r)).toEqual([]);
    // The no_result retry runs and lands on a provider outside the list.
    r.adapter.setOutcome("fr_2", {
      state: "ended",
      ending: "ok",
      runtime: { provider: "key-2", model: "m" },
    });
    await r.engine.tick();
    expect(limits(r)).toMatchObject([{ key: "included" }]);
    expect(r.engine.status(runId).run.status).toBe("failed");
  });
});
