import { describe, expect, test } from "vitest";
import { OpenClawAdapter } from "../../../src/openclaw/index.js";
import { makeStub } from "./stub.js";

const turn = (over: Record<string, unknown> = {}) => ({
  agent: "drafter",
  sessionKey: "run:r_7Q2M8K4N1P0Z:drafter",
  message: "write it",
  capMs: 60_000,
  idempotencyKey: "sr_1:drafter",
  tools: ["stage_complete"],
  ...over,
});

describe("startTurn", () => {
  test("calls subagent.run with the mapped key, the turn key and deliver false", async () => {
    const s = makeStub();
    const a = new OpenClawAdapter({ api: s.api, agents: ["drafter"] });
    const r = await a.startTurn(turn());
    expect(r).toEqual({ runId: "sr_1:drafter" });
    expect(s.runs).toEqual([
      {
        sessionKey: "agent:drafter:pipe-r_7q2m8k4n1p0z",
        message: "write it",
        idempotencyKey: "sr_1:drafter",
        deliver: false,
      },
    ]);
    for (const k of ["toolsAlsoAllow", "provider", "model"]) {
      expect(s.runs[0]).not.toHaveProperty(k);
    }
  });

  test("project sessions map to proj-<p>", async () => {
    const s = makeStub();
    const a = new OpenClawAdapter({ api: s.api, agents: ["checker"] });
    await a.startTurn(
      turn({ agent: "checker", sessionKey: "project:site-a:checker" }),
    );
    expect(s.runs[0]?.sessionKey).toBe("agent:checker:proj-site-a");
  });

  test("an unrecognised engine key throws", async () => {
    const s = makeStub();
    const a = new OpenClawAdapter({ api: s.api, agents: ["drafter"] });
    await expect(a.startTurn(turn({ sessionKey: "weird" }))).rejects.toThrow(
      /session key/,
    );
    expect(s.runs).toEqual([]);
  });

  test("a custom sessionKey mapper and agentFor are honoured", async () => {
    const s = makeStub();
    const a = new OpenClawAdapter({
      api: s.api,
      agents: ["x"],
      sessionKey: (k, agent) => `agent:${agent}:custom-${k.length}`,
    });
    await a.startTurn(turn());
    expect(s.runs[0]?.sessionKey).toBe("agent:drafter:custom-26");
  });

  test("a pinned agent passes provider and model", async () => {
    const s = makeStub();
    const a = new OpenClawAdapter({
      api: s.api,
      agents: ["drafter", "checker"],
      pin: { drafter: { provider: "anthropic", model: "m-1" } },
    });
    await a.startTurn(turn());
    expect(s.runs[0]).toMatchObject({ provider: "anthropic", model: "m-1" });
    await a.startTurn(
      turn({
        agent: "checker",
        sessionKey: "run:r_7Q2M8K4N1P0Z:checker",
        idempotencyKey: "k2",
      }),
    );
    expect(s.runs[1]).not.toHaveProperty("provider");
  });

  test("a pin refusal names both requirements", async () => {
    for (const text of [
      'plugin "x" is not trusted for fallback provider/model override requests. See plugins.entries.x.subagent.allowModelOverride.',
      'model "anthropic/m-1" is not allowed for agent drafter by agents.defaults.modelPolicy.allow',
    ]) {
      const s = makeStub("demo-plugin");
      s.failRun = new Error(text);
      const a = new OpenClawAdapter({
        api: s.api,
        agents: ["drafter"],
        pin: { drafter: { provider: "anthropic", model: "m-1" } },
      });
      const err = await a.startTurn(turn()).catch((e) => e as Error);
      expect(err).toBeInstanceOf(Error);
      const msg = (err as Error).message;
      expect(msg).toContain(
        "plugins.entries.demo-plugin.subagent.allowModelOverride",
      );
      expect(msg).toContain("agents.defaults.modelPolicy.allow");
      expect(msg).toContain(text);
    }
  });

  test("any other failure passes through unchanged", async () => {
    const s = makeStub();
    const boom = new Error("gateway down");
    s.failRun = boom;
    const a = new OpenClawAdapter({ api: s.api, agents: ["drafter"] });
    await expect(a.startTurn(turn())).rejects.toBe(boom);
  });

  test("it remembers which agent owns the run", async () => {
    const s = makeStub();
    const a = new OpenClawAdapter({
      api: s.api,
      agents: ["drafter", "checker"],
    });
    await a.startTurn(turn());
    expect(a.agentOf("sr_1:drafter")).toBe("drafter");
    expect(a.agentOf("nope")).toBeUndefined();
  });
});

describe("the other calls", () => {
  test("openSession does nothing", async () => {
    const s = makeStub();
    const a = new OpenClawAdapter({ api: s.api, agents: ["drafter"] });
    await a.openSession("drafter", "run:r_7Q2M8K4N1P0Z:drafter");
    expect(s.calls).toEqual([]);
  });

  test("deliver is unsupported", async () => {
    const s = makeStub();
    const a = new OpenClawAdapter({ api: s.api, agents: ["drafter"] });
    await expect(a.deliver("k", "hi")).rejects.toThrow(
      "not supported by the OpenClaw adapter",
    );
  });
});
