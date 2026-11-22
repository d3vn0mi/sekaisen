import { afterEach, describe, expect, it } from "vitest";
import type { Definition } from "../../../src/format/types.js";
import {
  type ActionFn,
  createRegistry,
  type HostRegistry,
} from "../../../src/host/registry.js";
import type { StageRunRow } from "../../../src/store/types.js";
import { inline, lastToken, type Rig, rig, variant } from "./engine-helpers.js";

const rigs: Rig[] = [];
afterEach(async () => {
  for (const r of rigs.splice(0)) {
    await r.engine.stop();
    r.store.close();
  }
});

/** The review-loop with `onCancel: undo`, an action stage running `demo.undo`. */
async function cancellable(
  setup: (registry: HostRegistry) => void,
  edit: (def: Definition) => void = () => {},
): Promise<Rig> {
  const registry = createRegistry();
  setup(registry);
  const r = await rig({ registry });
  rigs.push(r);
  r.source.defs.set(
    "review-loop",
    await variant("cancellable", (def) => {
      def.onCancel = "undo";
      def.stages.undo = {
        type: "action",
        action: "demo.undo",
        next: "failed",
        retry: { max: 3, on: ["turn_error"] },
      };
      edit(def);
    }),
  );
  return r;
}

const rows = (r: Rig, runId: string): StageRunRow[] =>
  r.store.tx((t) =>
    t.listStageRuns({ limit: 100 }).filter((s) => s.runId === runId),
  );

const events = (r: Rig, runId: string): string[] =>
  r.store.tx((t) => t.transitions(runId).map((x) => x.event));

