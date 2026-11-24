# Changelog

All notable changes to sekaisen are recorded in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/). From its first
release, sekaisen follows [Semantic Versioning](https://semver.org/spec/v2.0.0.html). It stays at 0.x
until the pipeline format and the adapter interface are settled, and a change to the format is always
a new `format` number.

## [Unreleased]

Pre-0.1. Nothing is installable yet.

### Added

- The OpenClaw adapter, `sekaisen/openclaw`: `OpenClawAdapter`, `createPipelinePlugin` to host the engine in a
  gateway plugin (completion tools, a service, host tools), and `gateButtons` to post operator gates with answer
  buttons. Documented in [`docs/openclaw.md`](docs/openclaw.md), with an example plugin in
  [`docs/examples/openclaw-plugin`](docs/examples/openclaw-plugin).
- A `gate_reminder` engine event, with the gate's prompt and outcomes and a `reminder` count from 1. An
  operator gate's reminder emits it in place of a repeated `gate` event, which now fires once, on entry.
- Format 1: pipeline definitions in YAML with `agent`, `gate`, `check`, `action`, `wait` and `end`
  stages, a published JSON Schema (`sekaisen/schema.json`), field shorthand, identifiers, a small
  guard language and brief templates, documented in [`docs/format.md`](docs/format.md).
- The package root exports the types its own signatures use: the store rows (`RunRow`, `StageRunRow`,
  `GateRow`, `TransitionRow`, `LimitRow`), `RunStatus`, `StageRunState`, `Ending`, `RetryEnding`,
  `JsonSchema` and the stage types.
- The checks behind `sekaisen check`: schema, references, graph, termination, policy, timing and
  failure, plus a hook for checks the host adds.
- The engine: dispatch-and-await of agent turns through a harness adapter, typed completion with
  per-attempt tokens derived from a host secret, continuation turns, deadlines, retries and
  exhaustion, operator and poll gates, checks, actions, waits, cancellation with an `on_cancel`
  action, restart reconciliation, and an append-only transition log.
- The store: SQLite on `node:sqlite`, with compare-and-set state changes and schema migrations.
- The scheduler: per-agent work limits, a global lane cap, priority and fairness, and pauses for
  usage limits and provider policies.
- The simulator and `--explore`: scripted outcomes on a virtual clock, with transition coverage, and
  a walk of every path up to a bound.
- The conformance suite: definitions, scripts and expected transition logs in a language-neutral
  form, run by the engine's own tests.
- The MCP completion server, `sekaisen-mcp`, which serves `stage_complete` and `stage_progress` from
  the shared store and holds no token secret.
- The CLI: `check`, `render` (Mermaid), `simulate`, `runs` and `status`.
- The adapter reference, [`docs/adapter.md`](docs/adapter.md), with a minimal in-memory adapter that
  the tests run.
- 2026-11-22: the project started, with the README, a public design overview in
  [`docs/design.md`](docs/design.md), the MIT licence, a contributing guide, the Contributor Covenant
  2.1 as the code of conduct, a security policy, issue forms (including one for format change
  proposals), a pull request template, Dependabot updates, citation metadata, `.editorconfig`,
  `.gitattributes` and `.gitignore`.

[Unreleased]: https://github.com/d3vn0mi/sekaisen/commits/main
