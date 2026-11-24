import type {
  Capabilities,
  HarnessAdapter,
  RunOutcome,
  StartTurn,
} from "../adapter/types.js";
import { refusalLine } from "../engine/classify.js";
import type { PluginApi, TaskRunView } from "./api.js";

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
  /** Run ids this adapter cancelled itself; they read as killed. Kept for the process's life. */
  protected readonly aborted = new Set<string>();

  constructor(o: AdapterOptions) {
    this.o = o;
    this.api = o.api;
  }

  /** The agent that owns a run this adapter dispatched, if it still remembers. */
  agentOf(runId: string): string | undefined {
    return this.owners.get(runId);
  }

  async capabilities(): Promise<Capabilities> {
    const cfg = await this.config();
    const defaults = obj(obj(cfg).agents).defaults;
    const timeoutS = num(obj(defaults).timeoutSeconds);
    const lane = num(obj(obj(defaults).subagents).maxConcurrent);
    return {
      turnCapMs:
        this.o.turnCapMs ??
        (timeoutS !== undefined ? timeoutS * 1000 : 5_400_000),
      maxConcurrent: this.o.maxConcurrent ?? lane ?? 8,
      canAbort: true,
      subscriptionProvider: this.o.subscriptionProvider ?? "claude-cli",
      agentTools: async (agent) => {
        const c = await this.config();
        const agents = obj(obj(c).agents);
        const own = alsoAllow(agentEntry(agents, agent));
        return own ?? alsoAllow(agents.defaults) ?? [];
      },
    };
  }

  private async config(): Promise<unknown> {
    try {
      return await this.api.runtime.config.current();
    } catch {
      return undefined;
    }
  }

  async openSession(_agent: string, _key: string): Promise<void> {
    // A run creates its own session.
  }

  async startTurn(p: StartTurn): Promise<{ runId: string }> {
    if (!this.o.agents.includes(p.agent)) {
      throw new Error(
        `agent "${p.agent}" is not listed in the adapter's agents; list it so its runs can be found again after a restart`,
      );
    }
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

  async readRunOutcome(runId: string): Promise<RunOutcome> {
    const found = await this.findRow(runId);
    if (!found) return { state: "unknown" };
    const { row, agent } = found;
    if (row.status === "queued" || row.status === "running") {
      return { state: "running" };
    }
    if (row.status === "lost") return { state: "unknown" };

    const wasAborted = this.aborted.has(runId);
    const ending: "ok" | "error" | "timeout" | "killed" = wasAborted
      ? "killed"
      : row.status === "succeeded"
        ? "ok"
        : row.status === "timed_out"
          ? "timeout"
          : row.status === "cancelled"
            ? "killed"
            : "error";

    const waited = await this.waitText(runId);
    const texts = [waited, row.error, row.terminalSummary].filter(
      (t): t is string => typeof t === "string" && t.length > 0,
    );
    const error = texts.find((t) => refusalLine(t) !== undefined) ?? texts[0];

    const out: RunOutcome = { state: "ended", ending };
    if (error !== undefined) out.error = error;
    const runtime = await this.runtimeOf(agent, row.childSessionKey);
    if (runtime) out.runtime = runtime;
    // An aborted run stays remembered so a repeat read still says killed.
    if (!wasAborted) this.owners.delete(runId);
    return out;
  }

  private async waitText(runId: string): Promise<string | undefined> {
    try {
      const w = await this.api.runtime.subagent.waitForRun({
        runId,
        timeoutMs: 1,
      });
      return typeof w?.error === "string" ? w.error : undefined;
    } catch {
      return undefined;
    }
  }

  private async runtimeOf(
    agent: string,
    sessionKey: string | undefined,
  ): Promise<{ provider: string; model: string } | undefined> {
    if (!sessionKey) return undefined;
    try {
      const e = await this.api.runtime.agent.session.getSessionEntry({
        agentId: agent,
        sessionKey,
        readConsistency: "latest",
      });
      if (typeof e?.modelProvider === "string" && typeof e.model === "string") {
        return { provider: e.modelProvider, model: e.model };
      }
    } catch {
      // No session row: the outcome simply carries no runtime.
    }
    return undefined;
  }

  /** The newest ledger row for a run: the remembered agent first, else a scan. */
  private async findRow(
    runId: string,
  ): Promise<{ row: TaskRunView; agent: string } | undefined> {
    const known = this.owners.get(runId);
    const candidates = known ? [known] : this.o.agents;
    let best: { row: TaskRunView; agent: string } | undefined;
    for (const agent of candidates) {
      const rows = await this.api.runtime.tasks.runs
        .bindSession({ sessionKey: `agent:${agent}:main` })
        .list();
      for (const row of rows) {
        if (row.runId !== runId) continue;
        if (!best || row.createdAt > best.row.createdAt) best = { row, agent };
      }
    }
    return best;
  }

  /**
   * Cancels the run's task in its owner's ledger. True only when OpenClaw
   * cancelled it; a task already terminal keeps its real ending.
   */
  async abortTurn(runId: string): Promise<boolean> {
    const found = await this.findRow(runId);
    if (!found) return false;
    const cfg = await this.api.runtime.config.current();
    const r = await this.api.runtime.tasks.runs
      .bindSession({ sessionKey: `agent:${found.agent}:main` })
      .cancel({ taskId: found.row.id, cfg });
    if (r?.cancelled !== true) return false;
    this.aborted.add(runId);
    return true;
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

function obj(v: unknown): Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v)
    ? (v as Record<string, unknown>)
    : {};
}

function num(v: unknown): number | undefined {
  return typeof v === "number" && Number.isFinite(v) && v > 0 ? v : undefined;
}

/** An agent's config entry, from the `entries` map or the older `list` array. */
function agentEntry(agents: Record<string, unknown>, id: string): unknown {
  const entries = agents.entries;
  if (
    typeof entries === "object" &&
    entries !== null &&
    !Array.isArray(entries)
  ) {
    const e = (entries as Record<string, unknown>)[id];
    if (e !== undefined) return e;
  }
  const list = Array.isArray(agents.list) ? agents.list : [];
  return list.find((a) => obj(a).id === id);
}

function alsoAllow(entry: unknown): string[] | undefined {
  const v = obj(obj(entry).tools).alsoAllow;
  return Array.isArray(v)
    ? v.filter((x): x is string => typeof x === "string")
    : undefined;
}
