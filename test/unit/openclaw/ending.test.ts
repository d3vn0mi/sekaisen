import { describe, expect, test } from "vitest";
import type { TaskRunView } from "../../../src/openclaw/api.js";
import {
  defaultSessionKey,
  OpenClawAdapter,
} from "../../../src/openclaw/index.js";
import { makeStub, type Stub } from "./stub.js";

const KEY = "agent:drafter:main";
const RESTART = "agent run aborted for restart";
const NOT_TRUSTED =
  'plugin "demo-plugin" is not trusted for fallback provider/model override requests';

const row = (over: Partial<TaskRunView> = {}): TaskRunView => ({
  id: "t1",
  runId: "run-1",
  status: "running",
  createdAt: 100,
  childSessionKey: "agent:drafter:pipe-x",
  agentId: "drafter",
  ...over,
});

function setup(
  rows: TaskRunView[],
  key = KEY,
): { s: Stub; a: OpenClawAdapter } {
  const s = makeStub("demo-plugin");
  s.ledgers.set(key, rows);
  return {
    s,
    a: new OpenClawAdapter({ api: s.api, agents: ["checker", "drafter"] }),
  };
}

const turn = (idempotencyKey: string) => ({
  agent: "drafter",
  sessionKey: "run:r_1:drafter",
  message: "m",
  capMs: 1,
  idempotencyKey,
  tools: [],
});

describe("a turn cut by a gateway restart", () => {
  test("a restart stop reason reads unknown", async () => {
    const { s, a } = setup([row({ status: "failed", error: "other text" })]);
    s.waits.set("run-1", {
      status: "error",
      stopReason: "restart",
      error: "whatever",
    });
    expect(await a.readRunOutcome("run-1")).toEqual({ state: "unknown" });
  });

  test("the restart abort text alone reads unknown", async () => {
    const { a } = setup([row({ status: "failed", error: RESTART })]);
    expect(await a.readRunOutcome("run-1")).toEqual({ state: "unknown" });
  });

  test("a run the adapter aborted still reads killed", async () => {
    const { s, a } = setup([row({ status: "failed", error: RESTART })]);
    s.waits.set("run-1", {
      status: "error",
      stopReason: "restart",
      error: RESTART,
    });
    expect(await a.abortTurn("run-1")).toBe(true);
    expect(await a.readRunOutcome("run-1")).toMatchObject({
      state: "ended",
      ending: "killed",
    });
  });

  test("text that only mentions the restart still reads error", async () => {
    const { a } = setup([
      row({ status: "failed", error: `${RESTART}, then something else` }),
    ]);
    expect(await a.readRunOutcome("run-1")).toMatchObject({
      state: "ended",
      ending: "error",
    });
  });
});

describe("the owner session key", () => {
  test("follows session.mainKey, trimmed and lowercased, for reads and cancel", async () => {
    const { s, a } = setup([row()], "agent:drafter:desk");
    s.config = { session: { mainKey: "  Desk " } };
    expect(await a.readRunOutcome("run-1")).toEqual({ state: "running" });
    expect(s.binds).toContain("agent:drafter:desk");
    expect(s.binds).not.toContain(KEY);
    expect(await a.abortTurn("run-1")).toBe(true);
    expect(s.cancels).toEqual([
      { ownerKey: "agent:drafter:desk", taskId: "t1", cfg: s.config },
    ]);
  });

  test("a blank or missing mainKey means main", async () => {
    for (const session of [{ mainKey: "   " }, { mainKey: 7 }, undefined]) {
      const { s, a } = setup([row()]);
      s.config = { session };
      expect(await a.readRunOutcome("run-1")).toEqual({ state: "running" });
      expect(s.binds).toEqual(["agent:checker:main", "agent:drafter:main"]);
    }
  });

  test("the agent id is lowercased as OpenClaw does", async () => {
    const s = makeStub();
    s.ledgers.set(KEY, [row()]);
    const a = new OpenClawAdapter({ api: s.api, agents: ["Drafter"] });
    expect(await a.readRunOutcome("run-1")).toEqual({ state: "running" });
    expect(s.binds).toEqual([KEY]);
  });

  test("an ownerKey option wins", async () => {
    const s = makeStub();
    s.config = { session: { mainKey: "desk" } };
    s.ledgers.set("owner/drafter", [row()]);
    const a = new OpenClawAdapter({
      api: s.api,
      agents: ["drafter"],
      ownerKey: (agent) => `owner/${agent}`,
    });
    expect(await a.readRunOutcome("run-1")).toEqual({ state: "running" });
    expect(await a.abortTurn("run-1")).toBe(true);
    expect(new Set(s.binds)).toEqual(new Set(["owner/drafter"]));
    expect(s.cancels.map((c) => c.ownerKey)).toEqual(["owner/drafter"]);
  });
});

