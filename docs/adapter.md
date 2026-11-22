# The harness adapter

The engine never runs an agent and never imports a harness. It talks to the system that does, a
coding agent, an agent gateway, anything that can take a turn and call a tool, through one
interface, `HarnessAdapter`. This page is the reference for that interface and for the completion
contract an agent uses to report back.

> [!NOTE]
> The interface is provisional until the first adapter has been built against a live harness. Expect
> it to change before 0.1.

## The calls

`capabilities()` describes the harness, and seven calls do the work. Four are required and three are
optional.

| Call | Required | What it does |
|---|---|---|
| `capabilities()` | describes the harness | Reports the harness's limits, below |
| `openSession(agent, key)` | yes | Prepares a session for an agent under an engine-chosen key. May do nothing |
| `startTurn(p)` | yes | Starts one turn and returns its run id at once |
| `readRunOutcome(runId)` | yes | Says whether a turn is running, ended (and how), or unknown |
| `deliver(sessionKey, message)` | yes | Tells a session something without starting a stage, such as a gate reminder |
| `abortTurn(runId)` | no | Stops a turn that is still running; returns whether it did |
| `schedule(spec, fn)` | no | Lets the host's own loop drive the engine's tick; returns `{ dispose() }` |
| `guardToolCall(fn)` | no | Hardening: receives a function that decides each tool call, `allow` or `{ deny }` |

An adapter that omits an optional call loses only that feature. Without `abortTurn` it reports
`canAbort: false`, and a timed-out turn is retired by its token instead of being stopped.

### `capabilities()`

```ts
interface Capabilities {
  turnCapMs: number;              // longest a single turn may run
  maxConcurrent: number;          // turns that can run at the same time
  canAbort: boolean;              // whether abortTurn works
  subscriptionProvider?: string;  // the provider that counts as the subscription
  agentTools?(agent: string): Promise<string[]>; // the tools an agent holds, if the harness can say
}
```

The engine reads these at start-up. `maxConcurrent` is the default lane cap, and the timing check
compares each stage's deadline against `turnCapMs`. `subscriptionProvider` is the provider name the
`providers: subscription` policy compares against each turn's reported `runtime.provider`; leave it
out when the harness has no such notion. `agentTools`, when present, lets the host verify that an agent holds the
completion tools; the engine does not call it itself.

### `openSession(agent, key)` and the session keys

The engine, not the adapter, chooses session keys, and a key is stable for a stage's session policy:

- `run:<runId>:<agent>` for `session: run`, one session per run and agent;
- `project:<project>:<agent>` for `session: project`, shared across runs of a project.

The adapter maps a key to a session of its own. **The same key must reach the same session**, so a
continuation turn and a later stage of the same run see what the agent already did.

### `startTurn(p)`

```ts
interface StartTurn {
  agent: string;           // the role named by the stage's `agent:`
  sessionKey: string;      // see above
  message: string;         // the rendered brief, ending with the completion token
  capMs: number;           // the turn cap for this turn
  idempotencyKey: string;  // see below
  tools: string[];         // the completion tools, for harnesses that grant tools per turn
}
```

It starts the turn and returns `{ runId }` without waiting for the turn to end. The `message` already
carries the token (`Your completion token is: …`); the adapter passes it on unread.

The **idempotency key** is `<runId>:<stage>:<attempt>` for the first turn of an attempt and
`<runId>:<stage>:<attempt>:<n>` for the `n`-th dispatch on the same attempt (a continuation turn, or a
re-dispatch after a usage limit). The engine repeats a key only for a turn the harness may already
have accepted, for instance after a crash between the call and the engine's record of it. **A key the
adapter has seen must return the original turn's run id and must not start a second turn.**

### `readRunOutcome(runId)`

```ts
type RunOutcome =
  | { state: "running" }
  | {
      state: "ended";
      ending: "ok" | "error" | "timeout" | "killed";
      error?: string;
      runtime?: { provider: string; model: string };
    }
  | { state: "unknown" };
```

- `running`: the turn is still going.
- `ended`: `ok` means the agent's turn finished normally (the stage may or may not have completed:
  completion arrives through `stage_complete`, not here); `error`, `timeout` and `killed` mean it did
  not. `runtime` reports the provider and model the turn ran on, when the harness knows; the engine
  records it per attempt and uses it for the provider policy.
- `unknown`: the harness no longer knows this run id. After a restart the engine ends such an attempt
  as `lost` and applies the stage's retry policy.

**Usage limits.** When a provider refuses a turn because a usage limit was hit, put the refusal text
in `error`. The engine recognises a line of the form

```text
You've hit your (session |usage |weekly )?limit …
```

and, when the text carries a `resets <time>` phrase, reads the reset time from it (an ISO instant
with a zone, or a clock time). The affected provider is paused until then; a reset it cannot parse
pauses it for one hour. A refused turn is not a failure: the stage run returns to `submitted`, no
retry is spent, and it is dispatched again once the pause lifts.

### `abortTurn(runId)` (optional)

Stops a turn that is still running and returns whether it did. The engine calls it after retiring the
turn's token (on a deadline, a retry or a cancel), so a late turn cannot complete the stage even when
the abort fails. It retries a failed abort with backoff.

### `deliver(sessionKey, message)`

Sends a message into a session without starting a stage run, for example a reminder that a gate is
still waiting. It must not start a stage.

### `schedule(spec, fn)` and `guardToolCall(fn)` (optional)

The engine calls neither of these itself; they are hooks for the host's wiring code.

`schedule` lets a host whose harness already has a scheduler drive the engine's tick (`engine.tick()`
is safe to call at any time): the host calls `schedule(spec, () => engine.tick())` and keeps the
returned handle, whose `dispose()` stops it. `guardToolCall` receives a function that answers
`"allow"` or `{ deny: reason }` for a pending `{ agent, tool }`, so a harness with tool hooks can
refuse a call a stage does not allow.

