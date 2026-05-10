import { readFileSync } from "node:fs";

const packageJson = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8"));
const packageVersion = String(packageJson.version ?? "");
const rawTag =
  process.env.RELEASE_TAG ||
  process.env.GITHUB_EVENT_RELEASE_TAG_NAME ||
  process.env.GITHUB_REF_NAME ||
  process.env.GITHUB_REF ||
  "";
const tag = rawTag.replace(/^refs\/tags\//, "");

if (!/^\d+\.\d+\.\d+$/.test(packageVersion)) {
  fail(`package.json version must be plain SemVer x.y.z, got "${packageVersion}".`);
}

if (!/^v\d+\.\d+\.\d+$/.test(tag)) {
  fail(`release tag must look like v${packageVersion}, got "${rawTag || "(empty)"}".`);
}

if (tag !== `v${packageVersion}`) {
  fail(`release tag "${tag}" does not match package.json version "${packageVersion}".`);
}

console.log(`release version ok: ${tag} matches package.json ${packageVersion}`);

function fail(message) {
  console.error(message);
  process.exit(1);
}
