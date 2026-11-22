import { parseArgs } from "node:util";
import type { RunStatus } from "../../store/types.js";
import type { Io } from "../main.js";
import { iso, openReadOnly } from "./readonly.js";

export const RUNS_USAGE =
  "sekaisen runs --store <path> [--status <s>[,<s>…]]… [--limit N] [--json]";

const DEFAULT_LIMIT = 20;
const STATUSES: RunStatus[] = [
  "working",
  "input_required",
  "completed",
  "failed",
  "canceled",
];

/** Lists runs in a store, most recently updated first; never writes. */
export async function runsCommand(args: string[], io: Io): Promise<number> {
  let values: {
    store?: string;
    status?: string[];
    limit?: string;
    json?: boolean;
    help?: boolean;
  };
  let positionals: string[];
  try {
    ({ values, positionals } = parseArgs({
      args,
      options: {
        store: { type: "string" },
        status: { type: "string", multiple: true },
        limit: { type: "string" },
        json: { type: "boolean" },
        help: { type: "boolean" },
      },
      allowPositionals: true,
    }));
  } catch (x) {
    io.err(`${(x as Error).message}\nusage: ${RUNS_USAGE}\n`);
    return 2;
  }
  if (values.help) {
    io.out(`usage: ${RUNS_USAGE}\n`);
    return 0;
  }
  if (values.store === undefined || positionals.length > 0) {
    io.err(`usage: ${RUNS_USAGE}\n`);
    return 2;
  }
  const status: RunStatus[] = [];
  for (const word of (values.status ?? []).flatMap((s) => s.split(","))) {
    if (!STATUSES.includes(word as RunStatus)) {
      io.err(
        `unknown status ${JSON.stringify(word)}; one of ${STATUSES.join(", ")}\nusage: ${RUNS_USAGE}\n`,
      );
      return 2;
    }
    status.push(word as RunStatus);
  }
  let limit = DEFAULT_LIMIT;
  if (values.limit !== undefined) {
    limit = /^\d+$/.test(values.limit) ? Number(values.limit) : 0;
    if (!Number.isSafeInteger(limit) || limit < 1) {
      io.err(`--limit must be a positive integer\nusage: ${RUNS_USAGE}\n`);
      return 2;
    }
  }
  const opened = openReadOnly(values.store);
  if ("error" in opened) {
    io.err(opened.error);
    return 1;
  }
  try {
    const rows = opened.store.tx((t) =>
      t.listRuns({
        order: "recent",
        limit,
        ...(status.length > 0 ? { status } : {}),
      }),
    );
    const view = rows.map((r) => ({
      run_id: r.runId,
      pipeline: r.pipelineId,
      status: r.status,
      current_stage: r.currentStage,
      updated_at: iso(r.updatedAt),
    }));
    if (values.json) {
      io.out(`${JSON.stringify(view, null, 2)}\n`);
    } else {
      for (const v of view) {
        io.out(
          `${v.run_id} ${v.pipeline} ${v.status} ${v.current_stage} ${v.updated_at}\n`,
        );
      }
    }
    return 0;
  } finally {
    opened.store.close();
  }
}
