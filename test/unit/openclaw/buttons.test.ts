import { afterEach, describe, expect, test, vi } from "vitest";
import { VirtualClock } from "../../../src/engine/clock.js";
import type { EngineEvents } from "../../../src/engine/engine.js";
import { createRegistry } from "../../../src/host/registry.js";
import type { InteractiveContext } from "../../../src/openclaw/api.js";
import {
  createPipelinePlugin,
  type GateButtonOptions,
  gateButtons,
  type PipelinePlugin,
} from "../../../src/openclaw/index.js";
import { openSqliteStore } from "../../../src/store/sqlite.js";
import { inline, SwapSource } from "../engine/engine-helpers.js";
import { makeStub, type SendCall, type Stub } from "./stub.js";

const MIN = 60_000;
const HOUR = 60 * MIN;
const OPERATOR = "1001";
const CHAT = "-2002";

const BUTTONS: GateButtonOptions = {
  channel: "telegram",
  to: `telegram:${CHAT}`,
  accountId: "default",
  operatorIds: [OPERATOR],
};

interface Rig {
  stub: Stub;
  plugin: PipelinePlugin;
  clock: VirtualClock;
}

const plugins: PipelinePlugin[] = [];
afterEach(async () => {
  for (const p of plugins.splice(0)) await p.close();
});

/** A plugin whose `held` pipeline is one operator gate between start and an end. */
function rig(): Rig {
  const stub = makeStub();
  const clock = new VirtualClock(1_000_000);
  const source = new SwapSource(
    inline({
      id: "held",
      start: "publish",
      stages: {
        publish: {
          type: "gate",
          who: "operator",
          prompt: "Publish the draft?",
          timeout: HOUR,
          onTimeout: { remind: 10 * MIN },
          outcomes: { approve: { next: "done" }, reject: { next: "failed" } },
        },
        done: { type: "end", status: "completed" },
        failed: { type: "end", status: "failed" },
      },
    }),
  );
  const plugin = createPipelinePlugin({
    api: stub.api,
    adapter: { api: stub.api, agents: ["drafter"] },
    storePath: ":memory:",
    tokenSecret: new Uint8Array(32).fill(9),
    definitions: source,
    registry: createRegistry(),
    engine: { clock },
    buttons: BUTTONS,
  });
  plugins.push(plugin);
  return { stub, plugin, clock };
}

/** Lets the listeners' async sends run to the end. */
async function settle(): Promise<void> {
  for (let i = 0; i < 10; i++) await new Promise((r) => setImmediate(r));
}

async function openGate(r: Rig): Promise<{ runId: string; id: string }> {
  const { runId } = await r.plugin.engine.startRun("held", {});
  await r.plugin.engine.tick();
  const id = r.plugin.engine.status(runId).live?.stageRunId;
  if (!id) throw new Error("no gate open");
  await settle();
  return { runId, id };
}

interface Pressed {
  ctx: InteractiveContext;
  replies: string[];
}

function press(
  payload: string,
  over: { senderId?: string | undefined; auth?: unknown } = {},
): Pressed {
  const replies: string[] = [];
  const ctx: Record<string, unknown> = {
    channel: "telegram",
    accountId: "default",
    senderId: OPERATOR,
    isGroup: true,
    auth: { isAuthorizedSender: true },
    callback: {
      data: `sekaisen:${payload}`,
      namespace: "sekaisen",
      payload,
      messageId: 7,
      chatId: CHAT,
    },
    respond: {
      async reply(p: { text: string }) {
        replies.push(p.text);
      },
    },
  };
  for (const [k, v] of Object.entries(over)) {
    if (v === undefined) delete ctx[k];
    else ctx[k] = v;
  }
  return { ctx: ctx as unknown as InteractiveContext, replies };
}

async function handle(r: Rig, p: Pressed): Promise<unknown> {
  const h = r.stub.handlers[0];
  if (!h) throw new Error("no interactive handler");
  return h.handler(p.ctx);
}

