import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { test } from "node:test";
import { ClaudeUsageAdapter } from "../src/adapters/ClaudeUsageAdapter";
import { CodexUsageAdapter } from "../src/adapters/CodexUsageAdapter";

test("Claude adapter imports valid JSONL with source metadata", async () => {
  const result = await new ClaudeUsageAdapter("test/fixtures/claude/valid.jsonl").importUsage();

  assert.equal(result.provider, "claude");
  assert.equal(result.records.length, 2);
  assert.equal(result.errors.length, 0);
  assert.equal(result.records[0]?.provider, "claude");
  assert.equal(result.records[0]?.model, "claude-sonnet-4-6");
  assert.equal(result.records[0]?.tokens.input, 1200);
  assert.equal(result.sourceMeta[0]?.sourceKind, "jsonl");
  assert.ok(result.sourceMeta[0]?.parserVersion);
});

test("Codex adapter imports valid JSON array", async () => {
  const result = await new CodexUsageAdapter("test/fixtures/codex/valid.json").importUsage();

  assert.equal(result.provider, "codex");
  assert.equal(result.records.length, 2);
  assert.equal(result.records[0]?.tokens.cachedInput, 500);
});

test("adapter imports token-bearing partial records and skips model-only noise", async () => {
  const result = await new ClaudeUsageAdapter("test/fixtures/claude/partial.json").importUsage();

  assert.equal(result.records.length, 1);
  assert.equal(result.warnings.some((warning) => warning.code === "missing_model"), false);
  assert.equal(result.warnings.some((warning) => warning.code === "missing_tokens"), false);
});

test("malformed JSONL does not drop valid records", async () => {
  const result = await new ClaudeUsageAdapter("test/fixtures/claude/malformed.jsonl").importUsage();

  assert.equal(result.records.length, 1);
  assert.ok(result.errors.some((error) => error.code === "malformed_jsonl" && error.line === 2));
});

test("missing path becomes import error", async () => {
  const result = await new CodexUsageAdapter("test/fixtures/nope.json").importUsage();

  assert.equal(result.records.length, 0);
  assert.ok(result.errors.some((error) => error.code === "path_unreadable"));
});

