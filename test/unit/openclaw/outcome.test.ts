import { describe, expect, test } from "vitest";
import type { TaskRunView } from "../../../src/openclaw/api.js";
import { OpenClawAdapter } from "../../../src/openclaw/index.js";
import { makeStub, type Stub } from "./stub.js";

const LIMIT = "You've hit your weekly limit · resets 7pm (Europe/Berlin)";
const KEY = "agent:drafter:main";

const row = (over: Partial<TaskRunView> = {}): TaskRunView => ({
  id: "t1",
  runId: "run-1",
  status: "running",
  createdAt: 100,
  childSessionKey: "agent:drafter:pipe-x",
  agentId: "drafter",
  ...over,
});

function setup(rows: TaskRunView[]): { s: Stub; a: OpenClawAdapter } {
  const s = makeStub();
  s.ledgers.set(KEY, rows);
  return {
    s,
    a: new OpenClawAdapter({ api: s.api, agents: ["checker", "drafter"] }),
  };
}

describe("readRunOutcome", () => {
  test("running task reads running", async () => {
    const { a } = setup([
      row({ status: "queued" }),
      row({ id: "t0", createdAt: 1 }),
    ]);
    expect(await a.readRunOutcome("run-1")).toEqual({ state: "running" });
  });

  test("succeeded task reads ok with the session row's provider and model", async () => {
    const { s, a } = setup([row({ status: "succeeded" })]);
    s.sessions.set("drafter|agent:drafter:pipe-x", {
      modelProvider: "claude-cli",
      model: "claude-sonnet-5-5",
    });
    expect(await a.readRunOutcome("run-1")).toEqual({
      state: "ended",
      ending: "ok",
      runtime: { provider: "claude-cli", model: "claude-sonnet-5-5" },
    });
  });

  test("a session row missing a model leaves runtime out", async () => {
    const { s, a } = setup([row({ status: "succeeded" })]);
    s.sessions.set("drafter|agent:drafter:pipe-x", {
      modelProvider: "claude-cli",
    });
    expect(await a.readRunOutcome("run-1")).toEqual({
      state: "ended",
      ending: "ok",
    });
  });

  test("failed task reads error with waitForRun's text", async () => {
    const { s, a } = setup([row({ status: "failed" })]);
    s.waits.set("run-1", { status: "error", error: "boom" });
    expect(await a.readRunOutcome("run-1")).toEqual({
      state: "ended",
      ending: "error",
      error: "boom",
    });
  });

  test("a waitForRun that rejects does not fail the read", async () => {
    const { s, a } = setup([row({ status: "failed", error: "row text" })]);
    s.api.runtime.subagent.waitForRun = async () => {
      throw new Error("gone");
    };
    expect(await a.readRunOutcome("run-1")).toEqual({
      state: "ended",
      ending: "error",
      error: "row text",
    });
  });

  describe("refusal text is surfaced from waitForRun or the task row", () => {
    test("from waitForRun", async () => {
      const { s, a } = setup([row({ status: "failed", error: "other" })]);
      s.waits.set("run-1", { status: "error", error: LIMIT });
      const o = await a.readRunOutcome("run-1");
      expect(o).toMatchObject({ state: "ended", ending: "error" });
      expect((o as { error: string }).error).toContain(LIMIT);
    });
    test("from the row's error", async () => {
      const { s, a } = setup([row({ status: "failed", error: LIMIT })]);
      s.waits.set("run-1", { status: "error", error: "generic failure" });
      const o = await a.readRunOutcome("run-1");
      expect((o as { error: string }).error).toContain(LIMIT);
    });
    test("from the row's terminal summary", async () => {
      const { a } = setup([
        row({ status: "failed", error: "generic", terminalSummary: LIMIT }),
      ]);
      const o = await a.readRunOutcome("run-1");
      expect((o as { error: string }).error).toContain(LIMIT);
    });
  });

  test("timed_out reads timeout, cancelled reads killed", async () => {
    const t = setup([row({ status: "timed_out" })]);
    expect(await t.a.readRunOutcome("run-1")).toMatchObject({
      ending: "timeout",
    });
    const c = setup([row({ status: "cancelled" })]);
    expect(await c.a.readRunOutcome("run-1")).toMatchObject({
      ending: "killed",
    });
  });

  test("a run the adapter aborted reads killed whatever the status", async () => {
    const { a } = setup([
      row({ status: "failed", error: "agent run aborted for restart" }),
    ]);
    (a as unknown as { aborted: Set<string> }).aborted.add("run-1");
    const o = await a.readRunOutcome("run-1");
    expect(o).toMatchObject({ state: "ended", ending: "killed" });
    // still killed on a second read
    expect(await a.readRunOutcome("run-1")).toMatchObject({ ending: "killed" });
  });

  test("a run nobody aborted that ends the same way reads error", async () => {
    const { a } = setup([
      row({ status: "failed", error: "agent run aborted for restart" }),
    ]);
    expect(await a.readRunOutcome("run-1")).toEqual({
      state: "ended",
      ending: "error",
      error: "agent run aborted for restart",
    });
  });

  test("after a restart, a lost task reads unknown", async () => {
    const { a } = setup([row({ status: "lost" })]);
    expect(a.agentOf("run-1")).toBeUndefined();
    expect(await a.readRunOutcome("run-1")).toEqual({ state: "unknown" });
  });

  test("a run id in no ledger reads unknown", async () => {
    const { a } = setup([row({ runId: "other" })]);
    expect(await a.readRunOutcome("run-1")).toEqual({ state: "unknown" });
  });

  test("two rows with one run id: the newest decides", async () => {
    const { a } = setup([
      row({ id: "new", status: "succeeded", createdAt: 200 }),
      row({ id: "old", status: "failed", createdAt: 100 }),
    ]);
    expect(await a.readRunOutcome("run-1")).toMatchObject({ ending: "ok" });
    const r = setup([
      row({ id: "old", status: "succeeded", createdAt: 100 }),
      row({ id: "new", status: "running", createdAt: 200 }),
    ]);
    expect(await r.a.readRunOutcome("run-1")).toEqual({ state: "running" });
  });

  test("a cold lookup keeps the newest row across agents", async () => {
    const { s, a } = setup([row({ status: "failed", createdAt: 100 })]);
    s.ledgers.set("agent:checker:main", [
      row({ status: "succeeded", createdAt: 300, agentId: "checker" }),
    ]);
    expect(await a.readRunOutcome("run-1")).toMatchObject({ ending: "ok" });
  });

  test("a remembered run reads only its own agent's ledger, and is forgotten once ended", async () => {
    const { s, a } = setup([row({ runId: "k1", status: "succeeded" })]);
    await a.startTurn({
      agent: "drafter",
      sessionKey: "run:r_1:drafter",
      message: "m",
      capMs: 1,
      idempotencyKey: "k1",
      tools: [],
    });
    s.binds.length = 0;
    await a.readRunOutcome("k1");
    expect(s.binds).toEqual([KEY]);
    expect(a.agentOf("k1")).toBeUndefined();
  });
});

