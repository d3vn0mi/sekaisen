import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, test, vi } from "vitest";
import { VirtualClock } from "../../../src/engine/clock.js";
import { createRegistry } from "../../../src/host/registry.js";
import type {
  ToolContext,
  ToolDefinition,
  ToolFactory,
} from "../../../src/openclaw/api.js";
import {
  createPipelinePlugin,
  OpenClawAdapter,
  type PipelinePlugin,
  type PipelinePluginOptions,
} from "../../../src/openclaw/index.js";
import type { Store } from "../../../src/store/types.js";
import { reviewLoop, SwapSource, tokenOf } from "../engine/engine-helpers.js";
import { makeStub, type Stub } from "./stub.js";

// Every store the plugin opens, so a test can see whether it was closed.
const opened = vi.hoisted((): Store[] => []);
vi.mock("../../../src/store/sqlite.js", async (importOriginal) => {
  const real =
    await importOriginal<typeof import("../../../src/store/sqlite.js")>();
  return {
    ...real,
    openSqliteStore: (...args: Parameters<typeof real.openSqliteStore>) => {
      const store = real.openSqliteStore(...args);
      opened.push(store);
      return store;
    },
  };
});

const isOpen = (store: Store | undefined): boolean => {
  try {
    store?.tx((t) => t.getGate("s_NONE"));
    return store !== undefined;
  } catch {
    return false;
  }
};

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

/**
 * The tool named `name`, as OpenClaw would build it for a turn of
 * `agentId`; null builds it for a turn with no agent id.
 */
function toolFor(
  stub: Stub,
  name: string,
  agentId: string | null = "drafter",
): ToolDefinition {
  const ctx: ToolContext =
    agentId === null
      ? { sessionKey: "agent:x:main" }
      : { agentId, sessionKey: "agent:x:main" };
  for (const { tool } of stub.tools) {
    const built =
      typeof tool === "function" ? (tool as ToolFactory)(ctx) : tool;
    for (const t of [built ?? []].flat()) if (t.name === name) return t;
  }
  throw new Error(`no tool ${name} registered`);
}

/** The draft stage's state in the only run. */
function draftState(plugin: PipelinePlugin, runId: string): string | undefined {
  return plugin.engine.status(runId).live?.state;
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
    // Stopping leaves the store open: OpenClaw may start the service again.
    expect(isOpen(opened.at(-1))).toBe(true);
  });

  test("service stop then start runs the engine again", async () => {
    const { stub, plugin } = await setup({ engine: { tickMs: 5 } });
    const service = stub.services[0];
    if (!service?.stop) throw new Error("no stop");
    await service.start();
    await service.stop();
    await service.start();
    await plugin.engine.startRun("review-loop", { topic: "rust" });
    // Dispatched by the engine's own tick, not by the test.
    await vi.waitFor(() => expect(stub.runs).toHaveLength(1));
    await service.stop();
  });

  test("a registration that throws closes the store it opened", async () => {
    const stub = makeStub();
    stub.api.registerService = () => {
      throw new Error("registration refused");
    };
    const before = opened.length;
    expect(() =>
      createPipelinePlugin({
        api: stub.api,
        adapter: { api: stub.api, agents: ["drafter"] },
        storePath: ":memory:",
        tokenSecret: SECRET,
        definitions: new SwapSource(),
        registry: createRegistry(),
      }),
    ).toThrow("registration refused");
    expect(opened.length).toBe(before + 1);
    expect(isOpen(opened.at(-1))).toBe(false);
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

  test("a tool context with no agentId cannot complete a live stage", async () => {
    const { stub, plugin } = await setup();
    const { runId } = await plugin.engine.startRun("review-loop", {
      topic: "rust",
    });
    await plugin.engine.tick();
    const run = stub.runs.at(-1);
    if (!run) throw new Error("no turn dispatched");
    const complete = vi.spyOn(plugin.engine, "complete");
    const progress = vi.spyOn(plugin.engine, "progress");
    const token = tokenOf(run.message);
    for (const name of ["stage_complete", "stage_progress"]) {
      const result = await toolFor(stub, name, null).execute("call-1", {
        token,
        outcome: "drafted",
        fields: { pr_url: "u" },
        note: "n",
      });
      expect(result).toEqual({
        content: [{ type: "text", text: `${name} needs a calling agent` }],
        details: { isError: true },
      });
      const empty = await toolFor(stub, name, "").execute("call-2", {
        token,
        outcome: "drafted",
        fields: { pr_url: "u" },
        note: "n",
      });
      expect(empty).toMatchObject({ details: { isError: true } });
    }
    expect(complete).not.toHaveBeenCalled();
    expect(progress).not.toHaveBeenCalled();
    expect(draftState(plugin, runId)).toBe("working");
  });

  test("an agent other than the stage's is refused", async () => {
    const { stub, plugin } = await setup();
    const { runId } = await plugin.engine.startRun("review-loop", {
      topic: "rust",
    });
    await plugin.engine.tick();
    const run = stub.runs.at(-1);
    if (!run) throw new Error("no turn dispatched");
    const result = await toolFor(stub, "stage_complete", "checker").execute(
      "call-1",
      {
        token: tokenOf(run.message),
        outcome: "drafted",
        fields: { pr_url: "u" },
      },
    );
    expect(result).toMatchObject({
      content: [{ type: "text", text: expect.stringContaining("drafter") }],
      details: { isError: true },
    });
    expect(draftState(plugin, runId)).toBe("working");
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
