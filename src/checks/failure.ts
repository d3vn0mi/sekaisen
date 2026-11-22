import type { LoadedDefinition } from "../format/load.js";
import { failedEnd } from "../format/rules.js";
import type { RetryEnding, Stage } from "../format/types.js";
import type { Finding } from "./index.js";

/**
 * True for a stage whose attempt can end without one of its outcomes: an
 * agent (an engine-classified ending), a check (a throw or an undeclared
 * outcome), an action (a throw), and a wait until a rendered instant (one
 * that does not parse). Once its retries are used up it takes
 * `onExhausted`, else the definition's first `failed` end.
 */
export function canFail(stage: Stage): boolean {
  switch (stage.type) {
    case "agent":
    case "check":
    case "action":
      return true;
    case "wait":
      return stage.until !== undefined;
    default:
      return false;
  }
}

/** The engine-classified endings an attempt of each retrying stage type can have. */
const ENDINGS: Record<"agent" | "action", readonly RetryEnding[]> = {
  agent: ["no_result", "lost", "timeout", "turn_error"],
  action: ["turn_error", "timeout"],
};

/**
 * A stage that can fail needs somewhere to go: its `onExhausted`, or a
 * `failed` end. A retry that names no ending to retry, or only endings its
 * stage type never has (an action inheriting an agent's `[no_result, lost]`
 * from `defaults`), never applies.
 */
export function failureFindings(loaded: LoadedDefinition): Finding[] {
  const { def } = loaded;
  const out: Finding[] = [];
  const hasFailedEnd = failedEnd(def) !== undefined;
  for (const [id, stage] of Object.entries(def.stages)) {
    if (
      (stage.type === "agent" || stage.type === "action") &&
      stage.retry.max > 0 &&
      stage.retry.on.length === 0
    ) {
      out.push({
        check: "failure",
        severity: "warning",
        stage: id,
        message: `stage ${id}: retry.max > 0 but retry.on is empty`,
      });
    }
    if (
      (stage.type === "agent" || stage.type === "action") &&
      stage.retry.max > 0 &&
      stage.retry.on.length > 0 &&
      !stage.retry.on.some((e) => ENDINGS[stage.type].includes(e))
    ) {
      out.push({
        check: "failure",
        severity: "warning",
        stage: id,
        message: `stage ${id}: retry.on lists only ${stage.retry.on.join(", ")}, which an ${stage.type} stage never ends with; an ${stage.type} ends ${ENDINGS[stage.type].join(" or ")}`,
      });
    }
    const target =
      stage.type === "agent" || stage.type === "action"
        ? stage.onExhausted
        : undefined;
    if (canFail(stage) && target === undefined && !hasFailedEnd) {
      out.push({
        check: "failure",
        severity: "error",
        stage: id,
        message: `stage ${id} can fail but the pipeline has no failed end`,
      });
    }
  }
  return out;
}
