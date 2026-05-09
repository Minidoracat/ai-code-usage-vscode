import { readFile, readdir } from "node:fs/promises";
import path from "node:path";

const roots = ["test"];

const denyPatterns = [
  { pattern: /Minidoracat/i, reason: "real local username" },
  { pattern: /\/root\/\.?(claude|codex)\b/i, reason: "real root usage path" },
  { pattern: /\/home\/(?!FixtureUser\b)[^/"'`\s]+\/\.?(claude|codex)\b/i, reason: "real POSIX usage path" },
  { pattern: /\/Users\/(?!FixtureUser\b)[^/"'`\s]+\/\.?(claude|codex)\b/i, reason: "real macOS usage path" },
  { pattern: /[A-Za-z]:\\Users\\(?!FixtureUser\b)[^\\/"'`\s]+\\\.?(claude|codex)\b/i, reason: "real Windows usage path" },
  { pattern: /\b[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\b/i, reason: "real-looking UUID session id" },
  { pattern: /\b(sk-[A-Za-z0-9_-]{16,}|ghp_[A-Za-z0-9_]{16,}|xox[baprs]-[A-Za-z0-9-]{16,})\b/, reason: "secret-looking token" },
  { pattern: /\bBearer\s+[A-Za-z0-9._~+/=-]{16,}/i, reason: "bearer token" },
];

const files = [];
for (const root of roots) {
  files.push(...(await listFiles(root)));
}

const failures = [];
for (const file of files) {
  const content = await readFile(file, "utf8");
  for (const { pattern, reason } of denyPatterns) {
    if (pattern.test(content)) {
      failures.push(`${file} contains ${reason}: ${pattern}`);
    }
  }
}

if (failures.length > 0) {
  console.error(failures.join("\n"));
  process.exit(1);
}

console.log(`test data check ok: scanned ${files.length} files, no real local usage data patterns found`);

async function listFiles(root) {
  const entries = await readdir(root, { withFileTypes: true });
  const result = [];
  for (const entry of entries) {
    const fullPath = path.join(root, entry.name);
    if (entry.isDirectory()) {
      result.push(...(await listFiles(fullPath)));
    } else if (/\.(ts|js|json|jsonl|md|txt)$/.test(entry.name)) {
      result.push(fullPath);
    }
  }
  return result;
}
