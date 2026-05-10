import * as vscode from "vscode";
import { ClaudeUsageAdapter } from "../adapters/ClaudeUsageAdapter";
import { CodexUsageAdapter } from "../adapters/CodexUsageAdapter";
import { tokenTotal } from "../domain/math";
import { defaultTimeRangeKind, normalizeTimeRangeKind } from "../domain/timeRange";
import type {
  ImportIssue,
  PricingCatalog,
  TokenBreakdown,
  TimeRange,
  TimeRangeKind,
  TimeZoneMode,
  TimeZoneState,
  UsageCost,
  UsageProvider,
  UsageProviderFilter,
  UsageSummary,
} from "../domain/types";
import { type MessageKey, messagesFor, normalizeLocale, translate } from "../i18n/messages";
import pricingCatalog from "../pricing/catalog.json";
import { PricingService } from "../services/PricingService";
import { defaultAutoRefreshIntervalSeconds, normalizeAutoRefreshIntervalSeconds } from "../services/AutoRefreshService";
import { CachedUsageImporter, type CachedUsageProgress, type CachedUsageState } from "../services/CachedUsageImporter";
import { isNativeUsagePath, SourceDetectionService, usageSourceCandidates } from "../services/SourceDetectionService";
import { TimeRangeService } from "../services/TimeRangeService";
import { defaultTimeZoneMode, isTimeZoneMode, isValidTimeZone, resolveTimeZone } from "../services/TimeZoneService";
import { UsageAggregator } from "../services/UsageAggregator";
import { renderDashboardHtml } from "../webview/renderDashboard";
import {
  validateWebviewRequest,
  webviewProtocolVersion,
  type DashboardLoadingPhase,
  type DashboardLocalePreference,
} from "../webview/protocol";

export class UsageViewProvider implements vscode.WebviewViewProvider {
  public static readonly viewType = "aiCodingUsage.dashboard";
  private static readonly panelType = "aiCodingUsage.dashboardPanel";

  private view?: vscode.WebviewView;
  private panel?: vscode.WebviewPanel;
  private readonly statusBarItem: vscode.StatusBarItem;
  private rangeKind: TimeRangeKind = defaultTimeRangeKind;
  private rangeInitialized = false;
  private providerFilter: UsageProviderFilter = "all";
  private invalidSourcePromptShown = false;
  private noSourcePromptShown = false;
  private readonly cachedImporter: CachedUsageImporter;
  private autoRefreshTimer?: ReturnType<typeof setTimeout>;
  private autoRefreshInProgress = false;
  private refreshRun = 0;
  private customRange: { start?: string; end?: string } = {};

