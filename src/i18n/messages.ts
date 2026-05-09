import catalog from "./catalog.json";

export type Locale = keyof typeof catalog;
export type MessageKey = keyof (typeof catalog)["en"];

export const supportedLocales = Object.keys(catalog) as Locale[];

export function normalizeLocale(value: string | undefined): Locale {
  if (!value || value === "auto") {
    return "en";
  }
  const exact = supportedLocales.find((locale) => locale.toLowerCase() === value.toLowerCase());
  if (exact) {
    return exact;
  }
  const language = value.split("-")[0];
  return supportedLocales.find((locale) => locale.split("-")[0] === language) ?? "en";
}

export function translate(locale: Locale, key: MessageKey, args: Record<string, string | number> = {}): string {
  const message = catalog[locale][key] ?? catalog.en[key] ?? key;
  return Object.entries(args).reduce((text, [name, value]) => text.replaceAll(`{${name}}`, String(value)), message);
}

export function messagesFor(locale: Locale): Record<MessageKey, string> {
  return { ...catalog.en, ...catalog[locale] };
}
