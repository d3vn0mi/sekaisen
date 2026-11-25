// A gateway plugin that hosts a sekaisen pipeline. In your own project, import
// from "sekaisen" and "sekaisen/openclaw" instead of the relative paths.
import { readFileSync } from "node:fs";
import path from "node:path";
import { createRegistry, loadDefinitionSync } from "../../../src/index.js";
import {
  createPipelinePlugin,
  type PluginApi,
} from "../../../src/openclaw/index.js";

const dir = import.meta.dirname;
// OpenClaw loads this module synchronously: no top-level await here.
const pipeline = loadDefinitionSync(path.join(dir, "pipeline.yaml"));

export default {
  id: "demo-pipeline",
  register(api: PluginApi) {
    const plugin = createPipelinePlugin({
      api,
      adapter: { api, agents: ["drafter", "checker"] },
      storePath: path.join(dir, "demo-pipeline.sqlite"),
      // At least 32 bytes, kept in a file only the gateway's user can read.
      tokenSecret: readFileSync(path.join(dir, "token-secret")),
      definitions: {
        current: (id) => (id === pipeline.def.id ? pipeline : undefined),
      },
      registry: createRegistry(),
    });
    plugin.tool(
      "demo_start",
      "Starts the demo pipeline on a topic.",
      {
        type: "object",
        properties: { topic: { type: "string" } },
        required: ["topic"],
      },
      async (params) => {
        const { runId } = await plugin.engine.startRun("demo-notes", params);
        return { text: `started run ${runId}`, isError: false };
      },
    );
  },
};
