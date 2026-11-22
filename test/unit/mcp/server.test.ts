import {
  copyFileSync,
  mkdirSync,
  mkdtempSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { PassThrough } from "node:stream";
import { afterEach, describe, expect, it } from "vitest";
import { FakeAdapter } from "../../../src/adapter/fake.js";
import { Engine } from "../../../src/engine/engine.js";
import { createRegistry } from "../../../src/host/registry.js";
import { main } from "../../../src/mcp/main.js";
import { createMcpServer, MAX_LINE_LENGTH } from "../../../src/mcp/server.js";
import { openSqliteStore } from "../../../src/store/sqlite.js";
import type { Store } from "../../../src/store/types.js";
import { lastToken, reviewLoop, SwapSource } from "../engine/engine-helpers.js";

const SECRET = new Uint8Array(32).fill(7);
const cleanup: Array<() => void | Promise<void>> = [];
afterEach(async () => {
  for (const f of cleanup.splice(0).reverse()) await f();
});

interface Reply {
  id: number | null;
  // biome-ignore lint/suspicious/noExplicitAny: a test reads arbitrary result shapes
  result: any;
  // biome-ignore lint/suspicious/noExplicitAny: a test reads arbitrary error shapes
  error: any;
}

interface Wire {
  send(msg: unknown): void;
  raw(line: string): void;
  next(): Promise<Reply>;
  end(): Promise<void>;
}

function wire(
  engine: Pick<Engine, "complete" | "progress">,
  callerAgent?: string,
): Wire {
  const input = new PassThrough();
  const output = new PassThrough();
  const server = createMcpServer({
    engine,
    ...(callerAgent === undefined ? {} : { callerAgent }),
    input,
    output,
  });
  const out: string[] = [];
  const waiting: Array<(l: string) => void> = [];
  output.setEncoding("utf8");
  let buf = "";
  output.on("data", (d: string) => {
    buf += d;
    let i = buf.indexOf("\n");
    while (i >= 0) {
      const line = buf.slice(0, i);
      buf = buf.slice(i + 1);
      const w = waiting.shift();
      if (w) w(line);
      else out.push(line);
      i = buf.indexOf("\n");
    }
  });
  cleanup.push(() => server.close());
  return {
    send: (m) => input.write(`${JSON.stringify(m)}\n`),
    raw: (l) => input.write(`${l}\n`),
    next: async () => {
      const line =
        out.shift() ?? (await new Promise<string>((r) => waiting.push(r)));
      return JSON.parse(line);
    },
    end: async () => {
      input.end();
      await server.done;
    },
  };
}

/** Collects the JSON lines written to `output`; `take(n)` awaits n of them. */
function collector(output: PassThrough): {
  take(n: number): Promise<Reply[]>;
} {
  const got: string[] = [];
  const waiting: Array<() => void> = [];
  let buf = "";
  output.setEncoding("utf8");
  output.on("data", (d: string) => {
    buf += d;
    const parts = buf.split("\n");
    buf = parts.pop() ?? "";
    got.push(...parts);
    for (const w of waiting.splice(0)) w();
  });
  return {
    async take(n) {
      while (got.length < n) await new Promise<void>((r) => waiting.push(r));
      return got.splice(0, n).map((l) => JSON.parse(l));
    },
  };
}

function fileStore(): { path: string; open(): Store } {
  const dir = mkdtempSync(path.join(tmpdir(), "sekaisen-mcp-"));
  cleanup.push(() => rmSync(dir, { recursive: true, force: true }));
  const file = path.join(dir, "store.db");
  return {
    path: file,
    open() {
      const s = openSqliteStore(file);
      cleanup.push(() => s.close());
      return s;
    },
  };
}

async function pair() {
  const fs = fileStore();
  const source = new SwapSource(await reviewLoop());
  const adapter = new FakeAdapter();
  const host = new Engine({
    store: fs.open(),
    adapter,
    registry: createRegistry(),
    definitions: source,
    tokenSecret: SECRET,
  });
  const completion = new Engine({
    store: fs.open(),
    adapter: new FakeAdapter(),
    registry: createRegistry(),
    definitions: source,
    dispatch: false,
    tokenSecret: SECRET,
  });
  cleanup.push(() => host.stop());
  return { host, completion, adapter };
}

describe("mcp server", () => {
  it("initialize then tools/list returns both tools with input schemas", async () => {
    const { completion } = await pair();
    const w = wire(completion);
    w.send({
      jsonrpc: "2.0",
      id: 1,
      method: "initialize",
      params: { protocolVersion: "2025-03-26" },
    });
    const init = await w.next();
    expect(init.result.protocolVersion).toBe("2025-03-26");
    expect(init.result.serverInfo.name).toBe("sekaisen");
    expect(init.result.capabilities).toEqual({ tools: {} });
    w.send({ jsonrpc: "2.0", method: "notifications/initialized" });
    w.send({ jsonrpc: "2.0", id: 2, method: "tools/list" });
    const list = await w.next();
    expect(list.id).toBe(2); // the notification got no answer
    const tools = list.result.tools as Array<{
      name: string;
      inputSchema: { type: string };
    }>;
    expect(tools.map((t) => t.name)).toEqual([
      "stage_complete",
      "stage_progress",
    ]);
    for (const t of tools) expect(t.inputSchema.type).toBe("object");
    w.send({ jsonrpc: "2.0", id: 3, method: "initialize", params: {} });
    expect((await w.next()).result.protocolVersion).toBe("2025-06-18");
    w.send({ jsonrpc: "2.0", id: 4, method: "ping" });
    expect((await w.next()).result).toEqual({});
  });

  it("tools/call stage_complete advances the run in the shared store", async () => {
    const { host, completion, adapter } = await pair();
    const { runId } = await host.startRun("review-loop", { topic: "rust" });
    await host.tick();
    const token = lastToken(adapter);
    const w = wire(completion, "drafter");
    w.send({
      jsonrpc: "2.0",
      id: 1,
      method: "tools/call",
      params: {
        name: "stage_complete",
        arguments: {
          token,
          outcome: "drafted",
          fields: { pr_url: "https://example.test/pr/1", summary: "short" },
        },
      },
    });
    const r = await w.next();
    expect(r.result.isError).toBe(false);
    expect(r.result.content[0].type).toBe("text");
    expect(r.result.content[0].text).toMatch(/Recorded outcome drafted/);
    const view = host.status(runId);
    expect(view.run.currentStage).toBe("check");
    expect(view.live?.state).toBe("submitted");
  });

  it("a host engine on the same file store dispatches the next stage on its next tick", async () => {
    const { host, completion, adapter } = await pair();
    await host.startRun("review-loop", { topic: "rust" });
    await host.tick();
    const w = wire(completion);
    w.send({
      jsonrpc: "2.0",
      id: 1,
      method: "tools/call",
      params: {
        name: "stage_complete",
        arguments: {
          token: lastToken(adapter),
          outcome: "drafted",
          fields: { pr_url: "u", summary: "s" },
        },
      },
    });
    expect((await w.next()).result.isError).toBe(false);
    expect(adapter.calls).toHaveLength(1);
    await host.tick();
    expect(adapter.calls).toHaveLength(2);
    expect(adapter.calls[1]?.message).toMatch(/Check the draft/);
  });

  it("invalid outcome returns isError with the declared outcomes", async () => {
    const { host, completion, adapter } = await pair();
    await host.startRun("review-loop", { topic: "rust" });
    await host.tick();
    const w = wire(completion);
    w.send({
      jsonrpc: "2.0",
      id: 1,
      method: "tools/call",
      params: {
        name: "stage_complete",
        arguments: { token: lastToken(adapter), outcome: "nope" },
      },
    });
    const r = await w.next();
    expect(r.result.isError).toBe(true);
    expect(r.result.content[0].text).toMatch(/unknown outcome "nope"/);
    expect(r.result.content[0].text).toMatch(/drafted/);
  });

  it("the engine refuses a caller other than the stage's agent", async () => {
    const { host, completion, adapter } = await pair();
    await host.startRun("review-loop", { topic: "rust" });
    await host.tick();
    const w = wire(completion, "intruder");
    w.send({
      jsonrpc: "2.0",
      id: 1,
      method: "tools/call",
      params: {
        name: "stage_progress",
        arguments: { token: lastToken(adapter), note: "x" },
      },
    });
    expect((await w.next()).result.isError).toBe(true);
  });

  it("stage_progress saves a checkpoint", async () => {
    const { host, completion, adapter } = await pair();
    await host.startRun("review-loop", { topic: "rust" });
    await host.tick();
    const w = wire(completion, "drafter");
    w.send({
      jsonrpc: "2.0",
      id: 1,
      method: "tools/call",
      params: {
        name: "stage_progress",
        arguments: { token: lastToken(adapter), note: "half done" },
      },
    });
    const r = await w.next();
    expect(r.result.isError).toBe(false);
    expect(r.result.content[0].text).toMatch(/Checkpoint saved/);
  });

  it("unknown method is -32601, malformed JSON -32700, bad params -32602", async () => {
    const { completion } = await pair();
    const w = wire(completion);
    w.send({ jsonrpc: "2.0", id: 1, method: "resources/list" });
    expect((await w.next()).error).toEqual({
      code: -32601,
      message: "method not found: resources/list",
    });
    w.raw("{nope");
    const bad = await w.next();
    expect(bad.id).toBeNull();
    expect(bad.error.code).toBe(-32700);
    w.send({ jsonrpc: "2.0", id: 2, method: "tools/call", params: {} });
    expect((await w.next()).error.code).toBe(-32602);
    w.send({
      jsonrpc: "2.0",
      id: 3,
      method: "tools/call",
      params: { name: "nope" },
    });
    expect((await w.next()).error.code).toBe(-32602);
    // A notification with an unknown method is not answered.
    w.send({ jsonrpc: "2.0", method: "whatever" });
    w.send({ jsonrpc: "2.0", id: 4, method: "ping" });
    expect((await w.next()).id).toBe(4);
  });

  it("answers requests in order", async () => {
    const { completion } = await pair();
    const w = wire(completion);
    for (let i = 1; i <= 5; i++)
      w.send({ jsonrpc: "2.0", id: i, method: "ping" });
    const ids: number[] = [];
    for (let i = 0; i < 5; i++) ids.push(Number((await w.next()).id));
    expect(ids).toEqual([1, 2, 3, 4, 5]);
  });

  it("closing the input ends the server", async () => {
    const { completion } = await pair();
    const w = wire(completion);
    await w.end();
  });
});

describe("mcp input handling", () => {
  it("drops an over-long line, answers -32600, then serves the next request", async () => {
    const { completion } = await pair();
    const w = wire(completion);
    w.raw("x".repeat(MAX_LINE_LENGTH + 10));
    w.send({ jsonrpc: "2.0", id: 1, method: "ping" });
    const err = await w.next();
    expect(err.id).toBeNull();
    expect(err.error).toEqual({ code: -32600, message: "line too long" });
    expect((await w.next()).id).toBe(1);
  });

  it("drops an over-long line that arrives in many chunks", async () => {
    const { completion } = await pair();
    const input = new PassThrough();
    const output = new PassThrough();
    const replies = collector(output);
    const server = createMcpServer({ engine: completion, input, output });
    cleanup.push(() => server.close());
    const chunk = "y".repeat(64 * 1024);
    for (let i = 0; i < 20; i++) input.write(chunk);
    input.write(
      `\n${JSON.stringify({ jsonrpc: "2.0", id: 9, method: "ping" })}\n`,
    );
    input.end();
    const got = await replies.take(2);
    expect(got.map((r) => r.error?.message ?? r.id)).toEqual([
      "line too long",
      9,
    ]);
  });

  it("parses CRLF lines and a multi-byte character split across chunks", async () => {
    const { completion } = await pair();
    const input = new PassThrough();
    const output = new PassThrough();
    const replies = collector(output);
    const server = createMcpServer({ engine: completion, input, output });
    cleanup.push(() => server.close());
    const bytes = Buffer.from(
      `${JSON.stringify({ jsonrpc: "2.0", id: "é€", method: "ping" })}\r\n`,
    );
    const cut = bytes.indexOf(0xe2) + 1; // inside the euro sign
    input.write(bytes.subarray(0, cut));
    input.write(bytes.subarray(cut));
    input.end();
    const [reply] = await replies.take(1);
    expect(reply?.id).toBe("é€");
  });

  it("a stage_complete call with missing arguments is a tool error", async () => {
    const { completion } = await pair();
    const w = wire(completion);
    w.send({
      jsonrpc: "2.0",
      id: 1,
      method: "tools/call",
      params: { name: "stage_complete" },
    });
    const r = await w.next();
    expect(r.result.isError).toBe(true);
    expect(r.result.content[0].text).toMatch(/token must be a string/);
  });

  it("a broken output pipe closes the server without throwing", async () => {
    const { completion } = await pair();
    const input = new PassThrough();
    const output = new PassThrough();
    const server = createMcpServer({ engine: completion, input, output });
    cleanup.push(() => server.close());
    output.emit("error", new Error("EPIPE"));
    await server.done;
  });
});

describe("sekaisen-mcp main", () => {
  function io() {
    const err: string[] = [];
    const input = new PassThrough();
    const output = new PassThrough();
    return {
      err,
      input,
      output,
      replies: collector(output),
      io: { err: (t: string) => err.push(t), input, output },
    };
  }

  it("exits 2 on missing arguments, unknown flags and a short secret", async () => {
    const a = io();
    expect(await main([], a.io)).toBe(2);
    expect(a.err.join("")).toMatch(/usage: sekaisen-mcp/);
    expect(await main(["--bogus"], io().io)).toBe(2);
    const dir = mkdtempSync(path.join(tmpdir(), "sekaisen-mcp-"));
    cleanup.push(() => rmSync(dir, { recursive: true, force: true }));
    const short = path.join(dir, "secret");
    writeFileSync(short, "tooshort");
    const b = io();
    const code = await main(
      [
        "--store",
        path.join(dir, "s.db"),
        "--definitions",
        dir,
        "--token-secret-file",
        short,
      ],
      b.io,
    );
    expect(code).toBe(2);
    expect(b.err.join("")).toMatch(/at least 32 raw bytes/);
  });

  it("warns on a group-readable secret and exits 2 on an unopenable store", async () => {
    const dir = mkdtempSync(path.join(tmpdir(), "sekaisen-mcp-"));
    cleanup.push(() => rmSync(dir, { recursive: true, force: true }));
    const secret = path.join(dir, "secret");
    writeFileSync(secret, Buffer.from(SECRET), { mode: 0o644 });
    const t = io();
    const code = await main(
      [
        "--store",
        path.join(dir, "missing", "s.db"),
        "--definitions",
        dir,
        "--token-secret-file",
        secret,
      ],
      t.io,
    );
    expect(code).toBe(2);
    const text = t.err.join("");
    expect(text).toMatch(/readable by group or others/);
    expect(text).toMatch(/cannot open the store/);
  });

  it("warns on a duplicate pipeline id across definition files", async () => {
    const dir = mkdtempSync(path.join(tmpdir(), "sekaisen-mcp-"));
    cleanup.push(() => rmSync(dir, { recursive: true, force: true }));
    const defs = path.join(dir, "defs");
    mkdirSync(defs);
    const src = path.resolve("test/fixtures/defs/review-loop/pipeline.yaml");
    copyFileSync(src, path.join(defs, "a.yaml"));
    copyFileSync(src, path.join(defs, "b.yaml"));
    const secret = path.join(dir, "secret");
    writeFileSync(secret, Buffer.from(SECRET), { mode: 0o600 });
    const t = io();
    t.input.end();
    const code = await main(
      [
        "--store",
        path.join(dir, "s.db"),
        "--definitions",
        defs,
        "--token-secret-file",
        secret,
      ],
      t.io,
    );
    expect(code).toBe(0);
    expect(t.err.join("")).toMatch(/duplicate pipeline id review-loop/);
  });

  it("answers a tools/call end to end", async () => {
    const dir = mkdtempSync(path.join(tmpdir(), "sekaisen-mcp-"));
    cleanup.push(() => rmSync(dir, { recursive: true, force: true }));
    const secret = path.join(dir, "secret");
    writeFileSync(secret, Buffer.from(SECRET), { mode: 0o600 });
    const t = io();
    const running = main(
      [
        "--store",
        path.join(dir, "s.db"),
        "--definitions",
        path.resolve("test/fixtures/defs"),
        "--token-secret-file",
        secret,
      ],
      t.io,
    );
    t.input.write(
      `${JSON.stringify({
        jsonrpc: "2.0",
        id: 1,
        method: "tools/call",
        params: {
          name: "stage_complete",
          arguments: { token: "nope", outcome: "drafted" },
        },
      })}\n`,
    );
    t.input.end();
    expect(await running).toBe(0);
    const [reply] = await t.replies.take(1);
    expect(reply?.result.isError).toBe(true);
    expect(reply?.result.content[0].type).toBe("text");
  });

  it("serves tools over the streams and exits 0 when stdin closes", async () => {
    const dir = mkdtempSync(path.join(tmpdir(), "sekaisen-mcp-"));
    cleanup.push(() => rmSync(dir, { recursive: true, force: true }));
    const secret = path.join(dir, "secret");
    writeFileSync(secret, Buffer.from(SECRET));
    const t = io();
    const running = main(
      [
        "--store",
        path.join(dir, "s.db"),
        "--definitions",
        path.resolve("test/fixtures/defs"),
        "--token-secret-file",
        secret,
        "--agent",
        "drafter",
      ],
      t.io,
    );
    t.input.write(
      `${JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list" })}\n`,
    );
    t.input.end();
    expect(await running).toBe(0);
    const [reply] = await t.replies.take(1);
    expect(reply?.result.tools).toHaveLength(2);
  });
});
