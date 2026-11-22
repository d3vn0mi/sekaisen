export type JsonSchema = {
  type?: string | string[];
  properties?: Record<string, JsonSchema>;
  required?: string[];
  additionalProperties?: boolean | JsonSchema;
  items?: JsonSchema;
  enum?: unknown[];
  const?: unknown;
  oneOf?: JsonSchema[];
  anyOf?: JsonSchema[];
  minimum?: number;
  maximum?: number;
  minLength?: number;
  maxLength?: number;
  pattern?: string;
  minItems?: number;
  maxItems?: number;
  $ref?: string;
  $defs?: Record<string, JsonSchema>;
  description?: string;
  title?: string;
  default?: unknown;
};

export const SUPPORTED_KEYWORDS: readonly string[] = [
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
];

const REF_PREFIX = "#/$defs/";

function escapeSegment(s: string): string {
  return s.replaceAll("~", "~0").replaceAll("/", "~1");
}

function isObject(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

function matchesType(type: string, v: unknown): boolean {
  switch (type) {
    case "string":
      return typeof v === "string";
    case "integer":
      return typeof v === "number" && Number.isInteger(v);
    case "number":
      return typeof v === "number" && Number.isFinite(v);
    case "boolean":
      return typeof v === "boolean";
    case "null":
      return v === null;
    case "object":
      return isObject(v);
    case "array":
      return Array.isArray(v);
    default:
      throw new Error(`unsupported JSON Schema type: ${type}`);
  }
}

function deepEqual(a: unknown, b: unknown): boolean {
  if (a === b) return true;
  if (Array.isArray(a) && Array.isArray(b)) {
    return a.length === b.length && a.every((x, i) => deepEqual(x, b[i]));
  }
  if (isObject(a) && isObject(b)) {
    const ka = Object.keys(a);
    return (
      ka.length === Object.keys(b).length &&
      ka.every((k) => Object.hasOwn(b, k) && deepEqual(a[k], b[k]))
    );
  }
  return false;
}

const TYPE_NAMES = [
  "string",
  "integer",
  "number",
  "boolean",
  "null",
  "object",
  "array",
];
const MAX_DEPTH = 64;
/** Upper bound on schema visits for one validateJson call. */
export const MAX_VALIDATION_STEPS = 100_000;
// Validation is synchronous, so one module-level counter per call is safe.
let steps = 0;
const NON_NEGATIVE_INTEGER_KEYWORDS = [
  "minLength",
  "maxLength",
  "minItems",
  "maxItems",
];

// Compiled patterns, one per schema node. Patterns use ECMA-262 semantics
// (no `u` flag), as JSON Schema specifies.
const patterns = new WeakMap<object, RegExp>();
// Schemas that already passed checkSchema.
const checked = new WeakSet<object>();

function resolveRef(ref: string, root: JsonSchema, path: string): JsonSchema {
  if (!ref.startsWith(REF_PREFIX)) {
    throw new Error(`${path}: unsupported $ref: ${ref} (only #/$defs/<name>)`);
  }
  const name = ref.slice(REF_PREFIX.length);
  const target =
    root.$defs && Object.hasOwn(root.$defs, name)
      ? root.$defs[name]
      : undefined;
  if (target === undefined) throw new Error(`${path}: unresolved $ref: ${ref}`);
  return target;
}

/**
 * Refuses a quantified group that itself contains a quantifier, such as
 * `(a+)+`, `(a*)*`, `(a|b+)*` or `(?:x+){2,}`. Such patterns backtrack
 * exponentially, and patterns run against untrusted strings. The scan is
 * deliberately conservative: it ignores escapes and character classes, and
 * only `*`, `+` and `{n,m}` count as quantifiers.
 */
function hasNestedQuantifiers(pattern: string): boolean {
  const stack: boolean[] = [];
  let hasQuantifier = false;
  const quantifierAt = (i: number): number => {
    const c = pattern[i];
    if (c === "*" || c === "+") return 1;
    if (c === "{") {
      const m = /^\{\d+(,\d*)?\}/.exec(pattern.slice(i));
      return m ? m[0].length : 0;
    }
    return 0;
  };
  for (let i = 0; i < pattern.length; i++) {
    const c = pattern[i];
    if (c === "\\") {
      i++;
    } else if (c === "[") {
      i++;
      while (i < pattern.length && pattern[i] !== "]") {
        if (pattern[i] === "\\") i++;
        i++;
      }
    } else if (c === "(") {
      stack.push(hasQuantifier);
      hasQuantifier = false;
    } else if (c === ")") {
      const inner: boolean = hasQuantifier;
      hasQuantifier = stack.pop() ?? false;
      const q = quantifierAt(i + 1);
      if (q > 0) {
        if (inner) return true;
        hasQuantifier = true;
        i += q;
      } else {
        hasQuantifier = hasQuantifier || inner;
      }
    } else {
      const q = quantifierAt(i);
      if (q > 0) {
        hasQuantifier = true;
        i += q - 1;
      }
    }
  }
  return false;
}

function isSchemaObject(v: unknown): v is JsonSchema {
  return isObject(v);
}

function walkSchema(
  schema: unknown,
  path: string,
  root: JsonSchema,
  depth: number,
): void {
  if (depth > MAX_DEPTH) {
    throw new Error(`${path}: schema nesting deeper than ${MAX_DEPTH}`);
  }
  if (!isSchemaObject(schema))
    throw new Error(`${path}: must be a schema object`);
  const s = schema as Record<string, unknown>;
  for (const key of Object.keys(s)) {
    if (!SUPPORTED_KEYWORDS.includes(key)) {
      throw new Error(`${path}: unsupported JSON Schema keyword: ${key}`);
    }
  }
  const bad = (key: string, what: string): never => {
    throw new Error(`${path}/${key}: must be ${what}`);
  };
  const subschemaMap = (key: string): void => {
    const m = s[key];
    if (m === undefined) return;
    if (!isObject(m)) bad(key, "an object of schemas");
    for (const [name, sub] of Object.entries(m as Record<string, unknown>)) {
      walkSchema(sub, `${path}/${key}/${escapeSegment(name)}`, root, depth + 1);
    }
  };
  const subschemaList = (key: string): void => {
    const l = s[key];
    if (l === undefined) return;
    if (!Array.isArray(l)) bad(key, "an array of schemas");
    (l as unknown[]).forEach((sub, i) => {
      walkSchema(sub, `${path}/${key}/${i}`, root, depth + 1);
    });
  };

  if (s.type !== undefined) {
    const types = Array.isArray(s.type) ? s.type : [s.type];
    if (types.length === 0) bad("type", "a type name or a non-empty array");
    for (const t of types) {
      if (typeof t !== "string") bad("type", "a type name or an array of them");
      if (!TYPE_NAMES.includes(t as string)) {
        throw new Error(`${path}/type: unsupported JSON Schema type: ${t}`);
      }
    }
  }
  if (s.required !== undefined) {
    if (
      !Array.isArray(s.required) ||
      !s.required.every((r) => typeof r === "string")
    ) {
      bad("required", "an array of strings");
    }
  }
  if (s.enum !== undefined && !Array.isArray(s.enum)) bad("enum", "an array");
  for (const key of ["minimum", "maximum"]) {
    const v = s[key];
    if (v !== undefined && (typeof v !== "number" || !Number.isFinite(v))) {
      bad(key, "a number");
    }
  }
  for (const key of NON_NEGATIVE_INTEGER_KEYWORDS) {
    const v = s[key];
    if (v !== undefined && !(Number.isInteger(v) && (v as number) >= 0)) {
      bad(key, "a non-negative integer");
    }
  }
  if (s.pattern !== undefined) {
    if (typeof s.pattern !== "string") bad("pattern", "a string");
    const source = s.pattern as string;
    if (hasNestedQuantifiers(source)) {
      throw new Error(`${path}/pattern: pattern has nested quantifiers`);
    }
    try {
      patterns.set(s, new RegExp(source));
    } catch (e) {
      throw new Error(
        `${path}/pattern: invalid pattern: ${e instanceof Error ? e.message : String(e)}`,
      );
    }
  }
  if (s.$ref !== undefined) {
    if (typeof s.$ref !== "string") bad("$ref", "a string");
    resolveRef(s.$ref as string, root, `${path}/$ref`);
  }
  if (s.items !== undefined) {
    if (!isObject(s.items)) bad("items", "a schema");
    walkSchema(s.items, `${path}/items`, root, depth + 1);
  }
  const ap = s.additionalProperties;
  if (ap !== undefined && typeof ap !== "boolean") {
    walkSchema(ap, `${path}/additionalProperties`, root, depth + 1);
  }
  subschemaMap("properties");
  subschemaMap("$defs");
  subschemaList("oneOf");
  subschemaList("anyOf");
}

/**
 * Walks the whole schema once and throws `Error("<pointer>: <message>")` for
 * anything the validator cannot honour: unknown keywords or types, malformed
 * keyword values, unresolvable or non-local `$ref`, and unsafe or invalid
 * patterns. Pointers locate the offending node inside the schema.
 */
export function checkSchema(schema: JsonSchema): void {
  if (checked.has(schema)) return;
  walkSchema(schema, "", schema, 0);
  checked.add(schema);
}

function check(
  schema: JsonSchema,
  value: unknown,
  path: string,
  root: JsonSchema,
  errors: string[],
  depth: number,
  active: readonly string[],
): void {
  if (depth > MAX_DEPTH) {
    throw new Error(`${path}: schema nesting deeper than ${MAX_DEPTH}`);
  }
  if (++steps > MAX_VALIDATION_STEPS) {
    throw new Error(
      `${path}: schema evaluation too large (over ${MAX_VALIDATION_STEPS} steps)`,
    );
  }
  // Same value, same schema position: refs followed so far stay active.
  const same = (s: JsonSchema, sub: string[]) =>
    check(s, value, path, root, sub, depth + 1, active);
  const fail = (msg: string) => errors.push(`${path}: ${msg}`);

  if (schema.$ref !== undefined) {
    if (active.includes(schema.$ref)) {
      throw new Error(`${path}: $ref cycle at ${schema.$ref}`);
    }
    check(
      resolveRef(schema.$ref, root, path),
      value,
      path,
      root,
      errors,
      depth + 1,
      [...active, schema.$ref],
    );
  }

  if (schema.type !== undefined) {
    const types = Array.isArray(schema.type) ? schema.type : [schema.type];
    if (!types.some((t) => matchesType(t, value))) {
      fail(`must be ${types.join(" or ")}`);
      return;
    }
  }
  if (schema.enum && !schema.enum.some((e) => deepEqual(e, value))) {
    fail(`must be one of ${JSON.stringify(schema.enum)}`);
  }
  if ("const" in schema && !deepEqual(schema.const, value)) {
    fail(`must equal ${JSON.stringify(schema.const)}`);
  }

  if (schema.anyOf) {
    const hit = schema.anyOf.some((s) => {
      const sub: string[] = [];
      same(s, sub);
      return sub.length === 0;
    });
    if (!hit) fail("must match at least one of anyOf");
  }
  if (schema.oneOf) {
    const n = schema.oneOf.filter((s) => {
      const sub: string[] = [];
      same(s, sub);
      return sub.length === 0;
    }).length;
    if (n !== 1) fail(`must match exactly one of oneOf (matched ${n})`);
  }

  if (typeof value === "number") {
    if (schema.minimum !== undefined && value < schema.minimum) {
      fail(`must be >= ${schema.minimum}`);
    }
    if (schema.maximum !== undefined && value > schema.maximum) {
      fail(`must be <= ${schema.maximum}`);
    }
  }

  if (typeof value === "string") {
    const len = [...value].length;
    if (schema.minLength !== undefined && len < schema.minLength) {
      fail(`must have at least ${schema.minLength} characters`);
    }
    if (schema.maxLength !== undefined && len > schema.maxLength) {
      fail(`must have at most ${schema.maxLength} characters`);
    }
    if (schema.pattern !== undefined) {
      const re = patterns.get(schema) ?? new RegExp(schema.pattern);
      if (!re.test(value)) fail(`must match pattern ${schema.pattern}`);
    }
  }

  if (Array.isArray(value)) {
    if (schema.minItems !== undefined && value.length < schema.minItems) {
      fail(`must have at least ${schema.minItems} items`);
    }
    if (schema.maxItems !== undefined && value.length > schema.maxItems) {
      fail(`must have at most ${schema.maxItems} items`);
    }
    const items = schema.items;
    if (items) {
      value.forEach((v, i) => {
        check(items, v, `${path}/${i}`, root, errors, depth + 1, []);
      });
    }
  }

  if (isObject(value)) {
    const props = schema.properties ?? {};
    for (const name of schema.required ?? []) {
      if (!Object.hasOwn(value, name)) {
        errors.push(`${path}/${escapeSegment(name)}: is required`);
      }
    }
    for (const [name, v] of Object.entries(value)) {
      const at = `${path}/${escapeSegment(name)}`;
      if (Object.hasOwn(props, name)) {
        check(props[name] as JsonSchema, v, at, root, errors, depth + 1, []);
      } else if (schema.additionalProperties === false) {
        errors.push(`${at}: unexpected property`);
      } else if (isObject(schema.additionalProperties)) {
        check(
          schema.additionalProperties as JsonSchema,
          v,
          at,
          root,
          errors,
          depth + 1,
          [],
        );
      }
    }
  }
}

/**
 * Returns an empty array when valid; each error is `"<json-pointer>: <message>"`.
 * Throws when the schema itself is unusable (see checkSchema).
 */
export function validateJson(
  schema: JsonSchema,
  value: unknown,
  path = "",
): string[] {
  checkSchema(schema);
  const errors: string[] = [];
  steps = 0;
  check(schema, value, path, schema, errors, 0, []);
  return errors;
}

const SHORTHAND_TYPES = [
  "string",
  "integer",
  "number",
  "boolean",
  "object",
  "array",
];

/** `{ issue: "integer", note: "string?" }` becomes a closed object schema; `?` marks optional. */
export function fieldsShorthandToSchema(
  fields: Record<string, string>,
): JsonSchema {
  const properties: Record<string, JsonSchema> = {};
  const required: string[] = [];
  for (const [name, spec] of Object.entries(fields)) {
    const optional = spec.endsWith("?");
    const base = optional ? spec.slice(0, -1) : spec;
    if (base === "string[]") {
      properties[name] = { type: "array", items: { type: "string" } };
    } else if (SHORTHAND_TYPES.includes(base)) {
      properties[name] = { type: base };
    } else {
      throw new Error(`unsupported field type "${spec}" for field ${name}`);
    }
    if (!optional) required.push(name);
  }
  return {
    type: "object",
    properties,
    required,
    additionalProperties: false,
  };
}
