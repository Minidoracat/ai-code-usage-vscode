<div align="center">

<a href="https://marketplace.visualstudio.com/items?itemName=minidoracat.ai-code-usage"><img src="../../resources/icon.png" alt="AI Coding Usage" width="120" /></a>

# AI Coding Usage

**在 VS Code 中追蹤本機 Claude Code 與 Codex 使用量。**

[![Visual Studio Marketplace Version](https://vsmarketplacebadges.dev/version-short/minidoracat.ai-code-usage.svg?label=Marketplace)](https://marketplace.visualstudio.com/items?itemName=minidoracat.ai-code-usage)
[![Visual Studio Marketplace Installs](https://vsmarketplacebadges.dev/installs-short/minidoracat.ai-code-usage.svg?label=Installs)](https://marketplace.visualstudio.com/items?itemName=minidoracat.ai-code-usage)
[![GitHub](https://img.shields.io/badge/GitHub-Source-181717?logo=github&logoColor=white)](https://github.com/Minidoracat/ai-code-usage-vscode)
[![Discord](https://img.shields.io/badge/Discord-Join%20chat-5865F2?logo=discord&logoColor=white)](https://discord.gg/Gur2V67)

[English](../../README.md)&nbsp;·&nbsp;**繁體中文**&nbsp;·&nbsp;[简体中文](README.zh-CN.md)&nbsp;·&nbsp;[日本語](README.ja.md)&nbsp;·&nbsp;[한국어](README.ko.md)

</div>

`AI Coding Usage` 是 local-first 的 VS Code extension，用來檢視 AI coding 使用量、Token 量、工作階段，以及 API 等效成本估算。它會讀取 Claude Code 與 Codex 的本機 usage files，依 provider、model、session、date range 彙整，並在 VS Code dashboard 與 status bar summary 中呈現結果。

## 功能

- 偵測本機 Claude Code 與 Codex 使用量來源
- 可篩選 Claude、Codex 或兩者
- 支援今天、昨天、本週、上週、本月、上月與自訂日期範圍；週範圍從週一開始，所有邊界依所選時區切分
- 支援時區選擇：系統時區、UTC 或自訂 IANA time zone
- 依模型與工作階段顯示 input tokens、output tokens、cache creation、cache reads 與 message counts
- 針對支援模型提供 API 等效 USD 成本估算
- 可設定 auto refresh interval
- 多語系 dashboard UI：英文、繁體中文、簡體中文、日文、韓文
- 支援本機複製 dashboard 截圖，不會上傳資料

## 使用方法

可以用以下任一方式開啟 dashboard：

- Command Palette：按 `Ctrl+Shift+P`（macOS 為 `Cmd+Shift+P`），執行 `開啟 AI Coding Usage`。
- 右下角 status bar：點擊 `AI Usage` 或成本摘要項目。

常用命令：

- `開啟 AI Coding Usage`：在 editor area 開啟 dashboard。
- `重新整理使用量`：重新掃描本機 usage files 並更新 dashboard。
- `偵測本機 AI 使用量來源`：偵測本機 Claude Code 與 Codex usage paths。
- `開啟 AI Coding Usage 設定`：設定 usage paths、語言、時區、auto refresh、顯示貨幣與截圖內容。

第一次啟動時，可以先讓 usage path settings 保持空白，extension 會偵測常見本機路徑。也可以在 settings 手動填入 `aiCodingUsage.claude.usagePath` 或 `aiCodingUsage.codex.usagePath`。

## 隱私

這個 extension 完全 local-only。

- 不需要 login
- 不上傳資料
- 不做 cloud sync
- 不收集 telemetry
- 沒有背景 network requests

唯一的網路請求是使用者主動觸發的：在儀表板按「更新公開匯率」時，會向 `open.er-api.com` 取得匯率（資料來源：[ExchangeRate-API](https://www.exchangerate-api.com)），不會傳送任何本機資料，也絕不會自動執行。其餘皆為本機處理：extension 只會讀取你設定或透過本機來源偵測核准的 usage paths。

## 本機使用量來源

如果以下 settings 留空，extension 會偵測常見本機路徑並自動套用：

| Provider | 預設路徑 |
| --- | --- |
| Claude Code | `~/.claude/projects` |
| Codex | `~/.codex/sessions` |

在原生 Windows VS Code 中，`~` 會解析為目前 Windows user home，例如 `C:\Users\<user>\.claude\projects` 與 `C:\Users\<user>\.codex\sessions`。

在 Remote SSH 或 WSL 視窗中，extension 會在 remote extension host 執行，並讀取 remote 或 WSL 的 home directory。若你在 remote 環境工作，但想檢視 Windows host 的使用量，請設定 extension host 可讀取的路徑。

## 成本估算

成本值是 API 等效估算，用來回答：「如果這些用量透過相對應的 public API pricing 計費，大約會花多少？」

它不是：

- Claude Code subscription bill
- Codex subscription bill
- provider invoice
- 保證正確的 billing statement

pricing 來自 package 內的 `src/pricing/catalog.json`。catalog 包含 source URLs 與 `checkedAt` metadata，並由 `npm run check:pricing` 在 package 前驗證 pricing metadata。

成本以 USD 計算。要以其他貨幣顯示，請使用儀表板的貨幣列：選擇 3 碼貨幣代碼（例如 `TWD`），再按「更新公開匯率」（使用者主動觸發、向 `open.er-api.com` 取得），或手動輸入每 1 USD 匯率。手動匯率（存於 `aiCodingUsage.exchangeRates`）優先於公開匯率；完全沒有匯率時回退為 USD 顯示。

複製整頁截圖預設不包含計價規則面板與工作階段表格；可透過 `aiCodingUsage.screenshot.includePricing` 或 `aiCodingUsage.screenshot.includeSessions` 開啟。

## 截圖

以下 screenshots 展示 dashboard 在繁體中文介面的畫面。

![AI Coding Usage 繁體中文 dashboard overview](../assets/screenshots/dashboard-zh-tw-1.png)

![AI Coding Usage 繁體中文 dashboard details](../assets/screenshots/dashboard-zh-tw-2.png)

![AI Coding Usage 繁體中文 dashboard pricing rules](../assets/screenshots/dashboard-zh-tw-3.png)

截圖指引請見 [docs/screenshots/README.md](../screenshots/README.md)。

## 開發

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

`npm run package:vsix` 會建立本機 `.vsix` package，不會發布到 Visual Studio Marketplace。

## Extension Host 測試

在 VS Code 開啟此 repository，執行 `Run Extension` launch configuration。

如果只想用 fixture 測試，請設定：

- `aiCodingUsage.claude.usagePath`: `test/fixtures/claude`
- `aiCodingUsage.codex.usagePath`: `test/fixtures/codex`

dashboard webview 使用 `Preact`、`uPlot` 與 `esbuild`。runtime assets 會 package 到 `media/main.js` 與 `media/main.css`；extension runtime 不會載入外部 web assets。

## 支援

請見 [SUPPORT.md](../../SUPPORT.md) 了解支援與 issue 回報方式。

## 授權

MIT。請見 [LICENSE](../../LICENSE)。
