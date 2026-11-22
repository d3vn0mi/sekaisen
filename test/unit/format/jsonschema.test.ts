import { describe, expect, test } from "vitest";
import {
  checkSchema,
  fieldsShorthandToSchema,
  type JsonSchema,
  SUPPORTED_KEYWORDS,
  validateJson,
} from "../../../src/format/jsonschema.js";

describe("validateJson", () => {
  test("type mismatch reports the pointer", () => {
    const schema: JsonSchema = {
      type: "object",
      properties: { a: { type: "integer" } },
    };
    expect(validateJson(schema, { a: "x" })).toEqual(["/a: must be integer"]);
  });

  test("root error uses the empty pointer", () => {
    expect(validateJson({ type: "object" }, 3)).toEqual([": must be object"]);
  });

  test("path argument prefixes the pointer and pointer segments are escaped", () => {
    const schema: JsonSchema = {
      properties: { "a/b~c": { type: "string" } },
    };
    expect(validateJson(schema, { "a/b~c": 1 })).toEqual([
      "/a~1b~0c: must be string",
    ]);
    expect(validateJson({ type: "string" }, 1, "/x")).toEqual([
      "/x: must be string",
    ]);
  });

  test("required and additionalProperties false", () => {
    const schema: JsonSchema = {
      type: "object",
      properties: { a: { type: "string" } },
      required: ["a"],
      additionalProperties: false,
    };
    expect(validateJson(schema, { a: "x" })).toEqual([]);
    expect(validateJson(schema, {})).toEqual(["/a: is required"]);
    expect(validateJson(schema, { a: "x", b: 1 })).toEqual([
      "/b: unexpected property",
    ]);
  });

  test("additionalProperties as a schema", () => {
    const schema: JsonSchema = { additionalProperties: { type: "number" } };
    expect(validateJson(schema, { a: 1, b: "x" })).toEqual([
      "/b: must be number",
    ]);
  });

  test("oneOf picks exactly one", () => {
    const schema: JsonSchema = {
      oneOf: [{ type: "string" }, { type: "integer" }],
    };
    expect(validateJson(schema, "x")).toEqual([]);
    expect(validateJson(schema, 2)).toEqual([]);
    expect(validateJson(schema, true)).toHaveLength(1);
    const both: JsonSchema = {
      oneOf: [{ type: "integer" }, { type: "number" }],
    };
    expect(validateJson(both, 2)).toHaveLength(1);
  });

  test("anyOf needs at least one", () => {
    const schema: JsonSchema = {
      anyOf: [{ type: "string" }, { type: "integer" }],
    };
    expect(validateJson(schema, 2)).toEqual([]);
    expect(validateJson(schema, null)).toHaveLength(1);
  });

  test("local $ref resolves", () => {
    const schema: JsonSchema = {
      $defs: { name: { type: "string", minLength: 1 } },
      type: "object",
      properties: { n: { $ref: "#/$defs/name" } },
    };
    expect(validateJson(schema, { n: "ok" })).toEqual([]);
    expect(validateJson(schema, { n: "" })).toEqual([
      "/n: must have at least 1 characters",
    ]);
  });

  test("unresolvable or non-local $ref throws", () => {
    expect(() => validateJson({ $ref: "#/$defs/missing" }, 1)).toThrow(
      /unresolved \$ref/,
    );
    expect(() => validateJson({ $ref: "http://x/y" }, 1)).toThrow(
      /unsupported \$ref/,
    );
  });

  test("unknown keyword throws at validation time", () => {
    expect(() => validateJson({ format: "email" } as JsonSchema, "a")).toThrow(
      "unsupported JSON Schema keyword: format",
    );
    expect(() =>
      validateJson(
        { properties: { a: { exclusiveMinimum: 1 } } } as JsonSchema,
        { a: 1 },
      ),
    ).toThrow("unsupported JSON Schema keyword: exclusiveMinimum");
  });

  test("enum and const compare deeply", () => {
    expect(validateJson({ enum: ["a", { x: 1 }] }, { x: 1 })).toEqual([]);
    expect(validateJson({ enum: ["a", "b"] }, "c")).toEqual([
      ': must be one of ["a","b"]',
    ]);
    expect(validateJson({ const: [1, 2] }, [1, 2])).toEqual([]);
    expect(validateJson({ const: [1, 2] }, [1, 3])).toEqual([
      ": must equal [1,2]",
    ]);
  });

  test("numeric, string and array bounds", () => {
    expect(validateJson({ minimum: 2 }, 1)).toEqual([": must be >= 2"]);
    expect(validateJson({ maximum: 2 }, 3)).toEqual([": must be <= 2"]);
    expect(validateJson({ maxLength: 2 }, "abc")).toEqual([
      ": must have at most 2 characters",
    ]);
    expect(validateJson({ pattern: "^a+$" }, "b")).toEqual([
      ": must match pattern ^a+$",
    ]);
    expect(validateJson({ minItems: 2 }, [1])).toEqual([
      ": must have at least 2 items",
    ]);
    expect(validateJson({ maxItems: 1 }, [1, 2])).toEqual([
      ": must have at most 1 items",
    ]);
    expect(validateJson({ items: { type: "integer" } }, [1, "x"])).toEqual([
      "/1: must be integer",
    ]);
  });

  test("type distinguishes integer, number, array, null and object", () => {
    expect(validateJson({ type: "integer" }, 1.5)).toHaveLength(1);
    expect(validateJson({ type: "number" }, 1.5)).toEqual([]);
    expect(validateJson({ type: "object" }, [])).toHaveLength(1);
    expect(validateJson({ type: "array" }, [])).toEqual([]);
    expect(validateJson({ type: "null" }, null)).toEqual([]);
    expect(validateJson({ type: "object" }, null)).toHaveLength(1);
  });

  test("annotation keywords are accepted", () => {
    expect(
      validateJson({ title: "t", description: "d", default: 1 }, 5),
    ).toEqual([]);
  });

  test("SUPPORTED_KEYWORDS lists the contract", () => {
    expect(SUPPORTED_KEYWORDS).toEqual([
      "type",
      "properties",
      "required",
      "additionalProperties",
      "items",
      "enum",
      "const",
      "oneOf",
      "anyOf",
      "minimum",
      "maximum",
      "minLength",
      "maxLength",
      "pattern",
      "minItems",
      "maxItems",
      "$ref",
      "$defs",
      "description",
      "title",
      "default",
    ]);
  });
});

