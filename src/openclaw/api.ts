/**
 * The parts of the OpenClaw plugin API this adapter and the plugin helper
 * use, described structurally so the package loads and type-checks without
 * OpenClaw installed. Only members they touch are listed, optional where
 * OpenClaw's are, so OpenClaw's own types assign to these; the shapes were
 * recorded from a running gateway.
 */

export interface Logger {
  info(message: string): void;
  warn(message: string): void;
  error(message: string): void;
}

export interface TaskRunView {
  id: string;
  runId?: string;
  status:
    | "queued"
    | "running"
    | "succeeded"
    | "failed"
    | "timed_out"
    | "cancelled"
    | "lost";
  createdAt: number;
  error?: string;
  terminalSummary?: string;
  childSessionKey?: string;
  agentId?: string;
}

export interface AgentWaitResult {
  status: "ok" | "timeout" | "error" | "pending";
  error?: string;
  stopReason?: string;
}

export interface SessionEntry {
  modelProvider?: string;
  model?: string;
  status?: string;
}

/** What a registered tool's factory is told about the calling turn. */
export interface ToolContext {
  agentId?: string;
  sessionKey?: string;
  messageChannel?: string;
  senderIsOwner?: boolean;
  requesterSenderId?: string;
}

export interface SubagentRunParams {
  sessionKey: string;
  message: string;
  idempotencyKey: string;
  deliver: boolean;
  provider?: string;
  model?: string;
}

export interface TaskRunBinding {
  list(): TaskRunView[] | Promise<TaskRunView[]>;
  cancel(p: { taskId: string; cfg: unknown }): Promise<{
    found: boolean;
    cancelled: boolean;
    reason?: string;
    task?: unknown;
  }>;
}

/** What a gate prompt is sent with. */
export interface OutboundPayload {
  cfg: unknown;
  to: string;
  text: string;
  accountId?: string | null;
  payload: unknown;
}

/**
 * A method type compared bivariantly, as TypeScript compares methods, so
 * OpenClaw's adapter (whose `cfg` is its own config type) still fits.
 */
type Bivariant<P, R> = { bivariant(p: P): R }["bivariant"];

export interface OutboundAdapter {
  sendPayload?: Bivariant<OutboundPayload, Promise<unknown>>;
}

export interface Runtime {
  config: { current(): unknown };
  subagent: {
    run(p: SubagentRunParams): Promise<{ runId: string }>;
    waitForRun(p: {
      runId: string;
      timeoutMs: number;
    }): Promise<AgentWaitResult>;
  };
  tasks: {
    runs: { bindSession(p: { sessionKey: string }): TaskRunBinding };
  };
  agent: {
    session: {
      getSessionEntry(p: {
        agentId: string;
        sessionKey: string;
        readConsistency?: "latest";
      }): SessionEntry | undefined | Promise<SessionEntry | undefined>;
    };
  };
  channel: {
    outbound: {
      loadAdapter(
        channel: string,
      ): OutboundAdapter | undefined | Promise<OutboundAdapter | undefined>;
    };
  };
}

export interface ServiceDefinition {
  id: string;
  start(ctx?: unknown): void | Promise<void>;
  stop?(ctx?: unknown): void | Promise<void>;
}

export interface ToolDefinition {
  name: string;
  /** Shown in OpenClaw's UI; OpenClaw's own tool type requires it. */
  label?: string;
  description: string;
  parameters: unknown;
  execute(id: string, params: unknown): Promise<unknown>;
}

export type ToolFactory = (
  ctx: ToolContext,
) => ToolDefinition | ToolDefinition[] | null | undefined;

/**
 * How a tool is registered. OpenClaw records `name` (or `names`) and refuses
 * one the host plugin's manifest does not declare under `contracts.tools`.
 */
export interface ToolOptions {
  name?: string;
  names?: string[];
  optional?: boolean;
}

/**
 * What an interactive handler is told about a button press, as Telegram
 * reports it. OpenClaw has already split the callback data at its first
 * colon into `namespace` and `payload`.
 */
export interface InteractiveContext {
  channel?: string;
  senderId?: string;
  auth?: { isAuthorizedSender?: boolean };
  callback: {
    data?: string;
    namespace?: string;
    payload: string;
    chatId: string;
  };
  respond: { reply(p: { text: string }): Promise<void> };
}

export interface InteractiveHandlerDefinition {
  channel: string;
  namespace: string;
  handler(ctx: unknown): unknown | Promise<unknown>;
}

export interface PluginApi {
  id: string;
  pluginConfig?: unknown;
  runtime: Runtime;
  logger: Logger;
  registerService(service: ServiceDefinition): void;
  registerTool(tool: ToolDefinition | ToolFactory, opts?: ToolOptions): void;
  registerInteractiveHandler(h: InteractiveHandlerDefinition): void;
}
