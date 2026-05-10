import { render } from "preact";
import { useEffect, useMemo, useRef, useState } from "preact/hooks";
import uPlot from "uplot";
import "uplot/dist/uPlot.min.css";
import type {
  PricingCatalog,
  PricingRule,
  TimeRangeKind,
  TimeZoneMode,
  TokenBreakdown,
  TokenCategory,
  UsageCost,
  UsageProvider,
  UsageProviderFilter,
  UsageSummary,
} from "../src/domain/types";
import { timeRangeKinds } from "../src/domain/timeRange";
import { findPricingRule } from "../src/services/PricingService";
import {
  webviewProtocolVersion,
  type DashboardLoadingPhase,
  type DashboardLoadingState,
  type DashboardLocalePreference,
  type DashboardState,
  type ExtensionMessage,
} from "../src/webview/protocol";

declare function acquireVsCodeApi(): {
  postMessage(message: unknown): void;
};

const vscodeApi = acquireVsCodeApi();
const ranges: readonly TimeRangeKind[] = timeRangeKinds;
const providerFilters: UsageProviderFilter[] = ["all", "claude", "codex"];
const localePreferences: DashboardLocalePreference[] = ["auto", "en", "zh-TW", "zh-CN", "ja", "ko"];
const timeZoneModes: Array<Exclude<TimeZoneMode, "custom">> = ["system", "utc"];
const chartMetrics = ["cost", "input", "output", "cacheWrite", "cacheRead", "records"] as const;
const chartSizes = ["compact", "comfortable", "expanded"] as const;
const autoRefreshIntervals = [0, 60, 300, 900, 1800] as const;
const pricingRateCategories: Array<{ category: Exclude<TokenCategory, "unknown">; labelKey: string }> = [
  { category: "input", labelKey: "metric.inputTokens" },
  { category: "output", labelKey: "metric.outputTokens" },
  { category: "cachedInput", labelKey: "pricing.cachedInput" },
  { category: "cacheWrite5m", labelKey: "pricing.cacheWrite5m" },
  { category: "cacheWrite1h", labelKey: "pricing.cacheWrite1h" },
  { category: "cacheRead", labelKey: "metric.cacheRead" },
];

type ChartMetric = (typeof chartMetrics)[number];
type ChartSize = (typeof chartSizes)[number];
type PendingRequest = {
  requestId: string;
  type: "refresh" | "rebuildCache" | "setRange" | "setProvider" | "setLocale" | "setAutoRefresh" | "setTimeZone";
  rangeKind?: TimeRangeKind;
  provider?: UsageProviderFilter;
  locale?: DashboardLocalePreference;
  autoRefreshIntervalSeconds?: number;
  timeZoneMode?: TimeZoneMode;
  customTimeZone?: string;
};

function Dashboard() {
  const [state, setState] = useState<DashboardState>();
  const [loadingState, setLoadingState] = useState<DashboardLoadingState>(() => readInitialLoadingState());
  const [error, setError] = useState<string>();
  const [chartMetric, setChartMetric] = useState<ChartMetric>("cost");
  const [chartSize, setChartSize] = useState<ChartSize>("compact");
  const [copyBusy, setCopyBusy] = useState(false);
  const [notice, setNotice] = useState<string>();
  const [customAutoRefreshInput, setCustomAutoRefreshInput] = useState("300");
  const [customTimeZoneInput, setCustomTimeZoneInput] = useState("Asia/Taipei");
  const [pendingRequest, setPendingRequest] = useState<PendingRequest>();

  useEffect(() => {
    const handleMessage = (event: MessageEvent<ExtensionMessage>) => {
      const message = event.data;
      if (!message || message.version !== webviewProtocolVersion) {
        return;
      }
      if (message.type === "usageData") {
        setState(message.payload);
        setError(undefined);
        setPendingRequest(undefined);
      }
      if (message.type === "loadingData") {
        setLoadingState(message.payload);
      }
      if (message.type === "error") {
        setError(message.payload.message);
        setPendingRequest(undefined);
      }
    };

    window.addEventListener("message", handleMessage);
    return () => window.removeEventListener("message", handleMessage);
  }, []);

  useEffect(() => {
    const intervalSeconds = state?.autoRefreshIntervalSeconds;
    if (intervalSeconds && !autoRefreshIntervals.includes(intervalSeconds as (typeof autoRefreshIntervals)[number])) {
      setCustomAutoRefreshInput(String(intervalSeconds));
    }
  }, [state?.autoRefreshIntervalSeconds]);

  useEffect(() => {
    const nextValue = state?.timeZone.customTimeZone ?? state?.timeZone.resolvedTimeZone;
    if (nextValue) {
      setCustomTimeZoneInput(nextValue);
    }
  }, [state?.timeZone.customTimeZone, state?.timeZone.resolvedTimeZone]);

  if (!state) {
    return <InitialLoading state={loadingState} error={error} />;
  }

  const summary = state.summary;
  const hasRecords = summary.totals.records > 0;
  const locale = state.locale;
  const messages = state.messages;
  const timeZone = state.timeZone;
  const isPending = Boolean(pendingRequest);
  const activeRange = pendingRequest?.type === "setRange" && pendingRequest.rangeKind ? pendingRequest.rangeKind : summary.range.kind;
  const activeProvider = pendingRequest?.type === "setProvider" && pendingRequest.provider ? pendingRequest.provider : summary.providerFilter;
  const activeLocale = pendingRequest?.type === "setLocale" && pendingRequest.locale ? pendingRequest.locale : state.localePreference;
  const activeTimeZoneMode = pendingRequest?.type === "setTimeZone" && pendingRequest.timeZoneMode ? pendingRequest.timeZoneMode : timeZone.mode;
  const activeAutoRefreshSeconds =
    pendingRequest?.type === "setAutoRefresh" && typeof pendingRequest.autoRefreshIntervalSeconds === "number"
      ? pendingRequest.autoRefreshIntervalSeconds
      : state.autoRefreshIntervalSeconds;
  const customTimeZoneValid = isValidTimeZoneName(customTimeZoneInput);

  const translate = (key: string) => messages[key] ?? key;
  const send = (
    type: "refresh" | "rebuildCache" | "setRange" | "setProvider" | "setLocale" | "setAutoRefresh" | "setTimeZone",
    payload?: unknown,
    pending?: Omit<PendingRequest, "requestId" | "type">,
  ) => {
    const requestId = createRequestId(type);
    setPendingRequest({ requestId, type, ...pending });
    vscodeApi.postMessage({
      requestId,
      type,
      version: webviewProtocolVersion,
      payload,
    });
  };
  const setRange = (kind: TimeRangeKind) => {
    const start = document.querySelector<HTMLInputElement>("#startDate")?.value;
    const end = document.querySelector<HTMLInputElement>("#endDate")?.value;
    send("setRange", { kind, start, end }, { rangeKind: kind });
  };
  const setProvider = (provider: UsageProviderFilter) => send("setProvider", { provider }, { provider });
  const setLocale = (locale: DashboardLocalePreference) => send("setLocale", { locale }, { locale });
  const setAutoRefresh = (intervalSeconds: number) =>
    send("setAutoRefresh", { intervalSeconds }, { autoRefreshIntervalSeconds: intervalSeconds });
  const setTimeZone = (mode: TimeZoneMode, customTimeZone?: string) =>
    send("setTimeZone", { mode, customTimeZone }, { timeZoneMode: mode, customTimeZone });
  const captureDashboard = async () => {
    const target = document.querySelector<HTMLElement>(".dashboard-frame");
    if (!target) {
      throw new Error(translate("error.screenshotTarget"));
    }
    try {
      return await captureElementPng(target);
    } catch {
      return renderDashboardReportPng({
        summary,
        locale,
        translate,
        metric: chartMetric,
        width: Math.max(target.scrollWidth, target.getBoundingClientRect().width, document.documentElement.clientWidth),
      });
    }
  };
  const copyScreenshot = async () => {
    setCopyBusy(true);
    setError(undefined);
    setNotice(undefined);
    try {
      await copyPngToClipboard(await captureDashboard(), translate);
      const message = translate("state.screenshotCopied");
      setNotice(message);
      window.setTimeout(() => {
        setNotice((current) => (current === message ? undefined : current));
      }, 3000);
    } catch (copyError) {
      setError(copyError instanceof Error ? copyError.message : String(copyError));
    } finally {
      setCopyBusy(false);
    }
  };

  return (
    <div class={classNames("dashboard-frame", isPending && "is-pending")} aria-busy={isPending}>
      <header class="topbar">
        <div class="title-stack">
          <h1>{translate("app.title")}</h1>
          <p>{translate("app.subtitle")}</p>
        </div>
        <div class="actions">
          <label class="locale-picker">
            <span>{translate("locale.label")}</span>
            <select
              aria-label={translate("locale.label")}
              value={activeLocale}
              disabled={isPending}
              onChange={(event) => setLocale((event.currentTarget as HTMLSelectElement).value as DashboardLocalePreference)}
            >
              {localePreferences.map((locale) => (
                <option value={locale}>{translate(`locale.${locale}`)}</option>
              ))}
            </select>
          </label>
          <button
            class="icon-button"
            type="button"
            title={copyBusy ? translate("state.copyingScreenshot") : translate("action.copyScreenshot")}
            aria-label={translate("action.copyScreenshot")}
            disabled={isPending || copyBusy}
            onClick={() => void copyScreenshot()}
          >
            <CopyIcon />
          </button>
          <button
            class="icon-button"
            type="button"
            title={translate("action.refresh")}
            aria-label={translate("action.refresh")}
            disabled={isPending}
            onClick={() => send("refresh")}
          >
            <RefreshIcon />
          </button>
          <button
            class="icon-button"
            type="button"
            title={translate("action.rebuildCache")}
            aria-label={translate("action.rebuildCache")}
            disabled={isPending}
            onClick={() => send("rebuildCache")}
          >
            <RebuildCacheIcon />
          </button>
          <button class="icon-button" type="button" title={translate("action.openSettings")} aria-label={translate("action.openSettings")} onClick={openSettings}>
            <SettingsIcon />
          </button>
        </div>
      </header>

      {isPending ? (
        <RefreshProgress state={loadingState} translate={translate} locale={locale} />
      ) : null}

      <section class="control-panel" aria-label={translate("filter.timeRange")}>
        <div class="range-row">
          {ranges.map((kind) => (
            <button
              class={classNames("segmented", activeRange === kind && "active", pendingRequest?.type === "setRange" && pendingRequest.rangeKind === kind && "pending")}
              type="button"
              data-range={kind}
              disabled={isPending}
              onClick={() => setRange(kind)}
            >
              {translate(`range.${kind}`)}
            </button>
          ))}
        </div>
        <div class="custom-row">
          <label>
            <span>{translate("field.startDate")}</span>
            <input id="startDate" type="date" value={summary.range.startDate} disabled={isPending} onChange={() => setRange("custom")} />
          </label>
          <label>
            <span>{translate("field.endDate")}</span>
            <input id="endDate" type="date" value={summary.range.endDate} disabled={isPending} onChange={() => setRange("custom")} />
          </label>
        </div>
        <div class="timezone-row" aria-label={translate("timezone.label")}>
          <div class="timezone-current">
            <span>{translate("timezone.label")}</span>
            <strong title={timeZone.label}>{timeZone.label}</strong>
          </div>
          <div class="timezone-controls">
            {timeZoneModes.map((mode) => (
              <button
                class={classNames(
                  "provider-filter-button",
                  activeTimeZoneMode === mode && "active",
                  pendingRequest?.type === "setTimeZone" && pendingRequest.timeZoneMode === mode && "pending",
                )}
                type="button"
                disabled={isPending}
                onClick={() => setTimeZone(mode)}
              >
                {translate(`timezone.${mode}`)}
              </button>
            ))}
            <label class="custom-timezone">
              <input
                type="text"
                value={customTimeZoneInput}
                placeholder={translate("timezone.customPlaceholder")}
                disabled={isPending}
                aria-label={translate("timezone.custom")}
                spellcheck={false}
                onInput={(event) => setCustomTimeZoneInput((event.currentTarget as HTMLInputElement).value)}
              />
              <button
                class={classNames(
                  "provider-filter-button",
                  activeTimeZoneMode === "custom" && "active",
                  pendingRequest?.type === "setTimeZone" && pendingRequest.timeZoneMode === "custom" && "pending",
                )}
                type="button"
                disabled={isPending || !customTimeZoneValid}
                title={customTimeZoneValid ? translate("timezone.custom") : translate("timezone.invalid")}
                onClick={() => setTimeZone("custom", customTimeZoneInput.trim())}
              >
                {translate("timezone.custom")}
              </button>
            </label>
          </div>
        </div>
        <div class="provider-filter" aria-label={translate("filter.provider")}>
          <span>{translate("filter.provider")}</span>
          <div class="provider-filter-options" role="group" aria-label={translate("filter.provider")}>
            {providerFilters.map((provider) => (
              <button
                class={classNames("provider-filter-button", activeProvider === provider && "active", provider !== "all" && `provider-${provider}`)}
                type="button"
                disabled={isPending}
                onClick={() => setProvider(provider)}
              >
                {provider === "all" ? translate("filter.all") : <ProviderBadge provider={provider} />}
              </button>
            ))}
          </div>
        </div>
        <div class="auto-refresh-row" aria-label={translate("refresh.auto")}>
          <div class="auto-refresh-status">
            <span>{translate("refresh.auto")}</span>
            <small>
              {translate("refresh.lastUpdated")}: {formatDateTime(state.updatedAt, locale, timeZone.resolvedTimeZone)}
            </small>
          </div>
          <div class="auto-refresh-controls">
            <div class="auto-refresh-options" role="group" aria-label={translate("refresh.auto")}>
              {autoRefreshIntervals.map((intervalSeconds) => (
                <button
                  class={classNames(
                    "provider-filter-button",
                    activeAutoRefreshSeconds === intervalSeconds && "active",
                    pendingRequest?.type === "setAutoRefresh" &&
                      pendingRequest.autoRefreshIntervalSeconds === intervalSeconds &&
                      "pending",
                  )}
                  type="button"
                  disabled={isPending}
                  onClick={() => setAutoRefresh(intervalSeconds)}
                >
                  {autoRefreshLabel(intervalSeconds, translate)}
                </button>
              ))}
            </div>
            <label class="custom-refresh">
              <span>{translate("refresh.customSeconds")}</span>
              <input
                type="number"
                min="30"
                max="86400"
                step="30"
                value={customAutoRefreshInput}
                disabled={isPending}
                aria-label={translate("refresh.customSeconds")}
                onInput={(event) => setCustomAutoRefreshInput((event.currentTarget as HTMLInputElement).value)}
              />
              <button
                class={classNames(
                  "provider-filter-button",
                  activeAutoRefreshSeconds > 0 &&
                    !autoRefreshIntervals.includes(activeAutoRefreshSeconds as (typeof autoRefreshIntervals)[number]) &&
                    "active",
                )}
                type="button"
                disabled={isPending || parseAutoRefreshSeconds(customAutoRefreshInput) === undefined}
                onClick={() => setAutoRefresh(parseAutoRefreshSeconds(customAutoRefreshInput) ?? 300)}
              >
                {translate("action.apply")}
              </button>
            </label>
          </div>
        </div>
      </section>

      <SummaryUsagePanel summary={summary} locale={locale} translate={translate} />

      {notice ? <NoticePanel message={notice} /> : null}
      {error ? <ErrorPanel title={translate("error.title")} message={error} /> : null}

      {hasRecords ? (
        <DataPanels
          summary={summary}
          pricing={state.pricing}
          locale={locale}
          translate={translate}
          chartMetric={chartMetric}
          setChartMetric={setChartMetric}
          chartSize={chartSize}
          setChartSize={setChartSize}
        />
      ) : (
        <>
          <EmptyState title={translate("empty.title")} body={translate("empty.body")} />
          <PricingRulesPanel pricing={state.pricing} locale={locale} translate={translate} />
        </>
      )}

      <footer class="privacy">{translate("state.localOnly")}</footer>
    </div>
  );
}

