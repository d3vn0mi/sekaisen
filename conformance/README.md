# sekaisen conformance suite

The pipeline format is sekaisen's public contract, and this suite pins it. Each case is a pipeline
definition, a script saying how each turn, gate and host function answers, and the transition log
a runtime must write when it runs that pipeline against that script. Nothing here depends on the
TypeScript engine: a runtime in any language can run the suite.

The expected logs were written by hand from the rules in [the format reference](../docs/format.md),
not recorded from the engine. Where a case and the engine disagreed, the disagreement was settled
in the reference first.

## The contract

**A runtime is conformant if, for every case, running `pipeline.yaml` against `script.yaml` as
described below writes exactly the lines of `expected.jsonl`.**

- In: `pipeline.yaml` (format 1, with its `briefs/`) and `script.yaml`, both YAML.
- Out: the run's transition log as JSON Lines, one object per transition, in log order, then one
  last line with the run's final status: `{"status":"completed"}`.

Each transition line has the keys `seq`, `run_stage`, `from`, `to`, `event`, `outcome` and `actor`,
in that order, with `outcome` present only on the transitions that take one. The
[format reference](../docs/format.md#the-transition-log) defines each key, every event name and
the order the events come in. **The event names and the line shape are part of the contract**: a
runtime that writes `stage_done` for `stage_completed`, or puts `outcome: null` on a line without
one, is not conformant.

Lines are compared as JSON values, key by key: whitespace between tokens does not matter, but key
names, values and the order of the lines do.

## Cases

| Case | What it pins |
|---|---|
| [`happy`](cases/happy) | An agent, a check, an operator gate, a guarded branch on an input, a second agent and an action, to a `completed` end |
| [`fix-loop-cap`](cases/fix-loop-cap) | A draft and check loop bounded by `count(check.fail) < 2`, where `count` includes the outcome being taken, ending at the `failed` end |
| [`gate-timeout`](cases/gate-timeout) | Gate reminders (the first at the timeout, then every `remind`), a resolution after them, and a gate whose `on_timeout` edge is taken |
| [`lost-retry`](cases/lost-retry) | A turn lost to a restart and retried by the default agent retry, then retries on `no_result` that run out and exhaust to the first `failed` end |
| [`usage-pause`](cases/usage-pause) | A refused turn pausing until its reset, a refusal without a reset pausing for an hour, then the attempt completing |
| [`cancel`](cases/cancel) | A cancel while a turn is in flight: the abort, the run's `canceled` status and the `on_cancel` action running once |
| [`continuation`](cases/continuation) | A checkpoint and a continuation turn sharing the attempt's deadline, the timeout of that turn, and a retry with a fresh deadline |
| [`poll-gate`](cases/poll-gate) | An action that fails once and is retried, then a poll gate that passes on its third poll |

Each case folder holds `pipeline.yaml`, `briefs/` (the brief templates its agent stages name),
`script.yaml` and `expected.jsonl`.

## Running a case

With the TypeScript engine, the suite runs as part of its tests (`test/conformance.test.ts`). One
case can be run by hand, which prints its log, one transition per line, and its final status; with
`--json` it prints the same as one JSON object (`log` and `status`, with coverage and notes):

```sh
sekaisen simulate conformance/cases/happy/pipeline.yaml --script conformance/cases/happy/script.yaml
```

Another runtime implements the procedure below and compares its output with `expected.jsonl`.

### The script

```yaml
inputs: { topic: release }          # the run's inputs; {} when absent
stages:                             # by stage id: one entry per turn (agent) or per opening (gate)
  draft:
    - { outcome: drafted, fields: { summary: a draft }, after: 5m }
    - { progress: "outline done", after: 20m }
    - { ending: lost, after: 5m }
    - { ending: usage_limited, after: 1m, resets: 30m }
  review:
    - { resolve: approve, after: 1h }
    - { ending: timeout }
checks: { demo.ready: [ ready ] }   # by check name: the outcome of each call, in order
actions: { demo.notify: [ fail, ok ] } # by action name: whether each call succeeds, in order
facts: { demo.merged: [ false, true ] } # by fact name: the answer of each poll, in order
cancel: { after: 30m }              # cancel the run this long after it starts
```

An agent stage's entries are used one per turn the harness starts for that stage, over every
visit, attempt and continuation, in order. An entry takes effect `after` (a [duration](../docs/format.md#durations),
0 when absent) the turn starts:

| Entry | The simulated turn |
|---|---|
| `outcome`, `fields` | Calls `stage_complete` with that outcome and those fields (`{}` when absent), then ends normally |
| `progress: <note>` | Calls `stage_progress` with that note, then ends normally without completing |
| `ending: no_result` | Ends normally without calling anything |
| `ending: turn_error` | Ends with the error `the simulated turn failed` |
| `ending: usage_limited` | Ends with the error `You've hit your usage limit`, followed, when `resets` is given, by ` · resets <instant>`, the turn's end plus `resets`, as an ISO 8601 UTC instant with milliseconds (`2026-01-01T00:40:00.000Z`) |
| `ending: lost` | The harness forgets the turn and the engine restarts at once; the new engine settles what was in flight before anything else happens |
| `ending: timeout` | Never ends; the attempt's deadline decides |

An operator gate's entries are used one per opening: `resolve: <outcome>` answers it with that
outcome `after` it opened, with the actor `simulator`; `ending: timeout` never answers it.

Once a stage's list runs out, a turn completes with the stage's first outcome and the smallest
fields its schema accepts, and a gate is resolved with its first outcome, both at once. A check
whose list ran out returns its stage's first outcome, an action succeeds and a fact holds.

### The procedure

1. **Start.** The virtual clock starts at `2026-01-01T00:00:00Z`. The run is started with the
   script's inputs and the actor `simulator`. The harness reports a turn cap of 10 minutes, 8
   concurrent turns, that it can abort turns, and no subscription provider, and the engine's other
   settings are their defaults.
2. **Step.** Repeat:
   1. If the script's cancel is due (the clock has reached the start plus `after`) and the run has
      not ended, cancel the run with the actor `simulator`. A cancel comes before anything else due
      at the same moment.
   2. Run one engine tick, as the [format reference](../docs/format.md#order) orders it.
   3. Give each turn started in that tick, and each operator gate that opened, its next entry. The
      entry is due at the current time plus its `after`.
   4. Play every entry that is due, earliest first. An entry whose turn or gate the run has moved
      past (the attempt timed out, the gate timed out, the run was canceled) is dropped.
   5. If this step wrote any transition or played any entry, step again at the same time.
      Otherwise move the clock to the earliest future moment anything is due: an entry, a wait's
      end, a deadline, a gate's reminder, poll or timeout, the end of a pause, the cancel. If
      nothing is due, the run is stalled and the simulation stops.
3. **Stop.** The simulation stops once the run has ended and none of its stage runs is still live
   (a canceled run's `on_cancel` action still runs). A turn whose end the engine has not yet read
   is not read: the last completion of a run is not followed by its `turn_ended`.

The log is every transition of the run, numbered from 1, followed by the final status.

## Adding a case

A new case starts as a change to the format reference, when it pins behaviour the reference does
not state yet. Write `expected.jsonl` by hand from the reference, then run it; a difference is a
bug in the engine, the case or the reference, and is settled there, never by copying the engine's
output. Use neutral roles (`drafter`, `checker`, `publisher`) and host names with the `demo.`
prefix.

## Author

**d3vn0mi**, [github.com/d3vn0mi](https://github.com/d3vn0mi)
