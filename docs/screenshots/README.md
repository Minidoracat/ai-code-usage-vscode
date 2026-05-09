# Screenshot Guidance

Marketplace screenshots must use synthetic fixture data only.

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
5. Store approved screenshots under this directory or another documented screenshot directory.

Screenshots should show the dashboard layout and controls, not private usage behavior.