test("a finished run read twice reads the same ending", async () => {
  const { s, a } = setup([row({ runId: "k2", status: "succeeded" })]);
  s.sessions.set("drafter|agent:drafter:pipe-x", {
    modelProvider: "claude-cli",
    model: "claude-sonnet-5-5",
  });
  await a.startTurn({
    agent: "drafter",
    sessionKey: "run:r_1:drafter",
    message: "m",
    capMs: 1,
    idempotencyKey: "k2",
    tools: [],
  });
  const first = await a.readRunOutcome("k2");
  const second = await a.readRunOutcome("k2");
  expect(first).toEqual({
    state: "ended",
    ending: "ok",
    runtime: { provider: "claude-cli", model: "claude-sonnet-5-5" },
  });
  expect(second).toEqual(first);
});

describe("capabilities", () => {
  test("options win, then config, then defaults", async () => {
    const d = setup([]);
    expect(await d.a.capabilities()).toMatchObject({
      turnCapMs: 5_400_000,
      maxConcurrent: 8,
      canAbort: true,
      subscriptionProvider: "claude-cli",
    });

    const c = setup([]);
    c.s.config = { agents: { defaults: { timeoutSeconds: 5400 } } };
    expect(await c.a.capabilities()).toMatchObject({
      turnCapMs: 5_400_000,
      maxConcurrent: 8,
    });

    const l = setup([]);
    l.s.config = {
      agents: {
        defaults: { timeoutSeconds: 100, subagents: { maxConcurrent: 3 } },
      },
    };
    expect(await l.a.capabilities()).toMatchObject({
      turnCapMs: 100_000,
      maxConcurrent: 3,
    });

    const o = new OpenClawAdapter({
      api: l.s.api,
      agents: [],
      turnCapMs: 7,
      maxConcurrent: 2,
      subscriptionProvider: "other",
    });
    expect(await o.capabilities()).toMatchObject({
      turnCapMs: 7,
      maxConcurrent: 2,
      subscriptionProvider: "other",
    });
  });

  test("odd config shapes fall through to the defaults", async () => {
    const { s, a } = setup([]);
    s.config = { agents: "nope" };
    expect(await a.capabilities()).toMatchObject({
      turnCapMs: 5_400_000,
      maxConcurrent: 8,
    });
    s.api.runtime.config.current = () => {
      throw new Error("x");
    };
    expect(await a.capabilities()).toMatchObject({ maxConcurrent: 8 });
  });

  test("agentTools returns the agent's own alsoAllow, or the defaults' when it has none", async () => {
    const { s, a } = setup([]);
    s.config = {
      agents: {
        defaults: { tools: { alsoAllow: ["base"] } },
        entries: {
          drafter: { tools: { alsoAllow: ["a", "stage_complete"] } },
          checker: {},
        },
      },
    };
    const caps = await a.capabilities();
    expect(await caps.agentTools?.("drafter")).toEqual(["a", "stage_complete"]);
    expect(await caps.agentTools?.("checker")).toEqual(["base"]);
    expect(await caps.agentTools?.("ghost")).toEqual(["base"]);
  });

  test("agentTools reads the older list array too", async () => {
    const { s, a } = setup([]);
    s.config = {
      agents: { list: [{ id: "drafter", tools: { alsoAllow: ["x"] } }] },
    };
    const caps = await a.capabilities();
    expect(await caps.agentTools?.("drafter")).toEqual(["x"]);
    expect(await caps.agentTools?.("other")).toEqual([]);
  });
});
