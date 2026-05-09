# AI Coding Usage

Track local Claude Code and Codex usage from VS Code.

Languages: [English](README.md) | [繁體中文](docs/readme/README.zh-TW.md) | [简体中文](docs/readme/README.zh-CN.md) | [日本語](docs/readme/README.ja.md) | [한국어](docs/readme/README.ko.md)

`AI Coding Usage` is a local-first VS Code extension for reviewing AI coding usage, token volume, sessions, and API-equivalent cost estimates. It reads local usage files from Claude Code and Codex, aggregates them by provider/model/session/date range, and presents the result in a VS Code dashboard and status bar summary.

## Features

- Local Claude Code and Codex usage discovery
- Provider filters for Claude, Codex, or both
- Calendar quick ranges for today, yesterday, this week, last week, this month, last month, and custom dates; week ranges start on Monday and all boundaries use the selected time zone
- Time zone selection: system time zone, UTC, or custom IANA time zone
- Model and session breakdowns with input tokens, output tokens, cache creation, cache reads, and message counts
- API-equivalent USD estimates for supported models
- Auto refresh controls with configurable intervals
- Multi-language dashboard UI: English, Traditional Chinese, Simplified Chinese, Japanese, and Korean
- Local screenshot copy support for sharing the dashboard without uploading data

## Privacy

This extension is local-only.

- No login
- No upload
- No cloud sync
- No telemetry
- No runtime network requests

The extension reads only the local usage paths you configure or approve through local source detection. Public screenshots and examples in this repository must use synthetic fixture data, not real Claude Code or Codex history.

## Local Usage Sources

If these settings are empty, the extension detects common local paths and applies them automatically:

| Provider | Default path |
| --- | --- |
| Claude Code | `~/.claude/projects` |
| Codex | `~/.codex/sessions` |

On native Windows VS Code, `~` resolves to the current Windows user home, such as `C:\Users\<user>\.claude\projects` and `C:\Users\<user>\.codex\sessions`.

In Remote SSH or WSL windows, the extension runs in the remote extension host and reads the remote or WSL home directory. To inspect usage from the Windows host while working remotely, configure a path that is readable from that extension host.

## Cost Estimates

Cost values are API-equivalent estimates. They answer the question: "What would this usage roughly cost if billed through the corresponding public API pricing?"

They are not:

- A Claude Code subscription bill
- A Codex subscription bill
- A provider invoice
- A guaranteed billing statement

Pricing is calculated from the packaged pricing catalog in `src/pricing/catalog.json`. The catalog includes source URLs and `checkedAt` metadata, and `npm run check:pricing` validates the pricing metadata before packaging.

## Screenshots

Marketplace screenshots should be generated from synthetic fixture data only. Do not capture real `.claude` or `.codex` usage data for public documentation.

Screenshot guidance lives in [docs/screenshots/README.md](docs/screenshots/README.md).

## Development

```bash
npm install
npm run compile
npm test
npm run check:i18n
npm run check:privacy
npm run check:pricing
npm run check:test-data
npm run package:vsix
npm run inspect:vsix
```

`npm run package:vsix` creates a local `.vsix` package. It does not publish to Visual Studio Marketplace.

## Extension Host Testing

Open this repository in VS Code and run the `Run Extension` launch configuration.

For fixture-only testing, configure:

- `aiCodingUsage.claude.usagePath`: `test/fixtures/claude`
- `aiCodingUsage.codex.usagePath`: `test/fixtures/codex`

The dashboard webview uses `Preact`, `uPlot`, and `esbuild`. Runtime assets are packaged into `media/main.js` and `media/main.css`; the extension does not load external web assets at runtime.

## Release

Release preparation is documented in [docs/release.md](docs/release.md).

Publishing requires:

- Marketplace publisher ID: `minidoracat`
- Azure DevOps Personal Access Token with Marketplace `Manage` scope
- GitHub environment: `marketplace-production`
- Environment secret: `VSCE_PAT`
- A deliberate GitHub Release or manual workflow dispatch with explicit publish confirmation

The publish workflow is designed to rerun all release gates before publishing. It must not be used to bypass local testing or the manual Marketplace checklist.

## Support

See [SUPPORT.md](SUPPORT.md) for support and issue reporting guidance.

## License

MIT. See [LICENSE](LICENSE).
