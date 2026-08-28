import { logWorkerEventArgs } from "../lib/structured-log";
import { validatePayloadWithSchema } from "../lib/api-schema";
import { USER_AGENT } from "../lib/constants";
import { fetchJsonWithRetry } from "../lib/fetch-retry";
import type {
  ExchangeRateApiPayload,
  SecondaryCurrencyCandidate,
  SecondaryCurrencyEndpoint,
} from "./sync-fx-rates-helpers";
import { z } from "zod";

const SECONDARY_FX_PRIMARY_URL = "https://cdn.jsdelivr.net/npm/@fawazahmed0/currency-api@latest/v1/currencies/usd.min.json";
const SECONDARY_FX_FALLBACK_URL = "https://latest.currency-api.pages.dev/v1/currencies/usd.min.json";
const TERTIARY_FX_URL = "https://open.er-api.com/v6/latest/USD";

const FrankfurterResponseSchema = z.object({
  base: z.string(),
  date: z.string(),
  rates: z.record(z.string(), z.number()),
});

const SecondaryCurrencyResponseSchema = z.object({
  date: z.string().optional(),
  usd: z.record(z.string(), z.number()),
});

const ExchangeRateApiResponseSchema = z.object({
  result: z.string().optional(),
  time_last_update_unix: z.number().optional(),
  time_last_update_utc: z.string().optional(),
  rates: z.record(z.string(), z.number()),
});

export interface FrankfurterPayload {
  date: string;
  rates: Record<string, number>;
}

export type FrankfurterLoadResult =
  | { ok: true; data: FrankfurterPayload }
  | { ok: false; kind: "unavailable"; statusCode: number | null }
  | { ok: false; kind: "invalid-payload"; issues: string };

function formatSecondaryFxVersion(date: Date): string {
  return `${date.getUTCFullYear()}.${date.getUTCMonth() + 1}.${date.getUTCDate()}`;
}

function buildSecondaryFxDatedPackageUrl(now = new Date()): string {
  const version = formatSecondaryFxVersion(now);
  return `https://cdn.jsdelivr.net/npm/@fawazahmed0/currency-api@${version}/v1/currencies/usd.min.json`;
}

function rankIsoDate(dateText: string | null | undefined): number {
  if (!dateText) return Number.NEGATIVE_INFINITY;
  const parsed = Date.parse(`${dateText}T00:00:00Z`);
  return Number.isFinite(parsed) ? parsed : Number.NEGATIVE_INFINITY;
}

async function fetchSecondaryCurrencyCandidate(
  endpoint: SecondaryCurrencyEndpoint,
  url: string,
  signal?: AbortSignal,
): Promise<SecondaryCurrencyCandidate | null> {
  const result = await fetchJsonWithRetry(url, {
    headers: { "User-Agent": USER_AGENT },
    signal,
  });
  if (!result || !result.response.ok) {
    return null;
  }

  try {
    const validation = validatePayloadWithSchema(
      SecondaryCurrencyResponseSchema,
      result.body,
      `sync-fx-rates:secondary:${endpoint}`,
    );
    if (!validation.ok) {
      logWorkerEventArgs("handler", "warn", `[sync-fx-rates] Secondary FX payload invalid (${endpoint}): ${validation.issues}`);
      return null;
    }

    return {
      endpoint,
      payload: validation.data,
    };
  } catch {
    return null;
  }
}

function chooseSecondaryCurrencyCandidate(
  primary: SecondaryCurrencyCandidate | null,
  fallback: SecondaryCurrencyCandidate | null,
): SecondaryCurrencyCandidate | null {
  if (!primary) return fallback;
  if (!fallback) return primary;

  return rankIsoDate(fallback.payload.date) > rankIsoDate(primary.payload.date)
    ? fallback
    : primary;
}

export async function loadFrankfurterPayload(
  primaryCurrencies: readonly string[],
  signal?: AbortSignal,
): Promise<FrankfurterLoadResult> {
  const url = `https://api.frankfurter.dev/v1/latest?base=USD&symbols=${primaryCurrencies.join(",")}`;
  const result = await fetchJsonWithRetry(url, {
    headers: { "User-Agent": USER_AGENT },
    signal,
  });
  if (!result || !result.response.ok) {
    return {
      ok: false,
      kind: "unavailable",
      statusCode: result?.response.status ?? null,
    };
  }

  const validation = validatePayloadWithSchema(
    FrankfurterResponseSchema,
    result.body,
    "sync-fx-rates:frankfurter",
  );
  if (!validation.ok) {
    return {
      ok: false,
      kind: "invalid-payload",
      issues: validation.issues,
    };
  }

  return {
    ok: true,
    data: validation.data,
  };
}

export async function loadSecondaryCurrencyCandidate(signal?: AbortSignal): Promise<SecondaryCurrencyCandidate | null> {
  const [primaryCandidate, fallbackCandidate, datedPackageCandidate] = await Promise.all([
    fetchSecondaryCurrencyCandidate("jsdelivr", SECONDARY_FX_PRIMARY_URL, signal),
    fetchSecondaryCurrencyCandidate("pages.dev", SECONDARY_FX_FALLBACK_URL, signal),
    fetchSecondaryCurrencyCandidate("jsdelivr-versioned", buildSecondaryFxDatedPackageUrl(), signal),
  ]);

  const secondaryCandidate = chooseSecondaryCurrencyCandidate(
    chooseSecondaryCurrencyCandidate(primaryCandidate, fallbackCandidate),
    datedPackageCandidate,
  );
  if (
    primaryCandidate &&
    secondaryCandidate &&
    secondaryCandidate.endpoint !== primaryCandidate.endpoint
  ) {
    logWorkerEventArgs("handler", "info",
      `[sync-fx-rates] Using fresher secondary FX mirror (${secondaryCandidate.endpoint} date=${secondaryCandidate.payload.date ?? "unknown"}, ` +
      `jsdelivr=${primaryCandidate.payload.date ?? "unknown"})`,
    );
  }

  return secondaryCandidate;
}

export async function loadExchangeRateApiPayload(signal?: AbortSignal): Promise<ExchangeRateApiPayload | null> {
  const result = await fetchJsonWithRetry(TERTIARY_FX_URL, {
    headers: { "User-Agent": USER_AGENT },
    signal,
  });
  if (!result || !result.response.ok) {
    return null;
  }

  const validation = validatePayloadWithSchema(
    ExchangeRateApiResponseSchema,
    result.body,
    "sync-fx-rates:exchange-rate-api",
  );
  if (!validation.ok) {
    logWorkerEventArgs("handler", "warn", `[sync-fx-rates] ExchangeRate-API payload invalid: ${validation.issues}`);
    return null;
  }
  if (validation.data.result && validation.data.result !== "success") {
    logWorkerEventArgs("handler", "warn", `[sync-fx-rates] ExchangeRate-API returned result=${validation.data.result}`);
    return null;
  }
  return validation.data;
}