describe("cancel", () => {
  it("cancel retires the token and runs on_cancel once", async () => {
    const keys: string[] = [];
    const undo: ActionFn = async (ctx) => {
      keys.push(ctx.idempotencyKey);
    };
    const r = await cancellable((reg) => reg.actions.set("demo.undo", undo));
    const { runId } = await r.engine.startRun("review-loop", { topic: "x" });
    await r.engine.tick();
    const token = lastToken(r.adapter);
    const draft = r.engine.status(runId).live;

    await r.engine.cancel(runId, "api");
    expect(r.adapter.aborted).toEqual(["fr_1"]);
    expect(
      r.store.tx((t) => t.getStageRun(draft?.stageRunId ?? "")),
    ).toMatchObject({ state: "canceled", dispatchedAt: null });
    const view = r.engine.status(runId);
    expect(view.run.status).toBe("canceled");
    expect(
      view.transitions.find((x) => x.event === "stage_canceled"),
    ).toMatchObject({
      actor: "api",
      fromState: "working",
      toState: "canceled",
    });
    expect(
      view.transitions.find((x) => x.event === "run_canceled"),
    ).toMatchObject({
      actor: "api",
      fromState: "working",
      toState: "canceled",
    });

    // The token is retired: a late completion is refused and logged.
    const late = await r.engine.complete({
      token,
      outcome: "drafted",
      fields: { pr_url: "u" },
    });
    expect(late).toEqual({
      ok: false,
      error: "this attempt has ended (canceled)",
    });
    expect(events(r, runId)).toContain("completion_refused");

    await r.engine.tick();
    await r.engine.tick();
    expect(keys).toEqual([`${runId}:cancel`]);
    const undoRow = rows(r, runId).find((x) => x.stage === "undo");
    expect(undoRow).toMatchObject({
      state: "completed",
      idempotencyKey: `${runId}:cancel`,
      wakeAt: null,
    });
    expect(events(r, runId)).toContain("cancel_action_completed");
    // The cancel action never moves the run on.
    expect(r.engine.status(runId).run).toMatchObject({
      status: "canceled",
      endedAt: 1_000_000,
    });
    await expect(r.engine.cancel(runId, "api")).rejects.toThrow(
      `run ${runId} already ended (canceled)`,
    );
    expect(keys).toHaveLength(1);
  });

  it("a cancel while the turn is being started aborts that turn", async () => {
    const r = await cancellable((reg) =>
      reg.actions.set("demo.undo", async () => {}),
    );
    const { runId } = await r.engine.startRun("review-loop", { topic: "x" });
    r.adapter.beforeStart = async () => {
      await r.engine.cancel(runId, "api");
    };
    await r.engine.tick();
    const token = lastToken(r.adapter);

    // The harness started fr_1 after the cancel committed: it is aborted.
    expect(r.adapter.aborted).toEqual(["fr_1"]);
    const draft = rows(r, runId).find((x) => x.stage === "draft");
    expect(draft).toMatchObject({ state: "canceled", adapterRunId: null });
    expect(r.engine.status(runId).run.status).toBe("canceled");
    expect(events(r, runId)).toContain("turn_start_superseded");

    const late = await r.engine.complete({
      token,
      outcome: "drafted",
      fields: { pr_url: "u" },
    });
    expect(late).toEqual({
      ok: false,
      error: "this attempt has ended (canceled)",
    });
    const refused = r.store.tx((t) =>
      t.transitions(runId).find((x) => x.event === "completion_refused"),
    );
    expect(refused).toMatchObject({
      stageRunId: draft?.stageRunId,
      detail: { reason: "attempt ended" },
    });
  });

  it("a cancel action that throws is not retried", async () => {
    let calls = 0;
    const r = await cancellable((reg) =>
      reg.actions.set("demo.undo", async () => {
        calls++;
        throw new Error("cannot close the PR");
      }),
    );
    const { runId } = await r.engine.startRun("review-loop", { topic: "x" });
    await r.engine.cancel(runId, "api");
    for (let i = 0; i < 3; i++) await r.engine.tick();
    expect(calls).toBe(1);
    expect(rows(r, runId).find((x) => x.stage === "undo")).toMatchObject({
      state: "failed",
      ending: "turn_error",
    });
    const failed = r.store.tx((t) =>
      t.transitions(runId).find((x) => x.event === "cancel_action_failed"),
    );
    expect(failed?.detail).toEqual({
      action: "demo.undo",
      error: "cannot close the PR",
    });
    expect(r.engine.status(runId).run.status).toBe("canceled");
  });

  it("canceling at an open gate resolves it as canceled", async () => {
    const r = await cancellable(
      (reg) => reg.actions.set("demo.undo", async () => {}),
      (def) => {
        def.start = "publish";
      },
    );
    const { runId } = await r.engine.startRun("review-loop", { topic: "x" });
    await r.engine.tick();
    const gate = r.engine.status(runId).live;
    expect(r.engine.status(runId).run.status).toBe("input_required");

    await r.engine.cancel(runId, "operator:a");
    expect(r.adapter.aborted).toEqual([]);
    expect(r.store.tx((t) => t.getGate(gate?.stageRunId ?? ""))).toMatchObject({
      resolvedBy: "canceled:operator:a",
      resolvedAt: 1_000_000,
    });
    expect(r.engine.status(runId).run).toMatchObject({ status: "canceled" });
    await expect(
      r.engine.resolveGate(gate?.stageRunId ?? "", "approve", "api"),
    ).rejects.toThrow("gate already resolved by canceled:operator:a");
  });

  it("a host call that returns after a cancel is dropped", async () => {
    let r: Rig | undefined;
    let runId = "";
    let notified = 0;
    const registry = createRegistry();
    registry.checks.set("demo.ready", async () => {
      await r?.engine.cancel(runId, "api");
      return "yes";
    });
    registry.actions.set("demo.notify", async () => {
      notified++;
    });
    r = await rig({ registry });
    rigs.push(r);
    r.source.defs.set(
      "flow",
      inline({
        id: "flow",
        start: "c",
        stages: {
          c: { type: "check", check: "demo.ready", outcomes: { yes: "n" } },
          n: {
            type: "action",
            action: "demo.notify",
            next: "done",
            retry: { max: 0, on: [] },
          },
          done: { type: "end", status: "completed" },
        },
      }),
    );
    ({ runId } = await r.engine.startRun("flow", {}));
    await r.engine.tick();
    await r.engine.tick();
    expect(notified).toBe(0);
    expect(r.engine.status(runId).run.status).toBe("canceled");
    const dropped = r.store.tx((t) =>
      t.transitions(runId).find((x) => x.event === "host_result_dropped"),
    );
    expect(dropped?.detail).toEqual({
      check: "demo.ready",
      reason: "the stage run is now canceled",
    });
  });

  it("an onCancel that is not an action is skipped and logged", async () => {
    const r = await cancellable(
      () => {},
      (def) => {
        def.onCancel = "failed";
      },
    );
    const { runId } = await r.engine.startRun("review-loop", { topic: "x" });
    await r.engine.cancel(runId, "api");
    expect(events(r, runId)).toContain("cancel_action_skipped");
    expect(rows(r, runId).map((x) => x.stage)).toEqual(["draft"]);
  });

  it("refuses an unknown run and a missing actor", async () => {
    const r = await cancellable(() => {});
    await expect(r.engine.cancel("nope", "api")).rejects.toThrow(
      "unknown run nope",
    );
    const { runId } = await r.engine.startRun("review-loop", { topic: "x" });
    await expect(r.engine.cancel(runId, "")).rejects.toThrow(
      "cancel needs who canceled the run",
    );
  });
});