  public constructor(private readonly context: vscode.ExtensionContext) {
    this.cachedImporter = new CachedUsageImporter(vscode.Uri.joinPath(this.context.globalStorageUri, "usage-cache", "v1").fsPath);
    this.statusBarItem = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Right, 100);
    this.statusBarItem.name = "AI Coding Usage";
    this.statusBarItem.command = "aiCodingUsage.openDashboard";
    this.statusBarItem.text = `$(graph) ${this.t("status.text.idle")}`;
    this.statusBarItem.tooltip = this.t("tooltip.openDashboard");
    this.statusBarItem.show();
    this.context.subscriptions.push(
      this.statusBarItem,
      { dispose: () => this.stopAutoRefresh() },
      vscode.workspace.onDidChangeConfiguration((event) => {
        if (
          event.affectsConfiguration("aiCodingUsage.claude.usagePath") ||
          event.affectsConfiguration("aiCodingUsage.codex.usagePath") ||
          event.affectsConfiguration("aiCodingUsage.autoDetectLocalSources")
        ) {
          this.resetSourceState();
        }
        if (event.affectsConfiguration("aiCodingUsage.autoRefreshIntervalSeconds")) {
          this.configureAutoRefresh();
          void this.refresh({ allowSourcePrompt: false });
        }
        if (event.affectsConfiguration("aiCodingUsage.timeZoneMode") || event.affectsConfiguration("aiCodingUsage.customTimeZone")) {
          void this.refresh({ allowSourcePrompt: false });
        }
      }),
    );
    this.configureAutoRefresh();
  }

  public resolveWebviewView(webviewView: vscode.WebviewView): void {
    this.view = webviewView;
    this.initializeRangeFromConfig();
    webviewView.webview.options = this.webviewOptions();
    webviewView.webview.html = renderDashboardHtml(webviewView.webview, this.context.extensionUri, this.loadingState("starting"));
    webviewView.webview.onDidReceiveMessage((message) => void this.handleMessage(message, webviewView.webview));
    void this.refresh({ allowSourcePrompt: true });
  }

  public async reveal(): Promise<void> {
    await this.openDashboardPanel();
  }

  public async refresh(options: { allowSourcePrompt?: boolean; forceImport?: boolean } = {}): Promise<void> {
    const run = ++this.refreshRun;
    this.initializeRangeFromConfig();
    await this.postLoadingData("detectingSources", run);
    try {
      const summary = await this.loadSummary(options, run);
      if (run !== this.refreshRun) {
        return;
      }
      this.updateStatus(summary);
      await Promise.all(this.activeWebviews().map((webview) => this.postUsageData(webview, summary)));
    } catch (error) {
      if (run !== this.refreshRun) {
        return;
      }
      const message = error instanceof Error ? error.message : String(error);
      await Promise.all(this.activeWebviews().map((webview) => this.postError(message, "refresh_failed", undefined, webview)));
    }
  }

  public async openDashboardPanel(): Promise<void> {
    if (this.panel) {
      this.panel.reveal(vscode.ViewColumn.Active);
      await this.refresh({ allowSourcePrompt: true });
      return;
    }

    this.panel = vscode.window.createWebviewPanel(
      UsageViewProvider.panelType,
      "AI Coding Usage",
      vscode.ViewColumn.Active,
      {
        ...this.webviewOptions(),
        retainContextWhenHidden: true,
      },
    );
    this.initializeRangeFromConfig();
    this.panel.webview.html = renderDashboardHtml(this.panel.webview, this.context.extensionUri, this.loadingState("starting"));
    this.panel.webview.onDidReceiveMessage((message) => void this.handleMessage(message, this.panel?.webview));
    this.panel.onDidDispose(() => {
      this.panel = undefined;
    });

    await this.refresh({ allowSourcePrompt: true });
  }

  private async postUsageData(webview: vscode.Webview, summary: UsageSummary): Promise<boolean> {
    return webview.postMessage({
      type: "usageData",
      version: webviewProtocolVersion,
      payload: {
        locale: this.resolvedLocale(),
        localePreference: this.localePreference(),
        messages: messagesFor(this.resolvedLocale()),
        updatedAt: new Date().toISOString(),
        autoRefreshIntervalSeconds: this.autoRefreshIntervalSeconds(),
        timeZone: this.timeZoneState(),
        pricing: pricingCatalog as PricingCatalog,
        summary,
      },
    });
  }

  private async handleMessage(message: unknown, webview?: vscode.Webview): Promise<void> {
    if (isOpenSettingsMessage(message)) {
      await vscode.commands.executeCommand("workbench.action.openSettings", "aiCodingUsage");
      return;
    }

    const request = validateWebviewRequest(message);
    if ("error" in request) {
      await this.postError(request.error, "invalid_message", requestIdFrom(message), webview);
      return;
    }

    if (request.type === "refresh") {
      await this.refresh({ allowSourcePrompt: true });
      return;
    }

    if (request.type === "rebuildCache") {
      await this.refresh({ allowSourcePrompt: true, forceImport: true });
      return;
    }

    if (request.type === "setProvider") {
      this.providerFilter = request.payload.provider;
      await this.refresh({ allowSourcePrompt: true });
      return;
    }

    if (request.type === "setLocale") {
      await vscode.workspace
        .getConfiguration("aiCodingUsage")
        .update("locale", request.payload.locale, vscode.ConfigurationTarget.Global);
      await this.refresh({ allowSourcePrompt: true });
      return;
    }

    if (request.type === "setAutoRefresh") {
      await vscode.workspace
        .getConfiguration("aiCodingUsage")
        .update("autoRefreshIntervalSeconds", request.payload.intervalSeconds, vscode.ConfigurationTarget.Global);
      this.configureAutoRefresh();
      await this.refresh({ allowSourcePrompt: false });
      return;
    }

    if (request.type === "setTimeZone") {
      const config = vscode.workspace.getConfiguration("aiCodingUsage");
      await config.update("timeZoneMode", request.payload.mode, vscode.ConfigurationTarget.Global);
      if (request.payload.mode === "custom" && request.payload.customTimeZone) {
        await config.update("customTimeZone", request.payload.customTimeZone, vscode.ConfigurationTarget.Global);
      }
      await this.refresh({ allowSourcePrompt: false });
      return;
    }

    this.rangeKind = request.payload.kind;
    this.customRange = {
      start: request.payload.start,
      end: request.payload.end,
    };
    await this.refresh({ allowSourcePrompt: true });
  }

  private async loadSummary(options: { allowSourcePrompt?: boolean; forceImport?: boolean } = {}, run = this.refreshRun): Promise<UsageSummary> {
    const config = vscode.workspace.getConfiguration("aiCodingUsage");
    this.initializeRangeFromConfig();
    if (options.allowSourcePrompt) {
      await this.previewDetectedSources(config);
    }
    const range = this.resolveCurrentRange();
    await this.postLoadingData("readingSources", run);
    const load = await this.importUsageCached(config, range, run, Boolean(options.forceImport));
    await this.postLoadingData("calculating", run, undefined, load.cache);
    return new UsageAggregator(new PricingService(pricingCatalog as PricingCatalog)).aggregate(load.imports, range, this.providerFilter);
  }

  public async detectLocalSources(): Promise<void> {
    await this.previewDetectedSources(vscode.workspace.getConfiguration("aiCodingUsage"), true);
    await this.refresh({ allowSourcePrompt: true });
  }

  private async importUsageCached(
    config: vscode.WorkspaceConfiguration,
    range: TimeRange,
    run: number,
    forceReparse: boolean,
  ) {
    return this.cachedImporter.loadForRange({
      sources: this.usageSources(config),
      range,
      forceReparse,
      onProgress: (progress, cache) => this.postLoadingData("readingSources", run, progress, cache),
    });
  }

  private resetSourceState(): void {
    this.invalidSourcePromptShown = false;
    this.noSourcePromptShown = false;
  }

  private usageSources(config: vscode.WorkspaceConfiguration) {
    const sourcePaths = this.configuredUsagePaths(config);
    const claudePath = sourcePaths.find((source) => source.provider === "claude");
    const codexPath = sourcePaths.find((source) => source.provider === "codex");
    return [
      {
        provider: "claude" as const,
        sourcePath: claudePath?.sourcePath ?? "",
        adapter: new ClaudeUsageAdapter(claudePath?.sourcePath),
        issue: claudePath?.issue,
      },
      {
        provider: "codex" as const,
        sourcePath: codexPath?.sourcePath ?? "",
        adapter: new CodexUsageAdapter(codexPath?.sourcePath),
        issue: codexPath?.issue,
      },
    ];
  }

  private localePreference(): DashboardLocalePreference {
    const configured = vscode.workspace.getConfiguration("aiCodingUsage").get<string>("locale", "auto");
    if (configured === "auto" || configured === "en" || configured === "zh-TW" || configured === "zh-CN" || configured === "ja" || configured === "ko") {
      return configured;
    }
    return "auto";
  }

  private resolvedLocale() {
    const configured = this.localePreference();
    return normalizeLocale(configured === "auto" ? vscode.env.language : configured);
  }

  private autoRefreshIntervalSeconds(): number {
    return normalizeAutoRefreshIntervalSeconds(
      vscode.workspace.getConfiguration("aiCodingUsage").get<number>("autoRefreshIntervalSeconds", defaultAutoRefreshIntervalSeconds),
    );
  }

  private timeZoneMode(): TimeZoneMode {
    const configured = vscode.workspace.getConfiguration("aiCodingUsage").get<string>("timeZoneMode", defaultTimeZoneMode);
    return isTimeZoneMode(configured) ? configured : defaultTimeZoneMode;
  }

  private customTimeZone(): string | undefined {
    const configured = vscode.workspace.getConfiguration("aiCodingUsage").get<string>("customTimeZone", "");
    const trimmed = configured.trim();
    return trimmed.length > 0 && isValidTimeZone(trimmed) ? trimmed : undefined;
  }

  private timeZoneState(): TimeZoneState {
    return resolveTimeZone(this.timeZoneMode(), this.customTimeZone());
  }

  private initializeRangeFromConfig(): void {
    if (this.rangeInitialized) {
      return;
    }
    this.rangeKind = normalizeTimeRangeKind(vscode.workspace.getConfiguration("aiCodingUsage").get<string>("defaultRange"), this.rangeKind);
    this.rangeInitialized = true;
  }

  private resolveCurrentRange(): TimeRange {
    return new TimeRangeService(() => new Date(), this.timeZoneState()).resolve(this.rangeKind, this.customRange);
  }

  private configureAutoRefresh(): void {
    this.stopAutoRefresh();
    const intervalSeconds = this.autoRefreshIntervalSeconds();
    if (intervalSeconds <= 0) {
      return;
    }
    this.autoRefreshTimer = setTimeout(() => void this.runAutoRefresh(), intervalSeconds * 1000);
  }

  private stopAutoRefresh(): void {
    if (this.autoRefreshTimer) {
      clearTimeout(this.autoRefreshTimer);
      this.autoRefreshTimer = undefined;
    }
  }

  private async runAutoRefresh(): Promise<void> {
    if (this.autoRefreshInProgress) {
      this.configureAutoRefresh();
      return;
    }

    this.autoRefreshInProgress = true;
    try {
      await this.refresh({ allowSourcePrompt: false });
    } finally {
      this.autoRefreshInProgress = false;
      this.configureAutoRefresh();
    }
  }

  private async postError(message: string, code: string, requestId = "unknown", webview?: vscode.Webview): Promise<void> {
    await webview?.postMessage({
      requestId,
      type: "error",
      version: webviewProtocolVersion,
      payload: { code, message },
    });
  }

  private async postLoadingData(
    phase: DashboardLoadingPhase,
    run = this.refreshRun,
    progress?: CachedUsageProgress,
    cache?: CachedUsageState,
  ): Promise<void> {
    if (run !== this.refreshRun) {
      return;
    }
    await Promise.all(
      this.activeWebviews().map((webview) =>
        webview.postMessage({
          type: "loadingData",
          version: webviewProtocolVersion,
          payload: this.loadingState(phase, progress, cache),
        }),
      ),
    );
  }

  private loadingState(phase: DashboardLoadingPhase, progress?: CachedUsageProgress, cache?: CachedUsageState) {
    return {
      locale: this.resolvedLocale(),
      localePreference: this.localePreference(),
      messages: messagesFor(this.resolvedLocale()),
      phase,
      sources: this.loadingSources(),
      range: this.resolveCurrentRange(),
      progress,
      cache,
    };
  }

  private loadingSources() {
    const config = vscode.workspace.getConfiguration("aiCodingUsage");
    const candidates = usageSourceCandidates();
    return this.configuredUsagePaths(config).map((source) => {
      if (source.issue) {
        return {
          provider: source.provider,
          status: "invalid" as const,
          path: source.configuredPath,
        };
      }
      if (source.sourcePath) {
        return {
          provider: source.provider,
          status: "configured" as const,
          path: source.sourcePath,
        };
      }
      const candidate = candidates.find((item) => item.provider === source.provider);
      return {
        provider: source.provider,
        status: candidate ? ("candidate" as const) : ("missing" as const),
        path: candidate?.sourcePath,
      };
    });
  }

  private activeWebviews(): vscode.Webview[] {
    return [this.view?.webview, this.panel?.webview].filter((webview): webview is vscode.Webview => Boolean(webview));
  }

  private webviewOptions(): vscode.WebviewOptions {
    return {
      enableScripts: true,
      localResourceRoots: [vscode.Uri.joinPath(this.context.extensionUri, "media")],
    };
  }

  private updateStatus(summary: UsageSummary): void {
    const locale = this.resolvedLocale();
    const tokens = tokenTotal(summary.totals.tokens);
    const cost = summary.totals.cost;
    if (cost) {
      this.statusBarItem.text = `$(graph) ${cost.currency} ${formatCompact(cost.amount, locale)}`;
    } else if (tokens > 0) {
      this.statusBarItem.text = `$(graph) ${formatCompact(tokens, locale)} ${this.t("status.text.tokens")}`;
    } else {
      this.statusBarItem.text = `$(graph) ${this.t("status.text.idle")}`;
    }

    const timeZone = `${summary.range.timeZone.label} ${summary.range.timeZone.offsetLabel}`.trim();
    this.statusBarItem.tooltip = [
      this.t("app.title"),
      `${this.t("filter.timeRange")}: ${this.t(rangeLabelKey(summary.range.kind))} · ${formatRangeDates(summary.range)} · ${timeZone}`,
      `${this.t("filter.provider")}: ${formatProviderFilter(summary.providerFilter, (key) => this.t(key))}`,
      `${this.t("metric.totalCost")}: ${formatCost(summary.totals.cost, locale, (key) => this.t(key))}`,
      `${this.t("metric.totalTokens")}: ${formatFullNumber(tokens, locale)}`,
      `${this.t("metric.inputTokens")}: ${formatFullNumber(inputTokens(summary.totals.tokens), locale)}`,
      `${this.t("metric.outputTokens")}: ${formatFullNumber(outputTokens(summary.totals.tokens), locale)}`,
      `${this.t("metric.cacheCreate")}: ${formatFullNumber(cacheCreateTokens(summary.totals.tokens), locale)}`,
      `${this.t("metric.cacheRead")}: ${formatFullNumber(cacheReadTokens(summary.totals.tokens), locale)}`,
      `${this.t("metric.messages")}: ${formatFullNumber(summary.totals.records, locale)}`,
      `${this.t("metric.sessions")}: ${formatFullNumber(summary.totals.sessions, locale)}`,
      `${this.t("metric.activeModels")}: ${formatFullNumber(summary.totals.activeModels, locale)}`,
      `${this.t("refresh.lastUpdated")}: ${formatDateTime(new Date(), locale, summary.range.timeZone.resolvedTimeZone)}`,
      "",
      this.t("status.tooltip.openDetails"),
    ].join("\n");
  }

  private async previewDetectedSources(config: vscode.WorkspaceConfiguration, force = false): Promise<void> {
    const enabled = config.get<boolean>("autoDetectLocalSources", true);
    if (!enabled && !force) {
      return;
    }

    const sourcePaths = this.configuredUsagePaths(config);
    const shouldContinue = await this.warnInvalidConfiguredPaths(config, sourcePaths, force);
    if (!shouldContinue) {
      return;
    }

    const missingProviders = sourcePaths.filter((source) => !source.sourcePath).map((source) => source.provider);
    if (missingProviders.length === 0) {
      return;
    }

    const detected = (await new SourceDetectionService().detect()).filter(
      (source) => missingProviders.includes(source.provider),
    );
    if (detected.length === 0) {
      await this.showNoSourceHint(force);
      return;
    }

    const target = vscode.ConfigurationTarget.Global;
    for (const source of detected) {
      await config.update(`${source.provider}.usagePath`, source.sourcePath, target);
    }
    const summary = detected.map((source) => `${source.provider}: ${source.sourcePath}`).join(", ");
    vscode.window.setStatusBarMessage(this.t("status.sourcesApplied", { summary }), 4000);
  }

  private configuredUsagePaths(config: vscode.WorkspaceConfiguration): ConfiguredUsagePath[] {
    return [this.configuredUsagePath(config, "claude"), this.configuredUsagePath(config, "codex")];
  }

  private configuredUsagePath(config: vscode.WorkspaceConfiguration, provider: UsageProvider): ConfiguredUsagePath {
    const rawValue = config.get<string>(`${provider}.usagePath`, "");
    const configuredPath = rawValue.trim();
    if (!configuredPath) {
      return { provider, configuredPath, sourcePath: "" };
    }
    if (isNativeUsagePath(configuredPath)) {
      return { provider, configuredPath, sourcePath: configuredPath };
    }
    return {
      provider,
      configuredPath,
      sourcePath: "",
      issue: {
        severity: "warning",
        code: "non_native_path",
        message: `${provider} usage path does not look valid on ${process.platform}.`,
        sourcePath: configuredPath,
        provider,
      },
    };
  }

  private async warnInvalidConfiguredPaths(
    config: vscode.WorkspaceConfiguration,
    sourcePaths: ConfiguredUsagePath[],
    force: boolean,
  ): Promise<boolean> {
    const invalidSources = sourcePaths.filter((source) => source.issue);
    if (invalidSources.length === 0 || (this.invalidSourcePromptShown && !force)) {
      return true;
    }

    this.invalidSourcePromptShown = true;
    const summary = invalidSources.map((source) => `${source.provider}: ${source.configuredPath}`).join("\n");
    const clearInvalidPaths = this.t("modal.clearInvalidPaths");
    const chooseFolders = this.t("modal.chooseFolders");
    const openSettings = this.t("action.openSettings");
    const notNow = this.t("modal.notNow");
    const selected = await vscode.window.showWarningMessage(
      this.t("modal.invalidPaths", { summary }),
      { modal: true },
      clearInvalidPaths,
      chooseFolders,
      openSettings,
      notNow,
    );

    if (selected === clearInvalidPaths) {
      for (const source of invalidSources) {
        await config.update(`${source.provider}.usagePath`, "", vscode.ConfigurationTarget.Global);
      }
      return true;
    }

    if (selected === chooseFolders) {
      await this.chooseUsageFolders(config, invalidSources.map((source) => source.provider));
      return false;
    }

    if (selected === openSettings) {
      await vscode.commands.executeCommand("workbench.action.openSettings", "aiCodingUsage");
    }
    return false;
  }

  private async showNoSourceHint(force: boolean): Promise<void> {
    if (this.noSourcePromptShown && !force) {
      return;
    }
    this.noSourcePromptShown = true;
    const chooseFolders = this.t("modal.chooseFolders");
    const openSettings = this.t("action.openSettings");
    const notNow = this.t("modal.notNow");
    const selected = await vscode.window.showInformationMessage(
      this.t("modal.noSources"),
      chooseFolders,
      openSettings,
      notNow,
    );
    if (selected === chooseFolders) {
      await this.chooseUsageFolders(vscode.workspace.getConfiguration("aiCodingUsage"), ["claude", "codex"]);
    } else if (selected === openSettings) {
      await vscode.commands.executeCommand("workbench.action.openSettings", "aiCodingUsage");
    }
  }

  private async chooseUsageFolders(config: vscode.WorkspaceConfiguration, providers: UsageProvider[]): Promise<void> {
    for (const provider of providers) {
      const selected = await vscode.window.showOpenDialog({
        canSelectFiles: false,
        canSelectFolders: true,
        canSelectMany: false,
        openLabel: this.t("modal.useFolder"),
        title: this.t("modal.selectUsageFolder", { provider }),
      });
      const folder = selected?.[0];
      if (folder) {
        await config.update(`${provider}.usagePath`, folder.fsPath, vscode.ConfigurationTarget.Global);
      }
    }
  }

  private t(key: MessageKey, args: Record<string, string | number> = {}): string {
    return translate(this.resolvedLocale(), key, args);
  }
}

