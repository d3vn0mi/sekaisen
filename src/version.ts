import { readFileSync } from "node:fs";

/**
 * The package's version, read from its package.json, which sits one folder
 * up both from `src` and from the built `dist`.
 */
export const VERSION: string = (
  JSON.parse(
    readFileSync(new URL("../package.json", import.meta.url), "utf8"),
  ) as { version: string }
).version;
