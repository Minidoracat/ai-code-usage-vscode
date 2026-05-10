import type {
  PricingCatalog,
  TimeRange,
  TimeRangeKind,
  TimeZoneMode,
  TimeZoneState,
  UsageProvider,
  UsageProviderFilter,
  UsageSummary,
} from "../domain/types";
import { isTimeRangeKind } from "../domain/timeRange";
import { isValidAutoRefreshIntervalSeconds } from "../services/AutoRefreshService";
import { isTimeZoneMode, isValidTimeZone } from "../services/TimeZoneService";

export const webviewProtocolVersion = 1;
export type DashboardLocalePreference = "auto" | "en" | "zh-TW" | "zh-CN" | "ja" | "ko";
export type DashboardLoadingPhase = "starting" | "detectingSources" | "readingSources" | "calculating";

export type WebviewRequest =
  | {
      requestId: string;
      type: "refresh";
      version: typeof webviewProtocolVersion;
      payload?: undefined;
    }
  | {
      requestId: string;
      type: "rebuildCache";
      version: typeof webviewProtocolVersion;
      payload?: undefined;
    }
  | {
      requestId: string;
      type: "setRange";
      version: typeof webviewProtocolVersion;
      payload: {
        kind: TimeRangeKind;
        start?: string;
        end?: string;
      };
    }
  | {
      requestId: string;
      type: "setProvider";
      version: typeof webviewProtocolVersion;
      payload: {
        provider: UsageProviderFilter;
      };
    }
  | {
      requestId: string;
      type: "setLocale";
      version: typeof webviewProtocolVersion;
      payload: {
        locale: DashboardLocalePreference;
      };
    }
  | {
      requestId: string;
      type: "setAutoRefresh";
      version: typeof webviewProtocolVersion;
      payload: {
        intervalSeconds: number;
      };
    }
  | {
      requestId: string;
      type: "setTimeZone";
      version: typeof webviewProtocolVersion;
      payload: {
        mode: TimeZoneMode;
        customTimeZone?: string;
      };
    };

export type ExtensionMessage =
  | {
      requestId?: string;
      type: "loadingData";
      version: typeof webviewProtocolVersion;
      payload: DashboardLoadingState;
    }
  | {
      requestId?: string;
      type: "usageData";
      version: typeof webviewProtocolVersion;
      payload: DashboardState;
    }
  | {
      requestId: string;
      type: "error";
      version: typeof webviewProtocolVersion;
      payload: {
        code: string;
        message: string;
      };
    };

export type DashboardLoadingSource = {
  provider: UsageProvider;
  status: "configured" | "candidate" | "invalid" | "missing";
  path?: string;
};

export type DashboardCacheStatus = "cold" | "warm" | "partial" | "rebuilding";

export type DashboardLoadingProgress = {
  filesTotal: number;
  filesChecked: number;
  filesParsed: number;
  recordsLoaded: number;
  currentProvider?: UsageProvider;
  currentPath?: string;
};

export type DashboardCacheState = {
  status: DashboardCacheStatus;
  rangeComplete: boolean;
  historicalComplete: boolean;
};

export type DashboardLoadingState = {
  locale: string;
  localePreference: DashboardLocalePreference;
  messages: Record<string, string>;
  phase: DashboardLoadingPhase;
  sources: DashboardLoadingSource[];
  range?: TimeRange;
  progress?: DashboardLoadingProgress;
  cache?: DashboardCacheState;
};

export type DashboardState = {
  locale: string;
  localePreference: DashboardLocalePreference;
  messages: Record<string, string>;
  updatedAt: string;
  autoRefreshIntervalSeconds: number;
  timeZone: TimeZoneState;
  pricing: PricingCatalog;
  summary: UsageSummary;
};

export function validateWebviewRequest(value: unknown): WebviewRequest | { error: string } {
  if (!isObject(value)) {
    return { error: "Message must be an object." };
  }
  if (typeof value["requestId"] !== "string" || value["requestId"].length === 0) {
    return { error: "Message requestId is required." };
  }
  if (value["version"] !== webviewProtocolVersion) {
    return { error: "Unsupported webview message version." };
  }
  if (value["type"] === "refresh") {
    return {
      requestId: value["requestId"],
      type: "refresh",
      version: webviewProtocolVersion,
    };
  }
  if (value["type"] === "rebuildCache") {
    return {
      requestId: value["requestId"],
      type: "rebuildCache",
      version: webviewProtocolVersion,
    };
  }
  if (value["type"] === "setRange" && isObject(value["payload"])) {
    const kind = value["payload"]["kind"];
    if (isTimeRangeKind(kind)) {
      return {
        requestId: value["requestId"],
        type: "setRange",
        version: webviewProtocolVersion,
        payload: {
          kind,
          start: stringOrUndefined(value["payload"]["start"]),
          end: stringOrUndefined(value["payload"]["end"]),
        },
      };
    }
  }
  if (value["type"] === "setProvider" && isObject(value["payload"])) {
    const provider = value["payload"]["provider"];
    if (provider === "all" || provider === "claude" || provider === "codex") {
      return {
        requestId: value["requestId"],
        type: "setProvider",
        version: webviewProtocolVersion,
        payload: { provider },
      };
    }
  }
  if (value["type"] === "setLocale" && isObject(value["payload"])) {
    const locale = value["payload"]["locale"];
    if (isLocalePreference(locale)) {
      return {
        requestId: value["requestId"],
        type: "setLocale",
        version: webviewProtocolVersion,
        payload: { locale },
      };
    }
  }
  if (value["type"] === "setAutoRefresh" && isObject(value["payload"])) {
    const intervalSeconds = value["payload"]["intervalSeconds"];
    if (isValidAutoRefreshIntervalSeconds(intervalSeconds)) {
      return {
        requestId: value["requestId"],
        type: "setAutoRefresh",
        version: webviewProtocolVersion,
        payload: { intervalSeconds },
      };
    }
  }
  if (value["type"] === "setTimeZone" && isObject(value["payload"])) {
    const mode = value["payload"]["mode"];
    const customTimeZone = stringOrUndefined(value["payload"]["customTimeZone"])?.trim();
    if (isTimeZoneMode(mode) && (mode !== "custom" || isValidTimeZone(customTimeZone))) {
      return {
        requestId: value["requestId"],
        type: "setTimeZone",
        version: webviewProtocolVersion,
        payload: {
          mode,
          customTimeZone,
        },
      };
    }
  }
  return { error: "Unsupported webview message type or payload." };
}

function isLocalePreference(value: unknown): value is DashboardLocalePreference {
  return value === "auto" || value === "en" || value === "zh-TW" || value === "zh-CN" || value === "ja" || value === "ko";
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function stringOrUndefined(value: unknown): string | undefined {
  return typeof value === "string" ? value : undefined;
}
