import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, test, vi } from "vitest";
import { VirtualClock } from "../../../src/engine/clock.js";
import { createRegistry } from "../../../src/host/registry.js";
import type { ToolDefinition, ToolFactory } from "../../../src/openclaw/api.js";
import {
  createPipelinePlugin,
  OpenClawAdapter,
  type PipelinePlugin,
  type PipelinePluginOptions,
} from "../../../src/openclaw/index.js";
import { reviewLoop, SwapSource, tokenOf } from "../engine/engine-helpers.js";
import { makeStub, type Stub } from "./stub.js";

const SECRET = new Uint8Array(32).fill(7);

const plugins: PipelinePlugin[] = [];
const dirs: string[] = [];
afterEach(async () => {
  for (const p of plugins.splice(0)) await p.engine.stop();
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

async function setup(
  over: Partial<PipelinePluginOptions> = {},
): Promise<{ stub: Stub; plugin: PipelinePlugin }> {
  const stub = makeStub();
  const plugin = createPipelinePlugin({
    api: stub.api,
    adapter: { api: stub.api, agents: ["drafter", "checker"] },
    storePath: ":memory:",
    tokenSecret: SECRET,
    definitions: new SwapSource(await reviewLoop()),
    registry: createRegistry(),
    engine: { clock: new VirtualClock(1_000_000) },
    ...over,
  });
  plugins.push(plugin);
  return { stub, plugin };
}

/** The tool named `name`, as OpenClaw would build it for a turn of `agentId`. */
function toolFor(
  stub: Stub,
  name: string,
  agentId = "drafter",
): ToolDefinition {
  for (const { tool } of stub.tools) {
    const built =
      typeof tool === "function"
        ? (tool as ToolFactory)({ agentId, sessionKey: "agent:x:main" })
        : tool;
    for (const t of [built ?? []].flat()) if (t.name === name) return t;
  }
  throw new Error(`no tool ${name} registered`);
}

describe("createPipelinePlugin", () => {
  test("service start and stop drive the engine", async () => {
    const dir = mkdtempSync(join(tmpdir(), "sekaisen-plugin-"));
    dirs.push(dir);
    const { stub, plugin } = await setup({
      storePath: join(dir, "store.db"),
    });
    expect(stub.services.map((s) => s.id)).toEqual(["sekaisen"]);
    const start = vi.spyOn(plugin.engine, "start");
    const stop = vi.spyOn(plugin.engine, "stop");
    const service = stub.services[0];
    if (!service?.stop) throw new Error("no stop");
    await service.start();
    expect(start).toHaveBeenCalledTimes(1);
    expect(stop).not.toHaveBeenCalled();
    await service.stop();
    expect(stop).toHaveBeenCalledTimes(1);
  });

  test("the service id can be set", async () => {
    const { stub } = await setup({ serviceId: "demo-pipelines" });
    expect(stub.services.map((s) => s.id)).toEqual(["demo-pipelines"]);
  });

  test("registers the completion tools by name, with a label", async () => {
    const { stub } = await setup();
    expect(stub.tools.map((t) => t.opts?.name).sort()).toEqual([
      "stage_complete",
      "stage_progress",
    ]);
    for (const name of ["stage_complete", "stage_progress"]) {
      const t = toolFor(stub, name);
      expect(t.label).toBeTruthy();
      expect(t.parameters).toMatchObject({ type: "object" });
    }
  });

  test("stage_complete passes ctx.agentId as the caller", async () => {
    const { stub, plugin } = await setup();
    await plugin.engine.startRun("review-loop", { topic: "rust" });
    await plugin.engine.tick();
    const run = stub.runs.at(-1);
    if (!run) throw new Error("no turn dispatched");
    const complete = vi.spyOn(plugin.engine, "complete");
    const result = await toolFor(stub, "stage_complete", "drafter").execute(
      "call-1",
      {
        token: tokenOf(run.message),
        outcome: "drafted",
        fields: { pr_url: "https://demo.example/pr/1" },
      },
    );
    expect(complete).toHaveBeenCalledWith(
      expect.objectContaining({ callerAgent: "drafter" }),
    );
    expect(result).toEqual({
      content: [{ type: "text", text: expect.stringMatching(/^Recorded/) }],
      details: { isError: false },
    });
  });

  test("stage_progress passes ctx.agentId as the caller", async () => {
    const { stub, plugin } = await setup();
    await plugin.engine.startRun("review-loop", { topic: "rust" });
    await plugin.engine.tick();
    const run = stub.runs.at(-1);
    if (!run) throw new Error("no turn dispatched");
    const progress = vi.spyOn(plugin.engine, "progress");
    const result = await toolFor(stub, "stage_progress", "drafter").execute(
      "call-1",
      { token: tokenOf(run.message), note: "half done" },
    );
    expect(progress).toHaveBeenCalledWith(
      expect.objectContaining({ callerAgent: "drafter" }),
    );
    expect(result).toMatchObject({ details: { isError: false } });
  });

  test("a wrong outcome is a tool error result, not a throw", async () => {
    const { stub, plugin } = await setup();
    await plugin.engine.startRun("review-loop", { topic: "rust" });
    await plugin.engine.tick();
    const run = stub.runs.at(-1);
    if (!run) throw new Error("no turn dispatched");
    const tool = toolFor(stub, "stage_complete");
    const wrong = await tool.execute("call-1", {
      token: tokenOf(run.message),
      outcome: "shipped",
    });
    expect(wrong).toMatchObject({
      content: [{ type: "text", text: expect.stringContaining("shipped") }],
      details: { isError: true },
    });
    const malformed = await tool.execute("call-2", "not an object");
    expect(malformed).toMatchObject({ details: { isError: true } });
    // An engine that throws is still a result.
    vi.spyOn(plugin.engine, "complete").mockRejectedValue(new Error("boom"));
    const thrown = await tool.execute("call-3", {
      token: tokenOf(run.message),
      outcome: "drafted",
      fields: { pr_url: "u" },
    });
    expect(thrown).toMatchObject({
      content: [{ type: "text", text: expect.stringContaining("boom") }],
      details: { isError: true },
    });
  });

  test("no tokenSecret refuses to start", async () => {
    const definitions = new SwapSource(await reviewLoop());
    for (const tokenSecret of [
      undefined,
      new Uint8Array(31),
      "a string secret that is long enough to pass",
    ]) {
      const stub = makeStub();
      expect(() =>
        createPipelinePlugin({
          api: stub.api,
          adapter: { api: stub.api, agents: ["drafter"] },
          storePath: ":memory:",
          tokenSecret: tokenSecret as unknown as Uint8Array,
          definitions,
          registry: createRegistry(),
        }),
      ).toThrow("tokenSecret must be at least 32 bytes");
      // Refused before anything was registered.
      expect(stub.services).toEqual([]);
      expect(stub.tools).toEqual([]);
      expect(stub.handlers).toEqual([]);
    }
  });

  test("an adapter instance is used as is; options build one", async () => {
    const stub = makeStub();
    const adapter = new OpenClawAdapter({ api: stub.api, agents: ["drafter"] });
    const { plugin } = await setup({ api: stub.api, adapter });
    expect(plugin.adapter).toBe(adapter);
    const built = await setup();
    expect(built.plugin.adapter).toBeInstanceOf(OpenClawAdapter);
  });

  test("tool() registers a host tool with the same result shape", async () => {
    const { stub, plugin } = await setup();
    const seen: unknown[] = [];
    plugin.tool(
      "demo_echo",
      "Echo the text back.",
      { type: "object", properties: { text: { type: "string" } } },
      async (params, ctx) => {
        seen.push([params, ctx.agentId]);
        const text = (params as { text?: unknown }).text;
        if (typeof text !== "string") throw new Error("text is required");
        return { text, isError: false };
      },
    );
    expect(stub.tools.at(-1)?.opts).toEqual({ name: "demo_echo" });
    const tool = toolFor(stub, "demo_echo", "checker");
    expect(tool.label).toBeTruthy();
    expect(await tool.execute("call-1", { text: "hi" })).toEqual({
      content: [{ type: "text", text: "hi" }],
      details: { isError: false },
    });
    expect(seen).toEqual([[{ text: "hi" }, "checker"]]);
    expect(await tool.execute("call-2", {})).toEqual({
      content: [{ type: "text", text: "demo_echo failed: text is required" }],
      details: { isError: true },
    });
  });

  test("buttons are wired only when asked for", async () => {
    const without = await setup();
    expect(without.stub.handlers).toEqual([]);
    const withButtons = await setup({
      buttons: { channel: "telegram", to: "telegram:1001", operatorIds: [] },
    });
    expect(
      withButtons.stub.handlers.map((h) => [h.channel, h.namespace]),
    ).toEqual([["telegram", "sekaisen"]]);
  });
});