describe("fieldsShorthandToSchema", () => {
  test("shorthand: { issue: integer, note: string? }", () => {
    const schema = fieldsShorthandToSchema({
      issue: "integer",
      note: "string?",
    });
    expect(validateJson(schema, { issue: 3 })).toEqual([]);
    expect(validateJson(schema, { issue: 3, note: "n" })).toEqual([]);
    expect(validateJson(schema, { issue: 3, extra: 1 })).toEqual([
      "/extra: unexpected property",
    ]);
    expect(validateJson(schema, {})).toEqual(["/issue: is required"]);
  });

  test("maps every shorthand type", () => {
    const schema = fieldsShorthandToSchema({
      s: "string",
      i: "integer",
      n: "number",
      b: "boolean",
      o: "object",
      a: "array",
      l: "string[]",
      m: "string[]?",
    });
    expect(schema.required).toEqual(["s", "i", "n", "b", "o", "a", "l"]);
    const ok = { s: "", i: 1, n: 1.5, b: false, o: {}, a: [], l: ["x"] };
    expect(validateJson(schema, ok)).toEqual([]);
    expect(validateJson(schema, { ...ok, l: [1] })).toEqual([
      "/l/0: must be string",
    ]);
  });

  test("rejects an unknown shorthand type", () => {
    expect(() => fieldsShorthandToSchema({ x: "date" })).toThrow(
      /unsupported field type "date"/,
    );
  });
});

