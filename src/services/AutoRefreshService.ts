export const defaultAutoRefreshIntervalSeconds = 300;
export const maxAutoRefreshIntervalSeconds = 86_400;
export const minAutoRefreshIntervalSeconds = 30;

export function normalizeAutoRefreshIntervalSeconds(value: number | undefined): number {
  if (typeof value !== "number" || !Number.isFinite(value)) {
    return defaultAutoRefreshIntervalSeconds;
  }
  const intervalSeconds = Math.round(value);
  if (intervalSeconds <= 0) {
    return 0;
  }
  return Math.min(maxAutoRefreshIntervalSeconds, Math.max(minAutoRefreshIntervalSeconds, intervalSeconds));
}

export function isValidAutoRefreshIntervalSeconds(value: unknown): value is number {
  return (
    typeof value === "number" &&
    Number.isInteger(value) &&
    value <= maxAutoRefreshIntervalSeconds &&
    (value === 0 || value >= minAutoRefreshIntervalSeconds)
  );
}