function InitialLoading(props: { state: DashboardLoadingState; error?: string }) {
  const translate = (key: string) => props.state.messages[key] ?? key;
  const phaseOrder: DashboardLoadingPhase[] = ["starting", "detectingSources", "readingSources", "calculating"];
  const activeIndex = Math.max(0, phaseOrder.indexOf(props.state.phase));
  const progress = props.state.progress;
  const cache = props.state.cache;

  return (
    <section class="loading-panel" aria-live="polite">
      <div class="loading-orbit" aria-hidden="true">
        <span />
        <span />
      </div>
      <div class="loading-copy">
        <p class="loading-eyebrow">{translate("loading.eyebrow")}</p>
        <h1>{translate("loading.title")}</h1>
        <p class="loading-subtitle">{props.error ?? translate("loading.subtitle")}</p>
      </div>
      <div class="loading-steps">
        {phaseOrder.map((phase, index) => (
          <div class={classNames("loading-step", index < activeIndex && "done", index === activeIndex && "active")}>
            <span>{index + 1}</span>
            <strong>{translate(`loading.phase.${phase}`)}</strong>
          </div>
        ))}
      </div>
      <div class="loading-source-list">
        {props.state.sources.map((source) => (
          <div class={classNames("loading-source", source.provider, source.status)}>
            <span>{source.provider}</span>
            <strong>{translate(`loading.source.${source.status}`)}</strong>
            <code title={source.path}>{source.path ?? translate("loading.source.none")}</code>
          </div>
        ))}
      </div>
      {props.state.range ? <LoadingRangeSummary range={props.state.range} translate={translate} /> : null}
      {progress || cache ? (
        <div class="loading-progress-card">
          {cache ? (
            <div class="loading-cache-state">
              <span>{translate("loading.cache.label")}</span>
              <strong>{translate(`loading.cache.${cache.status}`)}</strong>
              <em>
                {cache.rangeComplete ? translate("loading.cache.rangeComplete") : translate("loading.cache.rangePending")}
                {" · "}
                {cache.historicalComplete ? translate("loading.cache.historyComplete") : translate("loading.cache.historyPending")}
              </em>
            </div>
          ) : null}
          {progress ? (
            <div class="loading-progress-grid">
              <UsageMetric label={translate("loading.progress.filesChecked")} value={`${formatNumber(progress.filesChecked, props.state.locale)} / ${formatNumber(progress.filesTotal, props.state.locale)}`} />
              <UsageMetric label={translate("loading.progress.filesParsed")} value={formatNumber(progress.filesParsed, props.state.locale)} />
              <UsageMetric label={translate("loading.progress.recordsLoaded")} value={formatNumber(progress.recordsLoaded, props.state.locale)} />
              <UsageMetric label={translate("loading.progress.provider")} value={progress.currentProvider ?? translate("state.unknown")} />
            </div>
          ) : null}
          {progress?.currentPath ? (
            <div class="loading-current-path">
              <span>{translate("loading.progress.currentPath")}</span>
              <code title={progress.currentPath}>{progress.currentPath}</code>
            </div>
          ) : null}
        </div>
      ) : null}
    </section>
  );
}

function RefreshProgress(props: {
  state: DashboardLoadingState;
  translate: (key: string) => string;
  locale: string;
}) {
  const progress = props.state.progress;
  const cache = props.state.cache;
  const rangeText = props.state.range ? formatLoadingRange(props.state.range, props.translate) : undefined;
  const cacheStatus = cache ? props.translate(`loading.cache.${cache.status}`) : undefined;
  const cacheRange = cache
    ? cache.rangeComplete
      ? props.translate("loading.cache.rangeComplete")
      : props.translate("loading.cache.rangePending")
    : undefined;
  const cacheHistory = cache
    ? cache.historicalComplete
      ? props.translate("loading.cache.historyComplete")
      : props.translate("loading.cache.historyPending")
    : undefined;

  return (
    <div class="busy-strip busy-strip-detail" role="status" aria-live="polite">
      <span class="busy-spinner" aria-hidden="true" />
      <div class="busy-progress-copy">
        <strong>{props.translate(`loading.phase.${props.state.phase}`)}</strong>
        {rangeText ? <span>{rangeText}</span> : null}
        <span>{cacheStatus ? `${cacheStatus} · ${cacheRange} · ${cacheHistory}` : props.translate("state.loading")}</span>
      </div>
      {progress ? (
        <div class="busy-progress-metrics">
          <span>
            <em>{props.translate("loading.progress.filesChecked")}</em>
            {formatNumber(progress.filesChecked, props.locale)} / {formatNumber(progress.filesTotal, props.locale)}
          </span>
          <span>
            <em>{props.translate("loading.progress.filesParsed")}</em>
            {formatNumber(progress.filesParsed, props.locale)}
          </span>
          <span>
            <em>{props.translate("loading.progress.recordsLoaded")}</em>
            {formatNumber(progress.recordsLoaded, props.locale)}
          </span>
          <span>
            <em>{props.translate("loading.progress.provider")}</em>
            {progress.currentProvider ?? props.translate("state.unknown")}
          </span>
        </div>
      ) : null}
      {progress?.currentPath ? (
        <code class="busy-progress-path" title={progress.currentPath}>
          {props.translate("loading.progress.currentPath")}: {progress.currentPath}
        </code>
      ) : null}
    </div>
  );
}

