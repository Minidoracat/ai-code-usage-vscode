// The only file allowed to perform a network request (see scripts/check-privacy.mjs).
// The request is user-triggered only, sends no local data, and never runs automatically.
const publicExchangeRatesUrl = "https://open.er-api.com/v6/latest/USD";

export type PublicExchangeRates = {
  /** ISO timestamp of the provider's last data refresh. */
  updatedAt: string;
  /** Units of each currency per 1 USD; validated positive finite numbers. */
  rates: Record<string, number>;
};

export const publicExchangeRatesSource = "open.er-api.com";

// A well-formed response is ~4 KB; cap the decompressed body so a hostile or
// misbehaving endpoint cannot buffer unbounded data into the extension host.
const maxResponseBytes = 2 * 1024 * 1024;

export async function fetchPublicExchangeRates(timeoutMs = 10_000): Promise<PublicExchangeRates> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetch(publicExchangeRatesUrl, {
      signal: controller.signal,
      redirect: "error",
      headers: { accept: "application/json" },
    });
    if (!response.ok) {
      throw new Error(`Exchange rate request failed with status ${response.status}.`);
    }
    return parsePublicExchangeRates(JSON.parse(await readBodyCapped(response)));
  } finally {
    clearTimeout(timer);
  }
}

async function readBodyCapped(response: Response): Promise<string> {
  const reader = response.body?.getReader();
  if (!reader) {
    const text = await response.text();
    if (text.length > maxResponseBytes) {
      throw new Error("Exchange rate response is too large.");
    }
    return text;
  }
  const decoder = new TextDecoder();
  let received = 0;
  let text = "";
  for (;;) {
    const { done, value } = await reader.read();
    if (done) {
      break;
    }
    received += value.byteLength;
    if (received > maxResponseBytes) {
      await reader.cancel();
      throw new Error("Exchange rate response is too large.");
    }
    text += decoder.decode(value, { stream: true });
  }
  return text + decoder.decode();
}

export function parsePublicExchangeRates(payload: unknown): PublicExchangeRates {
  if (typeof payload !== "object" || payload === null) {
    throw new Error("Exchange rate response is not an object.");
  }
  const body = payload as Record<string, unknown>;
  if (body["result"] !== "success" || typeof body["rates"] !== "object" || body["rates"] === null) {
    throw new Error("Exchange rate response is malformed.");
  }
  // Fail closed on provider drift: rates must be USD-based or every converted
  // amount would be silently wrong.
  if (body["base_code"] !== "USD") {
    throw new Error("Exchange rate response is not USD-based.");
  }
  const rates: Record<string, number> = {};
  for (const [code, value] of Object.entries(body["rates"] as Record<string, unknown>)) {
    const normalized = code.trim().toUpperCase();
    if (/^[A-Z]{3}$/.test(normalized) && typeof value === "number" && Number.isFinite(value) && value > 0) {
      rates[normalized] = value;
    }
  }
  if (rates["USD"] !== 1) {
    throw new Error("Exchange rate response has an unexpected USD rate.");
  }
  const updatedAtRaw = body["time_last_update_utc"];
  if (typeof updatedAtRaw !== "string" || Number.isNaN(new Date(updatedAtRaw).getTime())) {
    throw new Error("Exchange rate response has an invalid data timestamp.");
  }
  return { updatedAt: new Date(updatedAtRaw).toISOString(), rates };
}
