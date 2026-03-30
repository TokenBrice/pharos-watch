import { validatePayloadWithSchema } from "../lib/api-utils";
import { USER_AGENT } from "../lib/constants";
import { fetchWithRetry } from "../lib/fetch-retry";
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
  const res = await fetchWithRetry(url, {
    headers: { "User-Agent": USER_AGENT },
    signal,
  });
  if (!res || !res.ok) {
    return null;
  }

  const payload = await res.json();
  const validation = validatePayloadWithSchema(
    SecondaryCurrencyResponseSchema,
    payload,
    `sync-fx-rates:secondary:${endpoint}`,
  );
  if (!validation.ok) {
    console.warn(`[sync-fx-rates] Secondary FX payload invalid (${endpoint}): ${validation.issues}`);
    return null;
  }

  return {
    endpoint,
    payload: validation.data,
  };
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
  const res = await fetchWithRetry(url, {
    headers: { "User-Agent": USER_AGENT },
    signal,
  });
  if (!res || !res.ok) {
    return {
      ok: false,
      kind: "unavailable",
      statusCode: res?.status ?? null,
    };
  }

  const payload = await res.json();
  const validation = validatePayloadWithSchema(
    FrankfurterResponseSchema,
    payload,
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
  const primaryCandidate = await fetchSecondaryCurrencyCandidate(
    "jsdelivr",
    SECONDARY_FX_PRIMARY_URL,
    signal,
  );
  const fallbackCandidate = await fetchSecondaryCurrencyCandidate(
    "pages.dev",
    SECONDARY_FX_FALLBACK_URL,
    signal,
  );

  const secondaryCandidate = chooseSecondaryCurrencyCandidate(primaryCandidate, fallbackCandidate);
  if (
    primaryCandidate &&
    fallbackCandidate &&
    secondaryCandidate &&
    secondaryCandidate.endpoint !== primaryCandidate.endpoint
  ) {
    console.log(
      `[sync-fx-rates] Using fresher secondary FX mirror (${secondaryCandidate.endpoint} date=${secondaryCandidate.payload.date ?? "unknown"}, ` +
      `jsdelivr=${primaryCandidate.payload.date ?? "unknown"})`,
    );
  }

  return secondaryCandidate;
}

export async function loadExchangeRateApiPayload(signal?: AbortSignal): Promise<ExchangeRateApiPayload | null> {
  const res = await fetchWithRetry(TERTIARY_FX_URL, {
    headers: { "User-Agent": USER_AGENT },
    signal,
  });
  if (!res || !res.ok) {
    return null;
  }

  const payload = await res.json();
  const validation = validatePayloadWithSchema(
    ExchangeRateApiResponseSchema,
    payload,
    "sync-fx-rates:exchange-rate-api",
  );
  if (!validation.ok) {
    console.warn(`[sync-fx-rates] ExchangeRate-API payload invalid: ${validation.issues}`);
    return null;
  }
  if (validation.data.result && validation.data.result !== "success") {
    console.warn(`[sync-fx-rates] ExchangeRate-API returned result=${validation.data.result}`);
    return null;
  }
  return validation.data;
}
