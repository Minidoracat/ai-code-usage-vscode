// Vendors the sql.js wasm runtime into media/ so the packaged extension can
// read SQLite usage stores (grok-cli) without native modules or node_modules.
import { copyFile, mkdir } from "node:fs/promises";
import { createRequire } from "node:module";
import path from "node:path";

const require = createRequire(import.meta.url);
const dist = path.dirname(require.resolve("sql.js/dist/sql-wasm.js"));
await mkdir("media/sqljs", { recursive: true });
for (const name of ["sql-wasm.js", "sql-wasm.wasm"]) {
  await copyFile(path.join(dist, name), path.join("media/sqljs", name));
}
// MIT requires the notice to travel with redistributed copies.
await copyFile(path.join(dist, "..", "LICENSE"), "media/sqljs/LICENSE");
