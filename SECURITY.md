# Security policy

sekaisen sits between AI agents and the decisions about what happens next in a pipeline, so what an
agent may and may not do is part of the design, not an afterthought. This policy covers what is
supported, how to report a vulnerability, and what counts as one.

## Supported versions

sekaisen is **pre-0.1**. Nothing has been released, and there is nothing to install yet.

| Version | Supported |
|---|---|
| `main`, unreleased | Reports about a flaw in the design or in the code are welcome now |
| 0.x, once released | The latest minor release receives security fixes |

## Reporting a vulnerability

**Please do not report a security problem in a public issue, discussion or pull request.**

Report it privately, through GitHub's private vulnerability reporting:

- open the repository's **Security** tab and choose **Report a vulnerability**; or
- go straight to
  [github.com/d3vn0mi/sekaisen/security/advisories/new](https://github.com/d3vn0mi/sekaisen/security/advisories/new).

Please include:

- what you found, and its impact;
- the sekaisen version or commit, and the adapter in use;
- your OS and Node.js version;
- a reproduction with a minimal definition and a simulation script, or the adapter calls that show
  it. **Never send private prompts, transcripts, secrets or state databases**, not even in a private
  report.

**What happens next:**

1. The maintainer aims to acknowledge your report within 7 days.
2. Together, you confirm the problem and agree a fix and a disclosure date.
3. The fix ships with a GitHub security advisory. The advisory credits you, unless you prefer not to
   be named, and a CVE is requested where one is warranted.

## The model: agent output is untrusted input

Everything an agent sends to the engine is treated as untrusted input to typed completion. An agent
can choose among the outcomes its stage declares, and nothing more. As designed for 0.1:

- **Completion tokens are scoped.** Each attempt of each stage run gets its own token, derived with
  HMAC-SHA-256 from a secret only the dispatching host holds and the attempt's idempotency key. Only
  its SHA-256 hash is stored, and a process that only takes completions, such as `sekaisen-mcp`,
  never holds the secret. A retry, a deadline or a cancellation retires a token, and a call with a
  retired token is refused and logged, never applied.
- **The caller is checked.** Where the harness reports who is calling, `stage_complete` and
  `stage_progress` accept a call only from the agent the stage was dispatched to.
- **Outcomes and fields are validated.** An undeclared outcome, a missing field, a wrong type, a
  non-object `fields` or an oversized payload is a precise tool error, and nothing is stored.
- **Agents cannot steer past the engine.** No completion tool can skip a stage, resolve or cancel a
  gate, or write state directly. Gates are resolved only through the host's own surfaces, and every
  resolution records who resolved it.
- **Definitions run no code.** Guards are a small fixed expression language, evaluated by the engine.
  Brief templates substitute values and nothing else. Host behaviour enters only by name, as checks,
  actions and polled facts the host has registered.
- **The core makes no network calls.** It talks to the harness only through the adapter, and to its
  state only through the store.

## What counts as a vulnerability

**In scope:**

- **Completing what you were not given.** A `stage_complete` or `stage_progress` that takes effect
  with a retired token, for another stage run or attempt, or from an agent other than the one
  dispatched, where the harness reports the caller.
- **Escaping the declared outcomes.** An outcome the stage does not declare, or fields that fail
  their schema, reaching the store or moving the run.
- **Steering past a gate.** Any path by which an agent's tool call resolves, cancels or skips a gate
  or a stage, or writes run state directly.
- **Code execution.** A definition, a brief, a guard or an agent's fields that makes code run in the
  engine's process, beyond the host-registered names.
- **Token exposure.** A plaintext completion token written to the store, the transition log or a log
  line outside the brief it was rendered into.
- **Checks that pass a violation.** A definition that `sekaisen check` accepts although a stage marked
  `deploys: true` is reachable without an operator gate.
- **Resource exhaustion** from agent input beyond the documented limits, such as the cap on `fields`.

**Out of scope** (please open a normal issue instead):

- an agent that picks a declared outcome that is wrong: the engine guarantees the shape of a
  completion, not its truth;
- prompt injection inside the harness, or the harness's own security;
- anyone who can already write the definitions, the host's registered code or the state database:
  they are trusted by design;
- a vulnerability in a harness itself: please report it upstream, and tell us too if the way sekaisen
  calls it makes it reachable.

Good-faith research on your own machine, with your own or synthetic pipelines, is welcome.
