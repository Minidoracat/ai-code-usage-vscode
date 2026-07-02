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

// The only sanctioned network call: user-triggered public exchange-rate
// updates. Any other file using fetch still fails the check, and the
// sanctioned file may only reference the pinned host below.
const allowedPatterns = new Map([["src/services/ExchangeRateService.ts", [String.raw`\bfetch\s*\(`]]]);
const allowedHost = "https://open.er-api.com/";

const failures = [];
for (const file of files) {
  const content = await readFile(file, "utf8");
  const allowed = allowedPatterns.get(file.split(path.sep).join("/")) ?? [];
  for (const pattern of denyPatterns) {
    if (allowed.includes(pattern.source)) {
      continue;
    }
    if (pattern.test(content)) {
      failures.push(`${file} matched privacy deny pattern ${pattern}`);
    }
  }
  if (allowed.length > 0) {
    for (const url of content.match(/https?:\/\/[^\s"'`)]+/g) ?? []) {
      if (!url.startsWith(allowedHost)) {
        failures.push(`${file} references non-allowlisted URL ${url}`);
      }
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
    } else if (/\.(ts|tsx|js|jsx|mjs|css|html)$/.test(entry.name)) {
      result.push(fullPath);
    }
  }
  return result;
}
