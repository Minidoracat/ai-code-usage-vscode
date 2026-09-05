# Changelog

All notable changes to this project will be documented in this file.

## 0.1.7 - 2026-09-05

### Added

- Claude Opus 5 pricing, matching `claude-opus-5`, `Claude Opus 5`, and `claude-opus-5[1m]`, with base, cache-write, and cache-read rates.
- `pi` provider for pi coding agent session transcripts (omp, pi CLI, vscode-pi), auto-detected from `PI_CODING_AGENT_DIR`, `~/.omp/agent/sessions`, `~/.pi/agent/sessions`, and the vscode-pi global storage; billed cost is imported from the transcript.
- Hourly trend buckets for ranges up to 48 hours, custom ranges with hour boundaries (`YYYY-MM-DDTHH`), and a cache-rate column in model usage cards.
- DeepSeek V4 pricing rules and refreshed GPT-5.6 Sol/Terra/Luna rates (Sol: $4 / $0.40 / $20, long context $8 / $0.80 / $30).

### Changed

- Display currency switches as soon as a valid code is entered; the manual rate input is gone and `setCurrency` no longer touches `aiCodingUsage.exchangeRates` (set rates there or refresh public rates).
- Hour buckets carry their UTC offset (`YYYY-MM-DDTHH±hh:mm`), so repeated local hours on DST fall-back days stay separate.
- JSONL sources that change during import are retried once and then skipped for that refresh instead of importing a partial snapshot.

## 0.1.6 - 2026-07-10

### Added

- GPT-5.6 Sol, Terra, and Luna pricing, with `gpt-5.6` as an alias for Sol, plus official long-context rates for GPT-5.5 and GPT-5.4.

### Changed

- Long-context pricing now uses a strict per-record `input + cachedInput > 272K` threshold and applies the selected base or long-context tier to the whole record.
- Pricing cards, model badges, tooltips, and fallback canvas reports now show distinct base and long-context rates without overlapping or clipping adjacent rules.
- Clarified the Codex-only cache-write limitation: local Codex JSONL has no structured `cache_write_tokens`, so unreported cache-write usage is not inferred; Claude `cacheWrite5m` and `cacheWrite1h` remain supported when present.

## 0.1.5 - 2026-07-02

### Added

- Claude Sonnet 5 pricing in the packaged catalog, including the introductory rates ($2/$10 per MTok with matching cache rates) through 2026-08-31 and the standard rates ($3/$15) from 2026-09-01 — the switch is automatic based on each record's timestamp, and a catalog gate now enforces that dated rules stay contiguous.
- Display currency conversion. A new currency row in the dashboard lets you pick a 3-letter code, fetch public exchange rates on demand (user-triggered request to `open.er-api.com`; no local data is sent, nothing runs automatically), or enter a manual rate per 1 USD. Manual rates take precedence over public rates; applying with an empty rate clears the manual override. Costs are always calculated and cached in USD — conversion is display-only and also applies to the status bar and screenshots.
- Screenshot content settings: the full-page screenshot copy now excludes the pricing rules panel and the sessions table by default; `aiCodingUsage.screenshot.includePricing` and `aiCodingUsage.screenshot.includeSessions` opt them back in (both capture paths honor the settings, and the fallback renderer now draws pricing rules when included).

### Changed

- Pricing rule cards now show their effective window inline, and the model breakdown marks models whose rate changed within the selected range.
- Display-only setting changes (currency, exchange rates, screenshot content) replay the cached summary instead of re-running the aggregate pipeline.
- The privacy static check now also scans `.tsx` sources and pins the one sanctioned network host; the exchange-rate fetch validates the provider response strictly (USD base, sane rates, valid timestamp), caps the response size, and refuses redirects.

## 0.1.4 - 2026-06-11

### Fixed

