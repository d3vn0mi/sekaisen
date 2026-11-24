import { createHash } from "node:crypto";
import { resolve } from "node:path";
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
import type { Disposable } from "../engine/events.js";
import { MIN_TOKEN_SECRET_BYTES } from "../engine/tokens.js";
import type { HostRegistry } from "../host/registry.js";
import { openSqliteStore } from "../store/sqlite.js";
import type { Store } from "../store/types.js";
import { type AdapterOptions, OpenClawAdapter } from "./adapter.js";
import type { PluginApi, ToolContext, ToolDefinition } from "./api.js";
import { type GateButtonOptions, gateButtons } from "./buttons.js";

/** Adapter options for `createPipelinePlugin`; `api` defaults to the plugin's. */
export type PluginAdapterOptions = Omit<AdapterOptions, "api"> & {
  api?: PluginApi;
};

export interface PipelinePluginOptions {
  api: PluginApi;
  /** An adapter to use as is, or the options to build one. */
  adapter: OpenClawAdapter | PluginAdapterOptions;
  /**
   * The engine's SQLite store; created and migrated if missing. One engine
   * runs per store file in a process: a later registration with the same
   * file reuses it.
   */
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
  /**
   * The engine. Outside a full registration it is the one a full
   * registration of the same store started in this process; reading it
   * throws when there is none.
   */
  readonly engine: Engine;
  /** The engine's adapter; resolved and thrown like `engine`. */
  readonly adapter: OpenClawAdapter;
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
  /**
   * Stops the engine, closes its store and forgets it, so a later
   * registration opens the store again. Does nothing outside a full
   * registration, or once closed.
   */
  close(): Promise<void>;
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

/**
 * A completion tool for one turn. Without a calling agent the core could
 * not check that the stage is the caller's, so the call is refused here.
 */
function completionTool(
  tool: CompletionTool,
  ctx: ToolContext,
): ToolDefinition {
  const agent = ctx.agentId;
  return hostTool(tool.name, tool.description, tool.inputSchema, (params) =>
    typeof agent === "string" && agent !== ""
      ? tool.handler(params, { agent })
      : { text: `${tool.name} needs a calling agent`, isError: true },
  );
}

/** One store's engine, shared by every registration of that store. */
interface Hosted {
  engine: Engine;
  adapter: OpenClawAdapter;
  store: Store;
  /** The gate buttons installed on the newest registration's api. */
  buttons?: Disposable;
  /** A SHA-256 of the token secret the engine was built with; never the bytes. */
  secret: string;
  closed?: boolean;
}

/** The engines this process runs, by resolved store path. */
const hosted = new Map<string, Hosted>();

function fingerprint(secret: Uint8Array): string {
  return createHash("sha256").update(secret).digest("hex");
}

/** The cache key for a store path; an in-memory store is never shared. */
function storeKey(storePath: string): string | undefined {
  return storePath === ":memory:" || storePath === ""
    ? undefined
    : resolve(storePath);
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
 *
 * Only a full registration (`api.registrationMode` `"full"` or absent)
 * opens the store and builds the engine. Any other mode registers the tools
 * alone, so OpenClaw can list them; their calls reach the engine a full
 * registration of the same store started in this process, and are error
 * results when there is none. One engine runs per store file: a later full
 * registration of the same file reuses it and registers the service, tools
 * and buttons again on its own `api`.
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
  const key = storeKey(o.storePath);
  const mode = o.api.registrationMode;
  if (mode !== undefined && mode !== "full") return registerTools(o, key);

  const cached = key === undefined ? undefined : hosted.get(key);
  if (cached) {
    // Reusing the engine would keep the first secret without a word.
    if (cached.secret !== fingerprint(o.tokenSecret)) {
      throw new Error(
        `store ${o.storePath} already has an engine in this process built with a different tokenSecret; close it first`,
      );
    }
    reregister(o, cached);
    return registerTools(o, key, cached);
  }

  const adapter =
    o.adapter instanceof OpenClawAdapter
      ? o.adapter
      : new OpenClawAdapter({ ...o.adapter, api: o.adapter.api ?? o.api });
  const store = openSqliteStore(o.storePath);
  try {
    const entry = host(o, adapter, store);
    const plugin = registerTools(o, key, entry);
    if (key !== undefined) hosted.set(key, entry);
    return plugin;
  } catch (err) {
    store.close();
    throw err;
  }
}

/** Builds the engine on `store` and registers its service and buttons. */
function host(
  o: PipelinePluginOptions,
  adapter: OpenClawAdapter,
  store: Store,
): Hosted {
  const engine = new Engine({
    ...o.engine,
    store,
    adapter,
    registry: o.registry,
    definitions: o.definitions,
    tokenSecret: o.tokenSecret,
  });
  const entry: Hosted = {
    engine,
    adapter,
    store,
    secret: fingerprint(o.tokenSecret),
  };
  reregister(o, entry);
  return entry;
}

/** Registers the service and, with `buttons`, the gate buttons on `o.api`. */
function reregister(o: PipelinePluginOptions, entry: Hosted): void {
  const { api } = o;
  const { engine, store } = entry;
  // Listeners first: the start-up reconcile can already emit a reminder.
  // A re-registration retires the buttons installed before, whose handler
  // then refuses every press, and installs its own if it has any, so a
  // gate is posted once and only the newest operators answer it.
  entry.buttons?.dispose();
  entry.buttons = undefined;
  if (o.buttons) {
    entry.buttons = gateButtons(o.buttons).install({ api, engine, store });
  }

  // Stop leaves the store open: OpenClaw may start the service again
  // without building the plugin anew.
  api.registerService({
    id: o.serviceId ?? "sekaisen",
    start: () => engine.start(),
    stop: () => engine.stop(),
  });
}

/**
 * Registers the completion tools and returns the plugin. With no `entry`
 * (a registration outside full mode) every engine use is resolved at call
 * time from the process's engines.
 */
function registerTools(
  o: PipelinePluginOptions,
  key: string | undefined,
  entry?: Hosted,
): PipelinePlugin {
  const { api } = o;
  const current = (): Hosted => {
    const found = entry ?? (key === undefined ? undefined : hosted.get(key));
    if (!found) {
      throw new Error(
        `no pipeline engine is running in this process for store ${o.storePath}`,
      );
    }
    return found;
  };
  const engine = {
    complete: (...a: Parameters<Engine["complete"]>) =>
      current().engine.complete(...a),
    progress: (...a: Parameters<Engine["progress"]>) =>
      current().engine.progress(...a),
  };

  for (const tool of [stageCompleteTool(engine), stageProgressTool(engine)]) {
    api.registerTool((ctx) => completionTool(tool, ctx), { name: tool.name });
  }

  return {
    get engine() {
      return current().engine;
    },
    get adapter() {
      return current().adapter;
    },
    tool(name, description, inputSchema, handler) {
      api.registerTool(
        (ctx) =>
          hostTool(name, description, inputSchema, (params) =>
            handler(params, ctx),
          ),
        { name },
      );
    },
    async close() {
      if (!entry || entry.closed) return;
      entry.closed = true;
      if (key !== undefined && hosted.get(key) === entry) hosted.delete(key);
      entry.buttons?.dispose();
      try {
        await entry.engine.stop();
      } finally {
        entry.store.close();
      }
    },
  };
}

function errorText(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}