describe("a pin refusal at the end of a run", () => {
  test("a failed row's refusal names both requirements and keeps the text", async () => {
    const { s, a } = setup([row({ status: "failed" })]);
    s.waits.set("run-1", { status: "error", error: NOT_TRUSTED });
    const o = await a.readRunOutcome("run-1");
    expect(o).toMatchObject({ state: "ended", ending: "error" });
    const error = (o as { error: string }).error;
    expect(error).toContain(
      "plugins.entries.demo-plugin.subagent.allowModelOverride",
    );
    expect(error).toContain("agents.defaults.modelPolicy.allow");
    expect(error).toContain(NOT_TRUSTED);
  });

  test("a dispatched run with no ledger row asks waitForRun", async () => {
    const { s, a } = setup([]);
    await a.startTurn(turn("k1"));
    s.waits.set("k1", { status: "error", error: NOT_TRUSTED });
    const o = await a.readRunOutcome("k1");
    expect(o).toMatchObject({ state: "ended", ending: "error" });
    const error = (o as { error: string }).error;
    expect(error).toContain(
      "plugins.entries.demo-plugin.subagent.allowModelOverride",
    );
    expect(error).toContain(NOT_TRUSTED);
    expect(a.agentOf("k1")).toBeUndefined();
  });

  test("a dispatched run with no ledger row that the draining gateway refused reads unknown", async () => {
    const { s, a } = setup([]);
    await a.startTurn(turn("k1"));
    s.waits.set("k1", {
      status: "error",
      error: "Gateway is draining; new tasks are not accepted",
    });
    expect(await a.readRunOutcome("k1")).toEqual({ state: "unknown" });
  });

  test("a dispatched run with no ledger row and any other error keeps its text", async () => {
    const { s, a } = setup([]);
    await a.startTurn(turn("k1"));
    s.waits.set("k1", { status: "error", error: "boom" });
    expect(await a.readRunOutcome("k1")).toEqual({
      state: "ended",
      ending: "error",
      error: "boom",
    });
  });

  test("a dispatched run with no ledger row that has not failed reads unknown", async () => {
    const { s, a } = setup([]);
    await a.startTurn(turn("k1"));
    expect(await a.readRunOutcome("k1")).toEqual({ state: "unknown" });
    s.waits.set("k1", { status: "ok" });
    expect(await a.readRunOutcome("k1")).toEqual({ state: "unknown" });
    s.waits.set("k1", { status: "error", stopReason: "restart" });
    expect(await a.readRunOutcome("k1")).toEqual({ state: "unknown" });
    expect(a.agentOf("k1")).toBe("drafter");
  });

  test("a run never dispatched here, with no row, does not ask waitForRun", async () => {
    const { s, a } = setup([]);
    s.waits.set("run-1", { status: "error", error: "boom" });
    expect(await a.readRunOutcome("run-1")).toEqual({ state: "unknown" });
    expect(s.calls).not.toContain("subagent.waitForRun");
  });
});

describe("a run that succeeded", () => {
  test("its terminal summary is not an error", async () => {
    const { s, a } = setup([
      row({ status: "succeeded", terminalSummary: "Wrote the note." }),
    ]);
    s.waits.set("run-1", { status: "ok" });
    expect(await a.readRunOutcome("run-1")).toEqual({
      state: "ended",
      ending: "ok",
    });
  });
});

describe("options", () => {
  test("agents is copied", async () => {
    const s = makeStub();
    const agents = ["drafter"];
    const a = new OpenClawAdapter({ api: s.api, agents });
    agents.push("checker");
    await expect(
      a.startTurn({ ...turn("k1"), agent: "checker" }),
    ).rejects.toThrow(/checker/);
  });

  test("the project part of a session key keeps only [a-z0-9_-]", () => {
    expect(defaultSessionKey("project:Site A/v2.1:drafter", "drafter")).toBe(
      "agent:drafter:proj-site-a-v2-1",
    );
    expect(defaultSessionKey("project:site_a-1:drafter", "drafter")).toBe(
      "agent:drafter:proj-site_a-1",
    );
  });
});
