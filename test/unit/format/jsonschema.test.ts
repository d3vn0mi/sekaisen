import { describe, expect, test } from "vitest";
import {
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
