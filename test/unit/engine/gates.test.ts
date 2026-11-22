import { afterEach, describe, expect, it } from "vitest";
import type { EngineEvents } from "../../../src/engine/engine.js";
import type { GateStage } from "../../../src/format/types.js";
import { createRegistry, type FactFn } from "../../../src/host/registry.js";
import type { StageRunRow } from "../../../src/store/types.js";
import { inline, lastToken, type Rig, rig } from "./engine-helpers.js";

const rigs: Rig[] = [];
afterEach(async () => {
  for (const r of rigs.splice(0)) {
    await r.engine.stop();
    r.store.close();
  }
});

const MIN = 60_000;
const HOUR = 60 * MIN;

/** A rig whose `held` pipeline is one gate between start and `done`. */
async function gated(
  gate: Omit<GateStage, "type" | "outcomes"> &
    Partial<Pick<GateStage, "outcomes">>,
  facts: Record<string, FactFn> = {},
): Promise<Rig> {
  const registry = createRegistry();
  for (const [name, fn] of Object.entries(facts)) registry.facts.set(name, fn);
  const r = await rig({ registry });
  rigs.push(r);
  r.source.defs.set(
    "held",
    inline({
      id: "held",
      start: "g",
      stages: {
        g: {
          type: "gate",
          outcomes: { go: { next: "done" } },
          ...gate,
        },
        late: { type: "end", status: "canceled" },
        done: { type: "end", status: "completed" },
        failed: { type: "end", status: "failed" },
      },
    }),
  );
  return r;
}

function gateEvents(r: Rig): Array<EngineEvents["gate"]> {
  const seen: Array<EngineEvents["gate"]> = [];
  r.engine.on("gate", (e) => seen.push(e));
  return seen;
}

const live = (r: Rig, runId: string): StageRunRow => {
  const row = r.engine.status(runId).live;
  if (!row) throw new Error("no live stage run");
  return row;
};

const events = (r: Rig, runId: string): string[] =>
  r.store.tx((t) => t.transitions(runId).map((x) => x.event));

