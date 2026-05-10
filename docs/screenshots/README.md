# Screenshot Guidance

Marketplace screenshots must use synthetic fixture data only.

Approved screenshot assets live in `docs/assets/screenshots/` and use this naming pattern:

- `dashboard-en-1.png`, `dashboard-en-2.png`, `dashboard-en-3.png`
- `dashboard-zh-tw-1.png`, `dashboard-zh-tw-2.png`, `dashboard-zh-tw-3.png`
- `dashboard-zh-cn-1.png`, `dashboard-zh-cn-2.png`, `dashboard-zh-cn-3.png`
- `dashboard-ja-1.png`, `dashboard-ja-2.png`, `dashboard-ja-3.png`
- `dashboard-ko-1.png`, `dashboard-ko-2.png`, `dashboard-ko-3.png`

Do not capture real local usage from:

- `~/.claude/projects`
- `~/.codex/sessions`
- Windows user home directories
- Remote SSH or WSL usage directories

## Recommended Process

1. Use fixture paths:
   - `aiCodingUsage.claude.usagePath`: `test/fixtures/claude`
   - `aiCodingUsage.codex.usagePath`: `test/fixtures/codex`
2. Open the dashboard in an Extension Host.
3. Confirm the visible data is small, fake, and suitable for public documentation.
4. Capture the dashboard.
5. Store approved screenshots under `docs/assets/screenshots/` with stable ASCII filenames.

Screenshots should show the dashboard layout and controls, not private usage behavior.
