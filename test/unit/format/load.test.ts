import {
  cp,
  mkdir,
  mkdtemp,
  rename,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, test } from "vitest";
import {
  loadDefinition,
  loadDefinitionSync,
} from "../../../src/format/load.js";
import { parseDuration } from "../../../src/format/types.js";

const FIXTURE = path.resolve("test/fixtures/defs/review-loop");

let work: string;
beforeEach(async () => {
  work = await mkdtemp(path.join(tmpdir(), "sekaisen-load-"));
  await cp(FIXTURE, work, { recursive: true });
});
afterEach(async () => {
  await rm(work, { recursive: true, force: true });
});

async function rewrite(edit: (yaml: string) => string): Promise<string> {
  const file = path.join(work, "pipeline.yaml");
  const { readFile } = await import("node:fs/promises");
  await writeFile(file, edit(await readFile(file, "utf8")));
  return file;
}

describe("parseDuration", () => {
  test("parses seconds, minutes, hours and days", () => {
    expect(parseDuration("90s")).toBe(90_000);
    expect(parseDuration("30m")).toBe(1_800_000);
    expect(parseDuration("24h")).toBe(86_400_000);
    expect(parseDuration("2d")).toBe(172_800_000);
  });

  test("anything else throws", () => {
    for (const bad of ["", "30", "m", "1.5h", "-1m", "30 m", "1w", "30M"]) {
      expect(() => parseDuration(bad)).toThrow();
    }
  });
});

