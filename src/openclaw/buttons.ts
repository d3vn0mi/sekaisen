import type { Engine, EngineEvents } from "../engine/engine.js";
import type { Disposable } from "../engine/events.js";
import type { Store } from "../store/types.js";
import type { InteractiveContext, PluginApi } from "./api.js";

/** Where gate prompts go and who may answer them. */
export interface GateButtonOptions {
  /** The OpenClaw channel the prompt is sent on, e.g. `"telegram"`. */
  channel: string;
  /** The channel's target for the prompt, e.g. `"telegram:<chatId>"`. */
  to: string;
  accountId?: string;
  /** Sender ids whose presses resolve a gate; anyone else is refused. */
  operatorIds: string[];
}

/** What the buttons need from the plugin that hosts the engine. */
export interface GateButtonHost {
  api: PluginApi;
  engine: Pick<Engine, "on" | "resolveGate">;
  /** Read for a pressed gate's outcomes, so a press works after a restart. */
  store: Store;
}

export interface GateButtons {
  /**
   * Registers the press handler and posts every `gate` and `gate_reminder`
   * event. Install before the engine starts: start-up can emit a reminder.
   */
  install(host: GateButtonHost): Disposable;
}

/** The interactive namespace; OpenClaw routes callback data by its prefix. */
export const BUTTON_NAMESPACE = "sekaisen";
/** Telegram's limit on a button's callback data. */
export const MAX_CALLBACK_BYTES = 64;

/** A button's callback data: the namespace, the stage run and the outcome index. */
export function callbackData(stageRunId: string, index: number): string {
  return `${BUTTON_NAMESPACE}:${stageRunId}:${index}`;
}

type GateEvent = EngineEvents["gate"] | EngineEvents["gate_reminder"];

const NOT_A_BUTTON = "not a gate button";
const NOT_ALLOWED = "not allowed";

/**
 * Posts each operator gate as a message with one button per outcome, and
 * resolves the gate when an operator presses one.
 *
 * A button's value is sent as raw callback data (`sekaisen:<stageRunId>:<i>`);
 * an OpenClaw `action` would wrap it in an opaque id the namespace cannot
 * match. A press resolves the gate only when OpenClaw says the sender is
 * authorised and the sender is in `operatorIds`; the outcome is read by
 * index from the gate row in the store, and `resolved_by` is
 * `<channel>:<senderId>`, the operator who pressed.
 */
export function gateButtons(o: GateButtonOptions): GateButtons {
  return {
    install({ api, engine, store }) {
      const warn = (message: string) => {
        try {
          api.logger.warn(message);
        } catch {
          // A logger that fails cannot be told so.
        }
      };

      const post = async (e: GateEvent): Promise<void> => {
        const values = e.outcomes.map((_, i) => callbackData(e.stageRunId, i));
        if (values.some((v) => Buffer.byteLength(v) > MAX_CALLBACK_BYTES)) {
          warn(
            `sekaisen: gate buttons for stage run ${e.stageRunId} not sent: their callback data passes ${MAX_CALLBACK_BYTES} bytes`,
          );
          return;
        }
        const adapter = await api.runtime.channel.outbound.loadAdapter(
          o.channel,
        );
        if (!adapter?.sendPayload) {
          warn(
            `sekaisen: gate for stage run ${e.stageRunId} not posted: channel ${o.channel} has no outbound adapter that sends payloads`,
          );
          return;
        }
        const ask = e.prompt ?? `Gate ${e.stage} is waiting for an answer.`;
        const text = "reminder" in e ? `Reminder ${e.reminder}: ${ask}` : ask;
        const buttons = e.outcomes.map((label, i) => ({
          label,
          value: values[i] as string,
        }));
        await adapter.sendPayload({
          cfg: await api.runtime.config.current(),
          to: o.to,
          text,
          ...(o.accountId === undefined ? {} : { accountId: o.accountId }),
          payload: {
            text,
            presentation: { blocks: [{ type: "buttons", buttons }] },
          },
        });
      };

      const listen = (e: GateEvent) => {
        post(e).catch((err) =>
          warn(
            `sekaisen: gate for stage run ${e.stageRunId} not posted on ${o.channel}: ${message(err)}`,
          ),
        );
      };

      const reply = async (ctx: InteractiveContext, text: string) => {
        try {
          await ctx.respond.reply({ text });
        } catch (err) {
          warn(
            `sekaisen: could not answer a gate button press: ${message(err)}`,
          );
        }
      };

      const answer = async (ctx: InteractiveContext): Promise<string> => {
        const sender = ctx.senderId;
        if (
          ctx.auth?.isAuthorizedSender !== true ||
          typeof sender !== "string" ||
          !o.operatorIds.includes(sender)
        ) {
          return NOT_ALLOWED;
        }
        const { payload, chatId } = ctx.callback ?? {};
        if (typeof payload !== "string" || typeof chatId !== "string") {
          return NOT_A_BUTTON;
        }
        // OpenClaw has split off the namespace; the stage run id is all
        // that precedes the last colon.
        const cut = payload.lastIndexOf(":");
        if (cut <= 0) return NOT_A_BUTTON;
        const stageRunId = payload.slice(0, cut);
        const digits = payload.slice(cut + 1);
        if (!/^\d+$/.test(digits)) return NOT_A_BUTTON;
        const index = Number(digits);
        const gate = store.tx((t) => t.getGate(stageRunId));
        const outcome = gate?.outcomes?.[index];
        if (!gate?.outcomes) {
          return `stage run ${stageRunId} is not waiting on a gate`;
        }
        if (outcome === undefined) {
          return `no outcome ${index} for stage run ${stageRunId}; it has ${gate.outcomes.length}`;
        }
        await engine.resolveGate(stageRunId, outcome, `${o.channel}:${sender}`);
        return `Answered ${outcome} for stage run ${stageRunId}.`;
      };

      api.registerInteractiveHandler({
        channel: o.channel,
        namespace: BUTTON_NAMESPACE,
        async handler(raw) {
          const ctx = raw as InteractiveContext;
          let text: string;
          try {
            text = await answer(ctx);
          } catch (err) {
            text = message(err);
          }
          await reply(ctx, text);
          return { handled: true };
        },
      });

      const subs = [
        engine.on("gate", listen),
        engine.on("gate_reminder", listen),
      ];
      return {
        dispose() {
          for (const s of subs) s.dispose();
        },
      };
    },
  };
}

function message(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}
