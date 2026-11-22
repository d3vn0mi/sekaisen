# sekaisen design overview

This is the design of sekaisen as it stands before 0.1: the ideas, the two state machines, the
completion contract and the interfaces between the engine, its host and the harness. It describes
what is being built, so details can still change before 0.1 ships. Once the code lands, the format
reference (`docs/format.md`) and the adapter reference (`docs/adapter.md`) take over the details,
and this page stays the overview.

## Contents

- [The problem](#the-problem)
- [Concepts](#concepts)
- [The pipeline definition](#the-pipeline-definition)
- [Two state machines](#two-state-machines)
- [Running a stage](#running-a-stage)
- [Storage](#storage)
- [Checks before a run](#checks-before-a-run)
- [Simulation](#simulation)
- [The scheduler](#the-scheduler)
- [The harness adapter](#the-harness-adapter)
- [The host](#the-host)
- [Conformance](#conformance)
- [Room for later](#room-for-later)

## The problem

Multi-stage work across AI agents is often wired together by the agents themselves. One agent's turn
hands work to another and waits for the reply. The rules about what comes next (retry this, loop at
most three times, ask a person before publishing) live in prompts. That breaks in predictable ways.
A long wait inside a turn dies when the turn hits its time limit. A reply that never comes looks
the same as a reply that said nothing. A verdict written as prose gets misread. A restart loses
every pipeline that was in flight. And nobody can test a pipeline without running it, at full price.

sekaisen moves those rules out of the prompts and into a file the engine reads:

- **A turn never waits on another turn.** The engine dispatches a turn and returns. The pipeline's
  state lives in the engine's store, not in anyone's context window.
- **An agent ends its stage with a typed call**, naming one of the outcomes the stage declares. The
  engine, not the agent, decides what happens next.
- **The rules are data.** Transitions, retries, loop bounds, gates and deadlines are in the
  definition, so they can be checked before a run and simulated without one.

## Concepts

| Term | Meaning |
|---|---|
| **Pipeline** | One YAML file: its stages, the outcomes each stage may end with, and where each outcome leads |
| **Stage** | One step of a pipeline: an agent's work, a gate, a check, an action, a wait or an end |
| **Outcome** | A named way a stage can end, with an optional schema for the fields that come with it |
| **Run** | One execution of a pipeline, with its inputs, moving through the stage graph |
| **Stage run** | One visit of a run to one stage. A loop that returns to a stage creates a new stage run |
| **Attempt** | One try of a stage run. A retry is a new attempt, with a fresh token and a fresh deadline |
| **Turn** | One unit of agent work in the harness: a prompt in, tool calls, a reply out |
| **Role** | The `agent:` name in a definition. The adapter resolves it to an agent in the harness |
| **Brief** | The Markdown template the engine renders into the message that starts an agent's turn |
| **Host** | The program that embeds the engine. It registers checks, actions and polled facts, and owns the surfaces where people resolve gates |
| **Adapter** | The code that connects the engine to one harness |

## The pipeline definition

A definition declares its `format`, an `id`, a hand-bumped `version`, a JSON Schema for its
`inputs`, optional `defaults`, the `start` stage and the `stages`. The README has a complete
example. A published JSON Schema validates every definition, and keys starting with `x-` are kept
for tools and ignored by the engine.

### Stage types

| Type | What it does | Completes when |
|---|---|---|
| `agent` | Dispatches a turn to a role, with a rendered brief | The agent calls `stage_complete`, or the engine classifies how the turn ended |
| `gate` | Waits for something outside: `who: operator` waits for a person, `poll:` waits for a fact the host checks, such as a merged pull request | A person resolves it, the polled fact turns true, or its timeout edge fires |
| `check` | Runs a deterministic predicate the host registered by name. No model is involved | At once, with one of its declared outcomes |
| `action` | Runs a deterministic side effect the host registered by name, with an idempotency key | When the action resolves. A failure follows the retry policy |
| `wait` | Waits for a duration, or until an instant | When the timer fires |
| `end` | Ends the run, with the status `completed`, `failed` or `canceled` | At once |

`subpipeline` and `parallel` are reserved names. The 0.1 validator refuses them, so a definition
cannot depend on them before they exist.

### Outcomes, transitions and guards

Every `agent`, `gate` and `check` stage declares a closed set of outcomes. Each has an optional
`fields` schema and a `next`. A `next` is either a stage id, or an ordered list of `{ if, to }`
branches that ends with an unconditional one:

```yaml
fail:
  fields: { findings: string }
  next:
    - { if: "count(check.fail) < 3", to: draft }
    - { to: failed }
```

Guards are written in a small, fixed expression language, never in general code:

- `count(<stage>.<outcome>)`: how many times a stage ended with an outcome in this run;
- `attempts(<stage>)`: how many attempts a stage has taken;
- `<stage>.<field>`, the fields of a stage's latest completed visit, and `inputs.<path>`;
- comparisons, `and`, `or`, `not`, parentheses, integers, strings and booleans.

Because the language is fixed, the checks can read the bounds out of a guard, and the simulator can
explore it exactly.

### Deadlines and retries

- `deadline` is the wall-clock budget for one attempt, across all of that attempt's turns. When it
  passes, the attempt ends as `timeout`. A retry gets a fresh deadline.
- `retry: { max, on: [...] }` names which engine-classified endings are retried: `no_result`, `lost`,
  `timeout` and `turn_error`. An outcome the agent chose is never retried automatically: it follows
  its `next`.
- When the retries run out, the stage takes its `on_exhausted` edge, by default the pipeline's
  `failed` end.

### Briefs

A brief is a Markdown template beside the definition. The engine renders it with the run's inputs,
the fields of earlier stages, the stage's declared outcomes and the completion token. It then appends
a fixed footer that tells the agent how to finish: call `stage_complete` with the token and one of the
listed outcomes, or `stage_progress` to save a checkpoint. A placeholder with no value yet renders as
a visible `(unset: stage.field)`, never as an error.

A brief says what this stage needs. How the agent does its job stays with the agent and its harness.

### Versioning

Every run stores the SHA-256 of its definition file and the briefs it references. A run finishes on
the version it started on, even if the file changes while it is in flight. The engine keeps the
parsed form of every version it has seen, so a change applies to new runs only.

## Two state machines

### The run

A run moves through the pipeline's own graph: the stages and the transitions the definition
declares. Its status is one of `working`, `input_required` (its live stage is a gate), `completed`,
`failed` or `canceled`. Only an `end` stage, or a cancellation, ends a run.

### The stage run

Every stage run, whatever the stage, moves through one fixed lifecycle. Its states are the
[A2A](https://a2a-protocol.org/) task states, so a stage run maps onto an A2A task without
translation:

| State | A2A task state | Meaning |
|---|---|---|
| `submitted` | `submitted` | Created, waiting for the scheduler to admit it |
| `working` | `working` | A turn is in flight, or the stage is between continuation turns |
| `input_required` | `input-required` | A gate is waiting on a person or a polled fact |
| `completed` | `completed` | Ended with one of its declared outcomes |
| `failed` | `failed` | Ended with an engine-classified failure, after its retries |
| `canceled` | `canceled` | Canceled, on its own or with its run |
| `rejected` | `rejected` | Refused by the engine before dispatch |

The allowed moves:

| From | To |
|---|---|
| `submitted` | `working`, `input_required`, `completed`, `failed`, `canceled`, `rejected` |
| `working` | `working` (a continuation turn), `submitted` (a retry, or a pause for a usage limit), `completed`, `failed`, `canceled` |
| `input_required` | `completed`, `failed`, `canceled` |
| `completed`, `failed`, `canceled`, `rejected` | none: these are final |

Any other move is a bug, and the engine refuses it.

## Running a stage

### Dispatch

When the scheduler admits a `submitted` agent stage run, the engine:

1. mints a random completion token for this stage run and this attempt, and stores only its hash;
2. computes the idempotency key `<run>:<stage>:<attempt>`;
3. renders the brief;
4. calls the adapter's `startTurn` with the role, the session, the message, the turn cap, the
   idempotency key and the completion tools;
5. records the adapter's run id and moves the stage run to `working`, in one transaction.

Then it returns. Nothing in the engine waits on the turn.

### The completion contract

An agent finishes its stage with:

```text
stage_complete(token, outcome, fields?, artifacts?)
```

The engine checks, in this order:

1. the token belongs to a live stage run and its current attempt;
2. the caller is the agent the stage was dispatched to, where the harness reports the caller;
3. the outcome is one the stage declares;
4. `fields` is an object, within the size limit, and validates against that outcome's schema.

On success it commits the transition and advances the run at once, without waiting for the next tick.
On failure it returns a precise error naming what was wrong, such as the declared outcomes, and
changes nothing. The agent can correct itself and call again in the same turn. A second identical
call for an attempt that is already complete returns the applied result again, so an agent that
retries after a slow tool response does no harm. A call with a retired token, such as one from a turn
that outlived its deadline, is refused and logged, never applied.

Inside a turn, `stage_progress(token, note)` saves a checkpoint: what is done, what is next and where
the work is.

### When a turn ends without completing

The engine also learns how each turn ended, from the adapter's `readRunOutcome`, and classifies an
ending without `stage_complete`:

| Ending | When |
|---|---|
| `no_result` | The turn ended normally, without completing and without a fresh progress note |
| `continue` | The turn ended normally after `stage_progress`: the stage wants another turn |
| `turn_error` | The turn failed, was killed or hit the harness's turn cap |
| `usage_limited` | The provider refused the turn because a usage limit was hit |
| `timeout` | The attempt's deadline passed |
| `lost` | After a restart, the harness no longer knows the turn |

Each ending goes to the retry policy, except two. `continue` leads to a continuation turn.
`usage_limited` returns the stage run to `submitted` without using a retry, and pauses that provider.

When a deadline passes, the engine cannot always stop the turn, since not every harness can abort
one. So it retires the token first: whatever the late turn does, it can no longer complete the stage.
Then it asks the adapter to abort the turn, if the adapter can, and applies the retry policy.

### Stages longer than one turn

A stage can allow several turns with `turns: { max: N }` (the default is 1). When a turn ends after a
fresh progress note, with turns and deadline left, the engine dispatches a continuation turn into the
same session. It carries the same token and the last note. When the turns run out without a
completion, the attempt ends as `no_result`.

### Gates

- **`who: operator`.** The stage run moves to `input_required` and the engine emits an event with the
  rendered prompt and the declared outcomes. The host shows it to a person, with one button per
  outcome for example. The host resolves the gate with the person's choice, and the resolution
  records who made it. No completion tool can resolve a gate, so an agent cannot approve its own
  work.
- **`poll:`.** The gate names a fact the host registered and an interval. The engine polls it on its
  tick, backing off when the fact throws, and takes the gate's outcome when it turns true.
- **Timeouts.** Every gate has a `timeout` and an `on_timeout`: by default, remind and wait again, or
  take a named edge. A wait for a person never sits inside an agent's turn.

### Restart reconciliation

Everything the engine knows is in its store. On start, before its first tick, it walks every
`working` stage run:

- if the adapter reports that the turn ended, the engine classifies the ending as above;
- if the harness no longer knows the turn, the attempt ends as `lost`, its token is retired and the
  retry policy applies, with the same idempotency key so the harness can drop a duplicate;
- gates and waits resume from their stored deadlines.

Every reconciliation decision is written to the transition log, with the actor `engine:reconcile`.

### Cancellation

Cancelling a run moves it and its live stage run to `canceled`, retires the token and asks the adapter
to abort the turn, if it can. Nothing is undone automatically. A pipeline that needs clean-up declares
an `on_cancel` action stage, which runs once.

## Storage

The engine talks to its state through a `Store` interface with transactional operations. The built-in
implementation is SQLite on `node:sqlite`, in WAL mode with full synchronous writes. It holds:

| Table | Holds |
|---|---|
| `definitions` | One row per distinct definition version the engine has seen, with its parsed form |
| `runs` | Each run: its pipeline, pinned definition hash, inputs, status, current stage and priority |
| `stage_runs` | Each stage run: attempt, state, token hash, idempotency key, adapter run id, session, turns used, deadline, outcome, fields, progress note and the provider that ran its last turn |
| `transitions` | The append-only log. Every state change of a run or a stage run writes one row, in the same transaction |
| `gates` | Gates that are waiting or resolved, and who resolved them |
| `limits` | Scheduler pauses, such as a provider paused until its usage limit resets |
| `meta` | The schema version and the engine version |

Every state change is a compare-and-set update: it applies only if the row is still in the state
and attempt the caller read. A change that loses a race is a no-op, and the caller reads again. The
transition log is never updated or deleted, so it is the run's whole history, the world line the
project is named after.

## Checks before a run

`sekaisen check <file>` runs every check before anything is dispatched. A host adds its own.

| Check | What it verifies |
|---|---|
| **Schema** | The file validates against the JSON Schema for its `format` |
| **References** | Every `next` target exists. Every `check`, `action` and polled fact is registered by the host. Every brief exists, and every placeholder names an input or a stage |
| **Graph** | Every stage is reachable from `start`, every stage that is not an end has a way out, an end is reachable from every stage, and every outcome has a `next` |
| **Termination** | Every cycle passes through a gate, or through a branch whose guard bounds it, such as `count(check.fail) < 3` |
| **Policy** | Every path from `start` to a stage marked `deploys: true` passes a gate that a person resolves |
| **Timing** | Each stage's turn cap fits within the harness's turn cap, each deadline leaves room for the turns a stage allows, and no gate reminds more often than once a minute, or later than its timeout |
| **Host checks** | Whatever the host adds, such as checking that each agent has every tool its stage needs |

## Simulation

`sekaisen simulate <file> --script <script.yaml>` runs the real interpreter and scheduler against a
scripted adapter, on a virtual clock and an in-memory store. The script says, for each stage and each
visit, which outcome and fields the "agent" returns, or which ending happens instead (`no_result`,
`lost`, `timeout`, `usage_limited`, `turn_error`). It also gives the answers of checks and polled
facts, and how gates are resolved.

- **Output:** the transition log, the final status and the transition coverage, meaning which
  declared edges were taken and which were not.
- **Time is virtual.** Deadlines, gate timeouts and reminders run on a simulated clock, so a 24-hour
  gate timeout takes no time at all.
- **`--explore`** walks every path up to a bound, through every declared outcome and every engine
  ending. It reports any path that does not reach an end, or that breaks a policy.

No turn is dispatched and no token is spent.

## The scheduler

Agents in a harness are shared and limited. Several pipelines may want the same agent at once, and
providers have usage limits. The scheduler decides which `submitted` stage run is dispatched next:

- **Per-agent work limit.** By default, at most one working stage run per agent per session, so two
  pipelines never talk over each other in one session.
- **Global lane cap.** Never more turns in flight than the harness allows, as its adapter reports.
- **Priority and fairness.** Higher priority first, first in first out within a priority, so one busy
  pipeline cannot starve another that shares its agent.
- **Usage-limit pause.** A turn the provider refused for a usage limit pauses dispatch to that
  provider until the limit resets, or for an hour when the reset time cannot be read. The stage run
  goes back to `submitted` without using a retry. A pipeline can also say which providers it accepts,
  and the engine records the provider of every turn, so it is always visible where work ran.

A stage run that waits says why, for example `wip:<agent>`, `lane_full` or `paused:provider:<id>`.

## The harness adapter

The core depends on one interface, never on a harness. `capabilities()` describes the harness, and
seven calls do the work. Four are needed by every adapter, and three are optional:

```ts
interface HarnessAdapter {
  // What the harness allows: its turn cap, how many turns may run at once, whether it can abort one,
  // and, where it can say, which tools an agent has.
  capabilities(): Promise<{
    turnCapMs: number;
    maxConcurrent: number;
    canAbort: boolean;
    agentTools?(agent: string): Promise<string[]>;
  }>;

  // Prepare a session for an agent. May do nothing.
  openSession(agent: string, key: string): Promise<void>;

  // Start a turn and return at once. The idempotency key lets the harness drop a duplicate after a
  // restart. `tools` lists the completion tools, for harnesses that can give tools per turn.
  startTurn(p: {
    agent: string;
    sessionKey: string;
    message: string;
    capMs: number;
    idempotencyKey: string;
    tools: string[];
  }): Promise<{ runId: string }>;

  // How a turn is doing: still running, ended (and how, and on which provider), or unknown.
  readRunOutcome(runId: string): Promise<
    | { state: "running" }
    | {
        state: "ended";
        ending: "ok" | "error" | "timeout" | "killed";
        error?: string;
        runtime?: { provider: string; model: string };
      }
    | { state: "unknown" }
  >;

  // Optional: stop a turn that is still running.
  abortTurn?(runId: string): Promise<boolean>;

  // Send a message into a session without starting a stage, such as a gate reminder.
  deliver(sessionKey: string, message: string): Promise<void>;

  // Optional: let the host's own loop drive the engine's tick.
  schedule?(spec: string, fn: () => void): { dispose(): void };

  // Optional: inspect tool calls before they run, for extra hardening.
  guardToolCall?(fn: (call: unknown) => "allow" | { deny: string }): void;
}
```

The interface is provisional until the first adapter is built against a live harness. The first is
for OpenClaw. A scripted fake adapter ships with the core, and drives the tests, the simulator and the
conformance suite.

### Completion over MCP

A harness with a plugin system registers `stage_complete` and `stage_progress` natively, through its
adapter. For a harness that speaks MCP and has no plugin system, sekaisen ships a small stdio MCP
server that exposes only those two tools, backed by the same handlers and the same store. The
completion contract is the same either way.

## The host

The host is the program that embeds the engine. It gives the engine:

- **A definition source**, from which the engine loads pipelines by id.
- **A registry** of checks, actions and polled facts by name, plus any extra checks it wants
  `sekaisen check` to run. Names usually carry the host's prefix, such as `demo.notify`, which keeps
  host-specific behaviour out of the definitions' format.
- **The surfaces where people resolve gates.** The engine emits gate events. How they reach a person
  (a chat message with buttons, a web page) is the host's business, and so is checking that the person
  may resolve the gate.
- **An adapter** for its harness.

The engine gives the host a small surface back: start a run, complete or checkpoint a stage, resolve
a gate, cancel a run, and read a run's status and transitions. The CLI's `status` and `runs` commands
read the same store.

## Conformance

The format is the public contract, and `conformance/` pins it. Each case is a definition, its briefs,
a script of outcomes and the expected transition log, one JSON object per line with no timestamps or
random ids, then the final status and the virtual time the run took. The cases are written by hand
from the format's rules, never recorded from the engine. A runtime in any language is conformant if it reproduces every expected
log. The TypeScript engine's test suite runs the whole suite.

## Room for later

- **Cost budgets** per stage and per pipeline, with a transition when a budget runs out.
- **An XState export** of a definition.
- **Crystallization reports** that read the transition log for decision points whose outcome never
  varies, as candidates to replace with a deterministic check.
- **Subpipelines**, a pipeline as one stage of another, and **each pipeline as an A2A agent** with its
  own agent card. Because stage runs already use the A2A task states, that is a mapping, not a
  rewrite.
- **Parallel stages**, as format 2.
- **More stores** (Postgres, libSQL) and **more adapters**.
