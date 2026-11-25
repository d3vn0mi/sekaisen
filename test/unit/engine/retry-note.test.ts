import { afterEach, describe, expect, it } from "vitest";
import { FakeAdapter } from "../../../src/adapter/fake.js";
import {
  RETRY_NOTE,
  renderBrief,
  renderContinuation,
  renderRetryNote,
} from "../../../src/engine/brief.js";
import { Engine } from "../../../src/engine/engine.js";
import type { AgentStage } from "../../../src/format/types.js";
import { createRegistry } from "../../../src/host/registry.js";
import {
  lastToken,
  type Rig,
  rig,
  tokenOf,
  variant,
} from "./engine-helpers.js";

const rigs: Rig[] = [];
const engines: Engine[] = [];
afterEach(async () => {
  for (const e of engines.splice(0)) await e.stop();
  for (const r of rigs.splice(0)) {
    await r.engine.stop();
    r.store.close();
  }
});

const MIN = 60_000;
const secret = new Uint8Array(32).fill(5);

async function make(): Promise<Rig> {
  const r = await rig({ tokenSecret: secret });
  rigs.push(r);
  r.source.defs.set(
    "review-loop",
    await variant("edited", (def) => {
      (def.stages.draft as AgentStage).retry = {
        max: 2,
        on: ["lost", "timeout", "no_result"],
      };
    }),
  );
  return r;
}

/** The brief the draft stage renders for `token`, as the engine sees it. */
function plainBrief(r: Rig, runId: string, token: string): string {
  const loaded = r.source.defs.get("review-loop");
  if (!loaded) throw new Error("no definition");
  const stage = loaded.def.stages.draft as AgentStage;
  return renderBrief(loaded.briefs[stage.brief] ?? "", {
    inputs: { topic: "rust" },
    runId,
    stages: {},
    outcomes: stage.outcomes,
    token,
  });
}

const note = (reason: string) => RETRY_NOTE.replace("{reason}", ` (${reason})`);

describe("retry note", () => {
  it("a first attempt gets the plain brief", async () => {
    const r = await make();
    const { runId } = await r.engine.startRun("review-loop", { topic: "rust" });
    await r.engine.tick();
    const message = r.adapter.calls[0]?.message ?? "";
    expect(message).toBe(plainBrief(r, runId, tokenOf(message)));
    expect(message).not.toContain("earlier attempt");
  });

  it("a retry after a lost attempt starts with the note, then the brief under a fresh token", async () => {
    const r = await make();
    const { runId } = await r.engine.startRun("review-loop", { topic: "rust" });
    await r.engine.tick();
    const first = lastToken(r.adapter);
    // The harness restarted and no longer knows the turn.
    const adapter = new FakeAdapter();
    const engine = new Engine({
      store: r.store,
      adapter,
      registry: createRegistry(),
      clock: r.clock,
      definitions: r.source,
      tokenSecret: secret,
    });
    engines.push(engine);
    await engine.reconcile();
    await engine.tick();
    const message = adapter.calls[0]?.message ?? "";
    const token = tokenOf(message);
    expect(token).not.toBe(first);
    expect(message).toBe(
      `${note("the system restarted")}\n\n${plainBrief(r, runId, token)}`,
    );
  });

  it("a retry after a deadline names the deadline", async () => {
    const r = await make();
    const { runId } = await r.engine.startRun("review-loop", { topic: "rust" });
    await r.engine.tick();
    r.clock.advance(30 * MIN);
    await r.engine.tick();
    await r.engine.tick();
    const message = r.adapter.calls.at(-1)?.message ?? "";
    expect(r.engine.status(runId).live?.retryIndex).toBe(1);
    expect(message.startsWith(note("it ran past its deadline"))).toBe(true);
  });

  it("a continuation turn of a retried attempt carries no note", async () => {
    const r = await make();
    const { runId } = await r.engine.startRun("review-loop", { topic: "rust" });
    await r.engine.tick();
    r.clock.advance(30 * MIN);
    await r.engine.tick();
    await r.engine.tick();
    const token = lastToken(r.adapter);
    await r.engine.progress({ token, note: "outline done" });
    r.store.tx((t) => {
      const live = t.liveStageRun(runId);
      if (!live) throw new Error("no live row");
      t.updateStageRunIf(
        live.stageRunId,
        { state: "working", attempt: live.attempt },
        { state: "submitted" },
      );
    });
    await r.engine.tick();
    const loaded = r.source.defs.get("review-loop");
    const stage = loaded?.def.stages.draft as AgentStage;
    expect(r.adapter.calls.at(-1)?.message).toBe(
      renderContinuation("outline done", token, stage.outcomes),
    );
  });

  it("a resent dispatch of a retried attempt is the same message", async () => {
    const r = await make();
    await r.engine.startRun("review-loop", { topic: "rust" });
    await r.engine.tick();
    r.clock.advance(30 * MIN);
    await r.engine.tick();
    // The retry is dispatched, but the process dies before the turn is recorded.
    r.adapter.beforeStart = () => {
      throw new Error("crash");
    };
    await r.engine.tick();
    r.adapter.beforeStart = undefined;
    const sent = r.adapter.calls.at(-1)?.message;
    const engine = new Engine({
      store: r.store,
      adapter: r.adapter,
      registry: createRegistry(),
      clock: r.clock,
      definitions: r.source,
      tokenSecret: Uint8Array.from(secret),
    });
    engines.push(engine);
    await engine.tick();
    expect(sent).toContain("earlier attempt");
    expect(r.adapter.calls.at(-1)?.message).toBe(sent);
  });
});

describe("renderRetryNote", () => {
  it("leaves out the parenthesis when the reason is unknown", () => {
    for (const ending of [undefined, "usage_limited"] as const) {
      const text = renderRetryNote(ending);
      expect(text).not.toContain("()");
      expect(text).toContain("before it reported a result.");
    }
  });

  it("maps a turn error or no result to the same phrase", () => {
    expect(renderRetryNote("turn_error")).toBe(renderRetryNote("no_result"));
    expect(renderRetryNote("no_result")).toContain(
      "(its turn ended without a result)",
    );
  });
});
