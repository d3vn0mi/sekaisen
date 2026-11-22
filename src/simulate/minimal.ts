import { type JsonSchema, validateJson } from "../format/jsonschema.js";

const MAX_DEPTH = 64;
const REF_PREFIX = "#/$defs/";

/**
 * The smallest plain value `schema` accepts: a string is `"x"` (repeated up
 * to `minLength`), a number the larger of 0 and `minimum`, a boolean false,
 * an array `minItems` minimal items, an object every required property
 * filled the same way (from `additionalProperties` when `properties` does
 * not name it). `const` wins; `enum` values, then `anyOf` and `oneOf`
 * branches (each with the keywords beside it), are tried in order until
 * one gives a value the whole schema accepts. Throws, naming the field,
 * when none does (a `pattern` that `"x"` does not match, say).
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
  if (s.$ref !== undefined) {
    const { $ref, ...beside } = s;
    return deeper(merge(resolve($ref, root, path), beside));
  }
  if ("const" in s) return s.const;

  const alternatives = alternativesOf(s);
  if (alternatives.length === 0) return scalarOrObject(s, path, deeper);
  // The first alternative whose value the whole schema accepts.
  let first: { value?: unknown; error?: unknown } | undefined;
  for (const make of alternatives) {
    let value: unknown;
    try {
      value = make(deeper);
    } catch (error) {
      first ??= { error };
      continue;
    }
    if (accepts(s, root, value)) return value;
    first ??= { value };
  }
  if (first && "error" in first) throw first.error;
  return first?.value;
}

type Deeper = (sub: JsonSchema, at?: string) => unknown;

/** The enum values, then the anyOf and oneOf branches, as ways to build a value. */
function alternativesOf(s: JsonSchema): Array<(deeper: Deeper) => unknown> {
  const out: Array<(deeper: Deeper) => unknown> = [];
  for (const v of s.enum ?? []) out.push(() => v);
  if (out.length > 0) return out;
  const { anyOf, oneOf, ...beside } = s;
  for (const branch of [...(anyOf ?? []), ...(oneOf ?? [])]) {
    out.push((deeper) => deeper(merge(beside, branch)));
  }
  return out;
}

function scalarOrObject(s: JsonSchema, path: string, deeper: Deeper): unknown {
  const type = typeOf(s);
  switch (type) {
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
      let n = Math.max(0, s.minimum ?? 0);
      if (type === "integer") n = Math.ceil(n);
      if (s.maximum !== undefined && n > s.maximum) {
        n = type === "integer" ? Math.floor(s.maximum) : s.maximum;
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
      const extra =
        typeof s.additionalProperties === "object"
          ? s.additionalProperties
          : {};
      const out: Record<string, unknown> = {};
      for (const name of s.required ?? []) {
        const sub =
          s.properties && Object.hasOwn(s.properties, name)
            ? s.properties[name]
            : extra;
        out[name] = deeper(sub ?? {}, `${path}/${name}`);
      }
      return out;
    }
  }
}

/**
 * `b`'s keywords over `a`'s, keeping both sides' constraints where they
 * add up: required names are joined, properties merged.
 */
function merge(a: JsonSchema, b: JsonSchema): JsonSchema {
  const out: JsonSchema = { ...a, ...b };
  if (a.required && b.required) {
    out.required = [...new Set([...a.required, ...b.required])];
  }
  if (a.properties && b.properties) {
    out.properties = { ...a.properties, ...b.properties };
  }
  return out;
}

/** True when `value` satisfies `s`, a part of `root` whose refs point into root. */
function accepts(s: JsonSchema, root: JsonSchema, value: unknown): boolean {
  const whole = root.$defs ? { ...s, $defs: root.$defs } : s;
  return validateJson(whole, value).length === 0;
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
