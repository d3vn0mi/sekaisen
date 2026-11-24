# The OpenClaw adapter

`sekaisen/openclaw` runs pipelines on an [OpenClaw](https://openclaw.ai) gateway. The engine lives
inside a gateway plugin and dispatches each agent turn in-process, through the gateway's plugin
runtime. Agents finish a stage by calling `stage_complete`, which the same plugin registers as a tool.
For the interface this adapter implements, see [the harness adapter](adapter.md).

> [!NOTE]
> Nothing is published yet. Once it is, install it in the plugin's own package:
> `npm install sekaisen`. OpenClaw is an optional peer dependency (`>=2026.9.2`); the host provides it.

## Structural types

No file in this package imports `openclaw`, not even a type. `PluginApi` and the types around it
describe only the parts of the plugin API that the adapter uses, so the package loads and type-checks
with no OpenClaw installed. OpenClaw's own types assign to them. If they ever drift, your plugin's
build fails at the `createPipelinePlugin` call, which is where you want to hear about it.

## Hosting a pipeline

`createPipelinePlugin` builds the engine and registers everything with the gateway:

```ts
import { createPipelinePlugin } from "sekaisen/openclaw";

const plugin = createPipelinePlugin({
  api,                                     // the PluginApi your register() receives
  adapter: { agents: ["drafter", "checker"] },  // api defaults to the one above
  storePath,                               // the engine's SQLite file, created if missing
  tokenSecret,                             // Uint8Array, at least 32 bytes
  definitions,                             // { current(pipelineId) } -> a loaded definition
  registry,                                // your checks, actions and facts
  buttons,                                 // optional, see "Gate buttons"
  engine: { tickMs: 5_000 },               // optional, further engine options
  serviceId: "my-pipelines",               // optional, "sekaisen" by default
});
```

`engine` takes further engine options, such as `tickMs`, `wip` or `clock`. The store, adapter,
registry, definitions and token secret always come from the options above, so the same keys under
`engine` are ignored. `serviceId` is the id the service is registered under, `"sekaisen"` by default.

It registers:

- a **service** that starts the engine and stops it. Stopping leaves the store open, because OpenClaw
  may stop and start a service without building the plugin again;
- the tools `stage_complete` and `stage_progress`;
- with `buttons`, the gate prompts and their press handler.

`createPipelinePlugin` throws, before it registers anything, when `tokenSecret` is missing or shorter
than 32 bytes. The secret must survive a restart, or a turn already sent could not be completed. Keep
it in a file readable only by the gateway's user.

The returned `plugin` has the `engine`, the `adapter`, and `plugin.tool(name, description, schema,
handler)` to register your own tools. Their handlers return `{ text, isError }` and get the calling
turn's context. A tool that throws returns an error result. `plugin.close()` stops the engine, closes
its store and forgets it, so a later registration opens the store again.

### Registration modes

OpenClaw loads a plugin for more than one reason, and says which in `api.registrationMode`. Only
`"full"` is the gateway's own registration. The others (`"discovery"`, `"tool-discovery"`,
`"setup-only"`, `"setup-runtime"`, `"cli-metadata"`) only read what the plugin registers, and some
of them make `api.runtime` unusable.

`createPipelinePlugin` acts on that:

- **Full registration**, or no `registrationMode` at all: opens the store, builds the engine, and
  registers the service, the tools and the buttons.
- **Any other mode**: registers the tools alone, so OpenClaw can list them. It opens no store, builds
  no engine, registers no service or buttons, and never touches `api.runtime`. OpenClaw can run a
  tool from such a load. The call then reaches the engine that a full registration of the same store
  started in this process. If there is none, the call returns an error result. `plugin.engine` and
  `plugin.adapter` resolve the same way, when read, and throw if there is no engine. So a host tool
  whose handler reads `plugin.engine` works from either load.

One engine runs per store file in a process. A later full registration with the same `storePath`
reuses it. It registers the service, the tools and the buttons again on its own `api`, and moves the
buttons there, so a gate is still posted once. The options of that later registration that build an
engine (`adapter`, `definitions`, `registry`, `tokenSecret`, `engine`) are ignored. An in-memory
store (`":memory:"`) is never shared.

### Adapter options

`adapter` takes either an `OpenClawAdapter` or its options:

| Option | Meaning |
|---|---|
| `api` | The plugin API. Optional in `createPipelinePlugin`, which passes its own |
| `agents` | The agent ids pipelines may name. `startTurn` refuses any other agent, so a run can always be found again after a gateway restart. The list is copied |
| `sessionKey(engineKey, agent)` | Maps an engine session key to an OpenClaw one; see below |
| `ownerKey(agent)` | The session that owns an agent's runs in the task ledger; see "Cancel" |
| `pin` | `{ [agent]: { provider, model } }`; see "Pinning a model" |
| `turnCapMs` | Overrides the turn cap |
| `maxConcurrent` | Overrides the lane cap. Otherwise `agents.defaults.subagents.maxConcurrent`, then 8 |
| `subscriptionProvider` | The provider that counts as the subscription. `"claude-cli"` by default |

The adapter starts a turn with `api.runtime.subagent.run`, with the engine's idempotency key as the
key and `deliver: false`. OpenClaw dedupes keys in memory only, so after a restart a repeated key
starts a new run; the engine's own idempotency handling covers that.

## Session keys

By default the engine's keys map to OpenClaw session keys, lowercased:

| Engine key | OpenClaw key |
|---|---|
| `run:<runId>:<agent>` | `agent:<agent>:pipe-<runid>` |
| `project:<p>:<agent>` | `agent:<agent>:proj-<p>` |

In a project name, every character outside `[a-z0-9_-]` becomes `-` after lowercasing, so
`project:Site A/v2:drafter` maps to `agent:drafter:proj-site-a-v2`. Two names that differ only in
those characters share a session.