function LoadingRangeSummary(props: {
  range: NonNullable<DashboardLoadingState["range"]>;
  translate: (key: string) => string;
}) {
  return (
    <dl class="usage-metric-grid loading-range-card">
      <UsageMetric label={props.translate("filter.timeRange")} value={props.translate(`range.${props.range.kind}`)} />
      <UsageMetric label={props.translate("field.startDate")} value={props.range.startDate} />
      <UsageMetric label={props.translate("field.endDate")} value={props.range.endDate} />
      <UsageMetric label={props.translate("timezone.label")} value={props.range.timeZone.label} />
    </dl>
  );
}

function formatLoadingRange(range: NonNullable<DashboardLoadingState["range"]>, translate: (key: string) => string): string {
  const dateRange = range.startDate === range.endDate ? range.startDate : `${range.startDate} - ${range.endDate}`;
  return `${translate(`range.${range.kind}`)} · ${dateRange} · ${range.timeZone.label}`;
}

function DataPanels(props: {
  summary: UsageSummary;
  pricing: PricingCatalog;
  locale: string;
  translate: (key: string) => string;
  chartMetric: ChartMetric;
  setChartMetric: (metric: ChartMetric) => void;
  chartSize: ChartSize;
  setChartSize: (size: ChartSize) => void;
}) {
  const { summary, pricing, locale, translate, chartMetric, setChartMetric, chartSize, setChartSize } = props;
  const chartSizeIndex = chartSizes.indexOf(chartSize);

  return (
    <>
      <section class="panel chart-panel">
        <div class="panel-heading">
          <h2>{translate("section.trend")}</h2>
          <div class="chart-toolbar">
            <div class="chart-size-controls" role="group" aria-label={translate("action.chartSize")}>
              <button
                type="button"
                title={translate("action.chartSmaller")}
                aria-label={translate("action.chartSmaller")}
                disabled={chartSizeIndex <= 0}
                onClick={() => setChartSize(chartSizes[Math.max(0, chartSizeIndex - 1)] ?? "compact")}
              >
                <MinusIcon />
              </button>
              <button
                type="button"
                title={translate("action.chartLarger")}
                aria-label={translate("action.chartLarger")}
                disabled={chartSizeIndex >= chartSizes.length - 1}
                onClick={() => setChartSize(chartSizes[Math.min(chartSizes.length - 1, chartSizeIndex + 1)] ?? "expanded")}
              >
                <PlusIcon />
              </button>
            </div>
            <div class="metric-switch" role="group" aria-label={translate("section.trend")}>
              {chartMetrics.map((metric) => (
                <button class={classNames(chartMetric === metric && "active")} type="button" onClick={() => setChartMetric(metric)}>
                  {chartLabel(metric, translate)}
                </button>
              ))}
            </div>
          </div>
        </div>
        <TrendChart summary={summary} metric={chartMetric} locale={locale} translate={translate} size={chartSize} />
      </section>

      <article class="panel">
        <div class="panel-heading">
          <h2>{translate("section.providers")}</h2>
        </div>
        <div class="bar-list">
          {summary.providerSplit.map((item) => (
            <BarRow key={item.provider} label={item.provider} value={item.records} max={summary.totals.records} locale={locale} accent="provider" provider={item.provider} />
          ))}
        </div>
      </article>

      <ModelUsagePanel summary={summary} pricing={pricing} locale={locale} translate={translate} />

      <PricingRulesPanel pricing={pricing} locale={locale} translate={translate} />

      <section class="panel">
        <div class="panel-heading">
          <h2>{translate("section.sessions")}</h2>
        </div>
        <SessionTable summary={summary} locale={locale} translate={translate} />
      </section>

      <IssuePanel summary={summary} translate={translate} />
    </>
  );
}

function SummaryUsagePanel(props: { summary: UsageSummary; locale: string; translate: (key: string) => string }) {
  const { summary, locale, translate } = props;
  return (
    <section class="panel summary-card" aria-label={translate("section.summary")}>
      <div class="model-usage-header">
        <h2>{translate("section.summary")}</h2>
        <CostValue cost={summary.totals.cost} text={formatSummaryCost(summary, locale, translate)} locale={locale} translate={translate} />
      </div>
      <dl class="usage-metric-grid summary-metric-grid">
        <UsageMetric label={translate("metric.totalTokens")} value={formatNumber(tokenSum(summary.totals.tokens), locale)} />
        <UsageMetric label={translate("metric.inputTokens")} value={formatNumber(inputTokens(summary.totals.tokens), locale)} />
        <UsageMetric label={translate("metric.outputTokens")} value={formatNumber(outputTokens(summary.totals.tokens), locale)} />
        <UsageMetric label={translate("metric.cacheCreate")} value={formatNumber(cacheCreateTokens(summary.totals.tokens), locale)} />
        <UsageMetric label={translate("metric.cacheRead")} value={formatNumber(cacheReadTokens(summary.totals.tokens), locale)} />
        <UsageMetric label={translate("metric.messages")} value={formatNumber(summary.totals.records, locale)} />
        <UsageMetric label={translate("metric.sessions")} value={formatNumber(summary.totals.sessions, locale)} />
        <UsageMetric label={translate("metric.activeModels")} value={formatNumber(summary.totals.activeModels, locale)} />
      </dl>
    </section>
  );
}

function ModelUsagePanel(props: { summary: UsageSummary; pricing: PricingCatalog; locale: string; translate: (key: string) => string }) {
  const { summary, pricing, locale, translate } = props;
  const models = summary.modelSplit.slice(0, 12);
  if (models.length === 0) {
    return null;
  }
  const pricingInstant = validDateOrUndefined(summary.range.end);

  return (
    <section class="panel model-usage-panel">
      <div class="panel-heading">
        <h2>{translate("section.models")}</h2>
      </div>
      <div class="model-usage-list">
        {models.map((model) => {
          const pricingRule = findPricingRule(pricing.rules, model.provider, model.model, pricingInstant);
          return (
            <article class={classNames("model-usage-card", `provider-${model.provider}`)} key={`${model.provider}-${model.model}`}>
              <div class="model-usage-header">
                <div class="model-title-stack">
                  <strong title={model.model}>{model.model}</strong>
                  <PricingSummary rule={pricingRule} locale={locale} translate={translate} />
                </div>
                <CostValue cost={model.cost} locale={locale} translate={translate} />
              </div>
              <UsageMetricGrid tokens={model.tokens} records={model.records} locale={locale} translate={translate} />
            </article>
          );
        })}
      </div>
    </section>
  );
}

function PricingRulesPanel(props: { pricing: PricingCatalog; locale: string; translate: (key: string) => string }) {
  const { pricing, locale, translate } = props;
  return (
    <details class="panel pricing-panel" aria-label={translate("section.pricing")}>
      <summary class="panel-heading pricing-heading">
        <div>
          <h2>{translate("section.pricing")}</h2>
          <p>{translate("pricing.formula")}</p>
        </div>
        <span class="pricing-catalog-meta" title={pricing.sourceUrls.join("\n")}>
          {translate("pricing.catalogCheckedAt")}: {formatDateTime(pricing.checkedAt, locale, "UTC")}
        </span>
      </summary>
      <div class="pricing-rule-list">
        {pricing.rules.map((rule) => (
          <article class={classNames("pricing-rule-card", `provider-${rule.provider}`)} key={`${rule.provider}-${rule.model}`}>
            <div class="pricing-rule-header">
              <div>
                <strong title={rule.model}>{rule.model}</strong>
                <ProviderBadge provider={rule.provider} />
              </div>
              <span title={pricingRuleTooltip(rule, locale, translate)}>{translate("pricing.perMillionTokens")}</span>
            </div>
            <div class="pricing-rate-grid">
              {pricingRateEntries(rule).map(({ category, rate }) => (
                <UsageMetric
                  key={category}
                  label={translate(pricingRateCategories.find((entry) => entry.category === category)?.labelKey ?? "state.unknown")}
                  value={formatPricingRate(rate, rule.currency, locale)}
                />
              ))}
            </div>
            <div class="pricing-rule-meta">
              <span title={rule.sourceUrl}>
                {translate("pricing.source")}: {sourceHost(rule.sourceUrl)}
              </span>
              <span>
                {translate("pricing.checkedAt")}: {formatDateTime(rule.checkedAt, locale, "UTC")}
              </span>
              <span title={rule.modelAliases.join(", ")}>
                {translate("pricing.aliases")}: {formatAliases(rule.modelAliases, translate)}
              </span>
            </div>
          </article>
        ))}
      </div>
    </details>
  );
}

function PricingSummary(props: { rule: PricingRule | undefined; locale: string; translate: (key: string) => string }) {
  const { rule, locale, translate } = props;
  if (!rule) {
    return (
      <span class="pricing-summary missing" title={translate("pricing.tooltip.unmatched")}>
        {translate("pricing.unmatched")}
      </span>
    );
  }

  return (
    <span class="pricing-summary" title={pricingRuleTooltip(rule, locale, translate)}>
      {formatPricingBadge(rule, locale, translate)}
    </span>
  );
}

function UsageMetricGrid(props: { tokens: TokenBreakdown; records: number; locale: string; translate: (key: string) => string }) {
  const { tokens, records, locale, translate } = props;
  return (
    <dl class="usage-metric-grid">
      <UsageMetric label={translate("metric.inputTokens")} value={formatNumber(inputTokens(tokens), locale)} />
      <UsageMetric label={translate("metric.outputTokens")} value={formatNumber(outputTokens(tokens), locale)} />
      <UsageMetric label={translate("metric.cacheCreate")} value={formatNumber(cacheCreateTokens(tokens), locale)} />
      <UsageMetric label={translate("metric.cacheRead")} value={formatNumber(cacheReadTokens(tokens), locale)} />
      <UsageMetric label={translate("metric.messages")} value={formatNumber(records, locale)} />
    </dl>
  );
}

function UsageMetric(props: { label: string; value: string }) {
  return (
    <div>
      <dt>{props.label}</dt>
      <dd>{props.value}</dd>
    </div>
  );
}

function CostValue(props: {
  cost: UsageCost | undefined;
  text?: string;
  locale: string;
  translate: (key: string) => string;
}) {
  const hint = props.cost?.note === "partial" ? props.translate("tooltip.partialCost") : undefined;
  const text = props.text ?? formatCost(props.cost, props.locale, props.translate);
  return (
    <span class="cost-value-wrap" title={hint}>
      <span class={classNames("cost-value", hint && "partial")}>{text}</span>
      {hint ? (
        <span class="partial-cost-hint" aria-label={hint}>
          i
        </span>
      ) : null}
    </span>
  );
}