describe("loadDefinition", () => {
  test("loads review-loop", async () => {
    const loaded = await loadDefinition(path.join(FIXTURE, "pipeline.yaml"));
    expect(loaded.problems).toEqual([]);
    const { def } = loaded;
    expect(Object.keys(def.stages)).toEqual([
      "draft",
      "check",
      "publish",
      "done",
      "failed",
    ]);
    const draft = def.stages.draft;
    if (draft?.type !== "agent") throw new Error("draft must be an agent");
    expect(draft.deadline).toBe(1_800_000);
    expect(draft.turns).toEqual({ max: 1 });
    expect(draft.session).toBe("run");
    expect(draft.retry).toEqual({ max: 1, on: ["no_result", "lost"] });
    expect(draft.outcomes.drafted?.fields).toEqual({
      type: "object",
      properties: { pr_url: { type: "string" }, summary: { type: "string" } },
      required: ["pr_url"],
      additionalProperties: false,
    });
    const check = def.stages.check;
    if (check?.type !== "agent") throw new Error("check must be an agent");
    expect(check.deadline).toBe(900_000);
    expect(check.turns).toEqual({ max: 2, capMs: 600_000 });
    expect(check.outcomes.fail?.next).toEqual([
      { if: "count(check.fail) < 3", to: "draft" },
      { to: "failed" },
    ]);
    expect(check.outcomes.pass).toEqual({ next: "publish" });
    const publish = def.stages.publish;
    if (publish?.type !== "gate") throw new Error("publish must be a gate");
    expect(publish.timeout).toBe(86_400_000);
    expect(publish.onTimeout).toEqual({ remind: 86_400_000 });
    expect(def.providers).toBe("fleet");
    expect(def.defaults?.deadline).toBe(1_800_000);
    expect(Object.keys(loaded.briefs)).toEqual([
      "briefs/check.md",
      "briefs/draft.md",
    ]);
    expect(loaded.dir).toBe(FIXTURE);
  });

  test("hash is stable across loads", async () => {
    const file = path.join(FIXTURE, "pipeline.yaml");
    const a = await loadDefinition(file);
    const b = await loadDefinition(file);
    expect(a.hash).toMatch(/^[0-9a-f]{64}$/);
    expect(a.hash).toBe(b.hash);
  });

  test("hash changes when a brief changes", async () => {
    const file = path.join(work, "pipeline.yaml");
    const before = await loadDefinition(file);
    await writeFile(path.join(work, "briefs/draft.md"), "A different brief.\n");
    const after = await loadDefinition(file);
    expect(after.hash).not.toBe(before.hash);
  });

  test("hash changes when the definition changes", async () => {
    const file = path.join(work, "pipeline.yaml");
    const before = await loadDefinition(file);
    await rewrite((y) => y.replace("version: 1", "version: 2"));
    expect((await loadDefinition(file)).hash).not.toBe(before.hash);
  });

  test("reserved stage types are rejected", async () => {
    const file = await rewrite((y) =>
      y.replace(
        "  done: { type: end, status: completed }",
        "  sub: { type: subpipeline }\n  par: { type: parallel }\n  done: { type: end, status: completed }",
      ),
    );
    const { problems } = await loadDefinition(file);
    expect(problems).toContain(
      "stage sub: type subpipeline is reserved for a later format",
    );
    expect(problems).toContain(
      "stage par: type parallel is reserved for a later format",
    );
  });

  test("reserved stage ids are rejected", async () => {
    for (const id of ["run", "stage", "inputs"]) {
      const file = await rewrite((y) =>
        y.replace(
          "  done: { type: end, status: completed }",
          `  ${id}: { type: end, status: failed }\n  done: { type: end, status: completed }`,
        ),
      );
      expect((await loadDefinition(file)).problems).toContain(
        `stage id ${id} is reserved`,
      );
    }
  });

  test("reserved outcome names are rejected", async () => {
    const file = await rewrite((y) =>
      y.replace(
        "      drafted:\n",
        "      on_exhausted: { next: failed }\n      drafted:\n",
      ),
    );
    expect((await loadDefinition(file)).problems).toContain(
      "stage draft: outcome name on_exhausted is reserved",
    );
  });

  test("a gate cannot have both who and poll", async () => {
    const file = await rewrite((y) =>
      y.replace(
        "    who: operator\n",
        "    who: operator\n    poll: { fact: demo.ready, every: 5m }\n",
      ),
    );
    expect((await loadDefinition(file)).problems).toContain(
      "stage publish: a gate has either who: operator or poll, not both",
    );
  });

  test("a gate needs who or poll", async () => {
    const file = await rewrite((y) => y.replace("    who: operator\n", ""));
    expect((await loadDefinition(file)).problems).toContain(
      "stage publish: a gate needs who: operator or poll",
    );
  });

  test("a wait has either for or until: neither is a problem", async () => {
    const file = await rewrite((y) =>
      y.replace(
        "  done: { type: end",
        "  pause: { type: wait, next: done }\n  done: { type: end",
      ),
    );
    expect((await loadDefinition(file)).problems).toContain(
      "stage pause: a wait has either for or until",
    );
  });

  test("a wait has either for or until: both is a problem", async () => {
    const file = await rewrite((y) =>
      y.replace(
        "  done: { type: end",
        '  pause: { type: wait, for: 1h, until: "2026-03-01T09:00:00Z", next: done }\n  done: { type: end',
      ),
    );
    expect((await loadDefinition(file)).problems).toContain(
      "stage pause: a wait has either for or until",
    );
  });

  test("a wait with one of for or until loads", async () => {
    const file = await rewrite((y) =>
      y.replace(
        "  done: { type: end",
        "  pause: { type: wait, for: 1h, next: done }\n  done: { type: end",
      ),
    );
    expect((await loadDefinition(file)).problems).toEqual([]);
  });

  test("an allow list of providers names at least one", async () => {
    const empty = await rewrite((y) =>
      y.replace("start: draft", "providers: { allow: [] }\nstart: draft"),
    );
    expect((await loadDefinition(empty)).problems).toEqual([
      expect.stringMatching(/providers/),
    ]);
    const one = await rewrite((y) =>
      y.replace("providers: { allow: [] }", "providers: { allow: [demo] }"),
    );
    expect((await loadDefinition(one)).problems).toEqual([]);
  });

  test("a poll gate declares exactly one outcome", async () => {
    const file = await rewrite((y) =>
      y.replace(
        "    who: operator\n",
        "    poll: { fact: demo.ready, every: 5m }\n",
      ),
    );
    expect((await loadDefinition(file)).problems).toContain(
      "stage publish: a poll gate declares exactly one outcome",
    );
  });

  test("a missing brief is a problem", async () => {
    await rm(path.join(work, "briefs/check.md"));
    const loaded = await loadDefinition(path.join(work, "pipeline.yaml"));
    expect(loaded.problems).toEqual(["brief briefs/check.md: cannot be read"]);
    expect(Object.keys(loaded.briefs)).toEqual(["briefs/draft.md"]);
  });

  test("a brief outside the pipeline folder is a problem", async () => {
    const file = await rewrite((y) =>
      y.replace("briefs/draft.md", "../outside.md"),
    );
    const { problems } = await loadDefinition(file);
    expect(problems).toEqual([
      "brief ../outside.md: must be inside the pipeline's folder",
    ]);
  });

  test("a brief that is a symlink to a file outside the folder is a problem", async () => {
    const outside = await mkdtemp(path.join(tmpdir(), "sekaisen-outside-"));
    try {
      await writeFile(path.join(outside, "secret.md"), "not a brief\n");
      await rm(path.join(work, "briefs/draft.md"));
      await symlink(
        path.join(outside, "secret.md"),
        path.join(work, "briefs/draft.md"),
      );
      const loaded = await loadDefinition(path.join(work, "pipeline.yaml"));
      expect(loaded.problems).toEqual([
        "brief briefs/draft.md: resolves outside the pipeline's folder",
      ]);
      expect(Object.keys(loaded.briefs)).toEqual(["briefs/check.md"]);

      // A symlinked directory on the way out is caught the same way.
      await rm(path.join(work, "briefs"), { recursive: true });
      await mkdir(path.join(outside, "briefs"));
      await writeFile(path.join(outside, "briefs/draft.md"), "x\n");
      await writeFile(path.join(outside, "briefs/check.md"), "x\n");
      await symlink(path.join(outside, "briefs"), path.join(work, "briefs"));
      const viaDir = await loadDefinition(path.join(work, "pipeline.yaml"));
      expect(viaDir.problems).toEqual([
        "brief briefs/check.md: resolves outside the pipeline's folder",
        "brief briefs/draft.md: resolves outside the pipeline's folder",
      ]);
    } finally {
      await rm(outside, { recursive: true, force: true });
    }
  });

  test("a symlink that stays inside the folder, or a folder reached through one, loads", async () => {
    await mkdir(path.join(work, "shared"));
    await rename(
      path.join(work, "briefs/draft.md"),
      path.join(work, "shared/draft.md"),
    );
    await symlink("../shared/draft.md", path.join(work, "briefs/draft.md"));
    const loaded = await loadDefinition(path.join(work, "pipeline.yaml"));
    expect(loaded.problems).toEqual([]);
    expect(Object.keys(loaded.briefs)).toEqual([
      "briefs/check.md",
      "briefs/draft.md",
    ]);
    const link = `${work}-link`;
    await symlink(work, link);
    try {
      const via = await loadDefinition(path.join(link, "pipeline.yaml"));
      expect(via.problems).toEqual([]);
      expect(via.briefs).toEqual(loaded.briefs);
    } finally {
      await rm(link, { force: true });
    }
  });

  test("ids and names follow the identifier rule", async () => {
    const yaml = (await import("node:fs/promises")).readFile;
    const original = await yaml(path.join(work, "pipeline.yaml"), "utf8");
    const pattern = "^[a-z][a-z0-9_-]{0,63}$";
    const cases: Array<[(y: string) => string, string]> = [
      [(y) => y.replace("id: review-loop", "id: Review-Loop"), "/id"],
      [
        (y) => y.replace("agent: drafter", "agent: Drafter"),
        "/stages/draft/agent",
      ],
      [
        (y) => y.replace("  drafted:", "  Drafted:"),
        "/stages/draft/outcomes/Drafted",
      ],
      [
        (y) =>
          y.replace(
            "stages:\n",
            "stages:\n  9lives: { type: end, status: completed }\n",
          ),
        "/stages/9lives",
      ],
      [(y) => y.replace("id: review-loop", `id: ${"a".repeat(65)}`), "/id"],
    ];
    for (const [edit, where] of cases) {
      const file = await rewrite(() => edit(original));
      const { problems } = await loadDefinition(file);
      expect(problems).toContainEqual(
        expect.stringMatching(
          new RegExp(
            `^${where.replaceAll("/", "\\/")}: (property name )?must match pattern \\^`,
          ),
        ),
      );
      expect(problems.join("\n")).toContain(pattern);
    }
    const ok = await rewrite(() =>
      original.replace("id: review-loop", `id: r_2-${"x".repeat(60)}`),
    );
    expect((await loadDefinition(ok)).problems).toEqual([]);
  });

  test("schema violations become problems with pointers", async () => {
    const file = await rewrite((y) =>
      y.replace("timeout: 24h", "timeout: tomorrow"),
    );
    const { problems } = await loadDefinition(file);
    expect(problems.some((p) => p.startsWith("/stages/publish/timeout"))).toBe(
      true,
    );
  });

  test("invalid YAML becomes a problem", async () => {
    const file = await rewrite(() => "a: [1, 2\n");
    const { problems, def } = await loadDefinition(file);
    expect(problems[0]).toMatch(/^yaml: /);
    expect(def.stages).toEqual({});
  });

  test("a malformed inputs schema becomes a problem, not a throw", async () => {
    const file = await rewrite((y) =>
      y.replace("    topic: { type: string }", "    topic: { type: blob }"),
    );
    const { problems } = await loadDefinition(file);
    expect(problems.some((p) => p.startsWith("/inputs: "))).toBe(true);
  });

  test("a malformed outcome fields schema becomes a problem", async () => {
    const file = await rewrite((y) =>
      y.replace("fields: { reason: string }", "fields: { reason: widget }"),
    );
    const { problems } = await loadDefinition(file);
    expect(
      problems.some((p) => p.startsWith("/stages/draft/outcomes/blocked")),
    ).toBe(true);
  });

  test("x- keys are collected into extensions", async () => {
    const file = await rewrite((y) => `${y}x-owner: demo\nx-meta: { a: 1 }\n`);
    const loaded = await loadDefinition(file);
    expect(loaded.problems).toEqual([]);
    expect(loaded.def.extensions).toEqual({
      "x-owner": "demo",
      "x-meta": { a: 1 },
    });
  });

  test("defaults: stage retry, then defaults, then the agent default", async () => {
    const noDefaults = await rewrite((y) =>
      y.replace("  retry: { max: 1, on: [no_result, lost] }\n", ""),
    );
    const loaded = await loadDefinition(noDefaults);
    const draft = loaded.def.stages.draft;
    if (draft?.type !== "agent") throw new Error("draft must be an agent");
    expect(draft.retry).toEqual({ max: 1, on: ["lost"] });
  });

  test("a retry without on retries the stage type's usual failures", async () => {
    const file = await rewrite((y) =>
      y
        .replace("  retry: { max: 1, on: [no_result, lost] }\n", "")
        .replace(
          "    session: run\n    brief: briefs/draft.md\n",
          "    session: run\n    brief: briefs/draft.md\n    retry: { max: 2 }\n",
        )
        .replace(
          "  done: { type: end, status: completed }",
          "  notify: { type: action, action: demo.notify, next: done, retry: { max: 2 } }\n  done: { type: end, status: completed }",
        ),
    );
    const { def, problems } = await loadDefinition(file);
    expect(problems).toEqual([]);
    const retry = (id: string) =>
      (def.stages[id] as { retry?: unknown } | undefined)?.retry;
    expect(retry("draft")).toEqual({ max: 2, on: ["lost"] });
    expect(retry("notify")).toEqual({
      max: 2,
      on: ["turn_error", "timeout"],
    });
  });

  test("a default retry without on is filled in per stage type", async () => {
    const file = await rewrite((y) =>
      y
        .replace(
          "  retry: { max: 1, on: [no_result, lost] }\n",
          "  retry: { max: 3 }\n",
        )
        .replace(
          "  done: { type: end, status: completed }",
          "  notify: { type: action, action: demo.notify, next: done }\n  done: { type: end, status: completed }",
        ),
    );
    const { def, problems } = await loadDefinition(file);
    expect(problems).toEqual([]);
    const retry = (id: string) =>
      (def.stages[id] as { retry?: unknown } | undefined)?.retry;
    expect(retry("draft")).toEqual({ max: 3, on: ["lost"] });
    expect(retry("notify")).toEqual({
      max: 3,
      on: ["turn_error", "timeout"],
    });
    expect(def.defaults?.retry).toEqual({ max: 3 });
  });

  test("snake_case keys become camelCase", async () => {
    const file = await rewrite((y) =>
      y
        .replace(
          "    on_timeout: { remind: 24h }",
          "    on_timeout: { next: failed }",
        )
        .replace("start: draft", "start: draft\non_cancel: failed"),
    );
    const { def, problems } = await loadDefinition(file);
    expect(problems).toEqual([]);
    expect(def.onCancel).toBe("failed");
    const publish = def.stages.publish;
    if (publish?.type !== "gate") throw new Error("publish must be a gate");
    expect(publish.onTimeout).toEqual({ next: "failed" });
  });

  test("action and wait stages get a non-agent retry default", async () => {
    const file = await rewrite((y) =>
      y
        .replace("  retry: { max: 1, on: [no_result, lost] }\n", "")
        .replace(
          "  done: { type: end, status: completed }",
          "  notify: { type: action, action: demo.notify, next: done }\n  pause: { type: wait, for: 90s, next: done }\n  done: { type: end, status: completed }",
        ),
    );
    const { def, problems } = await loadDefinition(file);
    expect(problems).toEqual([]);
    expect(def.stages.notify).toEqual({
      type: "action",
      action: "demo.notify",
      next: "done",
      retry: { max: 0, on: [] },
    });
    expect(def.stages.pause).toEqual({
      type: "wait",
      for: 90_000,
      next: "done",
    });
  });

  test("a full fields schema with properties and required is kept as is", async () => {
    const file = await rewrite((y) =>
      y.replace(
        "fields: { reason: string }",
        "fields: { type: object, properties: { reason: { type: string } }, required: [reason] }",
      ),
    );
    const { def, problems } = await loadDefinition(file);
    expect(problems).toEqual([]);
    const draft = def.stages.draft;
    if (draft?.type !== "agent") throw new Error("draft must be an agent");
    expect(draft.outcomes.blocked?.fields).toEqual({
      type: "object",
      properties: { reason: { type: "string" } },
      required: ["reason"],
    });
  });

  test("a shorthand field named type stays shorthand", async () => {
    const file = await rewrite((y) =>
      y.replace("fields: { reason: string }", "fields: { type: object }"),
    );
    const { def, problems } = await loadDefinition(file);
    expect(problems).toEqual([]);
    const draft = def.stages.draft;
    if (draft?.type !== "agent") throw new Error("draft must be an agent");
    expect(draft.outcomes.blocked?.fields).toEqual({
      type: "object",
      properties: { type: { type: "object" } },
      required: ["type"],
      additionalProperties: false,
    });
  });

  test("a full fields schema that is not an object schema is a problem", async () => {
    for (const bad of [
      '{ type: [string, "null"] }',
      "{ properties: { a: { type: string } } }",
      "{ oneOf: [{ type: object }] }",
    ]) {
      const file = await rewrite((y) =>
        y.replace("fields: { reason: string }", `fields: ${bad}`),
      );
      const { problems } = await loadDefinition(file);
      expect(problems).toContain(
        "outcome blocked: fields schema must be an object schema",
      );
    }
  });

  test("retry policies are not shared between stages or with defaults", async () => {
    const { def } = await loadDefinition(path.join(FIXTURE, "pipeline.yaml"));
    const draft = def.stages.draft;
    const check = def.stages.check;
    if (draft?.type !== "agent" || check?.type !== "agent") throw new Error();
    expect(draft.retry).not.toBe(def.defaults?.retry);
    expect(draft.retry.on).not.toBe(def.defaults?.retry?.on);
    expect(draft.retry.on).not.toBe(check.retry.on);
    draft.retry.on.push("timeout");
    expect(check.retry.on).toEqual(["no_result", "lost"]);
    expect(def.defaults?.retry?.on).toEqual(["no_result", "lost"]);
  });

  test("without a deadline anywhere the stage has none", async () => {
    const file = await rewrite((y) => y.replace("  deadline: 30m\n", ""));
    const { def } = await loadDefinition(file);
    const draft = def.stages.draft;
    if (draft?.type !== "agent") throw new Error("draft must be an agent");
    expect("deadline" in draft).toBe(false);
  });

  test("an empty on_timeout means remind after the timeout", async () => {
    const file = await rewrite((y) =>
      y.replace("on_timeout: { remind: 24h }", "on_timeout: {}"),
    );
    const { def, problems } = await loadDefinition(file);
    expect(problems).toEqual([]);
    const publish = def.stages.publish;
    if (publish?.type !== "gate") throw new Error("publish must be a gate");
    expect(publish.onTimeout).toEqual({ remind: 86_400_000 });
  });

  test("providers allow list, poll gate and wait until", async () => {
    const file = await rewrite((y) =>
      y
        .replace(
          "start: draft",
          "providers: { allow: [demo.a, demo.b] }\nstart: draft",
        )
        .replace(
          "    who: operator\n",
          "    poll: { fact: demo.ready, every: 5m }\n",
        )
        .replace("      reject: { next: failed }\n", "")
        .replace(
          "  done: { type: end, status: completed }",
          "  hold: { type: wait, until: demo.later, next: done }\n  done: { type: end, status: completed }",
        ),
    );
    const { def, problems } = await loadDefinition(file);
    expect(problems).toEqual([]);
    expect(def.providers).toEqual({ allow: ["demo.a", "demo.b"] });
    const publish = def.stages.publish;
    if (publish?.type !== "gate") throw new Error("publish must be a gate");
    expect(publish.poll).toEqual({ fact: "demo.ready", every: 300_000 });
    expect(publish.who).toBeUndefined();
    expect(def.stages.hold).toEqual({
      type: "wait",
      until: "demo.later",
      next: "done",
    });
  });

  test("a stage-level x- key is rejected", async () => {
    const file = await rewrite((y) =>
      y.replace("    agent: drafter\n", "    agent: drafter\n    x-note: hi\n"),
    );
    const { problems } = await loadDefinition(file);
    expect(problems.some((p) => p.startsWith("/stages/draft"))).toBe(true);
  });

  test("a brief named like a parent-prefixed file inside the folder is allowed", async () => {
    await writeFile(path.join(work, "..briefs.md"), "x\n");
    const file = await rewrite((y) =>
      y.replace("briefs/draft.md", "..briefs.md"),
    );
    const { problems } = await loadDefinition(file);
    expect(problems).toEqual([]);
  });
});

test("the sync loader returns what the async one does, briefs and hash included", async () => {
  const file = path.join(FIXTURE, "pipeline.yaml");
  const sync = loadDefinitionSync(file);
  expect(sync).toEqual(await loadDefinition(file));
  expect(Object.keys(sync.briefs).length).toBeGreaterThan(0);
});
