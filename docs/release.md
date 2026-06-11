# 發布流程

這份文件定義 `AI Coding Usage` 的正式發布流程。目標是讓 Marketplace 版本、GitHub commit、Git tag、`.vsix` artifact 與 `package.json` version 可以精準對齊，同時避免本機 usage data、PAT 或未驗證 build 被發布出去。

## 發布模型

正式發布只走 `vX.Y.Z` tag：

```text
package.json version 0.1.1 -> git tag v0.1.1 -> GitHub Actions -> vsce publish
```

一般 `push`、pull request、或 GitHub Release metadata 不會直接發布到 Marketplace。GitHub Release 可以在 tag 發布成功後建立，用來放 release notes 或 `.vsix` artifact，但不是主要觸發點。

## 一次性設定

Marketplace publisher：

- Publisher ID：`minidoracat`
- Extension ID：`minidoracat.ai-code-usage`
- `package.json` 的 `publisher` 必須維持 `minidoracat`

Azure DevOps PAT：

- 建議命名：`vsce-ai-code-usage`
- Organization：All accessible organizations，或至少包含 `minidoracat`
- Scope：Marketplace `Manage`
- 到期日：依個人安全策略設定，建議不要無限期
- 不要提交到 repo，不要寫進 workflow YAML

GitHub environment：

- 建立 environment：`marketplace-production`
- 在 environment secrets 放入：`VSCE_PAT`
- 建議啟用 required reviewers
- 建議限制 deployment branches/tags，只允許 `v*` release tag

官方參考：

- VS Code publishing：`https://code.visualstudio.com/api/working-with-extensions/publishing-extension`
- VS Code CI / automated publishing：`https://code.visualstudio.com/api/working-with-extensions/continuous-integration`

## 本機發布前檢查

發布前先確認 working tree 乾淨，並跑完整 gate：

```bash
git status --short
npm ci
npm run release:gate
```

`release:gate` 會執行：

- `npm test`
- `npm run check:i18n`
- `npm run check:privacy`
- `npm run check:pricing`
- `npm run check:test-data`
- `npm run check:audit`
- `npm run check:audit:runtime`
- `npm run package:vsix`
- `npm run inspect:vsix`

`.vsix` 必須通過 inspection，不得包含本機 `.claude` / `.codex` usage data、測試 raw fixtures、OMX runtime state、PAT 或其他 private artifacts。

### Parser / 診斷語義變更檢查

若本次 release 改動了 usage 解析行為或匯入診斷語義（`src/adapters/**` 的 parse 邏輯、警告訊息、警告觸發條件），**必須**同步 bump `src/adapters/JsonUsageAdapter.ts` 的 `jsonUsageParserVersion`。快取以這個版本字串判斷有效性；不 bump 會讓既有使用者的快取沿用舊版 parser 產生的記錄與警告（v0.1.3 的 `missing_tokens` 殘留警告即此成因）。bump 後使用者升級首次啟動會自動重建快取，冷建剪枝會把成本控制在目前範圍所需的檔案。

## 發布版本

1. 更新 `package.json` 的 `version`。
2. 更新 `CHANGELOG.md`，讓該版本不再是 `Pending release`。
3. 跑本機 gate：

```bash
npm ci
npm run release:gate
```

4. Commit 版本變更。
5. 建立 annotated tag，tag 必須等於 `v${package.json.version}`：

```bash
git tag -a v0.1.1 -m "v0.1.1: 發布摘要"
```

6. 推送 commit 與 tag：

```bash
git push origin main
git push origin v0.1.1
```

7. GitHub Actions `Publish` workflow 會自動執行：
   - 安裝依賴
   - 檢查 tag/version 是否一致
   - 跑完整 `release:gate`
   - 上傳 `.vsix` artifact
   - 進入 `marketplace-production` environment
   - 使用 `VSCE_PAT` 執行 `npm run deploy`

## 手動 dry run

可在 GitHub Actions 手動執行 `Publish` workflow：

- `dry_run=true`
- `confirm_publish=false`

這會跑完整 gate、產生 artifact，但不讀取 `VSCE_PAT`，也不發布。

## 手動發布

只有在 tag pipeline 失敗但 Marketplace 尚未接受該版本時才使用。

GitHub Actions 手動 dispatch 必須：

- 選擇 `vX.Y.Z` tag ref
- `dry_run=false`
- `confirm_publish=true`

workflow 仍會檢查 tag/version 是否一致，並要求 `marketplace-production` environment approval。

## 版本失敗與回復

如果 Marketplace 已接受某個 version，就不要重複發布同一個 version。請 bump patch，例如從 `0.1.1` 改成 `0.1.2`。

如果需要暫停公開，優先考慮 Marketplace `Unpublish`，不要輕易 `Remove`。移除 extension 會永久保留 extension name，且統計資料也會被移除。

## 本機 deploy 指令

`npm run deploy` 只保留給已準備好的環境使用。它不包含 PAT，會讓 `vsce` 從環境變數 `VSCE_PAT` 讀取 token：

```bash
VSCE_PAT=*** npm run deploy
```

日常發布應使用 GitHub Actions，不建議再用本機 `/root/.vsce` 明文 token 發布。
