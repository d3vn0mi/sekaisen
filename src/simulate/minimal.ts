import { type JsonSchema, validateJson } from "../format/jsonschema.js";

const MAX_DEPTH = 64;
const REF_PREFIX = "#/$defs/";

/**
 * The smallest plain value `schema` accepts: a string is `"x"` (repeated up
 * to `minLength`), a number the larger of 0 and `minimum`, a boolean false,
 * an array `minItems` minimal items, an object every required property
 * filled the same way; `const` and the first `enum` value win over all of
 * these, and `anyOf` or `oneOf` take their first branch. Throws, naming the
 * field, when the value it builds does not satisfy the schema (a `pattern`
 * that `"x"` does not match, say).
 */
export function minimalFields(schema: JsonSchema): unknown {
  const value = build(schema, schema, "", 0);
  const errors = validateJson(schema, value);
  if (errors.length > 0) {
    throw new Error(
      `no minimal value satisfies the schema: ${errors.slice(0, 5).join("; ")}`,
    );
  }
  return value;
}

function build(
  s: JsonSchema,
  root: JsonSchema,
  path: string,
  depth: number,
): unknown {
  if (depth > MAX_DEPTH) {
    throw new Error(`${field(path)}: schema nesting deeper than ${MAX_DEPTH}`);
  }
  const deeper = (sub: JsonSchema, at = path) =>
    build(sub, root, at, depth + 1);
  if (s.$ref !== undefined) return deeper(resolve(s.$ref, root, path));
  if ("const" in s) return s.const;
  if (s.enum !== undefined && s.enum.length > 0) return s.enum[0];
  const branch = s.anyOf?.[0] ?? s.oneOf?.[0];
  if (branch !== undefined) return deeper(branch);

  switch (typeOf(s)) {
    case "string": {
      let text = "x".repeat(Math.max(1, s.minLength ?? 1));
      if (s.maxLength !== undefined && text.length > s.maxLength) {
        text = text.slice(0, s.maxLength);
      }
      if (s.pattern !== undefined && !new RegExp(s.pattern).test(text)) {
        throw new Error(
          `${field(path)}: no minimal string matches pattern ${s.pattern}`,
        );
      }
      return text;
    }
    case "integer":
    case "number": {
      const integer = typeOf(s) === "integer";
      let n = Math.max(0, s.minimum ?? 0);
      if (integer) n = Math.ceil(n);
      if (s.maximum !== undefined && n > s.maximum) {
        n = integer ? Math.floor(s.maximum) : s.maximum;
      }
      return n;
    }
    case "boolean":
      return false;
    case "null":
      return null;
    case "array":
      return Array.from({ length: s.minItems ?? 0 }, (_, i) =>
        deeper(s.items ?? {}, `${path}/${i}`),
      );
    default: {
      const out: Record<string, unknown> = {};
      for (const name of s.required ?? []) {
        out[name] = deeper(s.properties?.[name] ?? {}, `${path}/${name}`);
      }
      return out;
    }
  }
}

/** The schema's type, or the one its keywords imply; a string when nothing does. */
function typeOf(s: JsonSchema): string {
  if (s.type !== undefined) {
    return (Array.isArray(s.type) ? s.type[0] : s.type) ?? "string";
  }
  if (s.properties || s.required || s.additionalProperties !== undefined) {
    return "object";
  }
  if (s.items || s.minItems !== undefined || s.maxItems !== undefined) {
    return "array";
  }
  if (s.minimum !== undefined || s.maximum !== undefined) return "number";
  return "string";
}

function resolve(ref: string, root: JsonSchema, path: string): JsonSchema {
  const name = ref.startsWith(REF_PREFIX)
    ? ref.slice(REF_PREFIX.length)
    : undefined;
  const target =
    name !== undefined && root.$defs && Object.hasOwn(root.$defs, name)
      ? root.$defs[name]
      : undefined;
  if (target === undefined) {
    throw new Error(`${field(path)}: unresolved $ref: ${ref}`);
  }
  return target;
}

function field(path: string): string {
  return path === "" ? "the value" : `field ${path.slice(1)}`;
}
