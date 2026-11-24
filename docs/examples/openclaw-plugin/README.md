# Example: a pipeline in an OpenClaw plugin

A gateway plugin that hosts a two-stage pipeline: the `drafter` writes a note and the `checker`
checks it. The `demo_start` tool starts a run. The page for the adapter is
[`docs/openclaw.md`](../../openclaw.md).

| File | What it is |
|---|---|
| `openclaw.plugin.json` | The manifest. `contracts.tools` lists every tool the plugin registers |
| `package.json` | Depends on `sekaisen`, with OpenClaw as an optional peer the gateway provides. Run `npm install` here, then build or point OpenClaw at `index.ts` as your host expects |
| `index.ts` | Loads the pipeline, calls `createPipelinePlugin`, registers `demo_start` |
| `pipeline.yaml`, `briefs/` | The pipeline |

`index.ts` imports from the repository's source so it type-checks here. In your own plugin, import
from `sekaisen` and `sekaisen/openclaw`.

## Host steps

1. **Token secret.** Put 32 or more random bytes in a file next to `index.ts` named `token-secret`,
   readable only by the gateway's user: `head -c 48 /dev/urandom > token-secret && chmod 600
   token-secret`. Keep it out of version control.
2. **Load the plugin.** In the OpenClaw config, add the plugin's directory to `plugins.load.paths`, add
   its id (`demo-pipeline`) to `plugins.allow`, and add an entry for it under `plugins.entries`.
   Without `plugins.allow` the gateway loads it disabled.
3. **Create the agents.** The pipeline names two agents, `drafter` and `checker`. They must exist in
   the config.
4. **Grant the tools.** In each of the two agents' `tools.alsoAllow`, add `stage_complete` and
   `stage_progress`. `alsoAllow` replaces what the agent inherited, so re-list everything that agent
   already had. Give `demo_start` to whichever agent will start runs.
5. **Restart the gateway.**
6. **Try it.** Have an agent call `demo_start` with a topic. The store file is
   `demo-pipeline.sqlite`, next to `index.ts`. Pass it as `--store` to read progress:
   `sekaisen runs --store demo-pipeline.sqlite` lists the runs, and
   `sekaisen status <run_id> --store demo-pipeline.sqlite` shows one.

## Author

d3vn0mi
