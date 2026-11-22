import type { Definition } from "../format/types.js";
import type { GuardAst } from "../guard/parse.js";
import type { RunRow, StoreTx } from "../store/types.js";

/** A definition version a run is pinned to, with its parsed guards. */
export interface Pinned {
  def: Definition;
  briefs: Record<string, string>;
  guards: Map<string, GuardAst | Error>;
}

/** Definition versions by pipeline and hash, read from the store once. */
export class PinnedDefinitions {
  private readonly cache = new Map<string, Pinned>();

  /** The definition version `run` is pinned to. */
  of(t: StoreTx, run: RunRow): Pinned {
    const key = `${run.pipelineId}\0${run.defHash}`;
    let p = this.cache.get(key);
    if (!p) {
      const row = t.getDefinition(run.pipelineId, run.defHash);
      if (!row) {
        throw new Error(
          `definition ${run.pipelineId}@${run.defHash} of run ${run.runId} is missing from the store`,
        );
      }
      p = { def: row.parsed, briefs: row.briefs, guards: new Map() };
      this.cache.set(key, p);
    }
    return p;
  }
}
