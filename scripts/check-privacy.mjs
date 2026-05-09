import { readFile, readdir } from "node:fs/promises";
import path from "node:path";

const roots = ["src", "webview-src"];
const denyPatterns = [
  /\bfetch\s*\(/,
  /\bXMLHttpRequest\b/,
  /\bhttp\.request\b/,
  /\bhttps\.request\b/,
  /\bfrom\s+["']node:net["']/,
  /\bfrom\s+["']node:tls["']/,
  /\btelemetry\b/i,
  /\boauth\b/i,
  /\bupload\b/i,
  /\bsync\b/i,
  /\bcloud\b/i,
];

const files = [];
for (const root of roots) {
  files.push(...(await listFiles(root)));
}

const failures = [];
for (const file of files) {
  const content = await readFile(file, "utf8");
  for (const pattern of denyPatterns) {
    if (pattern.test(content)) {
      failures.push(`${file} matched privacy deny pattern ${pattern}`);
    }
  }
}

if (failures.length > 0) {
  console.error(failures.join("\n"));
  process.exit(1);
}

console.log(`privacy static check ok: scanned ${files.length} runtime files`);

async function listFiles(root) {
  const entries = await readdir(root, { withFileTypes: true });
  const result = [];
  for (const entry of entries) {
    const fullPath = path.join(root, entry.name);
    if (entry.isDirectory()) {
      result.push(...(await listFiles(fullPath)));
    } else if (/\.(ts|js|css|html)$/.test(entry.name)) {
      result.push(fullPath);
    }
  }
  return result;
}
