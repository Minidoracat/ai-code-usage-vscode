import { addCost, addTokens } from "../domain/math";
import type {
  AdapterImportResult,
  ImportIssue,
  SourceMeta,
  TimeRange,
  UsageCost,
  UsageProviderFilter,
  UsageProvider,
  UsageRecord,
  UsageSession,
  UsageSummary,
} from "../domain/types";
import { estimateRecordCost, PricingService } from "./PricingService";
import { zonedDateKey } from "./TimeZoneService";

export class UsageAggregator {
  public constructor(private readonly pricing?: PricingService) {}

  public aggregate(imports: AdapterImportResult[], range: TimeRange, providerFilter: UsageProviderFilter = "all"): UsageSummary {
    const warnings = imports.flatMap((item) => item.warnings);
    const errors = imports.flatMap((item) => item.errors);
    const sourceMeta = imports.flatMap((item) => item.sourceMeta);
    const records = this.filterRecords(imports.flatMap((item) => item.records), range, providerFilter);

    return {
      range,
      providerFilter,
      totals: this.buildTotals(records),
      providerSplit: this.buildProviderSplit(records),
      modelSplit: this.buildModelSplit(records),
      trend: this.buildTrend(records, range),
      sessions: this.buildSessions(records),
      warnings,
      errors,
      sourceMeta,
    };
  }

  private filterRecords(records: UsageRecord[], range: TimeRange, providerFilter: UsageProviderFilter): UsageRecord[] {
    const start = new Date(range.start).getTime();
    const end = new Date(range.end).getTime();
    return records.filter((record) => {
      if (providerFilter !== "all" && record.provider !== providerFilter) {
        return false;
      }
      const value = new Date(record.startedAt ?? record.observedAt).getTime();
      return value >= start && value <= end;
    });
  }

  private buildTotals(records: UsageRecord[]): UsageSummary["totals"] {
    const sessionIds = new Set(records.map((record) => sessionKey(record)));
    const activeModels = new Set(records.map((record) => record.model).filter(Boolean));
    return {
      records: records.length,
      sessions: sessionIds.size,
      tokens: records.reduce((total, record) => addTokens(total, record.tokens), {}),
      cost: this.sumCost(records),
      activeModels: activeModels.size,
    };
  }

  private buildProviderSplit(records: UsageRecord[]): UsageSummary["providerSplit"] {
    const providers: UsageProvider[] = ["claude", "codex"];
    return providers.map((provider) => {
      const providerRecords = records.filter((record) => record.provider === provider);
      return {
        provider,
        records: providerRecords.length,
        sessions: new Set(providerRecords.map((record) => sessionKey(record))).size,
        tokens: providerRecords.reduce((total, record) => addTokens(total, record.tokens), {}),
        cost: this.sumCost(providerRecords),
      };
    });
  }

  private buildModelSplit(records: UsageRecord[]): UsageSummary["modelSplit"] {
    const groups = new Map<string, UsageRecord[]>();
    for (const record of records) {
      const model = record.model ?? "unknown";
      const key = `${record.provider}:${model}`;
      pushGroup(groups, key, record);
    }

    return [...groups.entries()]
      .map(([key, groupRecords]) => {
        const [provider, model] = key.split(":");
        return {
          provider: provider as UsageProvider,
          model: model ?? "unknown",
          records: groupRecords.length,
          tokens: groupRecords.reduce((total, record) => addTokens(total, record.tokens), {}),
          cost: this.sumCost(groupRecords),
        };
      })
      .sort((a, b) => b.records - a.records);
  }

  private buildTrend(records: UsageRecord[], range: TimeRange): UsageSummary["trend"] {
    const groups = new Map<string, UsageRecord[]>();
    for (const record of records) {
      const bucket = zonedDateKey(new Date(record.startedAt ?? record.observedAt), range.timeZone.resolvedTimeZone);
      pushGroup(groups, bucket, record);
    }

    return [...groups.entries()]
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([bucket, groupRecords]) => ({
        bucket,
        records: groupRecords.length,
        sessions: new Set(groupRecords.map((record) => sessionKey(record))).size,
        tokens: groupRecords.reduce((total, record) => addTokens(total, record.tokens), {}),
        cost: this.sumCost(groupRecords),
      }));
  }

  private buildSessions(records: UsageRecord[]): UsageSession[] {
    const groups = new Map<string, UsageRecord[]>();
    for (const record of records) {
      const key = sessionKey(record);
      pushGroup(groups, key, record);
    }

    return [...groups.values()]
      .map((groupRecords) => {
        const first = groupRecords[0];
        return {
          provider: first?.provider ?? "claude",
          sessionId: first?.sessionId ?? "unknown",
          model: first?.model,
          startedAt: earliest(groupRecords.map((record) => record.startedAt)),
          endedAt: latest(groupRecords.map((record) => record.endedAt ?? record.observedAt)),
          records: groupRecords.length,
          tokens: groupRecords.reduce((total, record) => addTokens(total, record.tokens), {}),
          cost: this.sumCost(groupRecords),
        };
      })
      .sort((a, b) => (b.startedAt ?? "").localeCompare(a.startedAt ?? ""));
  }

  private sumCost(records: UsageRecord[]): UsageCost | undefined {
    const costs = records.map((record) => estimateRecordCost(record, this.pricing)).filter((cost): cost is UsageCost => Boolean(cost));
    const currencies = new Set(costs.map((cost) => cost.currency));
    if (currencies.size !== 1) {
      return undefined;
    }
    const total = costs.reduce((total, cost) => addCost(total, cost), undefined as UsageCost | undefined);
    if (total && costs.length < records.length) {
      return { ...total, note: "partial" };
    }
    return total;
  }
}

function pushGroup(groups: Map<string, UsageRecord[]>, key: string, record: UsageRecord): void {
  const group = groups.get(key);
  if (group) {
    group.push(record);
    return;
  }
  groups.set(key, [record]);
}

export function mergeIssues(imports: AdapterImportResult[]): { warnings: ImportIssue[]; errors: ImportIssue[]; sourceMeta: SourceMeta[] } {
  return {
    warnings: imports.flatMap((item) => item.warnings),
    errors: imports.flatMap((item) => item.errors),
    sourceMeta: imports.flatMap((item) => item.sourceMeta),
  };
}

function sessionKey(record: UsageRecord): string {
  return `${record.provider}:${record.sessionId ?? record.source.sourcePath}:${record.model ?? "unknown"}`;
}

function earliest(values: Array<string | undefined>): string | undefined {
  return values.filter(Boolean).sort()[0];
}

function latest(values: Array<string | undefined>): string | undefined {
  return values.filter(Boolean).sort().at(-1);
}
