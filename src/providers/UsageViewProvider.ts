import path from "node:path";
import * as vscode from "vscode";
import { ClaudeUsageAdapter } from "../adapters/ClaudeUsageAdapter";
import { CodexUsageAdapter } from "../adapters/CodexUsageAdapter";
import { PiUsageAdapter } from "../adapters/PiUsageAdapter";
import { tokenTotal } from "../domain/math";
import { convertCost, resolveDisplayCurrencyState, type DisplayCurrencyState } from "../domain/currency";
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
import { fetchPublicExchangeRates, type PublicExchangeRates } from "../services/ExchangeRateService";
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

type RefreshOptions = {
  allowSourcePrompt?: boolean;
  forceImport?: boolean;
  /** Reuse the previous import when range and sources are unchanged (filter/locale-only changes). */
  reuseImports?: boolean;
};

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
  private refreshRun = 0;
  private customRange: { start?: string; end?: string } = {};
  // Single-flight refresh arbitration: at most one refresh executes at a time;
  // requests arriving meanwhile coalesce into one trailing rerun instead of
  // racing the in-flight run and discarding its result.
  private inflightRefresh?: Promise<void>;
  private trailingRefresh?: RefreshOptions;
  // Config updates initiated by webview handlers also fire the configuration
  // listener; this counter suppresses the listener's duplicate refresh.
  private suppressConfigRefresh = 0;
  private lastLoad?: { key: string; imports: Awaited<ReturnType<CachedUsageImporter["loadForRange"]>> };
  // Replayed into newly opened webviews so a reopened panel shows the last
  // known data immediately instead of a bare loading page. The timestamp keeps
  // replays from claiming hours-old data was just refreshed.
  private lastSummary?: { summary: UsageSummary; at: string };

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
          event.affectsConfiguration("aiCodingUsage.pi.usagePath") ||
          event.affectsConfiguration("aiCodingUsage.autoDetectLocalSources")
        ) {
          this.resetSourceState();
          if (this.suppressConfigRefresh === 0) {
            void this.refresh({ allowSourcePrompt: false });
          }
        }
        if (event.affectsConfiguration("aiCodingUsage.autoRefreshIntervalSeconds")) {
          this.configureAutoRefresh();
          if (this.suppressConfigRefresh === 0) {
            void this.refresh({ allowSourcePrompt: false });
          }
        }
        if (event.affectsConfiguration("aiCodingUsage.timeZoneMode") || event.affectsConfiguration("aiCodingUsage.customTimeZone")) {
          if (this.suppressConfigRefresh === 0) {
            void this.refresh({ allowSourcePrompt: false });
          }
        }
        if (
          event.affectsConfiguration("aiCodingUsage.displayCurrency") ||
          event.affectsConfiguration("aiCodingUsage.exchangeRates") ||
          event.affectsConfiguration("aiCodingUsage.screenshot")
        ) {
          if (this.suppressConfigRefresh === 0) {
            void this.replayDisplayState();
          }
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
    if (this.lastSummary) {
      void this.postUsageData(webviewView.webview, this.lastSummary.summary, this.lastSummary.at);
    }
    void this.refresh({ allowSourcePrompt: true });
  }

  public async reveal(): Promise<void> {
    await this.openDashboardPanel();
  }

  public async refresh(options: RefreshOptions = {}): Promise<void> {
    if (this.inflightRefresh) {
      this.trailingRefresh = {
        allowSourcePrompt: Boolean(this.trailingRefresh?.allowSourcePrompt) || Boolean(options.allowSourcePrompt),
        forceImport: Boolean(this.trailingRefresh?.forceImport) || Boolean(options.forceImport),
        reuseImports: (this.trailingRefresh ? Boolean(this.trailingRefresh.reuseImports) : true) && Boolean(options.reuseImports),
      };
      return this.inflightRefresh;
    }

    const loop = (async () => {
      let current: RefreshOptions | undefined = options;
      while (current) {
        await this.refreshOnce(current);
        current = this.trailingRefresh;
        this.trailingRefresh = undefined;
      }
    })();
    this.inflightRefresh = loop.finally(() => {
      this.inflightRefresh = undefined;
    });
    return this.inflightRefresh;
  }

  private async refreshOnce(options: RefreshOptions): Promise<void> {
    const run = ++this.refreshRun;
    this.initializeRangeFromConfig();
    await this.postLoadingData("detectingSources", run);
    try {
      const summary = await this.loadSummary(options, run);
      if (this.trailingRefresh) {
        // A newer request is queued; let its (cache-warm) rerun publish instead
        // of flashing this now-superseded result.
        return;
      }
      this.lastSummary = { summary, at: new Date().toISOString() };
      this.updateStatus(summary);
      await Promise.all(this.activeWebviews().map((webview) => this.postUsageData(webview, summary)));
    } catch (error) {
      // A failed load must not be replayed as fresh data by a queued rerun.
      this.lastLoad = undefined;
      if (this.trailingRefresh) {
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

    if (this.lastSummary) {
      void this.postUsageData(this.panel.webview, this.lastSummary.summary, this.lastSummary.at);
    }
    await this.refresh({ allowSourcePrompt: true });
  }

  private async postUsageData(webview: vscode.Webview, summary: UsageSummary, updatedAt = new Date().toISOString()): Promise<boolean> {
    return webview.postMessage({
      type: "usageData",
      version: webviewProtocolVersion,
      payload: {
        locale: this.resolvedLocale(),
        localePreference: this.localePreference(),
        messages: messagesFor(this.resolvedLocale()),
        updatedAt,
        autoRefreshIntervalSeconds: this.autoRefreshIntervalSeconds(),
        timeZone: this.timeZoneState(),
        pricing: pricingCatalog as PricingCatalog,
        currency: this.displayCurrency(),
        availableCurrencies: this.availableCurrencies(),
        screenshot: this.screenshotSettings(),
        // The dashboard never reads per-file sourceMeta; dropping it saves
        // hundreds of KB per postMessage on large ranges.
        summary: { ...summary, sourceMeta: [] },
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
      const proceed = this.t("modal.rebuildCacheProceed");
      const selected = await vscode.window.showWarningMessage(this.t("modal.rebuildCacheConfirm"), { modal: true }, proceed);
      if (selected !== proceed) {
        // Unlock the webview's pending state by replaying the latest summary,
        // or with a cheap cache-warm refresh when none exists yet.
        if (this.lastSummary && webview) {
          await this.postUsageData(webview, this.lastSummary.summary, this.lastSummary.at);
        } else {
          await this.refresh({ allowSourcePrompt: false });
        }
        return;
      }
      await this.refresh({ allowSourcePrompt: true, forceImport: true });
      return;
    }

    if (request.type === "setProvider") {
      // The provider filter only affects aggregation; the import result can be reused as-is.
      this.providerFilter = request.payload.provider;
      await this.refresh({ allowSourcePrompt: true, reuseImports: true });
      return;
    }

    if (request.type === "setLocale") {
      await this.updateConfigSuppressed((config) => config.update("locale", request.payload.locale, vscode.ConfigurationTarget.Global));
      await this.refresh({ allowSourcePrompt: true, reuseImports: true });
      return;
    }

    if (request.type === "setAutoRefresh") {
      await this.updateConfigSuppressed((config) =>
        config.update("autoRefreshIntervalSeconds", request.payload.intervalSeconds, vscode.ConfigurationTarget.Global),
      );
      this.configureAutoRefresh();
      await this.refresh({ allowSourcePrompt: false, reuseImports: true });
      return;
    }

    if (request.type === "setTimeZone") {
      await this.updateConfigSuppressed(async (config) => {
        await config.update("timeZoneMode", request.payload.mode, vscode.ConfigurationTarget.Global);
        if (request.payload.mode === "custom" && request.payload.customTimeZone) {
          await config.update("customTimeZone", request.payload.customTimeZone, vscode.ConfigurationTarget.Global);
        }
      });
      await this.refresh({ allowSourcePrompt: false });
      return;
    }

    if (request.type === "setCurrency") {
      try {
        await this.updateConfigSuppressed(async (config) => {
          await config.update("displayCurrency", request.payload.code, vscode.ConfigurationTarget.Global);
        });
      } catch (error) {
        await this.postError(error instanceof Error ? error.message : String(error), "config_write_failed", request.requestId, webview);
        return;
      }
      await this.replayDisplayState();
      return;
    }

    if (request.type === "refreshExchangeRates") {
      let table;
      try {
        table = await fetchPublicExchangeRates();
      } catch {
        await this.postError(this.t("currency.updateFailed"), "exchange_rates_failed", request.requestId, webview);
        return;
      }
      try {
        await this.context.globalState.update(publicExchangeRatesKey, table);
      } catch (error) {
        await this.postError(error instanceof Error ? error.message : String(error), "exchange_rates_store_failed", request.requestId, webview);
        return;
      }
      await this.replayDisplayState();
      return;
    }

    this.rangeKind = request.payload.kind;
    this.customRange = {
      start: request.payload.start,
      end: request.payload.end,
    };
    await this.refresh({ allowSourcePrompt: true });
  }

  /**
   * Replays the cached summary so display-only changes (currency, screenshot,
   * exchange rates) reach the webview without re-running the aggregate pipeline.
   */
  private async replayDisplayState(): Promise<void> {
    const last = this.lastSummary;
    if (last) {
      this.updateStatus(last.summary);
      await Promise.all(this.activeWebviews().map((webview) => this.postUsageData(webview, last.summary, last.at)));
    } else {
      await this.refresh({ allowSourcePrompt: false, reuseImports: true });
    }
  }

  private async loadSummary(options: RefreshOptions = {}, run = this.refreshRun): Promise<UsageSummary> {
    const config = vscode.workspace.getConfiguration("aiCodingUsage");
    this.initializeRangeFromConfig();
    if (options.allowSourcePrompt) {
      await this.previewDetectedSources(config);
    }
    const range = this.resolveCurrentRange();
    const loadKey = this.loadKey(config, range);
    const reused = options.reuseImports && !options.forceImport && this.lastLoad?.key === loadKey ? this.lastLoad.imports : undefined;
    let load = reused;
    if (!load) {
      await this.postLoadingData("readingSources", run);
      load = await this.importUsageCached(config, range, run, Boolean(options.forceImport));
      this.lastLoad = { key: loadKey, imports: load };
    }
    // A reused import replays no progress, so its historical cache status
    // (e.g. "rebuilding") would be misleading in the loading strip.
    await this.postLoadingData("calculating", run, undefined, reused ? undefined : load.cache);
    return new UsageAggregator(new PricingService(pricingCatalog as PricingCatalog)).aggregate(load.imports, range, this.providerFilter);
  }

  private loadKey(config: vscode.WorkspaceConfiguration, range: TimeRange): string {
    const paths = this.configuredUsagePaths(config)
      .map((source) => `${source.provider}=${source.sourcePath}`)
      .join("|");
    return `${range.start}|${range.end}|${paths}`;
  }

  private async updateConfigSuppressed(update: (config: vscode.WorkspaceConfiguration) => Thenable<void> | Promise<void>): Promise<void> {
    this.suppressConfigRefresh += 1;
    try {
      await update(vscode.workspace.getConfiguration("aiCodingUsage"));
    } finally {
      this.suppressConfigRefresh -= 1;
    }
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
    return this.configuredUsagePaths(config).map((source) => {
      const adapter = usageAdapterForProvider(source.provider, source.sourcePath);
      return {
        provider: source.provider,
        sourcePath: source.sourcePath ?? "",
        adapter,
        issue: source.issue,
      };
    });
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

  private displayCurrency(): DisplayCurrencyState {
    const config = vscode.workspace.getConfiguration("aiCodingUsage");
    return resolveDisplayCurrencyState(
      config.get<string>("displayCurrency", "USD"),
      config.get<Record<string, number>>("exchangeRates", {}),
      this.publicExchangeRates(),
    );
  }

  private publicExchangeRates(): PublicExchangeRates | undefined {
    const stored = this.context.globalState.get<PublicExchangeRates>(publicExchangeRatesKey);
    return stored && typeof stored.updatedAt === "string" && typeof stored.rates === "object" && stored.rates !== null
      ? stored
      : undefined;
  }

  private availableCurrencies(): string[] {
    const config = vscode.workspace.getConfiguration("aiCodingUsage");
    const codes = new Set<string>(commonCurrencyCodes);
    for (const key of Object.keys(config.get<Record<string, number>>("exchangeRates", {}))) {
      const normalized = key.trim().toUpperCase();
      if (/^[A-Z]{3}$/.test(normalized)) {
        codes.add(normalized);
      }
    }
    for (const key of Object.keys(this.publicExchangeRates()?.rates ?? {})) {
      codes.add(key);
    }
    return [...codes].sort();
  }

  private screenshotSettings(): { includePricing: boolean; includeSessions: boolean } {
    const config = vscode.workspace.getConfiguration("aiCodingUsage");
    return {
      includePricing: config.get<boolean>("screenshot.includePricing", false),
      includeSessions: config.get<boolean>("screenshot.includeSessions", false),
    };
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
    try {
      // Single-flight arbitration coalesces this with any in-flight refresh.
      await this.refresh({ allowSourcePrompt: false });
    } finally {
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

  private loadingStaticsRun = -1;
  private loadingStatics?: {
    locale: ReturnType<UsageViewProvider["resolvedLocale"]>;
    localePreference: DashboardLocalePreference;
    messages: ReturnType<typeof messagesFor>;
    sources: ReturnType<UsageViewProvider["loadingSources"]>;
    range: TimeRange;
  };

  private loadingState(phase: DashboardLoadingPhase, progress?: CachedUsageProgress, cache?: CachedUsageState) {
    // Progress events stream at ~10Hz during imports; the locale bundle,
    // source list, and range are constant within a refresh run, so compute
    // them once per run instead of per event.
    if (this.loadingStaticsRun !== this.refreshRun || !this.loadingStatics) {
      this.loadingStatics = {
        locale: this.resolvedLocale(),
        localePreference: this.localePreference(),
        messages: messagesFor(this.resolvedLocale()),
        sources: this.loadingSources(),
        range: this.resolveCurrentRange(),
      };
      this.loadingStaticsRun = this.refreshRun;
    }
    return {
      ...this.loadingStatics,
      phase,
      progress,
      cache,
    };
  }

  private loadingSources() {
    const config = vscode.workspace.getConfiguration("aiCodingUsage");
    const candidates = usageSourceCandidates(undefined, undefined, undefined, this.globalStorageRoot());
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
    const cost = convertCost(summary.totals.cost, this.displayCurrency());
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
      `${this.t("metric.totalCost")}: ${formatCost(cost, locale, (key) => this.t(key))}`,
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
    const invalidSources = sourcePaths.filter((source) => source.issue);
    if (invalidSources.length > 0 && (!this.invalidSourcePromptShown || force)) {
      this.invalidSourcePromptShown = true;
      // User prompts must never block the single-flight refresh loop; the
      // prompt handler triggers its own refresh after applying changes.
      void this.promptInvalidPaths(config, invalidSources);
      return;
    }

    const missingProviders = sourcePaths.filter((source) => !source.sourcePath).map((source) => source.provider);
    if (missingProviders.length === 0) {
      return;
    }

    const detected = (await new SourceDetectionService(undefined, undefined, undefined, this.globalStorageRoot()).detect()).filter(
      (source) => missingProviders.includes(source.provider),
    );
    if (detected.length === 0) {
      if (!this.noSourcePromptShown || force) {
        this.noSourcePromptShown = true;
        void this.promptNoSources();
      }
      return;
    }

    const target = vscode.ConfigurationTarget.Global;
    for (const source of detected) {
      await config.update(`${source.provider}.usagePath`, source.sourcePath, target);
    }
    const summary = detected.map((source) => `${source.provider}: ${source.sourcePath}`).join(", ");
    vscode.window.setStatusBarMessage(this.t("status.sourcesApplied", { summary }), 4000);
  }

  /** VS Code's shared `User/globalStorage` directory: parent of this extension's own storage. */
  private globalStorageRoot(): string {
    return path.dirname(this.context.globalStorageUri.fsPath);
  }

  private configuredUsagePaths(config: vscode.WorkspaceConfiguration): ConfiguredUsagePath[] {
    return (["claude", "codex", "pi"] as const).map((provider) => this.configuredUsagePath(config, provider));
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

  private async promptInvalidPaths(config: vscode.WorkspaceConfiguration, invalidSources: ConfiguredUsagePath[]): Promise<void> {
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
      void this.refresh({ allowSourcePrompt: true });
      return;
    }

    if (selected === chooseFolders) {
      await this.chooseUsageFolders(config, invalidSources.map((source) => source.provider));
      void this.refresh({ allowSourcePrompt: true });
      return;
    }

    if (selected === openSettings) {
      await vscode.commands.executeCommand("workbench.action.openSettings", "aiCodingUsage");
    }
  }

  private async promptNoSources(): Promise<void> {
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
      await this.chooseUsageFolders(vscode.workspace.getConfiguration("aiCodingUsage"), ["claude", "codex", "pi"]);
      void this.refresh({ allowSourcePrompt: true });
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

const publicExchangeRatesKey = "publicExchangeRates.v1";
const commonCurrencyCodes = ["USD", "TWD", "JPY", "KRW", "EUR", "GBP", "CNY", "HKD", "SGD", "AUD", "CAD"];

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
  const start = range.startHour ? `${range.startDate} ${range.startHour}:00` : range.startDate;
  const end = range.endHour ? `${range.endDate} ${range.endHour}:00` : range.endDate;
  return start === end ? start : `${start} - ${end}`;
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

/** Builds the adapter matching a provider (claude/codex/pi). */
function usageAdapterForProvider(provider: UsageProvider, sourcePath?: string): ClaudeUsageAdapter | CodexUsageAdapter | PiUsageAdapter {
  switch (provider) {
    case "codex":
      return new CodexUsageAdapter(sourcePath);
    case "pi":
      return new PiUsageAdapter(sourcePath);
    case "claude":
    default:
      return new ClaudeUsageAdapter(sourcePath);
  }
}
