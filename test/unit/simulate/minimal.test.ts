import { describe, expect, test } from "vitest";
import { minimalFields } from "../../../src/simulate/minimal.js";

describe("minimalFields", () => {
  test("scalars take their smallest value", () => {
    expect(minimalFields({ type: "string" })).toBe("x");
    expect(minimalFields({ type: "string", minLength: 3 })).toBe("xxx");
    expect(minimalFields({ type: "string", maxLength: 0 })).toBe("");
    expect(minimalFields({ type: "integer" })).toBe(0);
    expect(minimalFields({ type: "integer", minimum: 2.5 })).toBe(3);
    expect(minimalFields({ type: "number", minimum: -4 })).toBe(0);
    expect(minimalFields({ type: "number", maximum: -1 })).toBe(-1);
    expect(minimalFields({ type: "boolean" })).toBe(false);
    expect(minimalFields({ type: ["null", "string"] })).toBeNull();
  });

  test("enum and const win", () => {
    expect(minimalFields({ type: "string", enum: ["b", "a"] })).toBe("b");
    expect(minimalFields({ const: 7 })).toBe(7);
  });

  test("objects fill every required property, recursively", () => {
    expect(
      minimalFields({
        type: "object",
        properties: {
          pr_url: { type: "string" },
          summary: { type: "string" },
          meta: {
            type: "object",
            properties: { n: { type: "integer", minimum: 1 } },
            required: ["n"],
          },
        },
        required: ["pr_url", "meta"],
      }),
    ).toEqual({ pr_url: "x", meta: { n: 1 } });
  });

  test("arrays take minItems minimal items", () => {
    expect(minimalFields({ type: "array", items: { type: "string" } })).toEqual(
      [],
    );
    expect(
      minimalFields({ type: "array", items: { type: "boolean" }, minItems: 2 }),
    ).toEqual([false, false]);
  });

  test("refs and the first branch of anyOf are followed", () => {
    expect(
      minimalFields({
        type: "object",
        properties: { a: { $ref: "#/$defs/n" } },
        required: ["a"],
        $defs: { n: { anyOf: [{ type: "integer" }, { type: "string" }] } },
      }),
    ).toEqual({ a: 0 });
  });

  test("a pattern the minimal string misses throws, naming the field", () => {
    expect(minimalFields({ type: "string", pattern: "^x$" })).toBe("x");
    expect(() =>
      minimalFields({
        type: "object",
        properties: { url: { type: "string", pattern: "^https://" } },
        required: ["url"],
      }),
    ).toThrow("field url: no minimal string matches pattern ^https://");
  });

  test("any other constraint the value misses throws", () => {
    expect(() =>
      minimalFields({ type: "integer", minimum: 5, maximum: 4 }),
    ).toThrow(/no minimal value satisfies the schema: : must be >= 5/);
  });

  test("sibling keywords hold inside the anyOf branch tried", () => {
    expect(
      minimalFields({
        type: "object",
        properties: { a: { type: "integer" } },
        required: ["a"],
        anyOf: [{ required: ["a"] }, { required: ["b"] }],
      }),
    ).toEqual({ a: 0 });
  });

  test("branches are tried in order until one gives a valid value", () => {
    expect(
      minimalFields({
        type: "string",
        oneOf: [{ pattern: "^y$" }, { minLength: 2 }],
      }),
    ).toBe("xx");
    expect(minimalFields({ enum: ["a", "bb"], minLength: 2 })).toBe("bb");
  });

  test("sibling keywords hold beside a $ref", () => {
    expect(
      minimalFields({
        type: "object",
        properties: { s: { $ref: "#/$defs/text", minLength: 3 } },
        required: ["s"],
        $defs: { text: { type: "string" } },
      }),
    ).toEqual({ s: "xxx" });
  });

  test("a required name without a property takes additionalProperties' schema", () => {
    expect(
      minimalFields({
        type: "object",
        required: ["n"],
        additionalProperties: { type: "integer", minimum: 4 },
      }),
    ).toEqual({ n: 4 });
  });

  test("a stricter bound beside a branch or a $ref holds", () => {
    expect(
      minimalFields({
        type: "string",
        minLength: 3,
        anyOf: [{ minLength: 1 }],
      }),
    ).toBe("xxx");
    expect(
      minimalFields({
        type: "object",
        properties: { s: { $ref: "#/$defs/text", minLength: 1 } },
        required: ["s"],
        $defs: { text: { type: "string", minLength: 3 } },
      }),
    ).toEqual({ s: "xxx" });
    expect(
      minimalFields({
        type: "array",
        minItems: 1,
        items: { type: "integer", minimum: 3 },
        anyOf: [{ items: { maximum: 5 } }],
      }),
    ).toEqual([3]);
  });

  test("required joins, enum intersects, a clashing keyword is tried both ways", () => {
    expect(
      minimalFields({
        type: "object",
        properties: { a: { type: "string" }, b: { type: "integer" } },
        required: ["a"],
        oneOf: [{ required: ["b"] }],
      }),
    ).toEqual({ a: "x", b: 0 });
    expect(
      minimalFields({ enum: ["p", "q"], anyOf: [{ enum: ["q", "r"] }] }),
    ).toBe("q");
    // The branch's type list is tried first and gives "x", which the whole
    // schema refuses; the sibling's integer is tried next.
    expect(
      minimalFields({
        type: "integer",
        anyOf: [{ type: ["string", "integer"] }],
      }),
    ).toBe(0);
  });

  test("each type of a type list is tried in order", () => {
    expect(
      minimalFields({ type: ["string", "null"], pattern: "^a" }),
    ).toBeNull();
    expect(minimalFields({ type: ["integer", "string"] })).toBe(0);
  });
});
