import type { Capabilities } from "../adapter/types.js";
import type { LoadedDefinition } from "../format/load.js";
import type { Finding } from "./index.js";

const MIN_TURN_MS = 60_000;
const MIN_REMIND_MS = 60_000;

const secs = (ms: number): string => `${ms / 1000}s`;

/** Turn caps and deadlines against the harness, and gate reminders against their timeout. */
export function timingFindings(
  loaded: LoadedDefinition,
  capabilities?: Pick<Capabilities, "turnCapMs">,
): Finding[] {
  const { def } = loaded;
  const out: Finding[] = [];
  const err = (stage: string, message: string): void => {
    out.push({ check: "timing", severity: "error", stage, message });
  };
  for (const [id, stage] of Object.entries(def.stages)) {
    if (stage.type === "agent") {
      const cap = stage.turns.capMs;
      if (capabilities && cap !== undefined && cap > capabilities.turnCapMs) {
        err(
          id,
          `stage ${id} turn cap ${secs(cap)} is above the harness cap ${secs(capabilities.turnCapMs)}`,
        );
      }
      const deadline = stage.deadline ?? def.defaults?.deadline;
      if (deadline !== undefined && deadline < stage.turns.max * MIN_TURN_MS) {
        err(
          id,
          `stage ${id} deadline ${secs(deadline)} is below ${stage.turns.max} turn(s) of ${secs(MIN_TURN_MS)}`,
        );
      }
    } else if (stage.type === "gate" && "remind" in stage.onTimeout) {
      const remind = stage.onTimeout.remind;
      if (remind !== undefined && remind < MIN_REMIND_MS) {
        err(
          id,
          `stage ${id} reminder ${secs(remind)} is below ${secs(MIN_REMIND_MS)}`,
        );
      } else if (remind !== undefined && remind > stage.timeout) {
        err(
          id,
          `stage ${id} reminder ${secs(remind)} is later than its timeout ${secs(stage.timeout)}`,
        );
      }
    }
  }
  return out;
}
