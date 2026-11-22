import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { Ajv } from "ajv";
import { describe, expect, test } from "vitest";
import { parse } from "yaml";
import {
  type JsonSchema,
  SUPPORTED_KEYWORDS,
  validateJson,
} from "../../../src/format/jsonschema.js";
import { definitionSchema } from "../../../src/format/load.js";

const schemaUrl = new URL("../../../src/format/schema.json", import.meta.url);
const fixtureUrl = new URL(
  "../../fixtures/defs/review-loop/pipeline.yaml",
  import.meta.url,
);

function keywordsOutside(schema: unknown, at: string): string[] {
  if (typeof schema !== "object" || schema === null) return [];
  const s = schema as Record<string, unknown>;
  const bad: string[] = [];
  for (const [key, value] of Object.entries(s)) {
    if (!SUPPORTED_KEYWORDS.includes(key)) bad.push(`${at}/${key}`);
    if (key === "properties" || key === "$defs") {
      for (const [name, sub] of Object.entries(
        value as Record<string, unknown>,
      )) {
        bad.push(...keywordsOutside(sub, `${at}/${key}/${name}`));
      }
    } else if (key === "oneOf" || key === "anyOf") {
      (value as unknown[]).forEach((sub, i) => {
        bad.push(...keywordsOutside(sub, `${at}/${key}/${i}`));
      });
    } else if (key === "items" || key === "additionalProperties") {
      bad.push(...keywordsOutside(value, `${at}/${key}`));
    }
  }
  return bad;
}

describe("schema.json", () => {
  const schema = JSON.parse(readFileSync(schemaUrl, "utf8")) as JsonSchema;

  test("schema.json is valid JSON Schema", () => {
    const ajv = new Ajv({ strict: true, allErrors: true });
    expect(() => ajv.compile(schema)).not.toThrow();
  });

  test("schema.json uses only SUPPORTED_KEYWORDS", () => {
    expect(keywordsOutside(schema, "")).toEqual([]);
  });

  test("the loader reads the same schema", () => {
    expect(definitionSchema()).toEqual(schema);
  });

  test("fixture validates against schema.json with both validators", () => {
    const doc = parse(readFileSync(fixtureUrl, "utf8"));
    expect(validateJson(schema, doc)).toEqual([]);
    const ajv = new Ajv({ strict: true, allErrors: true });
    const validate = ajv.compile(schema);
    expect(validate(doc)).toBe(true);
  });

  test("both validators reject the same broken documents", () => {
    const ajv = new Ajv({ strict: true, allErrors: true });
    const validate = ajv.compile(schema);
    const good = parse(readFileSync(fixtureUrl, "utf8"));
    const broken = [
      { ...good, format: 2 },
      { ...good, extra: true },
      { ...good, stages: { s: { type: "agent", agent: "a" } } },
      { ...good, stages: { s: { type: "end", status: "paused" } } },
      { ...good, defaults: { deadline: "soon" } },
    ];
    for (const doc of broken) {
      expect(validateJson(schema, doc).length).toBeGreaterThan(0);
      expect(validate(doc)).toBe(false);
    }
  });

  test("the build script copies schema.json next to the compiled loader", () => {
    const dist = mkdtempSync(path.join(tmpdir(), "sekaisen-dist-"));
    try {
      execFileSync("node", ["scripts/copy-schema.mjs", dist]);
      expect(readFileSync(path.join(dist, "format/schema.json"), "utf8")).toBe(
        readFileSync(schemaUrl, "utf8"),
      );
    } finally {
      rmSync(dist, { recursive: true, force: true });
    }
    const pkg = JSON.parse(readFileSync("package.json", "utf8"));
    expect(pkg.scripts.build).toContain("scripts/copy-schema.mjs");
  });
});