describe("checkSchema and guards", () => {
  test("whole-schema check finds bad keywords in unvisited places", () => {
    const bad = /unsupported JSON Schema keyword: format/;
    expect(() =>
      validateJson({ properties: { opt: { format: "x" } } } as JsonSchema, {}),
    ).toThrow(/^\/properties\/opt: unsupported JSON Schema keyword: format/);
    expect(() =>
      validateJson({ $defs: { u: { format: "x" } } } as JsonSchema, 1),
    ).toThrow(bad);
    expect(() =>
      validateJson(
        { anyOf: [{ type: "string" }, { format: "x" }] } as JsonSchema,
        "s",
      ),
    ).toThrow(bad);
    expect(() => validateJson({ type: ["string", "bogus"] }, "s")).toThrow(
      /\/type: unsupported JSON Schema type: bogus/,
    );
  });

  test("malformed schemas throw clean pointer errors", () => {
    const cases: [unknown, RegExp][] = [
      [true, /^: must be a schema object/],
      [
        { properties: { a: null } },
        /^\/properties\/a: must be a schema object/,
      ],
      [{ required: 3 }, /^\/required: must be an array of strings/],
      [{ required: "ab" }, /^\/required: must be an array of strings/],
      [{ enum: "x" }, /^\/enum: must be an array/],
      [{ minLength: "3" }, /^\/minLength: must be a non-negative integer/],
      [{ maxItems: -1 }, /^\/maxItems: must be a non-negative integer/],
      [{ minimum: "1" }, /^\/minimum: must be a number/],
      [{ properties: [] }, /^\/properties: must be an object of schemas/],
      [{ $defs: 1 }, /^\/\$defs: must be an object of schemas/],
      [{ items: [{ type: "string" }] }, /^\/items: must be a schema/],
      [{ oneOf: {} }, /^\/oneOf: must be an array of schemas/],
      [{ $ref: "#/$defs/nope" }, /^\/\$ref: unresolved \$ref/],
    ];
    for (const [schema, re] of cases) {
      expect(() => checkSchema(schema as JsonSchema)).toThrow(re);
    }
  });

  test("patterns use ECMA semantics and are compiled once", () => {
    expect(validateJson({ pattern: "a{" }, "a{")).toEqual([]);
    expect(validateJson({ pattern: "\\_" }, "_")).toEqual([]);
    expect(() => checkSchema({ pattern: "(" })).toThrow(
      /^\/pattern: invalid pattern: /,
    );
  });

  test("nested quantifiers are refused", () => {
    for (const p of ["^(a+)+$", "(a*)*", "(a|b+)*", "(?:x+){2,}"]) {
      expect(() => checkSchema({ pattern: p })).toThrow(
        "/pattern: pattern has nested quantifiers",
      );
    }
    for (const p of ["^(ab)+$", "^[a+]+$", "a+b*", "^(a|b)*c+$", "\\(a+\\)+"]) {
      expect(() => checkSchema({ pattern: p })).not.toThrow();
    }
    const start = Date.now();
    expect(() =>
      validateJson({ pattern: "^(a+)+$" }, `${"a".repeat(40)}!`),
    ).toThrow();
    expect(Date.now() - start).toBeLessThan(1000);
  });

  test("a $ref cycle that makes no progress throws", () => {
    const schema: JsonSchema = {
      $defs: { a: { $ref: "#/$defs/b" }, b: { $ref: "#/$defs/a" } },
      $ref: "#/$defs/a",
    };
    expect(() => validateJson(schema, 1)).toThrow(
      /: \$ref cycle at #\/\$defs\/a/,
    );
  });

  test("a recursive schema that consumes the value is fine", () => {
    const schema: JsonSchema = {
      $defs: {
        node: {
          type: "object",
          properties: {
            kids: { type: "array", items: { $ref: "#/$defs/node" } },
          },
          additionalProperties: false,
        },
      },
      $ref: "#/$defs/node",
    };
    expect(
      validateJson(schema, { kids: [{ kids: [{}] }, { kids: [{ x: 1 }] }] }),
    ).toEqual(["/kids/1/kids/0/x: unexpected property"]);
  });

  test("nesting deeper than 64 throws", () => {
    const schema: JsonSchema = {
      $defs: {
        n: { type: "object", properties: { c: { $ref: "#/$defs/n" } } },
      },
      $ref: "#/$defs/n",
    };
    let v: Record<string, unknown> = {};
    for (let i = 0; i < 100; i++) v = { c: v };
    expect(() => validateJson(schema, v)).toThrow(
      /schema nesting deeper than 64/,
    );
    let s: JsonSchema = { type: "string" };
    for (let i = 0; i < 70; i++) s = { items: s };
    expect(() => checkSchema(s)).toThrow(/schema nesting deeper than 64/);
  });
});
