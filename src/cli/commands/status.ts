import { parseArgs } from "node:util";
import { renderMermaid } from "../../render/mermaid.js";
import { type Coverage, coverage } from "../../simulate/coverage.js";
import type {
  GateRow,
  RunRow,
  StageRunRow,
  Store,
  TransitionRow,
} from "../../store/types.js";
import type { Io } from "../main.js";
import { iso, openReadOnly } from "./readonly.js";

export const STATUS_USAGE =
  "sekaisen status <run_id> --store <path> [--json] [--mermaid]";

const SHOWN_TRANSITIONS = 20;
const HASH_SHORT = 12;

interface Snapshot {
  run: RunRow;
  live: StageRunRow | undefined;
  gate: GateRow | undefined;
  turns: StageRunRow[];
  /** Every transition, oldest first, with the stage each belongs to. */
  rows: Array<{ row: TransitionRow; stage: string | undefined }>;
  edges: Coverage | undefined;
  mermaid: string | undefined;
}

function snapshot(store: Store, runId: string): Snapshot | undefined {
  return store.tx((t) => {
    const run = t.getRun(runId);
    if (!run) return undefined;
    const stageRuns = t.listStageRuns({ runId, limit: 100_000 });
    const stages = new Map(stageRuns.map((s) => [s.stageRunId, s.stage]));
    const all = t.transitions(runId);
    const stageOf = (row: TransitionRow) =>
      row.stageRunId === null ? undefined : stages.get(row.stageRunId);
    const live = t.liveStageRun(runId);
    const gate = live && t.getGate(live.stageRunId);
    const def = t.getDefinition(run.pipelineId, run.defHash)?.parsed;
    const taken = def && coverage(def, all, stageOf);
    return {
      run,
      live,
      gate,
      turns: stageRuns.filter((s) => s.runtime !== null),
      rows: all.map((row) => ({ row, stage: stageOf(row) })),
      edges: taken,
      mermaid:
        def &&
        taken &&
        renderMermaid(def, {
          current: run.currentStage,
          taken: new Set(taken.taken),
        }),
    };
  });
}

/**
 * Text fit for a terminal: tabs and line breaks become spaces and every
 * other C0 or C1 control character is dropped, so a value an agent or a
 * harness supplied can neither move the cursor nor forge a line of output.
 */
export function printable(text: string): string {
  let out = "";
  for (const ch of text) {
    const c = ch.codePointAt(0) ?? 0;
    if (c === 0x09 || c === 0x0a || c === 0x0d) out += " ";
    else if (c >= 0x20 && (c < 0x7f || c > 0x9f)) out += ch;
  }
  return out;
}

function transitionLine(n: number, row: TransitionRow, stage?: string): string {
  const p = printable;
  const outcome = row.outcome === null ? "" : ` [${p(row.outcome)}]`;
  return `${n} ${p(stage ?? "run")}: ${p(row.fromState ?? "-")} → ${p(row.toState)} ${p(row.event)}${outcome} ${p(row.actor)}`;
}

function liveView(s: StageRunRow) {
  return {
    stage: s.stage,
    state: s.state,
    attempt: s.attempt,
    visit: s.visit,
    retry_index: s.retryIndex,
    wait_reason: s.waitReason,
    deadline_at: s.deadlineAt === null ? null : iso(s.deadlineAt),
  };
}

function gateView(g: GateRow) {
  return {
    prompt: g.prompt,
    outcomes: g.outcomes,
    remind_at: g.remindAt === null ? null : iso(g.remindAt),
  };
}

function jsonView(s: Snapshot, shown: Snapshot["rows"]): unknown {
  const first = s.rows.length - shown.length;
  return {
    run_id: s.run.runId,
    pipeline: s.run.pipelineId,
    def_hash: s.run.defHash,
    status: s.run.status,
    current_stage: s.run.currentStage,
    created_at: iso(s.run.createdAt),
    updated_at: iso(s.run.updatedAt),
    live: s.live ? liveView(s.live) : null,
    gate: s.gate ? gateView(s.gate) : null,
    providers: s.turns.map((u) => ({
      stage: u.stage,
      attempt: u.attempt,
      provider: u.runtime?.provider ?? null,
      model: u.runtime?.model ?? null,
    })),
    transitions: shown.map(({ row, stage }, i) => ({
      seq: first + i + 1,
      stage: stage ?? null,
      from: row.fromState,
      to: row.toState,
      event: row.event,
      outcome: row.outcome,
      actor: row.actor,
      at: iso(row.at),
    })),
    edges: s.edges ?? null,
  };
}

