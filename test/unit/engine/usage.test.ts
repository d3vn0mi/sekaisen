import { afterEach, describe, expect, it } from "vitest";
import { parseReset } from "../../../src/engine/classify.js";
import type {
  AgentStage,
  Definition,
  ProviderPolicy,
} from "../../../src/format/types.js";
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

const MIN = 60_000;

const live = (r: Rig, runId: string) => r.engine.status(runId).live;

const eventsOf = (r: Rig, runId: string) =>
  r.store.tx((t) => t.transitions(runId).map((x) => x.event));

function agent(def: Definition, id: string): AgentStage {
  const stage = def.stages[id];
  if (stage?.type !== "agent") throw new Error("fixture changed");
  return stage;
}

/** Registers a copy of the review loop as pipeline `id` under `providers`. */
async function pipeline(
  r: Rig,
  id: string,
  providers: ProviderPolicy,
  edit: (def: Definition) => void = () => {},
): Promise<void> {
  r.source.defs.set(
    id,
    await variant(`h-${id}`, (def) => {
      def.id = id;
      def.providers = providers;
      edit(def);
    }),
  );
}

/** Starts a run of `id` and dispatches it; its token and harness run id. */
async function startedOn(
  r: Rig,
  id: string,
): Promise<{ runId: string; token: string; adapterRunId: string }> {
  const { runId } = await r.engine.startRun(id, { topic: "t" });
  await r.engine.tick();
  const row = live(r, runId);
  const call = r.adapter.calls.findLast((c) => c.sessionKey.includes(runId));
  return {
    runId,
    token: call ? tokenOf(call.message) : "",
    adapterRunId: row?.adapterRunId ?? "",
  };
}

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
    // 10am passed two hours ago: tomorrow.
    expect(parseReset("You've hit your limit · resets 10am", NOW)).toBe(
      at("2026-11-23T10:00:00Z"),
    );
    expect(parseReset("resets 12:30pm", NOW)).toBe(at("2026-11-22T12:30:00Z"));
    expect(parseReset("resets 12am", NOW)).toBe(at("2026-11-23T00:00:00Z"));
  });

  it("reads a time of day in a named time zone", () => {
    // 12:00Z is 13:00 in Berlin (CET, UTC+1).
    expect(parseReset("resets 7:30pm (Europe/Berlin)", NOW)).toBe(
      at("2026-11-22T18:30:00Z"),
    );
    expect(parseReset("resets 11am (Europe/Berlin)", NOW)).toBe(
      at("2026-11-23T10:00:00Z"),
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

  it("a reset that passed within the hour pauses five minutes", () => {
    const FIVE_MIN = 300_000;
    // Exactly at the reset instant, and four seconds after it.
    expect(parseReset("resets 12pm", NOW)).toBe(NOW + FIVE_MIN);
    expect(parseReset("resets 12pm", NOW + 4000)).toBe(NOW + 4000 + FIVE_MIN);
    expect(parseReset("resets 1pm (Europe/Berlin)", NOW)).toBe(NOW + FIVE_MIN);
    // One hour is the edge of the grace; past it, the next day's reset.
    expect(parseReset("resets 11am", NOW)).toBe(NOW + FIVE_MIN);
    expect(parseReset("resets 11am", NOW + 1)).toBe(at("2026-11-23T11:00:00Z"));
    // Yesterday's 11:59pm read just after midnight.
    const night = at("2026-11-23T00:20:00Z");
    expect(parseReset("resets 11:59pm", night)).toBe(night + FIVE_MIN);
    // Dated forms get the same grace.
    expect(parseReset("resets 2026-11-22T11:59:56Z", NOW)).toBe(NOW + FIVE_MIN);
    expect(parseReset("resets Nov 22, 12pm (UTC)", NOW + 4000)).toBe(
      NOW + 4000 + FIVE_MIN,
    );
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
      "resets 2026-11-22T10:00:00Z",
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
      { scope: "policy", key: "included", pausedUntil: NOW + HOUR },
    ]);
    expect(check).toMatchObject({
      stage: "check",
      state: "submitted",
      waitReason: "paused:policy:included",
    });
    expect(r.adapter.calls).toHaveLength(1);
    const ended = r.engine
      .status(runId)
      .transitions.find((x) => x.event === "turn_ended");
    expect(ended?.detail).toMatchObject({
      provider: "metered-key",
      degraded: true,
      paused: "policy:included",
    });

    r.clock.advance(HOUR);
    await r.engine.tick();
    expect(r.adapter.calls).toHaveLength(2);
    expect(rows(r.store, runId)[1]).toMatchObject({
      state: "working",
      waitReason: null,
      heldSince: null,
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

  it("an allow list pauses its policy on a turn outside it, without a retry", async () => {
    const r = await make();
    await pipeline(r, "review-loop", { allow: ["key-1", "included", "key-1"] });
    const { runId } = await started(r);
    r.adapter.setOutcome("fr_1", {
      state: "ended",
      ending: "ok",
      runtime: { provider: "key-1", model: "m" },
    });
    await r.engine.tick();
    expect(limits(r)).toEqual([]);
    // The no_result retry runs and lands on a provider outside the list,
    // without completing: usage_limited, so the last retry is not spent.
    r.adapter.setOutcome("fr_2", {
      state: "ended",
      ending: "ok",
      runtime: { provider: "key-2", model: "m" },
    });
    await r.engine.tick();
    expect(limits(r)).toMatchObject([
      { scope: "policy", key: "included,key-1", pausedUntil: NOW + HOUR },
    ]);
    const all = rows(r.store, runId);
    expect(all).toHaveLength(2);
    expect(all[1]).toMatchObject({
      state: "submitted",
      retryIndex: 1,
      waitReason: "paused:policy:included,key-1",
      turnsUsed: 0,
    });
    expect(r.engine.status(runId).run.status).toBe("working");
    const ending = r.engine
      .status(runId)
      .transitions.filter((x) => x.event === "usage_limited");
    expect(ending.map((x) => x.detail)).toMatchObject([
      { policy: "included,key-1", until: NOW + HOUR, degraded: true },
    ]);
  });

  it("a degraded turn with a fresh note continues once the policy is released", async () => {
    const r = await make();
    await pipeline(r, "review-loop", "subscription", (def) => {
      agent(def, "draft").turns.max = 2;
    });
    const { runId, token } = await started(r);
    await r.engine.progress({ token, note: "half done" });
    r.adapter.setOutcome("fr_1", {
      state: "ended",
      ending: "ok",
      runtime: { provider: "metered-key", model: "m2" },
    });
    await r.engine.tick();
    let [row, ...others] = rows(r.store, runId);
    expect(others).toEqual([]);
    expect(row).toMatchObject({
      state: "submitted",
      retryIndex: 0,
      turnsUsed: 1,
      waitReason: "paused:policy:included",
      heldSince: NOW,
    });
    expect(r.adapter.calls).toHaveLength(1);

    r.clock.advance(HOUR);
    await r.engine.tick();
    expect(r.adapter.calls).toHaveLength(2);
    const next = r.adapter.calls[1];
    expect(next?.idempotencyKey).toBe(`${runId}:draft:1:2`);
    expect(next?.message).toContain("half done");
    expect(tokenOf(next?.message ?? "")).toBe(token);
    [row] = rows(r.store, runId);
    expect(row).toMatchObject({ state: "working", turnsUsed: 2 });
  });
});

describe("limits across pipelines", () => {
  it("a degraded turn pauses its policy and never a fleet pipeline", async () => {
    const r = await make();
    await pipeline(r, "sub", "subscription");
    await pipeline(r, "fleet", "fleet");
    await pipeline(r, "same-set", { allow: ["included"] });
    await pipeline(r, "other-set", { allow: ["key-1"] });
    const sub = await startedOn(r, "sub");
    await r.engine.complete({
      token: sub.token,
      outcome: "drafted",
      fields: { pr_url: "u" },
    });
    r.adapter.setOutcome(sub.adapterRunId, {
      state: "ended",
      ending: "ok",
      runtime: { provider: "metered-key", model: "m" },
    });
    await r.engine.tick();
    expect(limits(r)).toMatchObject([{ scope: "policy", key: "included" }]);

    expect(live(r, (await startedOn(r, "fleet")).runId)).toMatchObject({
      state: "working",
    });
    expect(live(r, (await startedOn(r, "other-set")).runId)).toMatchObject({
      state: "working",
    });
    for (const id of ["sub", "same-set"]) {
      expect(live(r, (await startedOn(r, id)).runId)).toMatchObject({
        state: "submitted",
        waitReason: "paused:policy:included",
      });
    }
  });

  it("a refusal holds every fleet pipeline and the policies that allow its provider", async () => {
    const r = await make();
    await pipeline(r, "fleet-a", "fleet");
    await pipeline(r, "fleet-b", "fleet");
    await pipeline(r, "sub", "subscription");
    await pipeline(r, "key-2-only", { allow: ["key-2"] });
    const a = await startedOn(r, "fleet-a");
    r.adapter.setOutcome(a.adapterRunId, {
      state: "ended",
      ending: "error",
      error: "You've hit your usage limit · resets 6pm",
      runtime: { provider: "key-2", model: "m" },
    });
    await r.engine.tick();
    expect(limits(r)).toMatchObject([{ scope: "provider", key: "key-2" }]);
    for (const id of ["fleet-b", "key-2-only"]) {
      expect(live(r, (await startedOn(r, id)).runId)).toMatchObject({
        state: "submitted",
        waitReason: "paused:provider:key-2",
      });
    }
    expect(live(r, (await startedOn(r, "sub")).runId)).toMatchObject({
      state: "working",
    });
  });

  it("a continuation held by another run's refusal does not time out", async () => {
    const r = await make();
    await pipeline(r, "fleet-a", "fleet");
    await pipeline(r, "fleet-b", "fleet", (def) => {
      agent(def, "draft").turns.max = 2;
    });
    const a = await startedOn(r, "fleet-a");
    const b = await startedOn(r, "fleet-b");
    expect(live(r, b.runId)?.deadlineAt).toBe(NOW + 30 * MIN);
    await r.engine.progress({ token: b.token, note: "part one" });
    r.adapter.setOutcome(a.adapterRunId, {
      state: "ended",
      ending: "error",
      error: "You've hit your limit · resets 2026-11-22T14:00:00Z",
    });
    r.adapter.setOutcome(b.adapterRunId, { state: "ended", ending: "ok" });
    await r.engine.tick();
    expect(live(r, b.runId)).toMatchObject({
      state: "submitted",
      waitReason: "paused:provider:included",
      heldSince: NOW,
    });

    // Well past B's deadline while held: no timeout.
    r.clock.set(NOW + HOUR);
    await r.engine.tick();
    expect(live(r, b.runId)).toMatchObject({ state: "submitted" });
    expect(eventsOf(r, b.runId)).not.toContain("timeout");

    // Released: the held two hours are added to the deadline.
    r.clock.set(NOW + 2 * HOUR);
    await r.engine.tick();
    expect(live(r, b.runId)).toMatchObject({
      state: "working",
      heldSince: null,
      deadlineAt: NOW + 30 * MIN + 2 * HOUR,
    });
    expect(eventsOf(r, b.runId)).not.toContain("timeout");
  });

  it("a held subscription continuation keeps its remaining budget", async () => {
    const r = await make();
    await pipeline(r, "review-loop", "subscription", (def) => {
      agent(def, "draft").turns.max = 2;
    });
    const { runId, token } = await started(r);
    await r.engine.progress({ token, note: "outline" });
    r.clock.advance(10 * MIN);
    r.adapter.setOutcome("fr_1", {
      state: "ended",
      ending: "ok",
      runtime: { provider: "metered-key", model: "m" },
    });
    await r.engine.tick();
    expect(live(r, runId)).toMatchObject({
      state: "submitted",
      heldSince: NOW + 10 * MIN,
      deadlineAt: NOW + 30 * MIN,
    });
    r.clock.set(NOW + 40 * MIN);
    await r.engine.tick();
    expect(live(r, runId)?.state).toBe("submitted");
    // The policy pause ends an hour after it began.
    r.clock.set(NOW + 70 * MIN);
    await r.engine.tick();
    expect(live(r, runId)).toMatchObject({
      state: "working",
      turnsUsed: 2,
      deadlineAt: NOW + 90 * MIN,
    });
    expect(eventsOf(r, runId)).not.toContain("timeout");
  });
});
