import assert from "node:assert/strict";
import { promises as fsp } from "node:fs";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { test } from "node:test";
import { ClaudeUsageAdapter } from "../src/adapters/ClaudeUsageAdapter";

const validLines = [
  JSON.stringify({ provider: "claude", model: "claude-sonnet-4-6", sessionId: "claude-a", startedAt: "2026-04-30T08:00:00.000Z", tokens: { input: 1200, output: 400 } }),
  JSON.stringify({ provider: "claude", model: "claude-sonnet-4-6", sessionId: "claude-a", startedAt: "2026-04-30T08:06:00.000Z", tokens: { input: 800, output: 200 } }),
].join("\n");

/**
 * Makes fs.stat report a growing size for `target` on its first
 * `unstableCalls` calls, simulating a writer appending to the file while it is
 * read (every line still parses, so only the stat fingerprint reveals it).
 */
function patchGrowingStat(target: string, unstableCalls: number): () => void {
  const real = fsp.stat;
  const handle = fsp as { stat: unknown };
  let calls = 0;
  handle.stat = async (statPath: string) => {
    const stat = await real(statPath);
    if (path.resolve(statPath) === path.resolve(target) && calls < unstableCalls) {
      calls += 1;
      stat.size += calls;
      stat.mtimeMs += calls;
    }
    return stat;
  };
  return () => {
    handle.stat = real;
  };
}

test("JSONL grown during every read attempt is skipped instead of imported partially", async () => {
  const dir = await mkdtemp(path.join(tmpdir(), "ai-code-usage-jsonl-stability-"));
  const filePath = path.join(dir, "session.jsonl");
  await writeFile(filePath, `${validLines}\n`);
  const restore = patchGrowingStat(filePath, 10);
  try {
    const result = await new ClaudeUsageAdapter(filePath).importUsageFile(filePath);

    assert.equal(result.records.length, 0);
    assert.equal(result.errors.length, 0);
    assert.ok(result.warnings.some((warning) => warning.code === "file_transient"));
  } finally {
    restore();
    await rm(dir, { recursive: true, force: true });
  }
});

test("JSONL that stops growing before the retry imports every record", async () => {
  const dir = await mkdtemp(path.join(tmpdir(), "ai-code-usage-jsonl-settled-"));
  const filePath = path.join(dir, "session.jsonl");
  await writeFile(filePath, `${validLines}\n`);
  const restore = patchGrowingStat(filePath, 1);
  try {
    const result = await new ClaudeUsageAdapter(filePath).importUsageFile(filePath);

    assert.equal(result.records.length, 2);
    assert.equal(result.errors.length, 0);
    assert.equal(result.warnings.some((warning) => warning.code === "file_transient"), false);
  } finally {
    restore();
    await rm(dir, { recursive: true, force: true });
  }
});