function TrendChart(props: { summary: UsageSummary; metric: ChartMetric; locale: string; translate: (key: string) => string; size: ChartSize }) {
  const { summary, metric, locale, translate, size } = props;
  const containerRef = useRef<HTMLDivElement>(null);
  const chartRef = useRef<uPlot>();
  const data = useMemo(() => trendData(summary, metric), [summary, metric]);
  const xRange = useMemo(() => trendDateRange(summary), [summary]);
  const hasData = data[0].length > 0;

  useEffect(() => {
    const container = containerRef.current;
    if (!container || !hasData) {
      return undefined;
    }

    const renderChart = () => {
      const width = Math.max(260, Math.floor(container.clientWidth));
      const height = chartHeight(width, size);
      const options: uPlot.Options = {
        width,
        height,
        legend: { show: false },
        cursor: { drag: { setScale: false } },
        scales: { x: { time: true, range: () => xRange } },
        series: [
          {},
          {
            label: chartLabel(metric, translate),
            stroke: providerColor(props.summary.providerFilter),
            fill: withAlpha(providerColor(props.summary.providerFilter), 0.14),
            width: 2,
            points: { show: data[0].length <= 12, size: 5 },
          },
        ],
        axes: [
          {
            stroke: getCssColor("--vscode-descriptionForeground", "#8b949e"),
            grid: { stroke: withAlpha(getCssColor("--vscode-panel-border", "#30363d"), 0.6), width: 1 },
            values: (_plot, ticks) => ticks.map((tick) => formatShortDate(tick, locale)),
          },
          {
            stroke: getCssColor("--vscode-descriptionForeground", "#8b949e"),
            grid: { stroke: withAlpha(getCssColor("--vscode-panel-border", "#30363d"), 0.6), width: 1 },
            values: (_plot, ticks) => ticks.map((tick) => formatChartValue(tick, metric, locale)),
          },
        ],
      };

      if (chartRef.current) {
        chartRef.current.setSize({ width, height });
        chartRef.current.setData(data, true);
      } else {
        chartRef.current = new uPlot(options, data, container);
      }
    };

    renderChart();
    const observer = new ResizeObserver(renderChart);
    observer.observe(container);

    return () => {
      observer.disconnect();
      chartRef.current?.destroy();
      chartRef.current = undefined;
    };
  }, [data, hasData, locale, metric, size, translate, xRange]);

  if (!hasData) {
    return <div class="chart-empty">{translate("empty.title")}</div>;
  }

  return <div class="uplot-wrap" ref={containerRef} />;
}

function BarRow(props: { label: string; value: number; max: number; locale: string; accent: "provider" | "model"; provider?: UsageProvider }) {
  const width = Math.max(3, Math.round((props.value / Math.max(props.max, 1)) * 100));
  return (
    <div class={classNames("bar-row", props.provider && `provider-${props.provider}`)}>
      <span title={props.label}>{props.provider && props.accent === "provider" ? <ProviderBadge provider={props.provider} /> : props.label}</span>
      <div class={`bar bar-${props.accent}`}>
        <i style={{ width: `${width}%` }} />
      </div>
      <strong>{formatNumber(props.value, props.locale)}</strong>
    </div>
  );
}

