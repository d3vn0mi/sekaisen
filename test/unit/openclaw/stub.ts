import type {
  AgentWaitResult,
  InteractiveHandlerDefinition,
  OutboundAdapter,
  OutboundPayload,
  PluginApi,
  ServiceDefinition,
  SessionEntry,
  TaskRunView,
  ToolDefinition,
  ToolFactory,
  ToolOptions,
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

export type SendCall = OutboundPayload;

export interface Stub {
  api: PluginApi;
  services: ServiceDefinition[];
  tools: Array<{ tool: ToolDefinition | ToolFactory; opts?: ToolOptions }>;
  handlers: InteractiveHandlerDefinition[];
  /** Every `sendPayload` call the default outbound adapter received. */
  sent: SendCall[];
  /** Channels `loadAdapter` was asked for. */
  loaded: string[];
  /** What `loadAdapter` returns; the default records into `sent`. */
  outbound: OutboundAdapter | undefined;
  warnings: string[];
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
    services: [],
    tools: [],
    handlers: [],
    sent: [],
    loaded: [],
    outbound: undefined,
    warnings: [],
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
  s.outbound = {
    async sendPayload(p) {
      s.sent.push(p);
      return { messageId: s.sent.length };
    },
  };
  s.api = {
    id,
    pluginConfig: {},
    logger: {
      info() {},
      warn(message) {
        s.warnings.push(message);
      },
      error() {},
    },
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
          loadAdapter(channel) {
            s.calls.push("channel.outbound.loadAdapter");
            s.loaded.push(channel);
            return s.outbound;
          },
        },
      },
    },
    registerService(service) {
      s.services.push(service);
    },
    registerTool(tool, opts) {
      s.tools.push(opts === undefined ? { tool } : { tool, opts });
    },
    registerInteractiveHandler(h) {
      s.handlers.push(h);
    },
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