describe("operator gates", () => {
  it("operator gate emits an event and resolves with resolved_by", async () => {
    const r = await rig();
    rigs.push(r);
    const seen = gateEvents(r);
    // Emitted after the commit: a listener already reads the open gate.
    const atEmit: unknown[] = [];
    r.engine.on("gate", (e) => {
      const view = r.engine.status(e.runId);
      atEmit.push([view.run.status, view.live?.state, view.gate?.resolvedBy]);
    });
    const { runId } = await r.engine.startRun("review-loop", { topic: "rust" });
    await r.engine.tick();
    await r.engine.complete({
      token: lastToken(r.adapter),
      outcome: "drafted",
      fields: { pr_url: "u" },
    });
    await r.engine.tick();
    await r.engine.complete({ token: lastToken(r.adapter), outcome: "pass" });
    expect(seen).toEqual([]);
    await r.engine.tick();

    const gate = live(r, runId);
    expect(gate).toMatchObject({ stage: "publish", state: "input_required" });
    expect(seen).toEqual([
      {
        runId,
        stageRunId: gate.stageRunId,
        stage: "publish",
        prompt: "Publish the draft for rust?",
        outcomes: ["approve", "reject"],
      },
    ]);
    expect(atEmit).toEqual([["input_required", "input_required", null]]);
    const view = r.engine.status(runId);
    expect(view.run.status).toBe("input_required");
    expect(view.gate).toMatchObject({
      kind: "operator",
      prompt: "Publish the draft for rust?",
      outcomes: ["approve", "reject"],
      resolvedBy: null,
    });

    await expect(
      r.engine.resolveGate(gate.stageRunId, "ship", "hud"),
    ).rejects.toThrow(
      'unknown outcome "ship" for gate publish; declared outcomes: approve, reject',
    );
    await r.engine.resolveGate(gate.stageRunId, "approve", "hud", "looks good");

    const after = r.engine.status(runId);
    expect(after.run.status).toBe("completed");
    expect(after.live).toBeUndefined();
    const row = r.store.tx((t) => t.getStageRun(gate.stageRunId));
    expect(row).toMatchObject({ state: "completed", outcome: "approve" });
    expect(r.store.tx((t) => t.getGate(gate.stageRunId))).toMatchObject({
      resolvedBy: "hud",
      resolvedAt: 1_000_000,
    });
    const resolved = after.transitions.find((x) => x.event === "gate_resolved");
    expect(resolved).toMatchObject({
      actor: "hud",
      outcome: "approve",
      fromState: "input_required",
      toState: "completed",
      detail: { note: "looks good", next: "done" },
    });
    await expect(
      r.engine.resolveGate(gate.stageRunId, "reject", "telegram:1"),
    ).rejects.toThrow("gate already resolved by hud");
  });

  it("gate reminder fires at remind interval on the virtual clock", async () => {
    const r = await gated({
      who: "operator",
      prompt: "Go?",
      timeout: HOUR,
      onTimeout: { remind: 10 * MIN },
    });
    const seen = gateEvents(r);
    const { runId } = await r.engine.startRun("held", {});
    await r.engine.tick();
    expect(seen).toHaveLength(1);
    const id = live(r, runId).stageRunId;
    expect(r.store.tx((t) => t.getGate(id))?.remindAt).toBe(1_000_000 + HOUR);

    r.clock.advance(HOUR - 1);
    await r.engine.tick();
    expect(seen).toHaveLength(1);
    r.clock.advance(1);
    await r.engine.tick();
    expect(seen).toHaveLength(2);
    expect(seen[1]).toEqual(seen[0]);
    expect(r.store.tx((t) => t.getGate(id))?.remindAt).toBe(
      1_000_000 + HOUR + 10 * MIN,
    );

    r.clock.advance(10 * MIN - 1);
    await r.engine.tick();
    expect(seen).toHaveLength(2);
    r.clock.advance(1);
    await r.engine.tick();
    expect(seen).toHaveLength(3);
    expect(events(r, runId).filter((e) => e === "gate_reminder")).toHaveLength(
      2,
    );
    // Reminding never moves the gate on.
    expect(live(r, runId)).toMatchObject({ state: "input_required" });
    expect(r.engine.status(runId).run.status).toBe("input_required");
  });

  it("a long outage sends one reminder, not one per missed interval", async () => {
    const r = await gated({
      who: "operator",
      timeout: HOUR,
      onTimeout: { remind: 10 * MIN },
    });
    const seen = gateEvents(r);
    const { runId } = await r.engine.startRun("held", {});
    await r.engine.tick();
    r.clock.advance(5 * HOUR);
    await r.engine.tick();
    expect(seen).toHaveLength(2);
    expect(seen[0]?.prompt).toBeNull();
    const id = live(r, runId).stageRunId;
    expect(r.store.tx((t) => t.getGate(id))?.remindAt).toBe(
      1_000_000 + 5 * HOUR + 10 * MIN,
    );
  });

  it("gate timeout with next takes the edge", async () => {
    const r = await gated({
      who: "operator",
      timeout: HOUR,
      onTimeout: { next: "late" },
    });
    const seen = gateEvents(r);
    const { runId } = await r.engine.startRun("held", {});
    await r.engine.tick();
    const id = live(r, runId).stageRunId;
    r.clock.advance(HOUR - 1);
    await r.engine.tick();
    expect(r.engine.status(runId).run.status).toBe("input_required");
    r.clock.advance(1);
    await r.engine.tick();

    expect(seen).toHaveLength(1);
    expect(r.store.tx((t) => t.getStageRun(id))).toMatchObject({
      state: "failed",
      ending: "timeout",
      wakeAt: null,
    });
    const view = r.engine.status(runId);
    expect(view.run).toMatchObject({
      status: "canceled",
      currentStage: "late",
    });
    expect(
      view.transitions.find((x) => x.event === "gate_timeout"),
    ).toMatchObject({
      fromState: "input_required",
      toState: "failed",
      detail: { timeoutAt: 1_000_000 + HOUR, next: "late" },
    });
    await expect(r.engine.resolveGate(id, "go", "hud")).rejects.toThrow(
      "gate already resolved by timeout",
    );
  });

  it("refuses to resolve what is not an open operator gate", async () => {
    const r = await gated({
      who: "operator",
      timeout: HOUR,
      onTimeout: { remind: HOUR },
    });
    const { runId } = await r.engine.startRun("held", {});
    const id = live(r, runId).stageRunId;
    // Not opened until the tick runs it.
    await expect(r.engine.resolveGate(id, "go", "hud")).rejects.toThrow(
      `stage run ${id} is not waiting on a gate`,
    );
    await expect(r.engine.resolveGate("nope", "go", "hud")).rejects.toThrow(
      "unknown stage run nope",
    );
    await r.engine.tick();
    await expect(r.engine.resolveGate(id, "go", "")).rejects.toThrow(
      "resolveGate needs who resolved the gate",
    );
    await r.engine.resolveGate(id, "go", "hud");
    expect(r.engine.status(runId).run.status).toBe("completed");
  });
});

