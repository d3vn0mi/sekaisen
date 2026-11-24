import { describe, expect, test } from "vitest";
import type { TaskRunView } from "../../../src/openclaw/api.js";
import { OpenClawAdapter } from "../../../src/openclaw/index.js";
import { makeStub, type Stub } from "./stub.js";

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

const ABORTED = {
  status: "error",
  stopReason: "restart",
  error: "agent run aborted for restart",
} as const;

describe("abortTurn", () => {
  test("abort binds the owner key and cancels the task by id", async () => {
    const { s, a } = setup([row()]);
    s.config = { agents: {} };
    expect(await a.abortTurn("run-1")).toBe(true);
    expect(s.binds).toContain(KEY);
    expect(s.cancels).toEqual([{ ownerKey: KEY, taskId: "t1", cfg: s.config }]);
  });

  test("abort of a task already terminal returns false", async () => {
    const { s, a } = setup([row({ status: "failed" })]);
    s.cancelResult = {
      found: true,
      cancelled: false,
      reason: "Task is already terminal.",
    };
    expect(await a.abortTurn("run-1")).toBe(false);
    s.waits.set("run-1", ABORTED);
    // Not marked aborted: the restart's own reading stands, not killed.
    expect(await a.readRunOutcome("run-1")).toEqual({ state: "unknown" });
  });

  test("abort of a run with no row returns false", async () => {
    const { s, a } = setup([]);
    expect(await a.abortTurn("run-1")).toBe(false);
    expect(s.cancels).toEqual([]);
  });

  test("abort cancels the newest row", async () => {
    const { s, a } = setup([
      row({ id: "old", createdAt: 1 }),
      row({ id: "new", createdAt: 9 }),
      row({ id: "mid", createdAt: 5 }),
    ]);
    expect(await a.abortTurn("run-1")).toBe(true);
    expect(s.cancels.map((c) => c.taskId)).toEqual(["new"]);
  });

  test("a rejected cancel throws and does not mark the run aborted", async () => {
    const { s, a } = setup([row()]);
    s.cancelResult = () => {
      throw new Error("ledger unavailable");
    };
    await expect(a.abortTurn("run-1")).rejects.toThrow("ledger unavailable");
    s.ledgers.set(KEY, [row({ status: "failed" })]);
    s.waits.set("run-1", ABORTED);
    expect(await a.readRunOutcome("run-1")).toEqual({ state: "unknown" });
  });

  test("an aborted run later reads killed, not error", async () => {
    const { s, a } = setup([row()]);
    await a.abortTurn("run-1");
    s.ledgers.set(KEY, [row({ status: "failed" })]);
    s.waits.set("run-1", ABORTED);
    expect(await a.readRunOutcome("run-1")).toMatchObject({
      state: "ended",
      ending: "killed",
    });
    expect(await a.readRunOutcome("run-1")).toMatchObject({ ending: "killed" });
  });

  test("an unaborted run that ends the same way reads unknown", async () => {
    const { s, a } = setup([row({ status: "failed" })]);
    s.waits.set("run-1", ABORTED);
    expect(await a.readRunOutcome("run-1")).toEqual({ state: "unknown" });
  });

  test("abort never calls runtime.gateway", async () => {
    const { s, a } = setup([row()]);
    await a.abortTurn("run-1");
    await a.abortTurn("missing");
    expect(s.gatewayCalls).toEqual([]);
  });
});
