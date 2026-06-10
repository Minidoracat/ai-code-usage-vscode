# Changelog

All notable changes to this project will be documented in this file.

## Pending release

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
