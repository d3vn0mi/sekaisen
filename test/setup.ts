// node:sqlite prints an ExperimentalWarning on the Node 22 line. Drop exactly
// that warning so test output stays clean; every other warning still prints.
const emitWarning = process.emitWarning.bind(process);

process.emitWarning = ((warning: string | Error, ...args: unknown[]) => {
  const text = typeof warning === "string" ? warning : warning.message;
  const type =
    typeof warning === "string"
      ? (args[0] as string | { type?: string } | undefined)
      : warning.name;
  const name = typeof type === "object" ? type?.type : type;
  if (name === "ExperimentalWarning" && /SQLite/i.test(text)) return;
  return (emitWarning as (...a: unknown[]) => void)(warning, ...args);
}) as typeof process.emitWarning;