/** The human view. Every value from the store goes through `printable`. */
function textView(s: Snapshot, shown: Snapshot["rows"]): string {
  const { run } = s;
  const p = printable;
  const out: string[] = [
    `run: ${p(run.runId)}`,
    `pipeline: ${p(run.pipelineId)} (${p(run.defHash.slice(0, HASH_SHORT))})`,
    `status: ${p(run.status)}`,
    `stage: ${p(run.currentStage)}`,
    `created: ${iso(run.createdAt)}`,
    `updated: ${iso(run.updatedAt)}`,
  ];
  if (s.live) {
    const l = s.live;
    out.push(
      "",
      `live: ${p(l.stage)} ${p(l.state)} attempt ${l.attempt} visit ${l.visit} retry ${l.retryIndex}`,
      `  wait_reason: ${p(l.waitReason ?? "-")}`,
      `  deadline: ${l.deadlineAt === null ? "-" : iso(l.deadlineAt)}`,
    );
  }
  if (s.gate) {
    out.push(
      "",
      `gate: ${p(s.gate.prompt ?? "-")}`,
      `  outcomes: ${p((s.gate.outcomes ?? []).join(", ")) || "-"}`,
      `  remind_at: ${s.gate.remindAt === null ? "-" : iso(s.gate.remindAt)}`,
    );
  }
  if (s.turns.length > 0) {
    out.push("", "providers (per stage run):");
    for (const u of s.turns) {
      const r = u.runtime;
      out.push(
        `  ${p(u.stage)} attempt ${u.attempt}: ${p(r?.provider ?? "-")}${r?.model ? ` ${p(r.model)}` : ""}`,
      );
    }
  }
  const first = s.rows.length - shown.length;
  out.push("", `transitions (last ${shown.length} of ${s.rows.length}):`);
  shown.forEach(({ row, stage }, i) => {
    out.push(`  ${transitionLine(first + i + 1, row, stage)}`);
  });
  if (s.edges) {
    out.push(
      "",
      `edges: ${s.edges.taken.length}/${s.edges.taken.length + s.edges.untaken.length}`,
    );
  }
  return `${out.join("\n")}\n`;
}

/** Shows one run from a store, read-only: header, live stage, gate, providers, log. */
export async function statusCommand(args: string[], io: Io): Promise<number> {
  let values: {
    store?: string;
    json?: boolean;
    mermaid?: boolean;
    help?: boolean;
  };
  let positionals: string[];
  try {
    ({ values, positionals } = parseArgs({
      args,
      options: {
        store: { type: "string" },
        json: { type: "boolean" },
        mermaid: { type: "boolean" },
        help: { type: "boolean" },
      },
      allowPositionals: true,
    }));
  } catch (x) {
    io.err(`${(x as Error).message}\nusage: ${STATUS_USAGE}\n`);
    return 2;
  }
  if (values.help) {
    io.out(`usage: ${STATUS_USAGE}\n`);
    return 0;
  }
  const [runId, ...extra] = positionals;
  if (values.store === undefined || runId === undefined || extra.length > 0) {
    io.err(`usage: ${STATUS_USAGE}\n`);
    return 2;
  }
  const opened = openReadOnly(values.store);
  if ("error" in opened) {
    io.err(opened.error);
    return 1;
  }
  try {
    const snap = snapshot(opened.store, runId);
    if (!snap) {
      io.err(`run ${runId} not found\n`);
      return 1;
    }
    const shown = snap.rows.slice(-SHOWN_TRANSITIONS);
    if (values.mermaid && snap.mermaid === undefined) {
      io.err(
        `${values.store}: error store the definition ${snap.run.defHash} of run ${runId} is not in the store\n`,
      );
      return 1;
    }
    if (values.json) {
      const view = jsonView(snap, shown) as Record<string, unknown>;
      if (values.mermaid) view.mermaid = snap.mermaid;
      io.out(`${JSON.stringify(view, null, 2)}\n`);
    } else if (values.mermaid) {
      io.out(snap.mermaid as string);
    } else {
      io.out(textView(snap, shown));
    }
    return 0;
  } finally {
    opened.store.close();
  }
}
