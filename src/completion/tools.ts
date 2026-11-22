import type { Engine } from "../engine/engine.js";
import type { JsonSchema } from "../format/jsonschema.js";

/** Who is calling a tool, as the harness reports it. */
export interface ToolCaller {
  agent?: string;
}

export interface ToolResult {
  text: string;
  isError: boolean;
}

/** A tool described without reference to any harness; adapters wrap it. */
export interface CompletionTool {
  name: string;
  description: string;
  inputSchema: JsonSchema;
  handler(args: unknown, caller?: ToolCaller): Promise<ToolResult>;
}

function asObject(args: unknown): Record<string, unknown> | undefined {
  return typeof args === "object" && args !== null && !Array.isArray(args)
    ? (args as Record<string, unknown>)
    : undefined;
}

const error = (text: string): ToolResult => ({ text, isError: true });

export function stageCompleteTool(
  engine: Pick<Engine, "complete">,
): CompletionTool {
  return {
    name: "stage_complete",
    description:
      "Report the result of your pipeline stage: the completion token from your brief, one of the outcomes it lists, and that outcome's fields.",
    inputSchema: {
      type: "object",
      properties: {
        token: { type: "string" },
        outcome: { type: "string" },
        fields: { type: "object" },
        artifacts: { type: "array", items: { type: "string" } },
      },
      required: ["token", "outcome"],
      additionalProperties: false,
    },
    async handler(args, caller) {
      const a = asObject(args);
      if (!a) return error("arguments must be an object");
      if (typeof a.token !== "string") return error("token must be a string");
      if (typeof a.outcome !== "string") {
        return error("outcome must be a string naming a declared outcome");
      }
      const artifacts = a.artifacts;
      if (
        artifacts !== undefined &&
        (!Array.isArray(artifacts) ||
          !artifacts.every((x) => typeof x === "string"))
      ) {
        return error("artifacts must be a list of strings");
      }
      const result = await engine.complete({
        token: a.token,
        outcome: a.outcome,
        fields: a.fields,
        ...(artifacts === undefined ? {} : { artifacts }),
        ...(caller?.agent === undefined ? {} : { callerAgent: caller.agent }),
      });
      if (!result.ok) return error(result.error);
      const lead =
        result.applied === "already"
          ? `Already recorded: outcome ${a.outcome}.`
          : `Recorded outcome ${a.outcome}.`;
      return {
        text: `${lead} Your part of this stage is done; you can end your turn.`,
        isError: false,
      };
    },
  };
}

export function stageProgressTool(
  engine: Pick<Engine, "progress">,
): CompletionTool {
  return {
    name: "stage_progress",
    description:
      "Save a checkpoint for your pipeline stage when you cannot finish in this turn: what is done, what is next, and where the work lives.",
    inputSchema: {
      type: "object",
      properties: {
        token: { type: "string" },
        note: { type: "string" },
      },
      required: ["token", "note"],
      additionalProperties: false,
    },
    async handler(args, caller) {
      const a = asObject(args);
      if (!a) return error("arguments must be an object");
      if (typeof a.token !== "string") return error("token must be a string");
      if (typeof a.note !== "string") return error("note must be a string");
      const result = await engine.progress({
        token: a.token,
        note: a.note,
        ...(caller?.agent === undefined ? {} : { callerAgent: caller.agent }),
      });
      if (!result.ok) return error(result.error);
      return {
        text: "Checkpoint saved. A later turn starts from this note.",
        isError: false,
      };
    },
  };
}