test("empty directory reports actionable warning", async () => {
  const dir = await mkdtemp(path.join(tmpdir(), "ai-code-usage-empty-"));
  try {
    const result = await new ClaudeUsageAdapter(dir).importUsage();
    assert.equal(result.records.length, 0);
    assert.ok(result.warnings.some((warning) => warning.code === "empty_directory"));
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("directory imports JSON and JSONL files only", async () => {
  const dir = await mkdtemp(path.join(tmpdir(), "ai-code-usage-dir-"));
  try {
    await writeFile(path.join(dir, "usage.json"), JSON.stringify([{ model: "gpt-5.5", sessionId: "a", inputTokens: 1, startedAt: "2026-04-30" }]));
    await writeFile(path.join(dir, "notes.txt"), "ignored");
    const result = await new CodexUsageAdapter(dir).importUsage();
    assert.equal(result.records.length, 1);
    assert.equal(result.records[0]?.provider, "codex");
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("Claude adapter imports Claude Code transcript usage rows", async () => {
  const dir = await mkdtemp(path.join(tmpdir(), "ai-code-usage-claude-transcript-"));
  try {
    await writeFile(
      path.join(dir, "session.jsonl"),
      [
        JSON.stringify({ type: "user", timestamp: "2026-04-30T08:00:00.000Z", sessionId: "fixture-claude-session" }),
        JSON.stringify({
          type: "assistant",
          timestamp: "2026-04-30T08:01:00.000Z",
          sessionId: "fixture-claude-session",
          message: {
            model: "claude-sonnet-4-6",
            usage: {
              input_tokens: 1000,
              cache_creation_input_tokens: 200,
              cache_read_input_tokens: 50,
              output_tokens: 300,
            },
          },
        }),
      ].join("\n"),
    );

    const result = await new ClaudeUsageAdapter(dir).importUsage();

    assert.equal(result.records.length, 1);
    assert.equal(result.records[0]?.model, "claude-sonnet-4-6");
    assert.equal(result.records[0]?.tokens.input, 1000);
    assert.equal(result.records[0]?.tokens.cacheWrite5m, 200);
    assert.equal(result.records[0]?.tokens.cacheRead, 50);
    assert.equal(result.records[0]?.tokens.output, 300);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("Claude adapter skips zero-token synthetic transcript rows", async () => {
  const dir = await mkdtemp(path.join(tmpdir(), "ai-code-usage-claude-synthetic-"));
  try {
    await writeFile(
      path.join(dir, "session.jsonl"),
      JSON.stringify({
        type: "assistant",
        timestamp: "2026-04-30T08:01:00.000Z",
        sessionId: "fixture-claude-session",
        message: {
          model: "<synthetic>",
          usage: {
            input_tokens: 0,
            cache_creation_input_tokens: 0,
            cache_read_input_tokens: 0,
            output_tokens: 0,
          },
        },
      }),
    );

    const result = await new ClaudeUsageAdapter(dir).importUsage();

    assert.equal(result.records.length, 0);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("Claude adapter splits nested cache creation durations", async () => {
  const dir = await mkdtemp(path.join(tmpdir(), "ai-code-usage-claude-cache-"));
  try {
    await writeFile(
      path.join(dir, "session.jsonl"),
      JSON.stringify({
        type: "assistant",
        timestamp: "2026-04-30T08:01:00.000Z",
        sessionId: "fixture-claude-session",
        message: {
          model: "claude-sonnet-4-6",
          usage: {
            input_tokens: 10,
            cache_creation_input_tokens: 700,
            cache_read_input_tokens: 30,
            output_tokens: 20,
            cache_creation: {
              ephemeral_5m_input_tokens: 200,
              ephemeral_1h_input_tokens: 500,
            },
          },
        },
      }),
    );

    const result = await new ClaudeUsageAdapter(dir).importUsage();

    assert.equal(result.records.length, 1);
    assert.equal(result.records[0]?.tokens.cacheWrite5m, 200);
    assert.equal(result.records[0]?.tokens.cacheWrite1h, 500);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("Codex adapter imports nested session directories", async () => {
  const dir = await mkdtemp(path.join(tmpdir(), "ai-code-usage-codex-sessions-"));
  try {
    const nested = path.join(dir, "2026", "05", "01");
    await mkdir(nested, { recursive: true });
    await writeFile(
      path.join(nested, "session.jsonl"),
      JSON.stringify({
        timestamp: "2026-05-01T02:00:00.000Z",
        session_id: "fixture-codex-session",
        response: {
          model: "gpt-5.5",
          usage: {
            input_tokens: 500,
            cached_input_tokens: 100,
            output_tokens: 80,
          },
        },
      }),
    );

    const result = await new CodexUsageAdapter(dir).importUsage();

    assert.equal(result.records.length, 1);
    assert.equal(result.records[0]?.sessionId, "fixture-codex-session");
    assert.equal(result.records[0]?.model, "gpt-5.5");
    assert.equal(result.records[0]?.tokens.cachedInput, 100);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("Codex adapter imports last token usage and falls back to rollout filename session", async () => {
  const dir = await mkdtemp(path.join(tmpdir(), "ai-code-usage-codex-rollout-"));
  try {
    const nested = path.join(dir, "2026", "05", "01");
    await mkdir(nested, { recursive: true });
    await writeFile(
      path.join(nested, "fixture-rollout-2026-05-01T00-00-00-abc123.jsonl"),
      [
        JSON.stringify({
          timestamp: "2026-05-01T00:00:00.000Z",
          type: "turn_context",
          payload: { model: "gpt-5.5" },
        }),
        JSON.stringify({
          timestamp: "2026-05-01T00:00:02.000Z",
          type: "event_msg",
          payload: {
            type: "token_count",
            info: {
              last_token_usage: {
                input_tokens: 42,
                cached_input_tokens: 7,
                output_tokens: 9,
              },
            },
          },
        }),
      ].join("\n"),
    );

    const result = await new CodexUsageAdapter(dir).importUsage();

    assert.equal(result.records.length, 1);
    assert.equal(result.records[0]?.sessionId, "fixture-rollout-2026-05-01T00-00-00-abc123");
    assert.equal(result.records[0]?.model, "gpt-5.5");
    assert.equal(result.records[0]?.tokens.input, 35);
    assert.equal(result.records[0]?.tokens.cachedInput, 7);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("Codex adapter tolerates recoverable escaped rollout lines", async () => {
  const dir = await mkdtemp(path.join(tmpdir(), "ai-code-usage-codex-escaped-line-"));
  try {
    await writeFile(
      path.join(dir, "rollout-escaped.jsonl"),
      [
        JSON.stringify({
          timestamp: "2026-05-01T00:00:00.000Z",
          type: "session_meta",
          payload: {
            id: "fixture-escaped-session",
          },
        }),
        `\\${JSON.stringify({
          timestamp: "2026-05-01T00:00:01.000Z",
          type: "event_msg",
          payload: {
            type: "task_started",
          },
        })}`,
        JSON.stringify({
          timestamp: "2026-05-01T00:00:02.000Z",
          type: "event_msg",
          payload: {
            type: "token_count",
            info: {
              last_token_usage: {
                input_tokens: 42,
                cached_input_tokens: 7,
                output_tokens: 9,
              },
            },
          },
        }),
      ].join("\n"),
    );

    const result = await new CodexUsageAdapter(dir).importUsage();

    assert.equal(result.records.length, 1);
    assert.equal(result.errors.some((error) => error.code === "malformed_jsonl"), false);
    assert.equal(result.records[0]?.sessionId, "fixture-escaped-session");
    assert.equal(result.records[0]?.tokens.input, 35);
    assert.equal(result.records[0]?.tokens.cachedInput, 7);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("Codex adapter imports cumulative token counts as deltas", async () => {
  const dir = await mkdtemp(path.join(tmpdir(), "ai-code-usage-codex-total-delta-"));
  try {
    await writeFile(
      path.join(dir, "rollout-total-delta.jsonl"),
      [
        JSON.stringify({
          timestamp: "2026-05-01T00:00:01.000Z",
          type: "event_msg",
          payload: {
            type: "token_count",
            info: {
              last_token_usage: {
                input_tokens: 100,
                cached_input_tokens: 40,
                output_tokens: 10,
              },
              total_token_usage: {
                input_tokens: 100,
                cached_input_tokens: 40,
                output_tokens: 10,
              },
            },
          },
        }),
        JSON.stringify({
          timestamp: "2026-05-01T00:00:02.000Z",
          type: "event_msg",
          payload: {
            type: "token_count",
            info: {
              last_token_usage: {
                input_tokens: 150,
                cached_input_tokens: 60,
                output_tokens: 15,
              },
              total_token_usage: {
                input_tokens: 150,
                cached_input_tokens: 60,
                output_tokens: 15,
              },
            },
          },
        }),
      ].join("\n"),
    );

    const result = await new CodexUsageAdapter(dir).importUsage();
    const totals = result.records.reduce(
      (sum, record) => ({
        input: sum.input + (record.tokens.input ?? 0),
        cachedInput: sum.cachedInput + (record.tokens.cachedInput ?? 0),
        output: sum.output + (record.tokens.output ?? 0),
      }),
      { input: 0, cachedInput: 0, output: 0 },
    );

    assert.equal(result.records.length, 2);
    assert.deepEqual(totals, { input: 90, cachedInput: 60, output: 15 });
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("Codex adapter backfills token usage model from a later single-model turn context", async () => {
  const dir = await mkdtemp(path.join(tmpdir(), "ai-code-usage-codex-model-backfill-"));
  try {
    await writeFile(
      path.join(dir, "rollout-single-model.jsonl"),
      [
        JSON.stringify({
          timestamp: "2026-05-01T00:00:01.000Z",
          type: "event_msg",
          payload: {
            type: "token_count",
            info: {
              last_token_usage: {
                input_tokens: 100,
                cached_input_tokens: 80,
                output_tokens: 12,
              },
            },
          },
        }),
        JSON.stringify({
          timestamp: "2026-05-01T00:00:02.000Z",
          type: "turn_context",
          payload: {
            model: "gpt-5.5",
          },
        }),
      ].join("\n"),
    );

    const result = await new CodexUsageAdapter(dir).importUsage();

    assert.equal(result.records.length, 1);
    assert.equal(result.records[0]?.model, "gpt-5.5");
    assert.equal(result.records[0]?.tokens.input, 20);
    assert.equal(result.records[0]?.tokens.cachedInput, 80);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("Codex adapter keeps early model-less token usage unknown when a file has multiple models", async () => {
  const dir = await mkdtemp(path.join(tmpdir(), "ai-code-usage-codex-ambiguous-model-"));
  try {
    await writeFile(
      path.join(dir, "rollout-multiple-models.jsonl"),
      [
        JSON.stringify({
          timestamp: "2026-05-01T00:00:01.000Z",
          type: "event_msg",
          payload: {
            type: "token_count",
            info: {
              last_token_usage: {
                input_tokens: 100,
                output_tokens: 12,
              },
            },
          },
        }),
        JSON.stringify({
          timestamp: "2026-05-01T00:00:02.000Z",
          type: "turn_context",
          payload: {
            model: "gpt-5.5",
          },
        }),
        JSON.stringify({
          timestamp: "2026-05-01T00:00:03.000Z",
          type: "turn_context",
          payload: {
            model: "gpt-5.4-mini",
          },
        }),
      ].join("\n"),
    );

    const result = await new CodexUsageAdapter(dir).importUsage();

    assert.equal(result.records.length, 1);
    assert.equal(result.records[0]?.model, undefined);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("Codex adapter silently skips rate-limit-only token_count events with null info", async () => {
  const dir = await mkdtemp(path.join(tmpdir(), "ai-code-usage-codex-rate-limit-only-"));
  try {
    await writeFile(
      path.join(dir, "rollout-rate-limit-only.jsonl"),
      JSON.stringify({
        timestamp: "2026-05-01T00:00:01.000Z",
        type: "event_msg",
        payload: {
          type: "token_count",
          info: null,
          rate_limits: {
            primary: { used_percent: 12.5, window_minutes: 300, resets_in_seconds: 1800 },
            secondary: { used_percent: 3.2, window_minutes: 10080, resets_in_seconds: 86400 },
          },
        },
      }),
    );

    const result = await new CodexUsageAdapter(dir).importUsage();

    assert.equal(result.records.length, 0);
    assert.equal(result.warnings.length, 0);
    assert.equal(result.errors.length, 0);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("Codex adapter still warns when token_count info lacks usage fields", async () => {
  const dir = await mkdtemp(path.join(tmpdir(), "ai-code-usage-codex-info-no-usage-"));
  try {
    await writeFile(
      path.join(dir, "rollout-info-no-usage.jsonl"),
      JSON.stringify({
        timestamp: "2026-05-01T00:00:01.000Z",
        type: "event_msg",
        payload: {
          type: "token_count",
          info: {
            model_context_window: 272000,
          },
        },
      }),
    );

    const result = await new CodexUsageAdapter(dir).importUsage();

    assert.equal(result.records.length, 0);
    assert.ok(result.warnings.some((warning) => warning.code === "missing_tokens" && warning.line === 1));
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
