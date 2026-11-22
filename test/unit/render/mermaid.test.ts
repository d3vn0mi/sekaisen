import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, test } from "vitest";
import { main } from "../../../src/cli/main.js";
import { loadDefinition } from "../../../src/format/load.js";
import type { Definition } from "../../../src/format/types.js";
import { renderMermaid } from "../../../src/render/mermaid.js";

const DIR = path.resolve("test/fixtures/defs/review-loop");
const FILE = path.join(DIR, "pipeline.yaml");
const golden = readFileSync(path.join(DIR, "expected.mmd"), "utf8");

async function def() {
  return (await loadDefinition(FILE)).def;
}

async function cli(...argv: string[]) {
  let out = "";
  let err = "";
  const code = await main(argv, {
    out: (t) => {
      out += t;
    },
    err: (t) => {
      err += t;
    },
  });
  return { code, out, err };
}

describe("renderMermaid", () => {
  test("matches the golden diagram", async () => {
    expect(renderMermaid(await def())).toBe(golden);
  });

  test("is deterministic", async () => {
    const d = await def();
    expect(renderMermaid(d)).toBe(renderMermaid(d));
  });

  test("current gets the current class", async () => {
    const out = renderMermaid(await def(), { current: "check" });
    expect(out).toContain("  class s_check current\n");
  });

  test("taken edges are styled by index and tint their states", async () => {
    const out = renderMermaid(await def(), {
      current: "check",
      taken: new Set(["draft.drafted", "check.fail[0]"]),
    });
    expect(out).toContain("  linkStyle 1 stroke:#047857,stroke-width:2px\n");
    expect(out).toContain("  linkStyle 4 stroke:#047857,stroke-width:2px\n");
    expect(out).toContain("  class s_draft taken\n");
    expect(out).toContain("  class s_check current\n");
  });

  test("long guards are truncated and quotes escaped", async () => {
    const d = structuredClone(await def()) as Definition;
    const check = d.stages.check;
    if (check?.type !== "agent") throw new Error("fixture changed");
    check.outcomes.fail = {
      next: [{ if: `x == "${"y".repeat(80)}"`, to: "draft" }, { to: "failed" }],
    };
    d.stages["a-b"] = { type: "end", status: "completed" };
    d.stages.a_b = { type: "end", status: "failed" };
    d.onCancel = "failed";
    const out = renderMermaid(d);
    expect(out).toMatch(/fail \[x == #quot;y+…\]/);
    expect(out).not.toContain("y".repeat(61));
    expect(out).toContain("s_a_b_2");
    expect(out).toContain("cancel --> s_failed : on_cancel");
  });
});

describe("sekaisen render", () => {
  test("prints the diagram", async () => {
    const r = await cli("render", FILE);
    expect(r).toMatchObject({ code: 0, out: golden, err: "" });
  });

  test("--current highlights a stage", async () => {
    const r = await cli("render", FILE, "--current", "publish");
    expect(r.out).toContain("class s_publish current");
  });

  test("unknown stage, missing file, no args, help", async () => {
    expect((await cli("render", FILE, "--current", "nope")).code).toBe(1);
    const missing = await cli("render", "/nonexistent/p.yaml");
    expect(missing.code).toBe(1);
    expect(missing.err).toMatch(/^\/nonexistent\/p\.yaml: error load /);
    expect((await cli("render")).code).toBe(2);
    const help = await cli("render", "--help");
    expect(help.code).toBe(0);
    expect(help.out).toContain("sekaisen render");
  });
});
