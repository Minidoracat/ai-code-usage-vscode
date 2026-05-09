import { readFileSync, readdirSync, statSync } from "node:fs";
import path from "node:path";

const packageName = "ai-code-usage";
const vsixPath = process.argv[2] ?? findLatestVsix();

if (!vsixPath) {
  console.error("No .vsix file found. Run npm run package:vsix first.");
  process.exit(1);
}

const entries = listVsixEntries(vsixPath);
const failures = [];

const denyPatterns = [
  /^extension\/\.omx(\/|$)/,
  /^extension\/\.omc(\/|$)/,
  /^extension\/\.codex(\/|$)/,
  /^extension\/\.claude(\/|$)/,
  /^extension\/\.gitnexus(\/|$)/,
  /^extension\/\.github(\/|$)/,
  /^extension\/\.vscode(\/|$)/,
  /^extension\/AGENTS\.md$/i,
  /^extension\/CLAUDE\.md$/i,
  /^extension\/test(\/|$)/,
  /^extension\/fixtures(\/|$)/,
  /^extension\/scripts(\/|$)/,
  /^extension\/src(\/|$)/,
  /^extension\/webview-src(\/|$)/,
  /^extension\/node_modules(\/|$)/,
  /^extension\/out\/test(\/|$)/,
  /^extension\/media\/.*\.map$/i,
  /^extension\/out\/.*\.map$/i,
];

for (const entry of entries) {
  if (denyPatterns.some((pattern) => pattern.test(entry))) {
    failures.push(`Unexpected file in VSIX: ${entry}`);
  }
}

const requiredGroups = [
  ["extension/package.json"],
  ["extension/readme.md", "extension/README.md"],
  ["extension/LICENSE", "extension/LICENSE.md", "extension/LICENSE.txt", "extension/license", "extension/license.md", "extension/license.txt"],
  ["extension/CHANGELOG.md", "extension/changelog.md"],
  ["extension/out/src/extension.js"],
  ["extension/media/main.js"],
  ["extension/media/main.css"],
  ["extension/resources/icon.png"],
];

for (const group of requiredGroups) {
  if (!group.some((required) => entries.includes(required))) {
    failures.push(`Missing required VSIX file: ${group.join(" or ")}`);
  }
}

if (failures.length > 0) {
  console.error(failures.join("\n"));
  process.exit(1);
}

console.log(`vsix inspection ok: ${path.basename(vsixPath)} (${entries.length} entries)`);

function findLatestVsix() {
  const candidates = readdirSync(process.cwd())
    .filter((file) => file.startsWith(`${packageName}-`) && file.endsWith(".vsix"))
    .map((file) => ({ file, mtime: statSync(file).mtimeMs }))
    .sort((a, b) => b.mtime - a.mtime);
  return candidates[0]?.file;
}

function listVsixEntries(file) {
  const data = readFileSync(file);
  const eocdOffset = findEndOfCentralDirectory(data);

  if (eocdOffset < 0) {
    console.error(`Unable to inspect VSIX contents: ${file} is not a valid ZIP archive.`);
    process.exit(1);
  }

  const entryCount = data.readUInt16LE(eocdOffset + 10);
  const centralDirectoryOffset = data.readUInt32LE(eocdOffset + 16);
  const entries = [];
  let offset = centralDirectoryOffset;

  for (let index = 0; index < entryCount; index += 1) {
    if (data.readUInt32LE(offset) !== 0x02014b50) {
      console.error(`Unable to inspect VSIX contents: invalid central directory header at ${offset}.`);
      process.exit(1);
    }

    const fileNameLength = data.readUInt16LE(offset + 28);
    const extraLength = data.readUInt16LE(offset + 30);
    const commentLength = data.readUInt16LE(offset + 32);
    const nameStart = offset + 46;
    const nameEnd = nameStart + fileNameLength;
    entries.push(data.subarray(nameStart, nameEnd).toString("utf8"));
    offset = nameEnd + extraLength + commentLength;
  }

  return entries;
}

function findEndOfCentralDirectory(data) {
  const minimumEocdSize = 22;
  const maxCommentSize = 0xffff;
  const searchStart = Math.max(0, data.length - minimumEocdSize - maxCommentSize);

  for (let offset = data.length - minimumEocdSize; offset >= searchStart; offset -= 1) {
    if (data.readUInt32LE(offset) === 0x06054b50) {
      return offset;
    }
  }

  return -1;
}
