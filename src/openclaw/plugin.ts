import {
  type CompletionTool,
  stageCompleteTool,
  stageProgressTool,
  type ToolResult,
} from "../completion/tools.js";
import {
  type DefinitionSource,
  Engine,
  type EngineOptions,
} from "../engine/engine.js";
import { MIN_TOKEN_SECRET_BYTES } from "../engine/tokens.js";
import type { HostRegistry } from "../host/registry.js";
import { openSqliteStore } from "../store/sqlite.js";
import { type AdapterOptions, OpenClawAdapter } from "./adapter.js";
import type { PluginApi, ToolContext, ToolDefinition } from "./api.js";
import { type GateButtonOptions, gateButtons } from "./buttons.js";

export interface PipelinePluginOptions {
  api: PluginApi;
  /** An adapter to use as is, or the options to build one. */
  adapter: OpenClawAdapter | AdapterOptions;
  /** The engine's SQLite store; created and migrated if missing. */
  storePath: string;
  /**
   * At least 32 bytes, from which completion tokens are derived. Required:
   * a gateway restart must not change the tokens of turns already sent.
   */
  tokenSecret: Uint8Array;
  definitions: DefinitionSource;
  registry: HostRegistry;
  /**
   * Further engine options (`tickMs`, `wip`, `clock`, …). The store,
   * adapter, registry, definitions and token secret always come from the
   * options above; the same keys here are ignored.
   */
  engine?: Partial<EngineOptions>;
  /** The id the engine's service is registered under; `"sekaisen"` by default. */
  serviceId?: string;
  /** Posts operator gates with answer buttons when set. */
  buttons?: GateButtonOptions;
}

/**
 * A host tool's handler: the tool call's parameters and the calling turn's
 * context. A thrown error becomes an error result naming the tool.
 */
export type HostToolHandler = (
  params: unknown,
  ctx: ToolContext,
) => ToolResult | Promise<ToolResult>;

export interface PipelinePlugin {
  engine: Engine;
  adapter: OpenClawAdapter;
  /**
   * Registers a host tool whose results have the same shape as the
   * completion tools'. The name must be declared under `contracts.tools` in
   * the host plugin's manifest, as for any OpenClaw plugin tool.
   */
  tool(
    name: string,
    description: string,
    inputSchema: object,
    handler: HostToolHandler,
  ): void;
}

/** What OpenClaw expects back from a tool: text content, never a throw. */
function toolResult(r: ToolResult) {
  return {
    content: [{ type: "text" as const, text: r.text }],
    details: { isError: r.isError },
  };
}

function labelOf(name: string): string {
  const words = name.replace(/_/g, " ");
  return words.charAt(0).toUpperCase() + words.slice(1);
}

/** An OpenClaw tool around `run`; a thrown error becomes an error result. */
function hostTool(
  name: string,
  description: string,
  parameters: unknown,
  run: (params: unknown) => ToolResult | Promise<ToolResult>,
): ToolDefinition {
  return {
    name,
    label: labelOf(name),
    description,
    parameters,
    async execute(_id, params) {
      try {
        return toolResult(await run(params));
      } catch (err) {
        return toolResult({
          text: `${name} failed: ${errorText(err)}`,
          isError: true,
        });
      }
    },
  };
}

function completionTool(
  tool: CompletionTool,
  ctx: ToolContext,
): ToolDefinition {
  const caller = ctx.agentId === undefined ? {} : { agent: ctx.agentId };
  return hostTool(tool.name, tool.description, tool.inputSchema, (params) =>
    tool.handler(params, caller),
  );
}

/**
 * Hosts the engine in an OpenClaw gateway plugin: a service that starts and
 * stops it, `stage_complete` and `stage_progress` as plugin tools (the
 * caller is the turn's agent), and, with `buttons`, gate prompts answered
 * by button.
 *
 * The completion tools are ordinary plugin tools: the host grants them to
 * each pipeline agent in that agent's `tools.alsoAllow`, and declares them
 * under `contracts.tools` in its manifest. Throws, before registering
 * anything, when `tokenSecret` is missing or shorter than 32 bytes.
 */
export function createPipelinePlugin(o: PipelinePluginOptions): PipelinePlugin {
  if (
    !(o.tokenSecret instanceof Uint8Array) ||
    o.tokenSecret.byteLength < MIN_TOKEN_SECRET_BYTES
  ) {
    throw new Error(
      `tokenSecret must be at least ${MIN_TOKEN_SECRET_BYTES} bytes`,
    );
  }
  const { api } = o;
  const adapter =
    o.adapter instanceof OpenClawAdapter
      ? o.adapter
      : new OpenClawAdapter(o.adapter);
  const store = openSqliteStore(o.storePath);
  let engine: Engine;
  try {
    engine = new Engine({
      ...o.engine,
      store,
      adapter,
      registry: o.registry,
      definitions: o.definitions,
      tokenSecret: o.tokenSecret,
    });
  } catch (err) {
    store.close();
    throw err;
  }

  // Listeners first: the start-up reconcile can already emit a reminder.
  if (o.buttons) gateButtons(o.buttons).install({ api, engine, store });

  api.registerService({
    id: o.serviceId ?? "sekaisen",
    start: () => engine.start(),
    async stop() {
      await engine.stop();
      store.close();
    },
  });

  for (const tool of [stageCompleteTool(engine), stageProgressTool(engine)]) {
    api.registerTool((ctx) => completionTool(tool, ctx), { name: tool.name });
  }

  return {
    engine,
    adapter,
    tool(name, description, inputSchema, handler) {
      api.registerTool(
        (ctx) =>
          hostTool(name, description, inputSchema, (params) =>
            handler(params, ctx),
          ),
        { name },
      );
    },
  };
}

function errorText(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}
