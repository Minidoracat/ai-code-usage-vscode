import * as vscode from "vscode";
import { randomBytes } from "node:crypto";
import { defaultTimeRangeKind, normalizeTimeRangeKind } from "../domain/timeRange";
import { messagesFor, normalizeLocale } from "../i18n/messages";
import { isNativeUsagePath, usageSourceCandidates } from "../services/SourceDetectionService";
import { TimeRangeService } from "../services/TimeRangeService";
import { defaultTimeZoneMode, isTimeZoneMode, isValidTimeZone, resolveTimeZone } from "../services/TimeZoneService";
import { type DashboardLoadingState, webviewProtocolVersion } from "./protocol";

export function renderDashboardHtml(webview: vscode.Webview, extensionUri: vscode.Uri, initialLoadingState = createInitialLoadingState()): string {
  const nonce = createNonce();
  const chartStylesUri = webview.asWebviewUri(vscode.Uri.joinPath(extensionUri, "media", "main.css"));
  const stylesUri = webview.asWebviewUri(vscode.Uri.joinPath(extensionUri, "media", "styles.css"));
  const scriptUri = webview.asWebviewUri(vscode.Uri.joinPath(extensionUri, "media", "main.js"));
  const loadingStateJson = escapeAttribute(JSON.stringify(initialLoadingState));

  return `<!DOCTYPE html>
<html lang="${escapeAttribute(initialLoadingState.locale)}">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <meta http-equiv="Content-Security-Policy" content="default-src 'none'; img-src ${webview.cspSource} data: blob:; style-src ${webview.cspSource}; script-src 'nonce-${nonce}';">
  <link href="${chartStylesUri}" rel="stylesheet">
  <link href="${stylesUri}" rel="stylesheet">
  <title>AI Coding Usage</title>
</head>
<body>
  <main id="app" class="dashboard-shell" data-protocol-version="${webviewProtocolVersion}" data-loading-state="${loadingStateJson}">
    ${renderLoadingShell(initialLoadingState)}
  </main>
  <script nonce="${nonce}" src="${scriptUri}"></script>
</body>
</html>`;
}

function createInitialLoadingState(): DashboardLoadingState {
  const config = vscode.workspace.getConfiguration("aiCodingUsage");
  const localePreference = localePreferenceFromConfig(config);
  const locale = normalizeLocale(localePreference === "auto" ? vscode.env.language : localePreference);
  const candidates = usageSourceCandidates();
  const sources = (["claude", "codex", "opencode"] as const).map((provider) => {
    const configuredPath = config.get<string>(`${provider}.usagePath`, "").trim();
    if (configuredPath && !isNativeUsagePath(configuredPath)) {
      return { provider, status: "invalid" as const, path: configuredPath };
    }
    if (configuredPath) {
      return { provider, status: "configured" as const, path: configuredPath };
    }
    const candidate = candidates.find((item) => item.provider === provider);
    return {
      provider,
      status: candidate ? ("candidate" as const) : ("missing" as const),
      path: candidate?.sourcePath,
    };
  });

  return {
    locale,
    localePreference,
    messages: messagesFor(locale),
    phase: "starting",
    sources,
    range: new TimeRangeService(() => new Date(), loadingTimeZoneState(config)).resolve(
      normalizeTimeRangeKind(config.get<string>("defaultRange"), defaultTimeRangeKind),
    ),
  };
}

function loadingTimeZoneState(config: vscode.WorkspaceConfiguration) {
  const configuredMode = config.get<string>("timeZoneMode", defaultTimeZoneMode);
  const mode = isTimeZoneMode(configuredMode) ? configuredMode : defaultTimeZoneMode;
  const configuredZone = config.get<string>("customTimeZone", "").trim();
  return resolveTimeZone(mode, configuredZone && isValidTimeZone(configuredZone) ? configuredZone : undefined);
}

function localePreferenceFromConfig(config: vscode.WorkspaceConfiguration): DashboardLoadingState["localePreference"] {
  const configured = config.get<string>("locale", "auto");
  if (configured === "auto" || configured === "en" || configured === "zh-TW" || configured === "zh-CN" || configured === "ja" || configured === "ko") {
    return configured;
  }
  return "auto";
}

function renderLoadingShell(state: DashboardLoadingState): string {
  const t = (key: string) => state.messages[key] ?? key;
  const phaseKeys = ["starting", "detectingSources", "readingSources", "calculating"] as const;
  return `<section class="loading-panel" aria-live="polite">
    <div class="loading-orbit" aria-hidden="true">
      <span></span>
      <span></span>
    </div>
    <div class="loading-copy">
      <p class="loading-eyebrow">${escapeHtml(t("loading.eyebrow"))}</p>
      <h1>${escapeHtml(t("loading.title"))}</h1>
      <p class="loading-subtitle">${escapeHtml(t("loading.subtitle"))}</p>
    </div>
    <div class="loading-steps">
      ${phaseKeys
        .map(
          (phase, index) => `<div class="loading-step ${phase === state.phase ? "active" : ""}">
            <span>${index + 1}</span>
            <strong>${escapeHtml(t(`loading.phase.${phase}`))}</strong>
          </div>`,
        )
        .join("")}
    </div>
    <div class="loading-source-list">
      ${state.sources
        .map(
          (source) => `<div class="loading-source ${escapeAttribute(source.provider)} ${escapeAttribute(source.status)}">
            <span>${escapeHtml(source.provider)}</span>
            <strong>${escapeHtml(t(`loading.source.${source.status}`))}</strong>
            <code>${escapeHtml(source.path ?? t("loading.source.none"))}</code>
          </div>`,
        )
        .join("")}
    </div>
    ${state.range ? renderLoadingRange(state) : ""}
  </section>`;
}

function renderLoadingRange(state: DashboardLoadingState): string {
  const t = (key: string) => state.messages[key] ?? key;
  const range = state.range;
  if (!range) {
    return "";
  }
  return `<dl class="usage-metric-grid loading-range-card">
    <div><dt>${escapeHtml(t("filter.timeRange"))}</dt><dd>${escapeHtml(t(`range.${range.kind}`))}</dd></div>
    <div><dt>${escapeHtml(t("field.startDate"))}</dt><dd>${escapeHtml(formatRangeBoundaryHtml(range, "start"))}</dd></div>
    <div><dt>${escapeHtml(t("field.endDate"))}</dt><dd>${escapeHtml(formatRangeBoundaryHtml(range, "end"))}</dd></div>
    <div><dt>${escapeHtml(t("timezone.label"))}</dt><dd>${escapeHtml(range.timeZone.label)}</dd></div>
  </dl>`;
}

/** Renders "YYYY-MM-DD HH:00" when the boundary has an hourly component. */
/** Renders "YYYY-MM-DD HH:00" when the boundary has an hourly component. */
function formatRangeBoundaryHtml(range: { startDate: string; endDate: string; startHour?: string; endHour?: string }, side: "start" | "end"): string {
  const date = side === "start" ? range.startDate : range.endDate;
  const hour = side === "start" ? range.startHour : range.endHour;
  return hour ? `${date} ${hour}:00` : date;
}

function createNonce(): string {
  return randomBytes(24).toString("base64url");
}

function escapeHtml(value: string): string {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");
}

function escapeAttribute(value: string): string {
  return escapeHtml(value).replaceAll("\n", "&#10;");
}
