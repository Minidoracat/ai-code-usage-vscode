export const supportedProviders = ["claude", "codex"] as const;

export type UsageProvider = (typeof supportedProviders)[number];

export type UsageProviderFilter = UsageProvider | "all";

export type TokenCategory =
  | "input"
  | "output"
  | "cachedInput"
  | "cacheRead"
  | "cacheWrite5m"
  | "cacheWrite1h"
  | "unknown";

export type TokenBreakdown = Partial<Record<TokenCategory, number>>;

export type CostSource = "calculated" | "imported";

export type UsageCost = {
  amount: number;
  currency: string;
  source: CostSource;
  sourceUrl?: string;
  checkedAt?: string;
  note?: string;
};

export type SourceKind = "json" | "jsonl" | "sqlite" | "directory" | "unknown";

export type SourceMeta = {
  sourcePath: string;
  sourceKind: SourceKind;
  schemaVersion?: string;
  parserVersion: string;
  readAt: string;
};

export type ImportIssueSeverity = "warning" | "error";

export type ImportIssue = {
  severity: ImportIssueSeverity;
  code: string;
  message: string;
  sourcePath?: string;
  line?: number;
  provider?: UsageProvider;
};

export type UsageRecord = {
  provider: UsageProvider;
  model?: string;
  sessionId?: string;
  startedAt?: string;
  endedAt?: string;
  observedAt: string;
  tokens: TokenBreakdown;
  cost?: UsageCost;
  source: SourceMeta;
  raw?: unknown;
};

export type AdapterImportResult = {
  provider: UsageProvider;
  records: UsageRecord[];
  warnings: ImportIssue[];
  errors: ImportIssue[];
  sourceMeta: SourceMeta[];
};

export type AdapterOptions = {
  usagePath?: string;
};

export interface UsageAdapter {
  readonly provider: UsageProvider;
  importUsage(options?: AdapterOptions): Promise<AdapterImportResult>;
}

export type TimeRangeKind = "today" | "yesterday" | "thisWeek" | "lastWeek" | "thisMonth" | "lastMonth" | "custom";

export type TimeZoneMode = "system" | "utc" | "custom";

export type TimeZoneState = {
  mode: TimeZoneMode;
  systemTimeZone: string;
  customTimeZone?: string;
  resolvedTimeZone: string;
  label: string;
  offsetLabel: string;
};

export type TimeRange = {
  kind: TimeRangeKind;
  startDate: string;
  endDate: string;
  start: string;
  end: string;
  timeZone: TimeZoneState;
};

export type UsageSession = {
  provider: UsageProvider;
  sessionId: string;
  model?: string;
  startedAt?: string;
  endedAt?: string;
  records: number;
  tokens: TokenBreakdown;
  cost?: UsageCost;
};

export type UsageSummary = {
  range: TimeRange;
  providerFilter: UsageProviderFilter;
  totals: {
    records: number;
    sessions: number;
    tokens: TokenBreakdown;
    cost?: UsageCost;
    activeModels: number;
  };
  providerSplit: Array<{
    provider: UsageProvider;
    records: number;
    sessions: number;
    tokens: TokenBreakdown;
    cost?: UsageCost;
  }>;
  modelSplit: Array<{
    provider: UsageProvider;
    model: string;
    records: number;
    tokens: TokenBreakdown;
    cost?: UsageCost;
  }>;
  trend: Array<{
    bucket: string;
    records: number;
    sessions: number;
    tokens: TokenBreakdown;
    cost?: UsageCost;
  }>;
  sessions: UsageSession[];
  warnings: ImportIssue[];
  errors: ImportIssue[];
  sourceMeta: SourceMeta[];
};

export type PricingRule = {
  provider: UsageProvider;
  model: string;
  modelAliases: string[];
  currency: string;
  priceUnit: "per_1m_tokens";
  sourceUrl: string;
  checkedAt: string;
  rates: Partial<Record<TokenCategory, number>>;
};

export type PricingCatalog = {
  checkedAt: string;
  sourceUrls: string[];
  rules: PricingRule[];
};

export type CostEstimate =
  | {
      available: true;
      cost: UsageCost;
    }
  | {
      available: false;
      reason: "unknown_model" | "missing_tokens" | "stale_pricing" | "missing_pricing_metadata";
      importedCost?: UsageCost;
    };
