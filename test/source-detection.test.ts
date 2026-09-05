import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { test } from "node:test";
import { isNativeUsagePath, SourceDetectionService, usageSourceCandidates } from "../src/services/SourceDetectionService";

test("source detection previews existing Claude and Codex usage roots", async () => {
  const home = await mkdtemp(path.join(tmpdir(), "ai-code-usage-home-"));
  try {
    const claudePath = path.join(home, ".claude", "projects", "repo");
    const codexPath = path.join(home, ".codex", "sessions", "2026", "05", "01");
    await mkdir(claudePath, { recursive: true });
    await mkdir(codexPath, { recursive: true });
    await writeFile(path.join(claudePath, "session.jsonl"), "{}\n");
    await writeFile(path.join(codexPath, "session.jsonl"), "{}\n");

    const detected = await new SourceDetectionService(home, {}).detect();

    assert.equal(detected.length, 2);
    assert.equal(detected.find((source) => source.provider === "claude")?.files, 1);
    assert.equal(detected.find((source) => source.provider === "codex")?.files, 1);
  } finally {
    await rm(home, { recursive: true, force: true });
  }
});

test("source detection builds Windows home candidates", () => {
  const candidates = usageSourceCandidates("C:\\Users\\FixtureUser", { USERPROFILE: "C:\\Users\\FixtureUser" }, "win32");

  assert.ok(candidates.some((source) => source.provider === "claude" && source.sourcePath === "C:\\Users\\FixtureUser\\.claude\\projects"));
  assert.ok(candidates.some((source) => source.provider === "codex" && source.sourcePath === "C:\\Users\\FixtureUser\\.codex\\sessions"));
});

test("source detection ignores POSIX home roots on Windows", () => {
  const candidates = usageSourceCandidates("C:\\Users\\FixtureUser", { HOME: "/posix-fixture-home", USERPROFILE: "C:\\Users\\FixtureUser" }, "win32");

  assert.equal(candidates.some((source) => source.sourcePath.includes("\\root\\")), false);
  assert.ok(candidates.every((source) => source.sourcePath.startsWith("C:\\Users\\FixtureUser\\")));
});

test("pi candidates prefer PI_CODING_AGENT_DIR, then omp, pi CLI, and vscode-pi storage, without duplicates", () => {
  const home = path.join(tmpdir(), "u");
  const storage = path.join(home, "globalStorage");
  const env = { HOME: home, PI_CODING_AGENT_DIR: path.join(home, ".omp", "agent") };
  const pi = usageSourceCandidates(home, env, process.platform, storage)
    .filter((source) => source.provider === "pi")
    .map((source) => source.sourcePath);

  assert.deepEqual(pi, [
    path.join(home, ".omp", "agent", "sessions"),
    path.join(home, ".pi", "agent", "sessions"),
    path.join(storage, "cdervis.vscode-pi", "bundled-pi-agent", "sessions"),
  ]);
});

test("source detection keeps only the first existing pi root", async () => {
  const home = await mkdtemp(path.join(tmpdir(), "ai-code-usage-home-"));
  try {
    for (const root of [".omp", ".pi"]) {
      const dir = path.join(home, root, "agent", "sessions", "proj");
      await mkdir(dir, { recursive: true });
      await writeFile(path.join(dir, "session.jsonl"), "{}\n");
    }

    const detected = await new SourceDetectionService(home, {}).detect();

    assert.deepEqual(
      detected.filter((source) => source.provider === "pi").map((source) => source.sourcePath),
      [path.join(home, ".omp", "agent", "sessions")],
    );
  } finally {
    await rm(home, { recursive: true, force: true });
  }
});

test("native usage path validation rejects cross-platform synced paths", () => {
  assert.equal(isNativeUsagePath("/posix-fixture-home/.claude/projects", "win32"), false);
  assert.equal(isNativeUsagePath("C:\\Users\\FixtureUser\\.codex\\sessions", "win32"), true);
  assert.equal(isNativeUsagePath("test/fixtures/claude", "win32"), true);
  assert.equal(isNativeUsagePath("C:\\Users\\FixtureUser\\.codex\\sessions", "linux"), false);
  assert.equal(isNativeUsagePath("/posix-fixture-home/.codex/sessions", "linux"), true);
});