function SessionTable(props: { summary: UsageSummary; locale: string; translate: (key: string) => string }) {
  const { summary, locale, translate } = props;
  const sessions = prioritizedSessions(summary.sessions);
  return (
    <div class="table-wrap">
      <table>
        <thead>
          <tr>
            <th>{translate("column.provider")}</th>
            <th>{translate("column.model")}</th>
            <th>{translate("column.session")}</th>
            <th>{translate("column.started")}</th>
            <th>{translate("column.ended")}</th>
            <th class="numeric">{translate("column.duration")}</th>
            <th>{translate("column.cost")}</th>
            <th class="numeric">{translate("metric.messages")}</th>
            <th class="numeric">{translate("metric.totalTokens")}</th>
            <th class="numeric">{translate("metric.inputTokens")}</th>
            <th class="numeric">{translate("metric.outputTokens")}</th>
            <th class="numeric">{translate("metric.cacheCreate")}</th>
            <th class="numeric">{translate("metric.cacheRead")}</th>
            <th class="numeric">{translate("metric.costPerMessage")}</th>
            <th class="numeric">{translate("metric.tokensPerMessage")}</th>
            <th class="numeric">{translate("metric.cacheRatio")}</th>
          </tr>
        </thead>
        <tbody>
          {sessions.map((session) => {
            const totalTokens = tokenSum(session.tokens);
            return (
              <tr key={`${session.provider}-${session.sessionId}-${session.model ?? ""}`}>
                <td>
                  <ProviderBadge provider={session.provider} />
                </td>
                <td>{session.model ?? translate("state.unknown")}</td>
                <td title={session.sessionId}>{session.sessionId}</td>
                <td>{formatDate(session.startedAt, locale, summary.range.timeZone.resolvedTimeZone)}</td>
                <td>{formatDate(session.endedAt, locale, summary.range.timeZone.resolvedTimeZone)}</td>
                <td class="numeric">{formatDuration(session.startedAt, session.endedAt, translate)}</td>
                <td>
                  <CostValue cost={session.cost} locale={locale} translate={translate} />
                </td>
                <td class="numeric">{formatNumber(session.records, locale)}</td>
                <td class="numeric">{formatNumber(totalTokens, locale)}</td>
                <td class="numeric">{formatNumber(inputTokens(session.tokens), locale)}</td>
                <td class="numeric">{formatNumber(outputTokens(session.tokens), locale)}</td>
                <td class="numeric">{formatNumber(cacheCreateTokens(session.tokens), locale)}</td>
                <td class="numeric">{formatNumber(cacheReadTokens(session.tokens), locale)}</td>
                <td class="numeric">
                  <CostValue cost={session.cost} text={formatCostPerMessage(session.cost, session.records, locale, translate)} locale={locale} translate={translate} />
                </td>
                <td class="numeric">{formatAverage(totalTokens, session.records, locale)}</td>
                <td class="numeric">{formatPercent(cacheReadTokens(session.tokens), totalTokens, locale)}</td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}

function ProviderBadge(props: { provider: UsageProvider }) {
  return (
    <span class={`provider-badge provider-${props.provider}`}>
      <i aria-hidden="true" />
      {props.provider}
    </span>
  );
}

function prioritizedSessions(sessions: UsageSummary["sessions"]): UsageSummary["sessions"] {
  const perProviderLimit = 60;
  const byProvider = new Map<string, UsageSummary["sessions"]>();
  for (const session of sessions) {
    const providerSessions = byProvider.get(session.provider) ?? [];
    if (providerSessions.length < perProviderLimit) {
      providerSessions.push(session);
      byProvider.set(session.provider, providerSessions);
    }
  }

  return [...byProvider.values()]
    .flat()
    .sort((left, right) => (right.startedAt ?? "").localeCompare(left.startedAt ?? ""));
}

function IssuePanel(props: { summary: UsageSummary; translate: (key: string) => string }) {
  const issues = [...props.summary.errors, ...props.summary.warnings];
  if (issues.length === 0) {
    return null;
  }

  return (
    <section class="panel issues">
      <div class="panel-heading">
        <h2>{props.translate("section.issues")}</h2>
      </div>
      <div class="issue-list">
        {issues.slice(0, 20).map((issue) => (
          <p key={`${issue.code}-${issue.sourcePath ?? ""}-${issue.line ?? 0}`}>
            <strong>{issue.code}</strong>
            <span>{issue.message}</span>
          </p>
        ))}
      </div>
    </section>
  );
}

function EmptyState(props: { title: string; body: string }) {
  return (
    <section class="panel empty-state">
      <h2>{props.title}</h2>
      <p>{props.body}</p>
    </section>
  );
}

function ErrorPanel(props: { title: string; message: string }) {
  return (
    <section class="panel error-panel">
      <h2>{props.title}</h2>
      <p>{props.message}</p>
    </section>
  );
}

function NoticePanel(props: { message: string }) {
  return (
    <section class="panel notice-panel" role="status" aria-live="polite">
      <p>{props.message}</p>
    </section>
  );
}

function trendData(summary: UsageSummary, metric: ChartMetric): uPlot.AlignedData {
  const points = summary.trend
    .map((item, index) => {
      const timestamp = dateKeyTimestamp(item.bucket);
      return {
        x: Number.isFinite(timestamp) ? timestamp : index,
        y: metric === "cost" ? item.cost?.amount ?? 0 : metric === "records" ? item.records : tokenMetricValue(item.tokens, metric),
      };
    })
    .sort((left, right) => left.x - right.x);

  return [points.map((point) => point.x), points.map((point) => point.y)];
}

function trendDateRange(summary: UsageSummary): [number | null, number | null] {
  const start = dateKeyTimestamp(summary.range.startDate);
  const end = dateKeyTimestamp(summary.range.endDate);
  if (!Number.isFinite(start) || !Number.isFinite(end)) {
    return [null, null];
  }
  return [start, end + 86_400];
}

function chartLabel(metric: ChartMetric, translate: (key: string) => string): string {
  const labels: Record<ChartMetric, string> = {
    cost: "metric.totalCost",
    input: "metric.inputTokens",
    output: "metric.outputTokens",
    cacheWrite: "metric.cacheCreate",
    cacheRead: "metric.cacheRead",
    records: "metric.messages",
  };
  return translate(labels[metric]);
}

function autoRefreshLabel(intervalSeconds: number, translate: (key: string) => string): string {
  if (intervalSeconds === 0) {
    return translate("refresh.off");
  }
  if (intervalSeconds === 60) {
    return translate("refresh.oneMinute");
  }
  if (intervalSeconds === 300) {
    return translate("refresh.fiveMinutes");
  }
  if (intervalSeconds === 900) {
    return translate("refresh.fifteenMinutes");
  }
  if (intervalSeconds === 1800) {
    return translate("refresh.thirtyMinutes");
  }
  return `${intervalSeconds}s`;
}

function parseAutoRefreshSeconds(value: string): number | undefined {
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed < 30 || parsed > 86_400) {
    return undefined;
  }
  return parsed;
}

function tokenSum(tokens: TokenBreakdown | undefined): number {
  return Object.values(tokens ?? {}).reduce((sum, value) => sum + (typeof value === "number" ? value : 0), 0);
}

function inputTokens(tokens: TokenBreakdown | undefined): number {
  return tokens?.input ?? 0;
}

function outputTokens(tokens: TokenBreakdown | undefined): number {
  return tokens?.output ?? 0;
}

function cacheCreateTokens(tokens: TokenBreakdown | undefined): number {
  return (tokens?.cacheWrite5m ?? 0) + (tokens?.cacheWrite1h ?? 0);
}

function cacheReadTokens(tokens: TokenBreakdown | undefined): number {
  return (tokens?.cacheRead ?? 0) + (tokens?.cachedInput ?? 0);
}

function tokenMetricValue(tokens: TokenBreakdown | undefined, metric: Exclude<ChartMetric, "cost" | "records">): number {
  if (metric === "input") {
    return inputTokens(tokens);
  }
  if (metric === "output") {
    return outputTokens(tokens);
  }
  if (metric === "cacheWrite") {
    return cacheCreateTokens(tokens);
  }
  return cacheReadTokens(tokens);
}

function formatCost(cost: UsageCost | undefined, locale: string, translate: (key: string) => string): string {
  if (!cost) {
    return translate("state.unavailable");
  }

  const formatted = `${cost.currency} ${new Intl.NumberFormat(locale, {
    maximumFractionDigits: cost.amount < 1 ? 4 : 2,
  }).format(cost.amount)}`;

  return cost.note === "partial" ? `${formatted} ${translate("state.partialCost")}` : formatted;
}

function formatCostPerMessage(cost: UsageCost | undefined, records: number, locale: string, translate: (key: string) => string): string {
  if (!cost || records <= 0) {
    return translate("state.unavailable");
  }
  return formatCost({ ...cost, amount: cost.amount / records }, locale, translate);
}

function formatSummaryCost(summary: UsageSummary, locale: string, translate: (key: string) => string): string {
  if (summary.totals.cost) {
    return formatCost(summary.totals.cost, locale, translate);
  }

  const byCurrency = new Map<string, number>();
  for (const item of summary.providerSplit) {
    if (!item.cost) {
      continue;
    }
    byCurrency.set(item.cost.currency, (byCurrency.get(item.cost.currency) ?? 0) + item.cost.amount);
  }

  const parts = [...byCurrency.entries()].map(([currency, amount]) =>
    formatCost({ amount, currency, source: "calculated" }, locale, translate),
  );
  return parts.length > 0 ? parts.join(" / ") : translate("state.unavailable");
}

function pricingRateEntries(rule: PricingRule): Array<{ category: Exclude<TokenCategory, "unknown">; rate: number }> {
  return pricingRateCategories.flatMap((entry) => {
    const rate = rule.rates[entry.category];
    return typeof rate === "number" ? [{ category: entry.category, rate }] : [];
  });
}

function formatPricingBadge(rule: PricingRule, locale: string, translate: (key: string) => string): string {
  const parts: string[] = [];
  if (typeof rule.rates.input === "number") {
    parts.push(`${translate("pricing.shortInput")} ${formatRateAmount(rule.rates.input, locale)}`);
  }
  if (typeof rule.rates.output === "number") {
    parts.push(`${translate("pricing.shortOutput")} ${formatRateAmount(rule.rates.output, locale)}`);
  }
  const cacheRate = rule.rates.cachedInput ?? rule.rates.cacheRead;
  if (typeof cacheRate === "number") {
    parts.push(`${translate("pricing.shortCache")} ${formatRateAmount(cacheRate, locale)}`);
  }
  return `${rule.currency}/1M${parts.length > 0 ? ` · ${parts.join(" · ")}` : ""}`;
}

function pricingRuleTooltip(rule: PricingRule, locale: string, translate: (key: string) => string): string {
  const lines = [
    `${rule.model} · ${rule.provider}`,
    `${translate("pricing.unit")}: ${translate("pricing.perMillionTokens")}`,
    ...pricingRateEntries(rule).map(({ category, rate }) => {
      const label = translate(pricingRateCategories.find((entry) => entry.category === category)?.labelKey ?? "state.unknown");
      return `${label}: ${formatPricingRate(rate, rule.currency, locale)}`;
    }),
    `${translate("pricing.checkedAt")}: ${formatDateTime(rule.checkedAt, locale, "UTC")}`,
    `${translate("pricing.source")}: ${rule.sourceUrl}`,
  ];
  if (rule.effectiveFrom || rule.effectiveTo) {
    lines.push(
      `${translate("pricing.effective")}: ${rule.effectiveFrom ? formatDateTime(rule.effectiveFrom, locale, "UTC") : "∞"} - ${
        rule.effectiveTo ? formatDateTime(rule.effectiveTo, locale, "UTC") : "∞"
      }`,
    );
  }
  return lines.join("\n");
}

function formatPricingRate(rate: number, currency: string, locale: string): string {
  return `${currency} ${formatRateAmount(rate, locale)}`;
}

function formatRateAmount(rate: number, locale: string): string {
  return new Intl.NumberFormat(locale, { maximumFractionDigits: rate < 1 ? 4 : 2 }).format(rate);
}

function formatAliases(aliases: string[], translate: (key: string) => string): string {
  if (aliases.length === 0) {
    return translate("pricing.noAliases");
  }
  const visible = aliases.slice(0, 3).join(", ");
  return aliases.length > 3 ? `${visible} +${aliases.length - 3}` : visible;
}

function sourceHost(url: string): string {
  try {
    return new URL(url).hostname;
  } catch {
    return url;
  }
}

function validDateOrUndefined(value: string | undefined): Date | undefined {
  if (!value) {
    return undefined;
  }
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? undefined : date;
}

function formatNumber(value: number | undefined, locale: string): string {
  return new Intl.NumberFormat(locale).format(value ?? 0);
}

function formatAverage(total: number, count: number, locale: string): string {
  if (count <= 0) {
    return formatNumber(0, locale);
  }
  return new Intl.NumberFormat(locale, { maximumFractionDigits: total / count < 10 ? 1 : 0 }).format(total / count);
}

function formatPercent(value: number, total: number, locale: string): string {
  if (total <= 0) {
    return new Intl.NumberFormat(locale, { style: "percent", maximumFractionDigits: 0 }).format(0);
  }
  return new Intl.NumberFormat(locale, { style: "percent", maximumFractionDigits: 1 }).format(value / total);
}

function formatDate(value: string | undefined, locale: string, timeZone: string): string {
  if (!value) {
    return "";
  }
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) {
    return value.slice(0, 10);
  }
  return new Intl.DateTimeFormat(locale, { month: "short", day: "numeric", timeZone }).format(date);
}

function formatDateTime(value: string | undefined, locale: string, timeZone: string): string {
  if (!value) {
    return "";
  }
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) {
    return value;
  }
  return new Intl.DateTimeFormat(locale, {
    month: "short",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    timeZone,
  }).format(date);
}

function formatDuration(start: string | undefined, end: string | undefined, translate: (key: string) => string): string {
  if (!start || !end) {
    return "";
  }
  const startTime = new Date(start).getTime();
  const endTime = new Date(end).getTime();
  if (!Number.isFinite(startTime) || !Number.isFinite(endTime) || endTime < startTime) {
    return "";
  }

  const totalMinutes = Math.round((endTime - startTime) / 60_000);
  if (totalMinutes < 1) {
    return translate("unit.lessThanMinute");
  }

  const days = Math.floor(totalMinutes / 1_440);
  const hours = Math.floor((totalMinutes % 1_440) / 60);
  const minutes = totalMinutes % 60;
  const parts: string[] = [];
  if (days > 0) {
    parts.push(`${days}${translate("unit.day")}`);
  }
  if (hours > 0 && parts.length < 2) {
    parts.push(`${hours}${translate("unit.hour")}`);
  }
  if (minutes > 0 && parts.length < 2) {
    parts.push(`${minutes}${translate("unit.minute")}`);
  }
  return parts.join(" ");
}

function formatShortDate(value: number, locale: string): string {
  return new Intl.DateTimeFormat(locale, { month: "numeric", day: "numeric", timeZone: "UTC" }).format(new Date(value * 1000));
}

function dateKeyTimestamp(value: string): number {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(value);
  if (!match) {
    return Number.NaN;
  }
  return Math.floor(Date.UTC(Number(match[1]), Number(match[2]) - 1, Number(match[3])) / 1000);
}

function isValidTimeZoneName(value: string): boolean {
  if (value.trim().length === 0) {
    return false;
  }
  try {
    new Intl.DateTimeFormat("en", { timeZone: value.trim() }).format(new Date());
    return true;
  } catch {
    return false;
  }
}

function formatChartValue(value: number, metric: ChartMetric, locale: string): string {
  if (metric === "cost") {
    return new Intl.NumberFormat(locale, { notation: "compact", maximumFractionDigits: 2 }).format(value);
  }
  return new Intl.NumberFormat(locale, { notation: "compact", maximumFractionDigits: 1 }).format(value);
}

function chartHeight(width: number, size: ChartSize): number {
  if (size === "expanded") {
    return Math.min(540, Math.max(280, Math.round(width * 0.42)));
  }
  if (size === "comfortable") {
    return Math.min(380, Math.max(220, Math.round(width * 0.32)));
  }
  return Math.min(260, Math.max(180, Math.round(width * 0.22)));
}

async function captureElementPng(element: HTMLElement): Promise<string> {
  const rect = element.getBoundingClientRect();
  const width = Math.ceil(Math.max(element.scrollWidth, rect.width, document.documentElement.clientWidth));
  const height = Math.ceil(Math.max(element.scrollHeight, rect.height));
  const clone = element.cloneNode(true) as HTMLElement;
  copyFormState(element, clone);
  replaceCanvasWithImages(element, clone);
  clone.style.width = `${width}px`;
  clone.style.minWidth = `${width}px`;
  clone.style.boxSizing = "border-box";
  clone.style.margin = "0";

  const background = getCssColor("--surface-muted", getComputedStyle(document.body).backgroundColor || "#111");
  const svg = [
    `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}" viewBox="0 0 ${width} ${height}">`,
    `<foreignObject width="100%" height="100%">`,
    `<div xmlns="http://www.w3.org/1999/xhtml" style="${escapeAttribute(`${rootCssText()}background:${background};width:${width}px;min-height:${height}px;`)}">`,
    `<style>${styleTextForSnapshot()}</style>`,
    clone.outerHTML,
    `</div>`,
    `</foreignObject>`,
    `</svg>`,
  ].join("");

  const url = URL.createObjectURL(new Blob([svg], { type: "image/svg+xml;charset=utf-8" }));
  try {
    const image = await loadImage(url);
    const maxPixels = 32_000_000;
    const scale = Math.min(2, window.devicePixelRatio || 1, Math.sqrt(maxPixels / Math.max(width * height, 1)));
    const canvas = document.createElement("canvas");
    canvas.width = Math.max(1, Math.floor(width * scale));
    canvas.height = Math.max(1, Math.floor(height * scale));
    const context = canvas.getContext("2d");
    if (!context) {
      throw new Error("Canvas is not available.");
    }
    context.fillStyle = background;
    context.fillRect(0, 0, canvas.width, canvas.height);
    context.drawImage(image, 0, 0, canvas.width, canvas.height);
    return canvas.toDataURL("image/png");
  } finally {
    URL.revokeObjectURL(url);
  }
}

type ReportRenderOptions = {
  summary: UsageSummary;
  locale: string;
  translate: (key: string) => string;
  metric: ChartMetric;
  width: number;
};

type ReportPalette = {
  background: string;
  surface: string;
  border: string;
  text: string;
  muted: string;
  accent: string;
  success: string;
  warning: string;
  claude: string;
  codex: string;
};

type ReportCanvas = {
  context: CanvasRenderingContext2D;
  width: number;
  margin: number;
  gap: number;
  palette: ReportPalette;
  fontFamily: string;
};

function renderDashboardReportPng(options: ReportRenderOptions): string {
  const width = Math.min(1800, Math.max(1280, Math.ceil(options.width)));
  const margin = 24;
  const gap = 12;
  const innerWidth = width - margin * 2;
  const models = options.summary.modelSplit.slice(0, 12);
  const sessions = prioritizedSessions(options.summary.sessions);
  const chartHeightValue = 300;
  const providerHeight = 92 + Math.max(0, options.summary.providerSplit.length - 1) * 28;
  const modelHeight = models.length > 0 ? 44 + models.length * 78 : 0;
  const sessionHeight = sessions.length > 0 ? 58 + sessions.length * 28 : 0;
  const issueHeight = options.summary.errors.length + options.summary.warnings.length > 0 ? 88 : 0;
  const controlsHeight = 78;
  const height =
    margin +
    58 +
    gap +
    controlsHeight +
    gap +
    112 +
    gap +
    (issueHeight > 0 ? issueHeight + gap : 0) +
    chartHeightValue +
    gap +
    providerHeight +
    gap +
    modelHeight +
    (modelHeight > 0 ? gap : 0) +
    sessionHeight +
    margin;

  const maxPixels = 28_000_000;
  const scale = Math.max(1, Math.min(2, window.devicePixelRatio || 1, Math.sqrt(maxPixels / Math.max(width * height, 1))));
  const canvas = document.createElement("canvas");
  canvas.width = Math.max(1, Math.floor(width * scale));
  canvas.height = Math.max(1, Math.floor(height * scale));
  const context = canvas.getContext("2d");
  if (!context) {
    throw new Error("Canvas is not available.");
  }

  context.scale(scale, scale);
  const report: ReportCanvas = {
    context,
    width,
    margin,
    gap,
    palette: reportPalette(),
    fontFamily: getComputedStyle(document.body).fontFamily || "system-ui, sans-serif",
  };

  context.fillStyle = report.palette.background;
  context.fillRect(0, 0, width, height);

  let y = margin;
  y = drawReportHeader(report, options, y) + gap;
  y = drawReportControls(report, options, y, innerWidth) + gap;
  y = drawReportSummary(report, options, y, innerWidth) + gap;
  if (issueHeight > 0) {
    y = drawReportIssues(report, options, y, innerWidth) + gap;
  }
  y = drawReportTrend(report, options, y, innerWidth, chartHeightValue) + gap;
  y = drawReportProviders(report, options, y, innerWidth, providerHeight) + gap;
  if (models.length > 0) {
    y = drawReportModels(report, options, y, innerWidth, models) + gap;
  }
  drawReportSessions(report, options, y, innerWidth, sessions);

  return canvas.toDataURL("image/png");
}

function reportPalette(): ReportPalette {
  return {
    background: canvasColor("--surface-muted", getComputedStyle(document.body).backgroundColor || "#111111"),
    surface: canvasColor("--surface", "#161b22"),
    border: canvasColor("--border", "rgba(127, 127, 127, 0.22)"),
    text: canvasColor("--text", "#e6edf3"),
    muted: canvasColor("--muted", "#9aa4b2"),
    accent: canvasColor("--accent", "#3794ff"),
    success: canvasColor("--accent-2", "#89d185"),
    warning: canvasColor("--accent-3", "#cca700"),
    claude: canvasColor("--provider-claude", "#d97757"),
    codex: canvasColor("--provider-codex", "#10a37f"),
  };
}

function canvasColor(name: string, fallback: string): string {
  const value = getCssColor(name, fallback);
  return value.startsWith("var(") ? fallback : value;
}

function drawReportHeader(report: ReportCanvas, options: ReportRenderOptions, y: number): number {
  const { context, margin, palette } = report;
  setReportFont(report, 20, 700);
  context.fillStyle = palette.text;
  context.fillText(options.translate("app.title"), margin, y + 22);
  setReportFont(report, 12, 400);
  context.fillStyle = palette.muted;
  context.fillText(options.translate("app.subtitle"), margin, y + 44);
  const cost = formatSummaryCost(options.summary, options.locale, options.translate);
  setReportFont(report, 17, 700);
  context.fillStyle = palette.success;
  context.textAlign = "right";
  context.fillText(cost, report.width - margin, y + 26);
  context.textAlign = "left";
  return y + 58;
}

function drawReportControls(report: ReportCanvas, options: ReportRenderOptions, y: number, width: number): number {
  const height = 78;
  drawReportCard(report, report.margin, y, width, height);
  const labels = [
    `${options.translate("field.startDate")}: ${options.summary.range.startDate}`,
    `${options.translate("field.endDate")}: ${options.summary.range.endDate}`,
    `${options.translate("filter.provider")}: ${options.summary.providerFilter === "all" ? options.translate("filter.all") : options.summary.providerFilter}`,
    `${options.translate("timezone.label")}: ${options.summary.range.timeZone.label}`,
  ];
  const pillWidth = (width - 28 - 10 * (labels.length - 1)) / labels.length;
  setReportFont(report, 12, 600);
  labels.forEach((label, index) => {
    drawReportPill(report, report.margin + 14 + index * (pillWidth + 10), y + 18, pillWidth, 28, label, index === 2);
  });
  return y + height;
}

function drawReportSummary(report: ReportCanvas, options: ReportRenderOptions, y: number, width: number): number {
  drawReportCard(report, report.margin, y, width, 112, report.palette.success);
  setReportFont(report, 12, 700);
  report.context.fillStyle = report.palette.muted;
  report.context.fillText(options.translate("section.summary"), report.margin + 14, y + 24);

  const metrics: Array<[string, string]> = [
    [options.translate("metric.totalTokens"), formatNumber(tokenSum(options.summary.totals.tokens), options.locale)],
    [options.translate("metric.inputTokens"), formatNumber(inputTokens(options.summary.totals.tokens), options.locale)],
    [options.translate("metric.outputTokens"), formatNumber(outputTokens(options.summary.totals.tokens), options.locale)],
    [options.translate("metric.cacheCreate"), formatNumber(cacheCreateTokens(options.summary.totals.tokens), options.locale)],
    [options.translate("metric.cacheRead"), formatNumber(cacheReadTokens(options.summary.totals.tokens), options.locale)],
    [options.translate("metric.messages"), formatNumber(options.summary.totals.records, options.locale)],
    [options.translate("metric.sessions"), formatNumber(options.summary.totals.sessions, options.locale)],
    [options.translate("metric.activeModels"), formatNumber(options.summary.totals.activeModels, options.locale)],
  ];
  const columnWidth = (width - 28) / metrics.length;
  metrics.forEach(([label, value], index) => {
    drawReportMetric(report, label, value, report.margin + 14 + index * columnWidth, y + 48, columnWidth - 10);
  });
  return y + 112;
}

function drawReportIssues(report: ReportCanvas, options: ReportRenderOptions, y: number, width: number): number {
  drawReportCard(report, report.margin, y, width, 88, report.palette.warning);
  const issues = [...options.summary.errors, ...options.summary.warnings].slice(0, 2);
  setReportFont(report, 12, 700);
  report.context.fillStyle = report.palette.muted;
  report.context.fillText(options.translate("section.issues"), report.margin + 14, y + 24);
  setReportFont(report, 12, 500);
  report.context.fillStyle = report.palette.text;
  issues.forEach((issue, index) => {
    drawClippedText(report, `${issue.code}: ${issue.message}`, report.margin + 14, y + 48 + index * 19, width - 28);
  });
  return y + 88;
}

function drawReportTrend(report: ReportCanvas, options: ReportRenderOptions, y: number, width: number, height: number): number {
  drawReportCard(report, report.margin, y, width, height);
  const { context, palette } = report;
  setReportFont(report, 12, 700);
  context.fillStyle = palette.muted;
  context.fillText(`${options.translate("section.trend")} - ${chartLabel(options.metric, options.translate)}`, report.margin + 14, y + 24);

  const plot = {
    x: report.margin + 54,
    y: y + 52,
    width: width - 82,
    height: height - 84,
  };
  const values = options.summary.trend.map((item) =>
    options.metric === "cost" ? item.cost?.amount ?? 0 : options.metric === "records" ? item.records : tokenMetricValue(item.tokens, options.metric),
  );
  const maxValue = Math.max(...values, 1);
  context.strokeStyle = withAlpha(palette.border, 0.72);
  context.lineWidth = 1;
  for (let line = 0; line <= 4; line += 1) {
    const lineY = plot.y + (plot.height / 4) * line;
    context.beginPath();
    context.moveTo(plot.x, lineY);
    context.lineTo(plot.x + plot.width, lineY);
    context.stroke();
  }

  if (values.length > 0) {
    const points = values.map((value, index) => ({
      x: plot.x + (values.length === 1 ? plot.width / 2 : (plot.width / (values.length - 1)) * index),
      y: plot.y + plot.height - (value / maxValue) * plot.height,
    }));
    context.beginPath();
    context.moveTo(points[0]?.x ?? plot.x, plot.y + plot.height);
    points.forEach((point) => context.lineTo(point.x, point.y));
    context.lineTo(points[points.length - 1]?.x ?? plot.x, plot.y + plot.height);
    context.lineTo(points[0]?.x ?? plot.x, plot.y + plot.height);
    context.closePath();
    context.fillStyle = withAlpha(palette.accent, 0.16);
    context.fill();

    context.beginPath();
    points.forEach((point, index) => {
      if (index === 0) {
        context.moveTo(point.x, point.y);
      } else {
        context.lineTo(point.x, point.y);
      }
    });
    context.strokeStyle = palette.accent;
    context.lineWidth = 2;
    context.stroke();
  }

  setReportFont(report, 11, 400);
  context.fillStyle = palette.muted;
  const first = options.summary.trend[0]?.bucket;
  const last = options.summary.trend[options.summary.trend.length - 1]?.bucket;
  if (first) {
    context.fillText(formatShortDate(dateKeyTimestamp(first), options.locale), plot.x, plot.y + plot.height + 24);
  }
  if (last) {
    context.textAlign = "right";
    context.fillText(formatShortDate(dateKeyTimestamp(last), options.locale), plot.x + plot.width, plot.y + plot.height + 24);
    context.textAlign = "left";
  }
  return y + height;
}

function drawReportProviders(report: ReportCanvas, options: ReportRenderOptions, y: number, width: number, height: number): number {
  drawReportCard(report, report.margin, y, width, height);
  setReportFont(report, 12, 700);
  report.context.fillStyle = report.palette.muted;
  report.context.fillText(options.translate("section.providers"), report.margin + 14, y + 24);
  options.summary.providerSplit.forEach((item, index) => {
    const color = item.provider === "claude" ? report.palette.claude : report.palette.codex;
    const rowY = y + 48 + index * 28;
    setReportFont(report, 12, 600);
    report.context.fillStyle = color;
    report.context.fillText(item.provider, report.margin + 14, rowY + 10);
    drawReportBar(report, report.margin + 180, rowY, width - 280, 8, item.records / Math.max(options.summary.totals.records, 1), color);
    report.context.fillStyle = report.palette.text;
    report.context.textAlign = "right";
    report.context.fillText(formatNumber(item.records, options.locale), report.margin + width - 14, rowY + 10);
    report.context.textAlign = "left";
  });
  return y + height;
}

function drawReportModels(report: ReportCanvas, options: ReportRenderOptions, y: number, width: number, models: UsageSummary["modelSplit"]): number {
  const height = 44 + models.length * 78;
  drawReportCard(report, report.margin, y, width, height);
  setReportFont(report, 12, 700);
  report.context.fillStyle = report.palette.muted;
  report.context.fillText(options.translate("section.models"), report.margin + 14, y + 24);
  models.forEach((model, index) => {
    const color = model.provider === "claude" ? report.palette.claude : report.palette.codex;
    const rowY = y + 42 + index * 78;
    drawReportCard(report, report.margin + 10, rowY, width - 20, 66, color, withAlpha(color, 0.1));
    setReportFont(report, 13, 700);
    report.context.fillStyle = color;
    drawClippedText(report, model.model, report.margin + 22, rowY + 21, width - 260);
    report.context.fillStyle = report.palette.success;
    report.context.textAlign = "right";
    report.context.fillText(formatCost(model.cost, options.locale, options.translate), report.margin + width - 22, rowY + 21);
    report.context.textAlign = "left";
    const metrics: Array<[string, string]> = [
      [options.translate("metric.inputTokens"), formatNumber(inputTokens(model.tokens), options.locale)],
      [options.translate("metric.outputTokens"), formatNumber(outputTokens(model.tokens), options.locale)],
      [options.translate("metric.cacheCreate"), formatNumber(cacheCreateTokens(model.tokens), options.locale)],
      [options.translate("metric.cacheRead"), formatNumber(cacheReadTokens(model.tokens), options.locale)],
      [options.translate("metric.messages"), formatNumber(model.records, options.locale)],
    ];
    const metricWidth = (width - 44) / metrics.length;
    metrics.forEach(([label, value], metricIndex) => {
      drawReportMetric(report, label, value, report.margin + 22 + metricIndex * metricWidth, rowY + 38, metricWidth - 12, 10, 11);
    });
  });
  return y + height;
}

function drawReportSessions(report: ReportCanvas, options: ReportRenderOptions, y: number, width: number, sessions: UsageSummary["sessions"]): number {
  if (sessions.length === 0) {
    return y;
  }
  const height = 58 + sessions.length * 28;
  drawReportCard(report, report.margin, y, width, height);
  setReportFont(report, 12, 700);
  report.context.fillStyle = report.palette.muted;
  report.context.fillText(options.translate("section.sessions"), report.margin + 14, y + 24);

  const columns = [
    { key: "provider", label: options.translate("column.provider"), width: 86 },
    { key: "model", label: options.translate("column.model"), width: 170 },
    { key: "session", label: options.translate("column.session"), width: Math.max(210, width - 1118) },
    { key: "started", label: options.translate("column.started"), width: 86 },
    { key: "duration", label: options.translate("column.duration"), width: 76 },
    { key: "cost", label: options.translate("column.cost"), width: 118 },
    { key: "records", label: options.translate("metric.messages"), width: 76 },
    { key: "tokens", label: options.translate("metric.totalTokens"), width: 104 },
    { key: "input", label: options.translate("metric.inputTokens"), width: 96 },
    { key: "output", label: options.translate("metric.outputTokens"), width: 96 },
    { key: "cache", label: options.translate("metric.cacheRead"), width: 96 },
  ];
  let x = report.margin + 14;
  setReportFont(report, 10, 700);
  report.context.fillStyle = report.palette.muted;
  for (const column of columns) {
    drawClippedText(report, column.label, x, y + 50, column.width - 8);
    x += column.width;
  }

  sessions.forEach((session, index) => {
    const rowY = y + 66 + index * 28;
    report.context.strokeStyle = withAlpha(report.palette.border, 0.65);
    report.context.beginPath();
    report.context.moveTo(report.margin + 10, rowY - 11);
    report.context.lineTo(report.margin + width - 10, rowY - 11);
    report.context.stroke();

    const values: Record<string, string> = {
      provider: session.provider,
      model: session.model ?? options.translate("state.unknown"),
      session: session.sessionId,
      started: formatDate(session.startedAt, options.locale, options.summary.range.timeZone.resolvedTimeZone),
      duration: formatDuration(session.startedAt, session.endedAt, options.translate),
      cost: formatCost(session.cost, options.locale, options.translate),
      records: formatNumber(session.records, options.locale),
      tokens: formatNumber(tokenSum(session.tokens), options.locale),
      input: formatNumber(inputTokens(session.tokens), options.locale),
      output: formatNumber(outputTokens(session.tokens), options.locale),
      cache: formatNumber(cacheReadTokens(session.tokens), options.locale),
    };
    x = report.margin + 14;
    setReportFont(report, 11, 500);
    for (const column of columns) {
      report.context.fillStyle =
        column.key === "provider" && values[column.key] === "claude"
          ? report.palette.claude
          : column.key === "provider" && values[column.key] === "codex"
            ? report.palette.codex
            : report.palette.text;
      drawClippedText(report, values[column.key] ?? "", x, rowY, column.width - 8);
      x += column.width;
    }
  });
  return y + height;
}

function drawReportMetric(report: ReportCanvas, label: string, value: string, x: number, y: number, width: number, labelSize = 11, valueSize = 13): void {
  setReportFont(report, labelSize, 500);
  report.context.fillStyle = report.palette.muted;
  drawClippedText(report, label, x, y, width);
  setReportFont(report, valueSize, 700);
  report.context.fillStyle = report.palette.text;
  drawClippedText(report, value, x, y + 21, width);
}

function drawReportPill(report: ReportCanvas, x: number, y: number, width: number, height: number, label: string, active: boolean): void {
  drawRoundedRect(report.context, x, y, width, height, 6);
  report.context.fillStyle = active ? withAlpha(report.palette.accent, 0.22) : report.palette.background;
  report.context.fill();
  report.context.strokeStyle = active ? report.palette.accent : report.palette.border;
  report.context.stroke();
  setReportFont(report, 12, 600);
  report.context.fillStyle = report.palette.text;
  drawClippedText(report, label, x + 10, y + 18, width - 20);
}

function drawReportBar(report: ReportCanvas, x: number, y: number, width: number, height: number, ratio: number, color: string): void {
  drawRoundedRect(report.context, x, y, width, height, height / 2);
  report.context.fillStyle = withAlpha(report.palette.border, 0.56);
  report.context.fill();
  drawRoundedRect(report.context, x, y, Math.max(4, width * Math.min(1, Math.max(0, ratio))), height, height / 2);
  report.context.fillStyle = color;
  report.context.fill();
}

function drawReportCard(report: ReportCanvas, x: number, y: number, width: number, height: number, accent?: string, fill?: string): void {
  drawRoundedRect(report.context, x, y, width, height, 6);
  report.context.fillStyle = fill ?? report.palette.surface;
  report.context.fill();
  report.context.strokeStyle = report.palette.border;
  report.context.stroke();
  if (accent) {
    drawRoundedRect(report.context, x, y, 4, height, 4);
    report.context.fillStyle = accent;
    report.context.fill();
  }
}

function drawRoundedRect(context: CanvasRenderingContext2D, x: number, y: number, width: number, height: number, radius: number): void {
  const safeRadius = Math.min(radius, width / 2, height / 2);
  context.beginPath();
  context.moveTo(x + safeRadius, y);
  context.lineTo(x + width - safeRadius, y);
  context.quadraticCurveTo(x + width, y, x + width, y + safeRadius);
  context.lineTo(x + width, y + height - safeRadius);
  context.quadraticCurveTo(x + width, y + height, x + width - safeRadius, y + height);
  context.lineTo(x + safeRadius, y + height);
  context.quadraticCurveTo(x, y + height, x, y + height - safeRadius);
  context.lineTo(x, y + safeRadius);
  context.quadraticCurveTo(x, y, x + safeRadius, y);
  context.closePath();
}

function drawClippedText(report: ReportCanvas, value: string, x: number, y: number, width: number): void {
  let text = value;
  if (report.context.measureText(text).width <= width) {
    report.context.fillText(text, x, y);
    return;
  }
  while (text.length > 1 && report.context.measureText(`${text}...`).width > width) {
    text = text.slice(0, -1);
  }
  report.context.fillText(`${text}...`, x, y);
}

function setReportFont(report: ReportCanvas, size: number, weight: number): void {
  report.context.font = `${weight} ${size}px ${report.fontFamily}`;
}

function copyFormState(source: HTMLElement, clone: HTMLElement): void {
  const sourceControls = source.querySelectorAll<HTMLInputElement | HTMLSelectElement | HTMLTextAreaElement>("input, select, textarea");
  const cloneControls = clone.querySelectorAll<HTMLInputElement | HTMLSelectElement | HTMLTextAreaElement>("input, select, textarea");
  sourceControls.forEach((sourceControl, index) => {
    const cloneControl = cloneControls[index];
    if (!cloneControl) {
      return;
    }
    if (sourceControl instanceof HTMLInputElement && cloneControl instanceof HTMLInputElement) {
      cloneControl.setAttribute("value", sourceControl.value);
      if (sourceControl.checked) {
        cloneControl.setAttribute("checked", "checked");
      }
      return;
    }
    if (sourceControl instanceof HTMLTextAreaElement && cloneControl instanceof HTMLTextAreaElement) {
      cloneControl.textContent = sourceControl.value;
      return;
    }
    if (sourceControl instanceof HTMLSelectElement && cloneControl instanceof HTMLSelectElement) {
      Array.from(cloneControl.options).forEach((option) => {
        if (option.value === sourceControl.value) {
          option.setAttribute("selected", "selected");
        } else {
          option.removeAttribute("selected");
        }
      });
    }
  });
}

function replaceCanvasWithImages(source: HTMLElement, clone: HTMLElement): void {
  const sourceCanvases = source.querySelectorAll("canvas");
  const cloneCanvases = clone.querySelectorAll("canvas");
  sourceCanvases.forEach((sourceCanvas, index) => {
    const cloneCanvas = cloneCanvases[index];
    if (!cloneCanvas) {
      return;
    }
    const image = document.createElement("img");
    const rect = sourceCanvas.getBoundingClientRect();
    image.src = sourceCanvas.toDataURL("image/png");
    image.style.cssText = (cloneCanvas as HTMLCanvasElement).style.cssText;
    image.style.width = `${Math.max(1, Math.round(rect.width))}px`;
    image.style.height = `${Math.max(1, Math.round(rect.height))}px`;
    image.setAttribute("width", String(Math.max(1, Math.round(rect.width))));
    image.setAttribute("height", String(Math.max(1, Math.round(rect.height))));
    cloneCanvas.replaceWith(image);
  });
}

function styleTextForSnapshot(): string {
  return Array.from(document.styleSheets)
    .map((sheet) => {
      try {
        return Array.from(sheet.cssRules).map((rule) => rule.cssText).join("\n");
      } catch {
        return "";
      }
    })
    .join("\n")
    .replace(/<\/style/gi, "<\\/style");
}

function rootCssText(): string {
  const style = getComputedStyle(document.documentElement);
  const declarations = [`color-scheme:${style.getPropertyValue("color-scheme") || "dark"};`];
  for (let index = 0; index < style.length; index += 1) {
    const property = style.item(index);
    if (property.startsWith("--")) {
      declarations.push(`${property}:${style.getPropertyValue(property)};`);
    }
  }
  return declarations.join("");
}

function loadImage(url: string): Promise<HTMLImageElement> {
  return new Promise((resolve, reject) => {
    const image = new Image();
    image.onload = () => resolve(image);
    image.onerror = () => reject(new Error("Screenshot rendering failed."));
    image.src = url;
  });
}

function escapeAttribute(value: string): string {
  return value.replaceAll("&", "&amp;").replaceAll('"', "&quot;").replaceAll("<", "&lt;").replaceAll(">", "&gt;");
}

async function copyPngToClipboard(dataUrl: string, translate: (key: string) => string): Promise<void> {
  if (!navigator.clipboard || typeof navigator.clipboard.write !== "function" || typeof globalThis.ClipboardItem === "undefined") {
    throw new Error(translate("error.clipboardImageUnsupported"));
  }

  if (typeof globalThis.ClipboardItem.supports === "function" && !globalThis.ClipboardItem.supports("image/png")) {
    throw new Error(translate("error.clipboardImageUnsupported"));
  }

  try {
    await navigator.clipboard.write([
      new globalThis.ClipboardItem({
        "image/png": pngDataUrlToBlob(dataUrl, translate),
      }),
    ]);
  } catch {
    throw new Error(translate("error.clipboardImageFailed"));
  }
}

function pngDataUrlToBlob(dataUrl: string, translate: (key: string) => string): Blob {
  const match = /^data:image\/png;base64,(.+)$/u.exec(dataUrl);
  const payload = match?.[1];
  if (!payload) {
    throw new Error(translate("error.screenshotDataInvalid"));
  }

  const binary = atob(payload);
  const bytes = new Uint8Array(binary.length);
  for (let index = 0; index < binary.length; index += 1) {
    bytes[index] = binary.charCodeAt(index);
  }
  return new Blob([bytes], { type: "image/png" });
}

function classNames(...values: Array<string | false | undefined>): string {
  return values.filter(Boolean).join(" ");
}

function readInitialLoadingState(): DashboardLoadingState {
  const host = document.getElementById("app");
  const rawValue = host?.dataset.loadingState;
  if (rawValue) {
    try {
      const parsed = JSON.parse(rawValue) as DashboardLoadingState;
      if (parsed && typeof parsed === "object" && parsed.messages && Array.isArray(parsed.sources)) {
        return parsed;
      }
    } catch {
      // Fall through to the English fallback below.
    }
  }

  return {
    locale: "en",
    localePreference: "auto",
    messages: {
      "loading.eyebrow": "Local scan",
      "loading.title": "Loading usage data",
      "loading.subtitle": "Preparing the dashboard and checking local usage paths.",
      "loading.phase.starting": "Preparing dashboard",
      "loading.phase.detectingSources": "Checking paths",
      "loading.phase.readingSources": "Reading usage files",
      "loading.phase.calculating": "Calculating totals",
      "loading.source.configured": "Configured",
      "loading.source.candidate": "Candidate path",
      "loading.source.invalid": "Needs attention",
      "loading.source.missing": "No path",
      "loading.source.none": "No path available",
      "loading.cache.label": "Cache",
      "loading.cache.cold": "Building cache",
      "loading.cache.warm": "Using cache",
      "loading.cache.partial": "Partial cache",
      "loading.cache.rebuilding": "Refreshing cache",
      "loading.cache.rangeComplete": "Range complete",
      "loading.cache.rangePending": "Range pending",
      "loading.cache.historyComplete": "History complete",
      "loading.cache.historyPending": "History pending",
      "loading.progress.filesChecked": "Files checked",
      "loading.progress.filesParsed": "Files parsed",
      "loading.progress.recordsLoaded": "Records loaded",
      "loading.progress.provider": "Provider",
      "loading.progress.currentPath": "Current file",
    },
    phase: "starting",
    sources: [
      { provider: "claude", status: "missing" },
      { provider: "codex", status: "missing" },
    ],
  };
}

function openSettings(): void {
  vscodeApi.postMessage({
    requestId: createRequestId("settings"),
    type: "openSettings",
    version: webviewProtocolVersion,
  });
}

function createRequestId(prefix: string): string {
  return `${prefix}-${Date.now()}-${Math.random().toString(16).slice(2)}`;
}

function getCssColor(name: string, fallback: string): string {
  const value = getComputedStyle(document.documentElement).getPropertyValue(name).trim();
  return value || fallback;
}

function providerColor(provider: UsageProviderFilter): string {
  if (provider === "claude") {
    return getCssColor("--provider-claude", "#d97757");
  }
  if (provider === "codex") {
    return getCssColor("--provider-codex", "#10a37f");
  }
  return getCssColor("--vscode-charts-blue", "#3794ff");
}

function withAlpha(color: string, alpha: number): string {
  if (color.startsWith("#")) {
    const normalized = color.length === 4 ? `#${color[1]}${color[1]}${color[2]}${color[2]}${color[3]}${color[3]}` : color;
    const red = Number.parseInt(normalized.slice(1, 3), 16);
    const green = Number.parseInt(normalized.slice(3, 5), 16);
    const blue = Number.parseInt(normalized.slice(5, 7), 16);
    if ([red, green, blue].every((value) => Number.isFinite(value))) {
      return `rgba(${red}, ${green}, ${blue}, ${alpha})`;
    }
  }
  if (color.startsWith("rgb(")) {
    return color.replace("rgb(", "rgba(").replace(")", `, ${alpha})`);
  }
  return color;
}

function RefreshIcon() {
  return (
    <svg viewBox="0 0 24 24" aria-hidden="true">
      <path d="M20 12a8 8 0 0 1-13.6 5.7M4 12A8 8 0 0 1 17.6 6.3M17 3v4h4M7 21v-4H3" />
    </svg>
  );
}

function RebuildCacheIcon() {
  return (
    <svg viewBox="0 0 24 24" aria-hidden="true">
      <path d="M4 6c0-2 3.6-3 8-3s8 1 8 3-3.6 3-8 3-8-1-8-3Z" />
      <path d="M4 6v5c0 1.3 2 2.3 5 2.7M20 6v4M4 11v5c0 1.2 1.7 2.1 4.4 2.6" />
      <path d="M18.2 14.2A4 4 0 1 1 14 13.1" />
      <path d="M18 11v3.2h3.2" />
    </svg>
  );
}

function SettingsIcon() {
  return (
    <svg viewBox="0 0 24 24" aria-hidden="true">
      <path d="M12 15.5a3.5 3.5 0 1 0 0-7 3.5 3.5 0 0 0 0 7Z" />
      <path d="M19.4 15a1.7 1.7 0 0 0 .3 1.9l.1.1a2 2 0 0 1-2.8 2.8l-.1-.1a1.7 1.7 0 0 0-1.9-.3 1.7 1.7 0 0 0-1 1.5V21a2 2 0 0 1-4 0v-.1a1.7 1.7 0 0 0-1-1.5 1.7 1.7 0 0 0-1.9.3l-.1.1A2 2 0 0 1 4.2 17l.1-.1a1.7 1.7 0 0 0 .3-1.9 1.7 1.7 0 0 0-1.5-1H3a2 2 0 0 1 0-4h.1a1.7 1.7 0 0 0 1.5-1 1.7 1.7 0 0 0-.3-1.9L4.2 7A2 2 0 0 1 7 4.2l.1.1a1.7 1.7 0 0 0 1.9.3 1.7 1.7 0 0 0 1-1.5V3a2 2 0 0 1 4 0v.1a1.7 1.7 0 0 0 1 1.5 1.7 1.7 0 0 0 1.9-.3l.1-.1A2 2 0 0 1 19.8 7l-.1.1a1.7 1.7 0 0 0-.3 1.9 1.7 1.7 0 0 0 1.5 1h.1a2 2 0 0 1 0 4h-.1a1.7 1.7 0 0 0-1.5 1Z" />
    </svg>
  );
}

function CopyIcon() {
  return (
    <svg viewBox="0 0 24 24" aria-hidden="true">
      <path d="M8 8h10v12H8Z" />
      <path d="M6 16H4V4h12v2" />
    </svg>
  );
}

function MinusIcon() {
  return (
    <svg viewBox="0 0 24 24" aria-hidden="true">
      <path d="M5 12h14" />
    </svg>
  );
}

function PlusIcon() {
  return (
    <svg viewBox="0 0 24 24" aria-hidden="true">
      <path d="M12 5v14M5 12h14" />
    </svg>
  );
}

render(<Dashboard />, document.getElementById("app") as HTMLElement);
