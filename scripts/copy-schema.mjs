// Copies the definition schema next to the compiled loader.
// Usage: node scripts/copy-schema.mjs [distDir]
import { copyFileSync, mkdirSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const dist = path.resolve(process.argv[2] ?? path.join(root, "dist"));
mkdirSync(path.join(dist, "format"), { recursive: true });
copyFileSync(
  path.join(root, "src/format/schema.json"),
  path.join(dist, "format/schema.json"),
);
