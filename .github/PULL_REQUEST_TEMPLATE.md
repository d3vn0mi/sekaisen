<!--
Thank you for contributing. Please read CONTRIBUTING.md first.
A security problem goes to SECURITY.md, never to a pull request.
A change to the pipeline format needs an accepted format change proposal first.
The title must be a Conventional Commit, such as "fix(engine): ...": it becomes the squash commit.
-->

## What and why

<!-- What does this change, and why? Link the issue or proposal, for example "Closes #<number>". -->

## How it was tested

<!-- The tests and conformance cases you added or changed. If an expected transition log changed, say how, and why. -->

## Checklist

- [ ] The title is a Conventional Commit, such as `feat(checks): ...` or `fix(engine): ...`
- [ ] Tests come with the change, and they pass locally
- [ ] If the format or an expected transition log changed, it follows an accepted format change proposal, and the schema, the checks, the conformance cases and `docs/` change with it
- [ ] Examples use neutral roles and `demo.` host names: no private prompts, transcripts, host names or state databases
- [ ] Docs are updated, if a field, a command, a flag or a behaviour changed
- [ ] No new runtime dependency, or the reason is given above
- [ ] The core still imports nothing from any harness, and makes no network calls