/** Who resolved the run's gate, from its transitions; null while it waits. */
function resolvedBy(r: Rig, runId: string): string | null {
  const view = r.plugin.engine.status(runId);
  const t = view.transitions.find((x) => x.event === "gate_resolved");
  return t?.actor ?? view.gate?.resolvedBy ?? null;
}

interface Buttons {
  text: string;
  presentation: {
    blocks: Array<{
      type: string;
      buttons: Array<Record<string, unknown>>;
    }>;
  };
}

/** The buttons of a sent prompt; throws when nothing was sent. */
function buttonsOf(sent: SendCall | undefined): Array<Record<string, unknown>> {
  if (!sent) throw new Error("nothing was sent");
  return (sent.payload as Buttons).presentation.blocks[0]?.buttons ?? [];
}

describe("gate buttons", () => {
  test("a gate posts one button per outcome with raw callback values", async () => {
    const r = rig();
    const { id } = await openGate(r);
    expect(r.stub.loaded).toEqual(["telegram"]);
    expect(r.stub.sent).toHaveLength(1);
    const sent = r.stub.sent[0];
    expect(sent).toMatchObject({
      cfg: r.stub.config,
      to: `telegram:${CHAT}`,
      accountId: "default",
      text: expect.stringContaining("Publish the draft?"),
    });
    const payload = sent?.payload as Buttons;
    expect(payload.text).toBe(sent?.text);
    expect(payload.presentation.blocks).toHaveLength(1);
    expect(payload.presentation.blocks[0]?.type).toBe("buttons");
    const buttons = payload.presentation.blocks[0]?.buttons ?? [];
    expect(buttons).toEqual([
      { label: "approve", value: `sekaisen:${id}:0` },
      { label: "reject", value: `sekaisen:${id}:1` },
    ]);
    expect(buttons[1]?.value).toBe(`sekaisen:${id}:1`);
    for (const b of buttons) expect(b).not.toHaveProperty("action");
  });

  test("a reminder re-posts the prompt", async () => {
    const r = rig();
    const { id } = await openGate(r);
    r.clock.advance(HOUR);
    await r.plugin.engine.tick();
    await settle();
    expect(r.stub.sent).toHaveLength(2);
    const again = r.stub.sent[1];
    expect(again?.text).toContain("Publish the draft?");
    expect(buttonsOf(again).map((b) => b.value)).toEqual([
      `sekaisen:${id}:0`,
      `sekaisen:${id}:1`,
    ]);
  });

  test("a press from an operator resolves the gate with resolved_by telegram:<sender>", async () => {
    const r = rig();
    const { runId, id } = await openGate(r);
    const p = press(`${id}:0`);
    expect(await handle(r, p)).toEqual({ handled: true });
    expect(r.plugin.engine.status(runId).run.status).toBe("completed");
    expect(resolvedBy(r, runId)).toBe(`telegram:${OPERATOR}`);
    expect(p.replies).toHaveLength(1);
    expect(p.replies[0]).toContain("approve");
  });

  test("a press from anyone else is refused", async () => {
    const r = rig();
    const { runId, id } = await openGate(r);
    const resolve = vi.spyOn(r.plugin.engine, "resolveGate");
    for (const over of [
      { senderId: "3003" },
      { senderId: undefined },
      { auth: { isAuthorizedSender: false } },
      { auth: undefined },
      { auth: {} },
    ]) {
      const p = press(`${id}:0`, over);
      expect(await handle(r, p)).toEqual({ handled: true });
      expect(p.replies).toEqual(["not allowed"]);
    }
    expect(resolve).not.toHaveBeenCalled();
    expect(resolvedBy(r, runId)).toBeNull();
    expect(r.plugin.engine.status(runId).run.status).toBe("input_required");
  });

  test("a press for a stage run not waiting, or an index out of range, changes nothing", async () => {
    const r = rig();
    const { runId, id } = await openGate(r);
    const cases: Array<[string, string]> = [
      [`${id}:2`, "no outcome 2"],
      [`${id}:-1`, "not a gate button"],
      [`${id}:1.5`, "not a gate button"],
      [`${id}:`, "not a gate button"],
      [id, "not a gate button"],
      ["s_NOSUCHSTAGERUN:0", "not waiting on a gate"],
    ];
    for (const [payload, reason] of cases) {
      const p = press(payload);
      expect(await handle(r, p)).toEqual({ handled: true });
      expect(p.replies).toHaveLength(1);
      expect(p.replies[0]).toContain(reason);
    }
    expect(resolvedBy(r, runId)).toBeNull();
    expect(r.plugin.engine.status(runId).run.status).toBe("input_required");

    // Once resolved, a second press is answered with the engine's reason.
    await handle(r, press(`${id}:1`));
    expect(resolvedBy(r, runId)).toBe(`telegram:${OPERATOR}`);
    expect(r.plugin.engine.status(runId).run.status).toBe("failed");
    const late = press(`${id}:0`);
    await handle(r, late);
    expect(late.replies[0]).toContain("already resolved");
    expect(r.plugin.engine.status(runId).run.status).toBe("failed");
  });

  test("callback data stays within 64 bytes", async () => {
    const r = rig();
    const { id } = await openGate(r);
    expect(id).toMatch(/^s_[0-9A-Z]{12}$/);
    const buttons = buttonsOf(r.stub.sent[0]);
    expect(buttons.length).toBeGreaterThan(0);
    for (const b of buttons) {
      expect(Buffer.byteLength(String(b.value))).toBeLessThanOrEqual(64);
    }
  });

  test("a gate whose callback data would pass 64 bytes is not sent, and says so", async () => {
    const stub = makeStub();
    const listeners = new Map<string, (e: unknown) => void>();
    const engine = {
      on(event: string, fn: (e: unknown) => void) {
        listeners.set(event, fn);
        return { dispose() {} };
      },
      async resolveGate() {},
    };
    const store = openSqliteStore(":memory:");
    try {
      gateButtons(BUTTONS).install({
        api: stub.api,
        engine: engine as never,
        store,
      });
      const event: EngineEvents["gate"] = {
        runId: "r_1",
        stageRunId: `s_${"X".repeat(60)}`,
        stage: "publish",
        prompt: "Go?",
        outcomes: ["approve"],
      };
      listeners.get("gate")?.(event);
      await settle();
      expect(stub.sent).toEqual([]);
      expect(stub.warnings).toHaveLength(1);
      expect(stub.warnings[0]).toContain(event.stageRunId);
      expect(stub.warnings[0]).toContain("64 bytes");
    } finally {
      store.close();
    }
  });

  test("a channel that cannot send is logged, never thrown", async () => {
    for (const outbound of [
      undefined,
      {},
      {
        async sendPayload(): Promise<unknown> {
          throw new Error("chat not found");
        },
      },
    ]) {
      const r = rig();
      r.stub.outbound = outbound;
      await openGate(r);
      expect(r.stub.sent).toEqual([]);
      expect(r.stub.warnings).toHaveLength(1);
      expect(r.stub.warnings[0]).toContain("telegram");
    }
  });

  test("a gate with no prompt still names its stage", async () => {
    const r = rig();
    const { id } = await openGate(r);
    const store = openSqliteStore(":memory:");
    const listeners = new Map<string, (e: unknown) => void>();
    try {
      gateButtons(BUTTONS).install({
        api: r.stub.api,
        engine: {
          on(event: string, fn: (e: unknown) => void) {
            listeners.set(event, fn);
            return { dispose() {} };
          },
        } as never,
        store,
      });
      listeners.get("gate_reminder")?.({
        runId: "r_1",
        stageRunId: id,
        stage: "publish",
        prompt: null,
        outcomes: ["approve"],
        reminder: 2,
      });
      await settle();
      expect(r.stub.sent.at(-1)?.text).toContain("publish");
    } finally {
      store.close();
    }
  });
});
