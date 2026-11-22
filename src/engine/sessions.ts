import type { AgentStage } from "../format/types.js";
import type { RunRow } from "../store/types.js";
import { descend } from "./values.js";

/**
 * The session key an agent stage's turns run under: `run:<runId>:<agent>`
 * for `session: run`, `project:<project>:<agent>` for `session: project`
 * (the run's `project` input, else the run id).
 */
export function sessionKeyOf(run: RunRow, stage: AgentStage): string {
  if (stage.session === "project") {
    const project = descend(run.inputs, "project");
    const scope =
      typeof project === "string" || typeof project === "number"
        ? String(project)
        : run.runId;
    return `project:${scope}:${stage.agent}`;
  }
  return `run:${run.runId}:${stage.agent}`;
}
