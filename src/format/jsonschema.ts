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

function resolveRef(ref: string, root: JsonSchema): JsonSchema {
  if (!ref.startsWith(REF_PREFIX)) {
    throw new Error(`unsupported $ref: ${ref} (only #/$defs/<name>)`);
  }
  const name = ref.slice(REF_PREFIX.length);
  const target =
    root.$defs && Object.hasOwn(root.$defs, name)
      ? root.$defs[name]
      : undefined;
  if (target === undefined) throw new Error(`unresolved $ref: ${ref}`);
  return target;
}

function check(
  schema: JsonSchema,
  value: unknown,
  path: string,
  root: JsonSchema,
  errors: string[],
): void {
  for (const key of Object.keys(schema)) {
    if (!SUPPORTED_KEYWORDS.includes(key)) {
      throw new Error(`unsupported JSON Schema keyword: ${key}`);
    }
  }
  const fail = (msg: string) => errors.push(`${path}: ${msg}`);

  if (schema.$ref !== undefined) {
    check(resolveRef(schema.$ref, root), value, path, root, errors);
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
      check(s, value, path, root, sub);
      return sub.length === 0;
    });
    if (!hit) fail("must match at least one of anyOf");
  }
  if (schema.oneOf) {
    const n = schema.oneOf.filter((s) => {
      const sub: string[] = [];
      check(s, value, path, root, sub);
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
    if (
      schema.pattern !== undefined &&
      !new RegExp(schema.pattern, "u").test(value)
    ) {
      fail(`must match pattern ${schema.pattern}`);
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
        check(items, v, `${path}/${i}`, root, errors);
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
        check(props[name] as JsonSchema, v, at, root, errors);
      } else if (schema.additionalProperties === false) {
        errors.push(`${at}: unexpected property`);
      } else if (isObject(schema.additionalProperties)) {
        check(schema.additionalProperties as JsonSchema, v, at, root, errors);
      }
    }
  }
}

/** Returns an empty array when valid; each error is `"<json-pointer>: <message>"`. */
export function validateJson(
  schema: JsonSchema,
  value: unknown,
  path = "",
): string[] {
  const errors: string[] = [];
  check(schema, value, path, schema, errors);
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
