import type { Readable, Writable } from "node:stream";
import { StringDecoder } from "node:string_decoder";
import {
  type CompletionTool,
  stageCompleteTool,
  stageProgressTool,
} from "../completion/tools.js";
import type { Engine } from "../engine/engine.js";
import { VERSION } from "../index.js";

/** The protocol version this server speaks first. */
export const PROTOCOL_VERSION = "2025-06-18";
const SUPPORTED_VERSIONS = [PROTOCOL_VERSION, "2025-03-26", "2024-11-05"];

/** Longest line, in characters, the server keeps while waiting for its newline. */
export const MAX_LINE_LENGTH = 1024 * 1024;
/** Requests waiting for an answer beyond which the input is paused. */
export const MAX_PENDING = 64;

const PARSE_ERROR = -32700;
const INVALID_REQUEST = -32600;
const METHOD_NOT_FOUND = -32601;
const INVALID_PARAMS = -32602;
const INTERNAL_ERROR = -32603;

type Id = string | number | null;

export interface McpServerOptions {
  /** An engine opened with `dispatch: false`; it only commits completions. */
  engine: Pick<Engine, "complete" | "progress">;
  /** The agent the connection belongs to; the engine refuses another caller. */
  callerAgent?: string;
  input: Readable;
  output: Writable;
}

export interface McpServer {
  close(): void;
  /** Settles once the input has ended and every request has been answered. */
  readonly done: Promise<void>;
}

function isObject(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

/**
 * Serves the completion tools as newline-delimited JSON-RPC 2.0. Requests are
 * answered in the order they arrive. Only JSON-RPC lines go to `output`.
 */
export function createMcpServer(o: McpServerOptions): McpServer {
  const tools: CompletionTool[] = [
    stageCompleteTool(o.engine),
    stageProgressTool(o.engine),
  ];
  const caller = o.callerAgent === undefined ? {} : { agent: o.callerAgent };
  let closed = false;

  const send = (msg: Record<string, unknown>): void => {
    if (closed) return;
    o.output.write(`${JSON.stringify({ jsonrpc: "2.0", ...msg })}\n`);
  };
  const fail = (id: Id, code: number, message: string): void =>
    send({ id, error: { code, message } });

  async function call(id: Id, params: unknown): Promise<void> {
    if (!isObject(params) || typeof params.name !== "string") {
      return fail(id, INVALID_PARAMS, "params.name must be a tool name");
    }
    const args = params.arguments;
    if (args !== undefined && !isObject(args)) {
      return fail(id, INVALID_PARAMS, "params.arguments must be an object");
    }
    const tool = tools.find((t) => t.name === params.name);
    if (!tool) return fail(id, INVALID_PARAMS, `unknown tool ${params.name}`);
    const r = await tool.handler(args ?? {}, caller);
    send({
      id,
      result: { content: [{ type: "text", text: r.text }], isError: r.isError },
    });
  }

  async function handle(line: string): Promise<void> {
    let msg: unknown;
    try {
      msg = JSON.parse(line);
    } catch {
      return fail(null, PARSE_ERROR, "parse error");
    }
    if (!isObject(msg) || typeof msg.method !== "string") {
      // A response to a request we never made is ignored.
      if (isObject(msg) && "id" in msg && !("method" in msg)) return;
      return fail(null, INVALID_REQUEST, "invalid request");
    }
    const isRequest = "id" in msg;
    const id = (isRequest ? msg.id : null) as Id;
    if (
      isRequest &&
      id !== null &&
      typeof id !== "string" &&
      typeof id !== "number"
    ) {
      return fail(null, INVALID_REQUEST, "id must be a string or number");
    }
    if (!isRequest) return; // a notification, initialized or not, gets no answer
    try {
      await dispatch(id, msg.method, msg.params);
    } catch (err) {
      fail(
        id,
        INTERNAL_ERROR,
        err instanceof Error ? err.message : "internal error",
      );
    }
  }

  async function dispatch(
    id: Id,
    method: string,
    params: unknown,
  ): Promise<void> {
    switch (method) {
      case "initialize": {
        const asked = isObject(params) ? params.protocolVersion : undefined;
        return send({
          id,
          result: {
            protocolVersion:
              typeof asked === "string" && SUPPORTED_VERSIONS.includes(asked)
                ? asked
                : PROTOCOL_VERSION,
            capabilities: { tools: {} },
            serverInfo: { name: "sekaisen", version: VERSION },
          },
        });
      }
      case "ping":
        return send({ id, result: {} });
      case "tools/list":
        return send({
          id,
          result: {
            tools: tools.map(({ name, description, inputSchema }) => ({
              name,
              description,
              inputSchema,
            })),
          },
        });
      case "tools/call":
        return call(id, params);
      default:
        return fail(id, METHOD_NOT_FOUND, `method not found: ${method}`);
    }
  }

  let queue: Promise<void> = Promise.resolve();
  let pending = 0;
  let paused = false;
  const enqueue = (job: () => Promise<void> | void): void => {
    pending++;
    if (pending > MAX_PENDING && !paused) {
      paused = true;
      o.input.pause();
    }
    queue = queue
      .then(job)
      .catch((err) => {
        console.error(
          `sekaisen-mcp: ${err instanceof Error ? err.message : err}`,
        );
      })
      .then(() => {
        pending--;
        if (paused && pending <= MAX_PENDING / 2) {
          paused = false;
          if (!closed) o.input.resume();
        }
      });
  };

  const decoder = new StringDecoder("utf8");
  let buf = "";
  let dropping = false;
  const tooLong = (): void =>
    enqueue(() => fail(null, INVALID_REQUEST, "line too long"));
  const takeLine = (line: string): void => {
    const text = line.endsWith("\r") ? line.slice(0, -1) : line;
    if (text.trim() === "") return;
    // A line queued before the server closed is dropped, not handled: its
    // answer could never be sent, so it must not commit anything either.
    enqueue(() => (closed ? undefined : handle(text)));
  };
  const feed = (text: string): void => {
    let rest = text;
    while (rest.length > 0) {
      const nl = rest.indexOf("\n");
      if (dropping) {
        if (nl < 0) return;
        dropping = false;
        rest = rest.slice(nl + 1);
        continue;
      }
      if (nl < 0) {
        buf += rest;
        if (buf.length > MAX_LINE_LENGTH) {
          buf = "";
          dropping = true;
          tooLong();
        }
        return;
      }
      const line = buf + rest.slice(0, nl);
      buf = "";
      rest = rest.slice(nl + 1);
      if (line.length > MAX_LINE_LENGTH) tooLong();
      else takeLine(line);
    }
  };

  let finish: () => void = () => {};
  const done = new Promise<void>((resolve) => {
    finish = resolve;
  });
  let ended = false;
  const end = (): void => {
    if (ended) return;
    ended = true;
    if (!dropping && buf !== "") takeLine(buf + decoder.end());
    buf = "";
    queue.then(() => finish());
  };
  const onData = (chunk: Buffer | string): void =>
    feed(typeof chunk === "string" ? chunk : decoder.write(chunk));
  /** Stops reading: later input and a partial line in the buffer are dropped. */
  const stop = (): void => {
    closed = true;
    o.input.off("data", onData);
    buf = "";
    end();
  };
  const onFail = (err: Error): void => {
    console.error(`sekaisen-mcp: ${err.message}`);
    stop();
  };
  o.input.on("data", onData);
  o.input.on("end", end);
  o.input.on("close", end);
  o.input.on("error", onFail);
  o.output.on("error", onFail);

  return {
    close: stop,
    done,
  };
}
