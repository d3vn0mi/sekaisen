# Contributing to sekaisen

Thank you for your interest in sekaisen. This guide covers how to report a problem, how to propose a
change to the format, and how a change gets merged.

> [!NOTE]
> **sekaisen is pre-0.1.** The design is done and the engine is being built in the open, but nothing
> is installable yet and there is no code in this repository so far. The most useful contributions
> right now are design feedback, use cases and questions. Issues and pull requests are welcome.

Everyone who takes part follows the [Code of Conduct](CODE_OF_CONDUCT.md).

## Ground rules

- **Never paste private data.** No private prompts, briefs, transcripts, secrets, host names or state
  databases (`*.sqlite`). Reproduce every bug with a minimal definition and a simulation script. More
  on this [below](#reproduce-with-a-minimal-definition).
- **Tests come with every change.** A change without a test that would have caught its absence is not
  done.
- **The format is a contract.** A change to the pipeline format, the stage-run states or the
  transition-log shape starts as a [format change proposal](#proposing-a-format-change), not as a pull
  request.
- **Security problems go to [SECURITY.md](SECURITY.md)**, never to an issue, a discussion or a pull
  request.

## Development set-up

**You will need:**

- Linux or macOS.
- Node.js 22.13 or later. From 22.13, `node:sqlite` needs no flag, and the SQLite store is built on
  it. CI will run 22.13, the current LTS and the latest release.
- git.

The toolchain lands with the first code. From then on:

```sh
git clone https://github.com/d3vn0mi/sekaisen.git
cd sekaisen
npm ci            # the lockfile is committed; always install with npm ci
npm test          # the unit and conformance tests
npm run ci:local  # typecheck, lint, every test, then the build
```

## The conformance suite is the contract

The pipeline format is the public contract, and the conformance suite is how it is pinned.
`conformance/` holds cases, each one a pipeline definition, its briefs, a script of agent outcomes and
the expected transition log:

```text
conformance/cases/<case>/
  pipeline.yaml     the definition
  briefs/           its brief templates
  script.yaml       what each "agent" returns, visit by visit, on a virtual clock
  expected.jsonl    one transition per line, then the final status
```

The cases are written by hand from the format's rules, never recorded from the engine. A runtime in
any language is conformant if it reproduces every `expected.jsonl` from its `pipeline.yaml` and
`script.yaml`. The TypeScript engine's own test suite runs every case.

So:

- **A change in engine behaviour** that moves an expected log is a format change. It needs a proposal,
  and the pull request shows the changed log and says why.
- **A bug fix** that makes the engine match the documented format adds a case that fails before the fix.
- **A new feature** adds the cases that show it.

## Proposing a format change

Open a [format change proposal](https://github.com/d3vn0mi/sekaisen/issues/new?template=format_change.yml)
before you write code. It covers:

1. **What changes:** a stage type, a field, the guard language, a state, the brief footer or the
   transition-log shape.
2. **Why:** the pipeline you cannot write today, with a minimal example.
3. **The YAML you would write** with the change.
4. **What it does to existing definitions.** An optional field with a default that keeps today's
   behaviour can join the current format. Anything that changes what an existing definition means is a
   new `format` number, and the old format keeps working.
5. **The conformance cases** that would pin it.

A proposal is accepted when the maintainer labels it `accepted`. Then a pull request can implement it,
with the cases, the schema, the checks and `docs/` updated together.

## Reproduce with a minimal definition

When you report a bug:

1. Write the smallest pipeline definition that shows it, using neutral roles such as `drafter`,
   `checker` and `publisher`, and host names with a `demo.` prefix.
2. Add a simulation script that drives it to the problem, and give the exact `sekaisen check` or
   `sekaisen simulate` command and its output.
3. If only a live harness shows it, describe the adapter calls and their results, with every private
   value removed.

**Never paste private data**: no real prompts or briefs, transcripts, secrets, host names, home paths
or state databases. A state database holds everything its runs did.

## Commit messages

Commits follow [Conventional Commits](https://www.conventionalcommits.org/en/v1.0.0/):

```text
<type>(<scope>): <summary>
```

- **Types:** `feat`, `fix`, `docs`, `test`, `refactor`, `perf`, `build`, `ci` and `chore`.
- **Scopes** name the module: `format`, `guard`, `checks`, `render`, `store`, `engine`, `scheduler`,
  `simulate`, `conformance`, `completion`, `mcp`, `adapter` or `cli`.
- **Breaking changes** add `!` after the scope, and a `BREAKING CHANGE:` footer. A change is breaking
  when it alters the format, the transition-log shape, the adapter interface, the store schema without
  a migration, or the CLI.

Examples:

```text
feat(checks): report a gate whose reminder outlasts its timeout
fix(engine): refuse stage_complete from a retired token after a deadline
docs(format): explain the brief footer
```

## Pull requests

1. **Open an issue first** for anything larger than a small fix, so that no work is wasted. A format
   change needs an accepted proposal.
2. **Keep it focused:** one concern per pull request.
3. **Give it a Conventional Commit title.** It becomes the commit message when the pull request is
   squash-merged.
4. **Fill in the template:** what changed, why, and how it was tested.
5. **Keep CI green.**

**Dependencies.** The core has one runtime dependency, a YAML parser, and imports nothing from any
harness. A new runtime dependency needs a strong reason in the pull request. Harness-specific code
lives in an adapter, never in the core.

**Out of scope.** These will not be merged, however they are framed:

- model calls or prompt handling inside the engine;
- arbitrary code in a definition: guards stay a small fixed expression language, and host behaviour
  enters only by registered name;
- free-text parsing of an agent's reply to decide an outcome;
- a completion tool that can skip a stage, resolve or cancel a gate, or write state directly;
- telemetry, update checks, or any network access by the core.

## How changes are merged

The maintainer reviews and merges every change. A merge to the public repository is a publication, so
nothing is merged automatically.

Pull requests from outside contributors are **squash-merged**, and **you stay the author** of the
resulting commit. `Co-authored-by` trailers that name the people who worked on the change are kept.

## Licence

sekaisen is released under the [MIT licence](LICENSE). By contributing, you agree that your
contribution is released under the same licence, and you confirm that you have the right to submit
it.
