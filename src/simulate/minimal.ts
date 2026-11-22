import { type JsonSchema, validateJson } from "../format/jsonschema.js";

const MAX_DEPTH = 64;
const REF_PREFIX = "#/$defs/";

/**
 * The smallest plain value `schema` accepts: a string is `"x"` (repeated up
 * to `minLength`), a number the larger of 0 and `minimum`, a boolean false,
 * an array `minItems` minimal items, an object every required property
 * filled the same way (from `additionalProperties` when `properties` does
 * not name it). `const` wins; `enum` values, then `anyOf` and `oneOf`
 * branches (each joined with the keywords beside it, as a `$ref` target
 * is), then the types of a `type` list are tried in order until one gives
 * a value the whole schema accepts. Throws, naming the field, when none
 * does (a `pattern` that `"x"` does not match, say).
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
  if ("const" in s) return s.const;
  const alternatives = alternativesOf(s, root, path);
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

/**
 * Ways to build a value, in the order they are tried: a `$ref` target
 * joined with the keywords beside it, the enum values, the anyOf and
 * oneOf branches joined with theirs, the types of a `type` list. Empty
 * when the schema has one plain shape.
 */
function alternativesOf(
  s: JsonSchema,
  root: JsonSchema,
  path: string,
): Array<(deeper: Deeper) => unknown> {
  const joined = (schemas: JsonSchema[]) =>
    schemas.map((one) => (deeper: Deeper) => deeper(one));
  if (s.$ref !== undefined) {
    const { $ref, ...beside } = s;
    return joined(conjoin(resolve($ref, root, path), beside));
  }
  if (s.enum !== undefined && s.enum.length > 0) {
    return s.enum.map((v) => () => v);
  }
  const { anyOf, oneOf, ...beside } = s;
  const branches = [...(anyOf ?? []), ...(oneOf ?? [])];
  if (branches.length > 0) {
    return joined(branches.flatMap((branch) => conjoin(beside, branch)));
  }
  if (Array.isArray(s.type) && s.type.length > 1) {
    return joined(s.type.map((type) => ({ ...s, type })));
  }
  return [];
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

/** Most variants one conjunction of two schemas yields. */
const MAX_VARIANTS = 16;

const LOWER_BOUNDS = ["minimum", "minLength", "minItems"];
const UPPER_BOUNDS = ["maximum", "maxLength", "maxItems"];

/**
 * Schemas that each hold where both `a` and `b` hold: lower bounds take the
 * larger, upper bounds the smaller, `required` joins, `enum` intersects,
 * `properties` and `items` conjoin recursively. Any other keyword both give
 * differently cannot be joined, so each side's value is offered in turn
 * (b's first) and the caller keeps the variant whose value the whole
 * schema accepts.
 */
function conjoin(a: JsonSchema, b: JsonSchema): JsonSchema[] {
  const x = a as Record<string, unknown>;
  const y = b as Record<string, unknown>;
  let out: Array<Record<string, unknown>> = [{}];
  for (const key of new Set([...Object.keys(x), ...Object.keys(y)])) {
    const options = joinKeyword(key, x[key], y[key]);
    out = out
      .flatMap((s) => options.map((v) => ({ ...s, [key]: v })))
      .slice(0, MAX_VARIANTS);
  }
  return out as JsonSchema[];
}

/** The values a keyword may take in the conjunction of two schemas. */
function joinKeyword(key: string, a: unknown, b: unknown): unknown[] {
  if (a === undefined) return [b];
  if (b === undefined) return [a];
  if (LOWER_BOUNDS.includes(key)) return [Math.max(a as number, b as number)];
  if (UPPER_BOUNDS.includes(key)) return [Math.min(a as number, b as number)];
  switch (key) {
    case "required":
      return [[...new Set([...(a as string[]), ...(b as string[])])]];
    case "enum":
      return [
        (a as unknown[]).filter((v) =>
          (b as unknown[]).some((w) => same(v, w)),
        ),
      ];
    case "items":
      return conjoin(a as JsonSchema, b as JsonSchema);
    case "properties":
      return joinProperties(
        a as Record<string, JsonSchema>,
        b as Record<string, JsonSchema>,
      );
    default:
      return same(a, b) ? [a] : [b, a];
  }
}

/** Property maps joined name by name, a shared name's schemas conjoined. */
function joinProperties(
  a: Record<string, JsonSchema>,
  b: Record<string, JsonSchema>,
): Array<Record<string, JsonSchema>> {
  let out: Array<Record<string, JsonSchema>> = [{ ...a, ...b }];
  for (const name of Object.keys(a)) {
    if (!Object.hasOwn(b, name)) continue;
    const variants = conjoin(a[name] as JsonSchema, b[name] as JsonSchema);
    out = out
      .flatMap((m) => variants.map((v) => ({ ...m, [name]: v })))
      .slice(0, MAX_VARIANTS);
  }
  return out;
}

function same(a: unknown, b: unknown): boolean {
  return JSON.stringify(a) === JSON.stringify(b);
}

/** True when `value` satisfies `s`, a part of `root` whose refs point into root. */
function accepts(s: JsonSchema, root: JsonSchema, value: unknown): boolean {
  const whole = root.$defs ? { ...s, $defs: root.$defs } : s;
  return validateJson(whole, value).length === 0;
}

/** The schema's type, or the one its keywords imply; a string when nothing does. */
function typeOf(s: JsonSchema): string {
  // A list of several types was tried type by type before getting here.
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