`openSession` does nothing: the first turn creates the session. Pass `sessionKey` to map keys another
way.

## Granting the completion tools

OpenClaw has three rules for a plugin's tools.

1. **Declare them in the manifest.** The host plugin's `openclaw.plugin.json` must list
   `stage_complete`, `stage_progress` and every name you pass to `plugin.tool()` under
   `contracts.tools`. OpenClaw refuses to register a tool the manifest does not declare.
2. **Grant them to each pipeline agent.** Add the tools to that agent's `tools.alsoAllow` in the
   OpenClaw config. **`alsoAllow` replaces, it does not extend.** An agent's list wipes what it
   inherited, so re-list everything the agent needs, not only the new tools.
3. **The caller is the turn's agent.** A completion call whose tool context carries no agent id gets
   an error result ("needs a calling agent"). A call from a different agent than the stage's is
   refused.

The adapter does not grant tools per run. OpenClaw ignores a per-run grant for turns that run in a
CLI harness, so a per-turn `tools` list would silently do nothing. That is why the adapter ignores
`StartTurn.tools`. Tokens keep the tools harmless: a token works only for a live attempt, so the
tools do nothing outside one.

## Pinning a model

A pipeline agent runs on whatever model the gateway gives it. To pin one, set `pin` for that agent.
OpenClaw has two requirements, and the adapter reports a refusal of either as one error that names
both:

- `plugins.entries.<id>.subagent.allowModelOverride: true` for your plugin;
- the model listed in `agents.defaults.modelPolicy.allow`.

The refusal can come when the turn starts, as an error from `startTurn`, or at the end of the run, as
its error text. Either way it is rewritten the same way and keeps OpenClaw's own text. A run the
adapter started that has no task row yet is checked with `waitForRun`. If it already failed, it reads
`ended` / `error` with that text.

There is no way to switch fallback off, so a pinned turn can still end on another model.
The adapter therefore reads the provider and model after the turn, from the session row, and
reports them as `runtime`. That is what the `providers` policy compares.

## Turn cap

`capabilities().turnCapMs` is `turnCapMs` if you set it, else `agents.defaults.timeoutSeconds`, else
90 minutes. The engine's own deadlines apply either way.

**Known unknown.** The gateway's real limit on a plugin's turn is not yet known. One candidate is the
gateway's subagent run timeout, `agents.defaults.subagents.runTimeoutSeconds`, because plugin runs
are registered as subagent tasks. It is being measured. Until it is, do not rely on a stage deadline
longer than that timeout, and set `turnCapMs` to what you observe.

## Cancel

`abortTurn(runId)` cancels through the gateway's task ledger. It binds the run's owner session, finds
the task whose run id matches (the newest, if several do) and cancels it. A plugin cannot call the
gateway's own abort, so there is nothing else to call.

The owner session is `agent:<id>:<mainKey>`, built as OpenClaw builds it: `<mainKey>` is the config's
`session.mainKey`, trimmed and lowercased, or `main` when it is unset or blank, and the agent id is
lowercased. Reads use the same key. Pass `ownerKey(agent)` to name it yourself.

A run the adapter cancelled reads `ended` / `killed`, never `error`, although OpenClaw reports such
a run as an error.

## After a restart

A gateway restart cuts the turns in flight. OpenClaw marks each one failed, with the stop reason
`restart` and the error "agent run aborted for restart". The adapter reads such a run as `unknown`,
the same as a lost turn, unless it cancelled the run itself. The engine reconciles its turns when it
starts, records that attempt as lost, and retries it under the stage's retry rules (by default, a
lost turn is retried). Outside start-up, a turn read as `unknown` is left to its deadline.

The adapter remembers which agent owns a run, and which runs it cancelled, only in memory. After a
restart it scans the ledgers of the agents in `agents`. A run it finds as `lost`, or in no ledger,
reads `unknown`. If two rows share a run id, the newest decides.

A cancel made before a restart is forgotten too, so the adapter would read that run as `unknown`. The
engine never asks: a cancel ends the stage run in the store at once, and the engine reads no turn of
a stage run that has ended. Nothing is retried, and the run stays canceled. An abort request still
pending at the restart is sent again. If the turn has already ended, the request settles as not
aborted.

## Gate buttons

With `buttons: { channel, to, accountId?, operatorIds }`, each operator gate is posted to `to` as a
message with one button per outcome. The message goes out on the gate's first appearance and again on
each reminder. A gate first seen already past its timeout is announced by its reminder alone, and the
button helper posts on both events.

A press resolves the gate only when OpenClaw reports the sender as authorized and the sender's id is
in `operatorIds`. Anyone else is answered "not allowed" and nothing changes. `resolved_by` is
`<channel>:<senderId>`, the operator who pressed; in a group chat the chat id would name the group. A press for a gate that is not waiting, or for an outcome that does not exist,
is answered with the engine's error. So is a second press.

Callback data is `sekaisen:<stageRunId>:<outcomeIndex>`. If any button's data passes 64 bytes
(Telegram's limit), the whole gate prompt is skipped, not only that button, and the plugin logs a
warning. The gate still waits for an answer, given some other way.

OpenClaw routes button presses by a namespace. This adapter's is fixed, `sekaisen`, so one gateway can
host only one plugin that uses `buttons`.

`gateButtons(options).install({ api, engine, store })` is the same helper for a host that builds its
engine by hand. Install it before the engine starts, because start-up can emit a reminder.

## An example

[`docs/examples/openclaw-plugin`](examples/openclaw-plugin/) is a complete plugin: a `drafter` and
`checker` pipeline, one `demo_start` tool, the manifest, and the host steps to run it.