## The completion contract

An agent finishes a stage by calling two tools. The adapter exposes them to the harness (natively, or
through the MCP server below) and forwards each call to the engine's `complete` and `progress`.

```text
stage_complete({ token, outcome, fields?, artifacts? })
stage_progress({ token, note })
```

`stage_complete` takes the completion token from the brief, one of the outcomes the stage declares,
that outcome's `fields` (an object; leave out when the outcome declares none) and, optionally,
`artifacts`: a list of strings naming where large results live. The engine checks, in this order:

1. the token belongs to a live attempt of a stage run;
2. the caller is the agent the stage was dispatched to, when the harness reports the caller (pass it
   as `callerAgent`);
3. the outcome is one the stage declares;
4. `fields` is an object under 64 KiB that validates against the outcome's schema.

On success the transition is committed and the run advances at once. On failure the result is a
precise error (it names the declared outcomes, the missing field and so on) and nothing changes, so
the agent can correct itself and call again within the same turn. Each failure is a tool error, not a
silent wrong turn.

- **Idempotent repeat.** A second call for an attempt that is already completed, with the same outcome
  and the same fields, succeeds again and reports `applied: "already"`. A repeat with a different
  outcome or different fields is refused.
- **Dead tokens.** A token from an earlier attempt, or from one past its deadline, is refused and
  logged, never applied.

`stage_progress` saves a checkpoint (what is done, what is next, where the work lives, up to 64 KiB)
when the agent cannot finish in this turn. If the turn then ends normally and the stage has turns
left (`turns: { max: N }`), the engine dispatches a continuation turn into the same session with the
same token and the last note.

### The token secret

Each attempt's token is derived from a secret the host gives the engine as `tokenSecret`: at least 32
bytes, with only the token's hash stored. **Keep the secret out of the store**, for example in a file
readable only by the host's user. **Every process that completes stages must use the same secret**: a
completion arriving at a process with a different secret derives a different token and is refused as
unknown. Without a `tokenSecret` the engine uses a random one held in memory, so a turn resent after a
restart cannot reproduce its old token.

## Completion-only mode and the MCP server

A harness may take turns in one process while completions arrive in another. Open the engine with
`dispatch: false` and it starts no turns and runs no tick loop; it only commits completions to the
shared store. `sekaisen-mcp` is that engine behind a small stdio MCP server that exposes only
`stage_complete` and `stage_progress`:

```text
sekaisen-mcp --store <path> --definitions <dir> --token-secret-file <path> [--agent <id>]
```

The secret file must hold at least 32 raw bytes and be the same secret the dispatching process uses.
`--agent` names the agent the connection belongs to, so the engine refuses a completion for another
agent's stage. A harness that speaks MCP but has no plugin system needs nothing else for completion;
it still needs an adapter for the required calls.

## A minimal adapter

This in-memory adapter is the whole interface with the optional calls included. It starts no real
agent: a turn runs until `finish` is called. It lives in
[`docs/examples/memory-adapter.ts`](examples/memory-adapter.ts), is compiled with the rest of the
project, and is run against the engine in a test, so it stays correct.

```ts
// A minimal harness adapter that keeps everything in memory. It starts no real
// agent: a turn "runs" until the host calls `finish`. Replace the bodies with
// calls to your harness. In your own project, import the types from "sekaisen".
import type {
  Capabilities,
  HarnessAdapter,
  RunOutcome,
  StartTurn,
} from "../../src/index.js";

interface Turn {
  start: StartTurn;
  outcome: RunOutcome;
}

export class MemoryAdapter implements HarnessAdapter {
  /** Turns by harness run id, in the order they started. */
  readonly turns = new Map<string, Turn>();
  /** Harness run ids by idempotency key: a key seen again returns its turn. */
  private readonly byKey = new Map<string, string>();
  /** What `deliver` was asked to tell each session. */
  readonly delivered: Array<{ sessionKey: string; message: string }> = [];

  async capabilities(): Promise<Capabilities> {
    return {
      turnCapMs: 10 * 60_000,
      maxConcurrent: 2,
      canAbort: true,
      subscriptionProvider: "demo-subscription",
    };
  }

  async openSession(_agent: string, _key: string): Promise<void> {
    // Nothing to prepare: a session here is just a key.
  }

  async startTurn(p: StartTurn): Promise<{ runId: string }> {
    const known = this.byKey.get(p.idempotencyKey);
    if (known !== undefined) return { runId: known };
    const runId = `turn-${this.turns.size + 1}`;
    this.byKey.set(p.idempotencyKey, runId);
    this.turns.set(runId, { start: p, outcome: { state: "running" } });
    return { runId };
  }

  async readRunOutcome(runId: string): Promise<RunOutcome> {
    return this.turns.get(runId)?.outcome ?? { state: "unknown" };
  }

  async abortTurn(runId: string): Promise<boolean> {
    const turn = this.turns.get(runId);
    if (turn?.outcome.state !== "running") return false;
    turn.outcome = { state: "ended", ending: "killed" };
    return true;
  }

  async deliver(sessionKey: string, message: string): Promise<void> {
    this.delivered.push({ sessionKey, message });
  }

  /** What a real harness does when the agent's turn ends. */
  finish(runId: string, outcome: Extract<RunOutcome, { state: "ended" }>) {
    const turn = this.turns.get(runId);
    if (turn) turn.outcome = outcome;
  }
}
```

Run it against the engine with a definition, as the simulator does with its scripted adapter, and
read the result with `sekaisen runs` and `sekaisen status`.
