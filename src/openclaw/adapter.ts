import type {
  Capabilities,
  HarnessAdapter,
  RunOutcome,
  StartTurn,
} from "../adapter/types.js";
import type { PluginApi } from "./api.js";

export interface AdapterOptions {
  api: PluginApi;
  /** The agent ids pipelines may name; scanned on a cold lookup. */
  agents: string[];
  /** Maps an engine session key to an OpenClaw one. */
  sessionKey?(engineKey: string, agent: string): string;
  /** Pins a provider and model, by agent. Opt-in. */
  pin?: Record<string, { provider: string; model: string }>;
  turnCapMs?: number;
  maxConcurrent?: number;
  subscriptionProvider?: string;
}

const NOT_TRUSTED = "not trusted for fallback provider/model override requests";
const NOT_ALLOWED = "by agents.defaults.modelPolicy.allow";

/** The default mapping from the engine's session keys to OpenClaw's. */
export function defaultSessionKey(engineKey: string, agent: string): string {
  const run = /^run:([^:]+):.+$/.exec(engineKey);
  if (run) return `agent:${agent}:pipe-${run[1]}`.toLowerCase();
  const project = /^project:(.+):[^:]+$/.exec(engineKey);
  if (project) return `agent:${agent}:proj-${project[1]}`.toLowerCase();
  throw new Error(
    `unrecognised session key "${engineKey}": expected run:<id>:<agent> or project:<name>:<agent>`,
  );
}

export class OpenClawAdapter implements HarnessAdapter {
  private readonly api: PluginApi;
  private readonly o: AdapterOptions;
  private readonly owners = new Map<string, string>();

  constructor(o: AdapterOptions) {
    this.o = o;
    this.api = o.api;
  }

  /** The agent that owns a run this adapter dispatched, if it still remembers. */
  agentOf(runId: string): string | undefined {
    return this.owners.get(runId);
  }

  async capabilities(): Promise<Capabilities> {
    throw new Error("not implemented yet");
  }

  async openSession(_agent: string, _key: string): Promise<void> {
    // A run creates its own session.
  }

  async startTurn(p: StartTurn): Promise<{ runId: string }> {
    // `p.tools` is ignored: a per-run grant does not reach claude-cli turns,
    // so completion tools are granted by the agent's own tool config.
    const sessionKey = (this.o.sessionKey ?? defaultSessionKey)(
      p.sessionKey,
      p.agent,
    );
    const pin = this.o.pin?.[p.agent];
    try {
      const r = await this.api.runtime.subagent.run({
        sessionKey,
        message: p.message,
        idempotencyKey: p.idempotencyKey,
        deliver: false,
        ...(pin ? { provider: pin.provider, model: pin.model } : {}),
      });
      this.owners.set(r.runId, p.agent);
      return { runId: r.runId };
    } catch (e) {
      throw this.rewriteRefusal(e);
    }
  }

  async readRunOutcome(_runId: string): Promise<RunOutcome> {
    throw new Error("not implemented yet");
  }

  async deliver(_sessionKey: string, _message: string): Promise<void> {
    throw new Error("deliver is not supported by the OpenClaw adapter");
  }

  private rewriteRefusal(e: unknown): unknown {
    const text = e instanceof Error ? e.message : String(e);
    if (!text.includes(NOT_TRUSTED) && !text.includes(NOT_ALLOWED)) return e;
    return new Error(
      `pinning a model needs plugins.entries.${this.api.id}.subagent.allowModelOverride: true and the model listed in agents.defaults.modelPolicy.allow. OpenClaw said: ${text}`,
    );
  }
}