describe("poll gates", () => {
  it("poll gate passes when the fact turns true and backs off on throw", async () => {
    const answers: Array<boolean | Error> = [
      false,
      new Error("down"),
      new Error("down"),
      new Error("still down"),
      new Error("still down"),
      new Error("still down"),
      true,
    ];
    const polledAt: number[] = [];
    let clock = () => 0;
    const r = await gated(
      {
        poll: { fact: "demo.ready", every: MIN },
        timeout: 24 * HOUR,
        onTimeout: { remind: 24 * HOUR },
      },
      {
        "demo.ready": async (ctx) => {
          polledAt.push(clock());
          expect(ctx).toMatchObject({ stage: "g", inputs: {} });
          const a = answers.shift();
          if (a instanceof Error) throw a;
          return a ?? false;
        },
      },
    );
    clock = () => r.clock.now() - 1_000_000;
    const seen = gateEvents(r);
    const { runId } = await r.engine.startRun("held", {});
    // Tick every 30 s for an hour, or until the gate passes.
    for (let i = 0; i < 120 && r.engine.status(runId).live; i++) {
      await r.engine.tick();
      if (r.engine.status(runId).live) {
        expect(r.engine.status(runId).run.status).toBe("working");
      }
      r.clock.advance(MIN / 2);
    }
    // false, then backoff 2x, 4x, 8x, 8x (capped) after throws.
    expect(polledAt.map((t) => t / MIN)).toEqual([0, 1, 3, 7, 15, 23, 31]);
    const view = r.engine.status(runId);
    expect(view.run.status).toBe("completed");
    const pollErrors = r.store.tx((t) =>
      t.transitions(runId).filter((x) => x.event === "poll_error"),
    );
    // Logged on the first failure and when the text changed, not every time.
    expect(
      pollErrors.map((x) => (x.detail as { error: string }).error),
    ).toEqual(["down", "still down"]);
    const passed = view.transitions.find((x) => x.event === "gate_passed");
    expect(passed).toMatchObject({
      actor: "fact:demo.ready",
      outcome: "go",
      fromState: "working",
      toState: "completed",
    });
    const id = passed?.stageRunId ?? "";
    expect(r.store.tx((t) => t.getGate(id))).toMatchObject({
      kind: "poll",
      waitingOn: "fact:demo.ready",
      resolvedBy: "fact:demo.ready",
    });
    expect(seen).toEqual([]);
    await expect(r.engine.resolveGate(id, "go", "hud")).rejects.toThrow(
      "gate already resolved by fact:demo.ready",
    );
  });

  it("a poll gate cannot be resolved by an operator and still times out", async () => {
    const r = await gated(
      {
        poll: { fact: "demo.ready", every: 10 * MIN },
        timeout: HOUR,
        onTimeout: { next: "late" },
      },
      { "demo.ready": async () => false },
    );
    const { runId } = await r.engine.startRun("held", {});
    await r.engine.tick();
    const id = live(r, runId).stageRunId;
    expect(live(r, runId).state).toBe("working");
    await expect(r.engine.resolveGate(id, "go", "hud")).rejects.toThrow(
      `stage run ${id} is a poll gate; it passes when its fact holds`,
    );
    r.clock.advance(HOUR);
    await r.engine.tick();
    expect(r.engine.status(runId).run).toMatchObject({
      status: "canceled",
      currentStage: "late",
    });
    expect(events(r, runId)).toContain("gate_timeout");
  });

  it("a poll gate whose fact is not registered is rejected", async () => {
    const r = await gated({
      poll: { fact: "demo.missing", every: MIN },
      timeout: HOUR,
      onTimeout: { remind: HOUR },
    });
    const { runId } = await r.engine.startRun("held", {});
    await r.engine.tick();
    const view = r.engine.status(runId);
    expect(view.run.status).toBe("failed");
    expect(
      view.transitions.find((x) => x.event === "stage_rejected")?.detail,
    ).toEqual({ reason: "fact demo.missing is not registered" });
  });
});