- Stale `missing_tokens` warnings cached by older releases now clear automatically: the usage cache parser version was bumped, so the first launch after upgrading rebuilds the cache once (cold pruning keeps that rebuild scoped to the files the current range needs).
- Custom date inputs no longer fire a reload on every keystroke. Dates are edited as a draft with an explicit Apply button, validated (start ≤ end, year ≥ 2000) with an inline error, so partially typed years can no longer trigger runaway multi-minute loads.
- A refresh started while another one is running (for example auto-refresh during a cache rebuild) no longer discards the in-flight result and freezes the dashboard; refreshes are now serialized with a single coalesced rerun, and rebuild progress stays visible to the end.
- Corrupt cache shard files now self-heal on the next refresh (affected files are re-imported automatically) instead of silently dropping other files' records until a manual rebuild.
- Model names containing colons (for example Bedrock-style `…-v2:0`) are no longer truncated in the model breakdown.
- Multiple VS Code windows on the same profile no longer risk overwriting each other's cached usage: each window detects cache writes from the others and reloads from disk before serving or appending data.
- Detection prompts (invalid usage paths, no sources found) no longer block the refresh pipeline while waiting for user input.

### Changed

- Summary calculation is ~100x faster on large ranges (a 2-month / 83k-record range dropped from 60–110 s of frozen UI to under one second) by caching Intl formatters, precomputing day boundaries, and estimating each record's cost once instead of five times.
- Full cache rebuilds are ~7x faster (3+ minutes down to ~26 s on a 1.5 GB corpus) via in-memory shard buffering, bulk-line prefiltering, and byte-streamed JSONL parsing; first-time cache builds only parse files that can affect the selected range (30x less I/O for the default week view).
- Grown Codex rollout files are parsed incrementally from the previous offset instead of re-reading the whole file on every refresh.
- The dashboard restores the last known data instantly when a webview reloads or reopens, long-running refreshes no longer lock every control (a watchdog also unlocks the UI if a response is delayed), and rebuilding the cache now asks for confirmation and shows per-file progress.
- `index.json` is only rewritten when the cache actually changed, and cache JSON is written compactly (~27% smaller).

## 0.1.3 - 2026-06-10

### Fixed

- Codex rate-limit-only `token_count` events (`info: null`) no longer flood the import issues panel with `missing_tokens` warnings; the warning now fires only when usage fields are genuinely missing from a populated payload.

## 0.1.2 - 2026-06-10

### Added

- Claude Fable 5 and Claude Mythos 5 pricing in the packaged catalog (API-equivalent USD estimates, including prompt cache rates).

### Fixed

- Codex JSONL usage import — streaming importer for large rollout files, tolerant parsing of escaped lines, `total_token_usage` deltas, cached-input split, and cold-cache time-range coverage (thanks @YuMJie, #1).

## 0.1.1 - 2026-05-29

### Added

- Claude Opus 4.8 pricing in the packaged catalog (API-equivalent USD estimates), sharing Opus 4.5–4.8 rates with backward-compatible model aliases.

### Changed

- README now leads with the app icon, Marketplace/GitHub/Discord links, and a single English dashboard preview that links out to the localized READMEs for other languages.
- CI and publish workflows run on the Node 24 GitHub Actions (`actions/checkout@v6`, `actions/setup-node@v6`, `actions/upload-artifact@v7`).
- Trimmed the packaged VSIX (~2 MB → ~0.5 MB) by excluding localized dashboard screenshots that the Marketplace listing (English README) does not render.

## 0.1.0 - 2026-05-10

### Added

- Local Claude Code and Codex usage dashboard for VS Code.
- Provider, model, daily trend, and session summaries.
- API-equivalent USD cost estimates for supported models.
- Time-zone-aware calendar shortcuts, custom date ranges, and selectable time zones.
- Dashboard language selection for English, Traditional Chinese, Simplified Chinese, Japanese, and Korean.
- Auto refresh controls and status bar summary.
- Local source detection for Claude Code and Codex usage paths.
- Privacy, i18n, pricing, test-data, and VSIX inspection release checks.

### Security and privacy

- Runtime remains local-only: no login, upload, sync, cloud service, telemetry, or runtime network request.
- Tests and public screenshot guidance require synthetic fixture data.
