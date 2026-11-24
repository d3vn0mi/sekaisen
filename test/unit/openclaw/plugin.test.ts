import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, test, vi } from "vitest";
import { VirtualClock } from "../../../src/engine/clock.js";
import { createRegistry } from "../../../src/host/registry.js";
import type {
  InteractiveHandlerDefinition,
  PluginApi,
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
import {
  inline,
  reviewLoop,
  SwapSource,
  tokenOf,
} from "../engine/engine-helpers.js";
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
  for (const p of plugins.splice(0)) await p.close();
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

describe("registration modes and one engine per store", () => {
  /** A pipeline that is one operator gate between start and an end. */
  function held(): SwapSource {
    return new SwapSource(
      inline({
        id: "held",
        start: "publish",
        stages: {
          publish: {
            type: "gate",
            who: "operator",
            prompt: "Publish?",
            timeout: 3_600_000,
            onTimeout: { remind: 600_000 },
            outcomes: { approve: { next: "done" } },
          },
          done: { type: "end", status: "completed" },
        },
      }),
    );
  }

  /** Presses the gate's first button through `handler`, as `senderId`; the reply. */
  async function pressFirst(
    handler: InteractiveHandlerDefinition | undefined,
    stageRunId: string,
    senderId: string,
  ): Promise<string[]> {
    if (!handler) throw new Error("no interactive handler");
    const replies: string[] = [];
    await handler.handler({
      channel: "telegram",
      senderId,
      auth: { isAuthorizedSender: true },
      callback: {
        data: `sekaisen:${stageRunId}:0`,
        namespace: "sekaisen",
        payload: `${stageRunId}:0`,
        chatId: senderId,
      },
      respond: {
        async reply(p: { text: string }) {
          replies.push(p.text);
        },
      },
    });
    return replies;
  }

  /** Opens the held gate; its stage run id. */
  async function openHeld(plugin: PipelinePlugin): Promise<{
    runId: string;
    id: string;
  }> {
    const { runId } = await plugin.engine.startRun("held", {});
    await plugin.engine.tick();
    const id = plugin.engine.status(runId).live?.stageRunId;
    if (!id) throw new Error("no gate open");
    return { runId, id };
  }

  function tempStore(): string {
    const dir = mkdtempSync(join(tmpdir(), "sekaisen-plugin-"));
    dirs.push(dir);
    return join(dir, "store.db");
  }

  async function register(
    stub: Stub,
    over: Partial<PipelinePluginOptions> = {},
  ): Promise<PipelinePlugin> {
    const plugin = createPipelinePlugin({
      api: stub.api,
      adapter: { agents: ["drafter", "checker"] },
      storePath: ":memory:",
      tokenSecret: SECRET,
      definitions: new SwapSource(await reviewLoop()),
      registry: createRegistry(),
      engine: { clock: new VirtualClock(1_000_000) },
      ...over,
    });
    plugins.push(plugin);
    return plugin;
  }

  test("outside full registration nothing stateful happens, and the runtime is not touched", async () => {
    for (const mode of [
      "discovery",
      "tool-discovery",
      "setup-only",
      "setup-runtime",
      "cli-metadata",
    ]) {
      const stub = makeStub();
      stub.api.registrationMode = mode;
      stub.api.runtime = new Proxy({} as PluginApi["runtime"], {
        get() {
          throw new Error(`runtime unavailable during ${mode}`);
        },
      });
      const before = opened.length;
      const plugin = await register(stub, {
        storePath: tempStore(),
        buttons: { channel: "telegram", to: "telegram:1", operatorIds: [] },
      });
      expect(opened.length).toBe(before);
      expect(stub.services).toEqual([]);
      expect(stub.handlers).toEqual([]);
      // The tool names are still there for OpenClaw to discover.
      expect(stub.tools.map((t) => t.opts?.name).sort()).toEqual([
        "stage_complete",
        "stage_progress",
      ]);
      // With no engine running in the process, a call is an error result.
      const result = await toolFor(stub, "stage_complete").execute("c-1", {
        token: "t",
        outcome: "drafted",
      });
      expect(result).toMatchObject({
        content: [
          { type: "text", text: expect.stringContaining("no pipeline engine") },
        ],
        details: { isError: true },
      });
      expect(() => plugin.engine).toThrow(/no pipeline engine/);
    }
  });

  test("a host tool outside full registration reaches the engine lazily", async () => {
    const storePath = tempStore();
    const discovery = makeStub();
    discovery.api.registrationMode = "tool-discovery";
    const lazy = await register(discovery, { storePath });
    lazy.tool("demo_runs", "Counts runs.", { type: "object" }, async () => {
      const { runId } = await lazy.engine.startRun("review-loop", {
        topic: "rust",
      });
      return { text: runId, isError: false };
    });
    const tool = toolFor(discovery, "demo_runs");
    expect(await tool.execute("c-1", {})).toMatchObject({
      content: [
        { type: "text", text: expect.stringContaining("no pipeline engine") },
      ],
      details: { isError: true },
    });

    const full = makeStub();
    full.api.registrationMode = "full";
    const plugin = await register(full, { storePath });
    expect(lazy.engine).toBe(plugin.engine);
    expect(lazy.adapter).toBe(plugin.adapter);
    expect(await tool.execute("c-2", {})).toMatchObject({
      details: { isError: false },
    });
  });

  test("two registrations with one store share one engine", async () => {
    const storePath = tempStore();
    const first = makeStub();
    const before = opened.length;
    const a = await register(first, { storePath });
    const second = makeStub();
    second.api.registrationMode = "full";
    const b = await register(second, { storePath });
    expect(opened.length).toBe(before + 1);
    expect(b.engine).toBe(a.engine);
    expect(b.adapter).toBe(a.adapter);
    // Each registry gets its own service and tools.
    expect(second.services.map((s) => s.id)).toEqual(["sekaisen"]);

    // A tool built from either registration completes the same engine's turn.
    await a.engine.startRun("review-loop", { topic: "rust" });
    await a.engine.tick();
    const run = first.runs.at(-1);
    if (!run) throw new Error("no turn dispatched");
    const result = await toolFor(second, "stage_complete").execute("c-1", {
      token: tokenOf(run.message),
      outcome: "drafted",
      fields: { pr_url: "https://demo.example/pr/1" },
    });
    expect(result).toMatchObject({ details: { isError: false } });

    // So does a tool-discovery registration in the same process.
    const discovery = makeStub();
    discovery.api.registrationMode = "tool-discovery";
    await register(discovery, { storePath });
    expect(opened.length).toBe(before + 1);
    const progress = vi.spyOn(a.engine, "progress");
    await toolFor(discovery, "stage_progress").execute("c-2", {
      token: "t",
      note: "n",
    });
    expect(progress).toHaveBeenCalledTimes(1);
  });

  test("a re-registration with buttons posts each gate once, on the new api", async () => {
    const storePath = tempStore();
    const buttons = {
      channel: "telegram",
      to: "telegram:1",
      operatorIds: ["1"],
    };
    const definitions = held();
    const first = makeStub();
    const a = await register(first, { storePath, buttons, definitions });
    const second = makeStub();
    await register(second, { storePath, buttons, definitions });
    expect(second.handlers.map((h) => h.namespace)).toEqual(["sekaisen"]);
    await a.engine.startRun("held", {});
    await a.engine.tick();
    for (let i = 0; i < 10; i++) await new Promise((r) => setImmediate(r));
    expect(first.sent).toHaveLength(0);
    expect(second.sent).toHaveLength(1);
  });

  test("a re-registration's buttons replace the old ones, whose handler then refuses every press", async () => {
    const storePath = tempStore();
    const definitions = held();
    const first = makeStub();
    const a = await register(first, {
      storePath,
      definitions,
      buttons: { channel: "telegram", to: "telegram:1", operatorIds: ["1"] },
    });
    const second = makeStub();
    await register(second, {
      storePath,
      definitions,
      buttons: { channel: "telegram", to: "telegram:2", operatorIds: ["2"] },
    });
    const { runId, id } = await openHeld(a);
    // Only the old list had "1"; the old handler no longer answers for it.
    expect(await pressFirst(first.handlers[0], id, "1")).toEqual([
      "not allowed",
    ]);
    expect(await pressFirst(second.handlers[0], id, "1")).toEqual([
      "not allowed",
    ]);
    expect(a.engine.status(runId).run.status).toBe("input_required");
    // The new operator answers through the new handler.
    const answered = await pressFirst(second.handlers[0], id, "2");
    expect(answered[0]).toContain("approve");
    expect(a.engine.status(runId).run.status).toBe("completed");
  });

  test("a re-registration without buttons retires the old ones", async () => {
    const storePath = tempStore();
    const definitions = held();
    const first = makeStub();
    const a = await register(first, {
      storePath,
      definitions,
      buttons: { channel: "telegram", to: "telegram:1", operatorIds: ["1"] },
    });
    const second = makeStub();
    await register(second, { storePath, definitions });
    expect(second.handlers).toEqual([]);
    const { runId, id } = await openHeld(a);
    for (let i = 0; i < 10; i++) await new Promise((r) => setImmediate(r));
    expect(first.sent).toHaveLength(0);
    expect(await pressFirst(first.handlers[0], id, "1")).toEqual([
      "not allowed",
    ]);
    expect(a.engine.status(runId).run.status).toBe("input_required");
  });

  test("a re-registration with another token secret is refused", async () => {
    const storePath = tempStore();
    const a = await register(makeStub(), { storePath });
    const other = makeStub();
    await expect(
      register(other, {
        storePath,
        tokenSecret: new Uint8Array(32).fill(8),
      }),
    ).rejects.toThrow(/different tokenSecret/);
    // Refused before anything was registered; the running engine is kept.
    expect(other.services).toEqual([]);
    expect(other.tools).toEqual([]);
    expect(isOpen(opened.at(-1))).toBe(true);
    // The same secret, in a fresh copy, is accepted.
    const b = await register(makeStub(), {
      storePath,
      tokenSecret: Uint8Array.from(SECRET),
    });
    expect(b.engine).toBe(a.engine);
  });

  test("a failed re-registration leaves the shared store open", async () => {
    const storePath = tempStore();
    const a = await register(makeStub(), { storePath });
    const broken = makeStub();
    broken.api.registerService = () => {
      throw new Error("registration refused");
    };
    await expect(register(broken, { storePath })).rejects.toThrow(
      "registration refused",
    );
    expect(isOpen(opened.at(-1))).toBe(true);
    expect(a.engine.status).toBeTypeOf("function");
  });

  test("close stops the engine, closes the store and forgets it", async () => {
    const storePath = tempStore();
    const a = await register(makeStub(), { storePath });
    const stop = vi.spyOn(a.engine, "stop");
    const store = opened.at(-1);
    await a.close();
    expect(stop).toHaveBeenCalledTimes(1);
    expect(isOpen(store)).toBe(false);
    // Closing twice is harmless.
    await a.close();
    const before = opened.length;
    const b = await register(makeStub(), { storePath });
    expect(opened.length).toBe(before + 1);
    expect(b.engine).not.toBe(a.engine);
  });

  test("an in-memory store is never shared", async () => {
    const a = await register(makeStub());
    const b = await register(makeStub());
    expect(b.engine).not.toBe(a.engine);
  });

  test("adapter options may leave out api", async () => {
    const stub = makeStub();
    const plugin = await register(stub);
    await plugin.engine.startRun("review-loop", { topic: "rust" });
    await plugin.engine.tick();
    expect(stub.runs).toHaveLength(1);
  });
});
