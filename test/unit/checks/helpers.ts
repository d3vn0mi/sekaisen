import path from "node:path";
import type { Finding } from "../../../src/checks/index.js";
import { runChecks } from "../../../src/checks/index.js";
import type { LoadedDefinition } from "../../../src/format/load.js";
import type { Definition, Stage } from "../../../src/format/types.js";
import {
  createRegistry,
  type HostRegistry,
} from "../../../src/host/registry.js";

export const FIXTURE = path.resolve("test/fixtures/defs/review-loop");

export function agent(
  outcomes: Record<string, { next: unknown }>,
  brief = "briefs/a.md",
): Stage {
  return {
    type: "agent",
    agent: "drafter",
    session: "run",
    brief,
    turns: { max: 1 },
    retry: { max: 0, on: [] },
    outcomes,
  } as Stage;
}

export const end = (status: "completed" | "failed" = "completed"): Stage => ({
  type: "end",
  status,
});

export function loaded(
  stages: Record<string, Stage>,
  opts: {
    start?: string;
    briefs?: Record<string, string>;
    problems?: string[];
    onCancel?: string;
  } = {},
): LoadedDefinition {
  const def: Definition = {
    format: 1,
    id: "t",
    version: 1,
    providers: "fleet",
    start: opts.start ?? Object.keys(stages)[0] ?? "",
    stages,
    extensions: {},
  };
  if (opts.onCancel) def.onCancel = opts.onCancel;
  const briefs: Record<string, string> = { "briefs/a.md": "", ...opts.briefs };
  return {
    file: "/x/pipeline.yaml",
    dir: "/x",
    def,
    hash: "h",
    briefs,
    problems: opts.problems ?? [],
  };
}

export function run(
  l: LoadedDefinition,
  registry: HostRegistry = createRegistry(),
): Promise<Finding[]> {
  return runChecks(l, { registry });
}
