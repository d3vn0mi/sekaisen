import type {
  AgentWaitResult,
  PluginApi,
  SessionEntry,
  TaskRunView,
} from "../../../src/openclaw/api.js";

export interface RunCall {
  sessionKey: string;
  message: string;
  idempotencyKey: string;
  deliver: boolean;
  [extra: string]: unknown;
}

export interface CancelCall {
  ownerKey: string;
  taskId: string;
  cfg: unknown;
}

export interface Stub {
  api: PluginApi;
  /** Every runtime call, by name, in order. */
  calls: string[];
  runs: RunCall[];
  cancels: CancelCall[];
  binds: string[];
  /** Task ledgers by owner session key. */
  ledgers: Map<string, TaskRunView[]>;
  /** Session rows by `<agent>|<sessionKey>`. */
  sessions: Map<string, SessionEntry>;
  /** Wait results by run id. */
  waits: Map<string, AgentWaitResult>;
  config: Record<string, unknown>;
  /** What `cancel` answers; a function can throw. */
  cancelResult:
    | { found: boolean; cancelled: boolean; reason?: string }
    | (() => never);
  /** Every `runtime.gateway.request` call; the adapter must make none. */
  gatewayCalls: unknown[];
  /** Makes the next `subagent.run` throw this. */
  failRun?: Error;
}

export function makeStub(id = "demo-plugin"): Stub {
  const s: Stub = {
    api: undefined as unknown as PluginApi,
    calls: [],
    runs: [],
    cancels: [],
    binds: [],
    ledgers: new Map(),
    sessions: new Map(),
    waits: new Map(),
    config: {},
    cancelResult: { found: true, cancelled: true },
    gatewayCalls: [],
  };
  s.api = {
    id,
    pluginConfig: {},
    logger: { info() {}, warn() {}, error() {} },
    runtime: {
      config: {
        current() {
          s.calls.push("config.current");
          return s.config;
        },
      },
      subagent: {
        async run(p) {
          s.calls.push("subagent.run");
          if (s.failRun) throw s.failRun;
          s.runs.push(p as RunCall);
          return { runId: p.idempotencyKey };
        },
        async waitForRun(p) {
          s.calls.push("subagent.waitForRun");
          return s.waits.get(p.runId) ?? { status: "pending" };
        },
      },
      tasks: {
        runs: {
          bindSession({ sessionKey }) {
            s.calls.push("tasks.runs.bindSession");
            s.binds.push(sessionKey);
            return {
              list: () => s.ledgers.get(sessionKey) ?? [],
              async cancel({ taskId, cfg }) {
                s.cancels.push({ ownerKey: sessionKey, taskId, cfg });
                return typeof s.cancelResult === "function"
                  ? s.cancelResult()
                  : s.cancelResult;
              },
            };
          },
        },
      },
      agent: {
        session: {
          getSessionEntry({ agentId, sessionKey }) {
            s.calls.push("agent.session.getSessionEntry");
            return s.sessions.get(`${agentId}|${sessionKey}`);
          },
        },
      },
      channel: {
        outbound: {
          loadAdapter() {
            s.calls.push("channel.outbound.loadAdapter");
            return { async sendPayload() {} };
          },
        },
      },
    },
    registerService() {},
    registerTool() {},
    registerInteractiveHandler() {},
  };
  // Not part of the typed surface: a spy that proves the adapter never reaches for it.
  (s.api.runtime as unknown as Record<string, unknown>).gateway = {
    async request(...args: unknown[]) {
      s.gatewayCalls.push(args);
      return {};
    },
  };
  return s;
}