type ConfiguredUsagePath = {
  provider: UsageProvider;
  configuredPath: string;
  sourcePath: string;
  issue?: ImportIssue;
};

function formatCompact(value: number, locale: string): string {
  return new Intl.NumberFormat(locale, {
    notation: "compact",
    maximumFractionDigits: value < 10 ? 2 : 1,
  }).format(value);
}

function formatFullNumber(value: number, locale: string): string {
  return new Intl.NumberFormat(locale).format(value);
}

function formatCost(cost: UsageCost | undefined, locale: string, translateMessage: (key: MessageKey) => string): string {
  if (!cost) {
    return translateMessage("state.unavailable");
  }
  const formatted = `${cost.currency} ${new Intl.NumberFormat(locale, {
    maximumFractionDigits: cost.amount < 1 ? 4 : 2,
  }).format(cost.amount)}`;
  return cost.note === "partial" ? `${formatted} ${translateMessage("state.partialCost")}` : formatted;
}

function formatRangeDates(range: TimeRange): string {
  return range.startDate === range.endDate ? range.startDate : `${range.startDate} - ${range.endDate}`;
}

function formatDateTime(date: Date, locale: string, timeZone: string): string {
  return new Intl.DateTimeFormat(locale, {
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    timeZone,
  }).format(date);
}

function formatProviderFilter(providerFilter: UsageProviderFilter, translateMessage: (key: MessageKey) => string): string {
  return providerFilter === "all" ? translateMessage("filter.all") : providerFilter;
}

function rangeLabelKey(kind: TimeRangeKind): MessageKey {
  return `range.${kind}` as MessageKey;
}

function inputTokens(tokens: TokenBreakdown): number {
  return tokens.input ?? 0;
}

function outputTokens(tokens: TokenBreakdown): number {
  return tokens.output ?? 0;
}

function cacheCreateTokens(tokens: TokenBreakdown): number {
  return (tokens.cacheWrite5m ?? 0) + (tokens.cacheWrite1h ?? 0);
}

function cacheReadTokens(tokens: TokenBreakdown): number {
  return (tokens.cacheRead ?? 0) + (tokens.cachedInput ?? 0);
}

function isOpenSettingsMessage(message: unknown): boolean {
  return typeof message === "object" && message !== null && (message as Record<string, unknown>)["type"] === "openSettings";
}

function requestIdFrom(message: unknown): string {
  if (typeof message === "object" && message !== null) {
    const requestId = (message as Record<string, unknown>)["requestId"];
    if (typeof requestId === "string") {
      return requestId;
    }
  }
  return "unknown";
}
