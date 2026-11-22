import { parseArgs } from "node:util";
import { loadDefinition } from "../../format/load.js";
import { renderMermaid } from "../../render/mermaid.js";
import type { Io } from "../main.js";

export const RENDER_USAGE = "sekaisen render <file> [--current <stage>]";

/** Prints a Mermaid state diagram of one definition. */
export async function renderCommand(args: string[], io: Io): Promise<number> {
  let parsed: ReturnType<
    typeof parseArgs<{
      options: { current: { type: "string" }; help: { type: "boolean" } };
      allowPositionals: true;
    }>
  >;
  try {
    parsed = parseArgs({
      args,
      options: { current: { type: "string" }, help: { type: "boolean" } },
      allowPositionals: true,
    });
  } catch (x) {
    io.err(`${(x as Error).message}\nusage: ${RENDER_USAGE}\n`);
    return 2;
  }
  if (parsed.values.help) {
    io.out(`usage: ${RENDER_USAGE}\n`);
    return 0;
  }
  const [file, ...extra] = parsed.positionals;
  if (file === undefined || extra.length > 0) {
    io.err(`usage: ${RENDER_USAGE}\n`);
    return 2;
  }
  let loaded: Awaited<ReturnType<typeof loadDefinition>>;
  try {
    loaded = await loadDefinition(file);
  } catch (x) {
    io.err(`${file}: error load ${(x as Error).message}\n`);
    return 1;
  }
  const current = parsed.values.current;
  if (current !== undefined && !(current in loaded.def.stages)) {
    io.err(`${file}: error no stage named ${current}\n`);
    return 1;
  }
  io.out(renderMermaid(loaded.def, current === undefined ? {} : { current }));
  return 0;
}
