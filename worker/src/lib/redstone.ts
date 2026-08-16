import { logWorkerEventArgs } from "./structured-log";
import {
  REDSTONE_PROVIDER_AUDIT_CONFIG,
  REDSTONE_SYMBOL_CONFIG,
} from "@shared/lib/pricing-provider-config";
import { median } from "@shared/lib/stats";
import { sleepWithSignal, throwIfAborted } from "./abort";
import { toErrorMessage } from "./error-utils";
import { fetchJsonWithRetry } from "./fetch-retry";
import type { FetcherOutcome } from "./fetcher-result";

export interface RedstoneResult {
  stablecoinId: string;
  metaSymbol: string;
  apiSymbol: string;
  price: number;
  venues: Map<string, number>;    // venue name → price
  venueCount: number;
  venueAgreementPct: number;      // % of venues within 50bps of median
  timestamp: number;
}

interface RedstoneEntry {
  value?: number;
  source?: Record<string, number>;
  timestamp?: number;
}

const REDSTONE_BATCH_SIZE = 10;
const REDSTONE_REQUEST_TIMEOUT_MS = 7_500;
const REDSTONE_MAX_STALENESS_SEC = 300;
const REDSTONE_RETRY_BUDGET = 5;
const REDSTONE_RETRY_SLEEP_MS = 100;

const REDSTONE_META_TO_API_SYMBOL = new Map<string, string>(
  REDSTONE_SYMBOL_CONFIG.map((entry) => [entry.metaSymbol, entry.apiSymbol] as const),
);
const REDSTONE_META_TO_ENTRY = new Map<string, (typeof REDSTONE_SYMBOL_CONFIG)[number]>(
  REDSTONE_SYMBOL_CONFIG.map((entry) => [entry.metaSymbol, entry] as const),
);
const REDSTONE_STABLECOIN_ID_TO_META_SYMBOL = new Map<string, string>(
  REDSTONE_SYMBOL_CONFIG.map((entry) => [entry.stablecoinId, entry.metaSymbol] as const),
);

export const REDSTONE_TRACKED_SYMBOL_ALLOWLIST = REDSTONE_SYMBOL_CONFIG.map((entry) => entry.metaSymbol) as readonly string[];
export const REDSTONE_TRACKED_STABLECOIN_IDS = REDSTONE_SYMBOL_CONFIG.map((entry) => entry.stablecoinId) as readonly string[];

function toApiSymbol(metaSymbol: string): string {
  return REDSTONE_META_TO_API_SYMBOL.get(metaSymbol) ?? metaSymbol;
}

const REDSTONE_TRACKED_SYMBOL_SET = new Set<string>(REDSTONE_TRACKED_SYMBOL_ALLOWLIST);

export function getRedstoneMetaSymbolForStablecoinId(stablecoinId: string): string | undefined {
  return REDSTONE_STABLECOIN_ID_TO_META_SYMBOL.get(stablecoinId);
}

function normalizeSymbols(symbols: string[]): string[] {
  const deduped = new Set<string>();
  for (const symbol of symbols) {
    if (REDSTONE_TRACKED_SYMBOL_SET.has(symbol)) {
      deduped.add(symbol);
    }
  }
  return [...deduped];
}

function normalizeEntry(entry: RedstoneEntry | RedstoneEntry[] | undefined): RedstoneEntry | null {
  if (entry == null) return null;
  if (Array.isArray(entry)) {
    if (entry.length === 0) return null;
    // The live RedStone /prices endpoint currently returns one object per
    // symbol. The schema still permits arrays for future provider modes;
    // if arrays ever arrive, pick the entry with the largest timestamp so
    // downstream staleness checks see the freshest sample.
    return [...entry].sort((a, b) => (b.timestamp ?? 0) - (a.timestamp ?? 0))[0] ?? null;
  }
  return entry;
}

async function fetchRedstoneBatch(
  symbols: string[],
  signal?: AbortSignal,
): Promise<{ results: Map<string, RedstoneResult>; transportOk: boolean }> {
  const results = new Map<string, RedstoneResult>();
  if (symbols.length === 0) return { results, transportOk: true };

  // Translate metadata symbols to RedStone API symbols and build reverse map.
  // Results are keyed by canonical stablecoin id so same-symbol tracked assets
  // cannot receive a feed that belongs to a different issuer or deployment.
  const apiToEntry = new Map<string, (typeof REDSTONE_SYMBOL_CONFIG)[number]>();
  const apiSymbols: string[] = [];
  for (const metaSym of symbols) {
    const configEntry = REDSTONE_META_TO_ENTRY.get(metaSym);
    if (!configEntry) continue;
    const apiSym = toApiSymbol(metaSym);
    apiSymbols.push(apiSym);
    apiToEntry.set(apiSym, configEntry);
  }

  const symbolsParam = apiSymbols.join(",");
  const result = await fetchJsonWithRetry<Record<string, RedstoneEntry | RedstoneEntry[]>>(
    `${REDSTONE_PROVIDER_AUDIT_CONFIG.metadataUrl}?symbols=${encodeURIComponent(symbolsParam)}&provider=redstone-primary-prod`,
    { signal, headers: { Accept: "application/json" } },
    0,
    { timeoutMs: REDSTONE_REQUEST_TIMEOUT_MS },
  );
  if (!result?.response.ok) {
    logWorkerEventArgs("lib", "warn", `[redstone] API returned ${result?.response.status ?? "no response"} for batch: ${symbolsParam}`);
    return { results, transportOk: false };
  }

  const data = result.body;
  for (const apiSym of apiSymbols) {
    const configEntry = apiToEntry.get(apiSym);
    if (!configEntry) continue;
    const entry = normalizeEntry(data[apiSym]);
    if (!entry?.value || entry.value <= 0) continue;

    const timestampSec =
      typeof entry.timestamp === "number" && Number.isFinite(entry.timestamp)
        ? Math.floor(entry.timestamp / 1000)
        : null;
    const nowSec = Math.floor(Date.now() / 1000);
    if (timestampSec == null || nowSec - timestampSec > REDSTONE_MAX_STALENESS_SEC) {
      logWorkerEventArgs("lib", "warn", `[redstone] Skipping stale or timestamp-less price for ${apiSym}`);
      continue;
    }

    const venues = new Map<string, number>();
    if (entry.source) {
      for (const [venue, price] of Object.entries(entry.source)) {
        if (typeof price === "number" && price > 0) {
          venues.set(venue, price);
        }
      }
    }
    if (venues.size === 0) {
      logWorkerEventArgs("lib", "warn", `[redstone] Skipping ${apiSym}: no per-venue breakdown`);
      continue;
    }

    const venuePrices = [...venues.values()];
    const derivedPrice = median(venuePrices);
    if (derivedPrice == null || !Number.isFinite(derivedPrice) || derivedPrice <= 0) {
      logWorkerEventArgs("lib", "warn", `[redstone] Skipping ${apiSym}: unusable venue median`);
      continue;
    }

    let agreeCount = 0;
    for (const venuePrice of venuePrices) {
      const bps = Math.abs(((venuePrice / derivedPrice) - 1) * 10000);
      if (bps <= 50) agreeCount++;
    }
    const venueAgreementPct = venues.size > 0
      ? Math.round((agreeCount / venues.size) * 100)
      : 100;

    results.set(configEntry.stablecoinId, {
      stablecoinId: configEntry.stablecoinId,
      metaSymbol: configEntry.metaSymbol,
      apiSymbol: configEntry.apiSymbol,
      price: derivedPrice,
      venues,
      venueCount: venues.size,
      venueAgreementPct,
      timestamp: timestampSec,
    });
  }

  return { results, transportOk: true };
}

/**
 * Fetch prices from RedStone API with per-venue breakdown.
 * Free API, no auth, undocumented rate limits.
 * Uses exact-case tracked symbols, small sequential batches, and single-symbol
 * retries for batch drops observed on the live API.
 */
export async function fetchRedstonePrices(
  symbols: string[],
  signal?: AbortSignal,
): Promise<FetcherOutcome<Map<string, RedstoneResult>>> {
  const results = new Map<string, RedstoneResult>();
  const requestedSymbols = normalizeSymbols(symbols);
  if (requestedSymbols.length === 0) return { kind: "no-data", value: results };

  let transportAttempts = 0;
  let transportFailures = 0;
  try {
    const missingSymbols: string[] = [];

    for (let i = 0; i < requestedSymbols.length; i += REDSTONE_BATCH_SIZE) {
      throwIfAborted(signal);
      const batch = requestedSymbols.slice(i, i + REDSTONE_BATCH_SIZE);
      transportAttempts++;
      const { results: batchResults, transportOk } = await fetchRedstoneBatch(batch, signal);
      if (!transportOk) transportFailures++;
      for (const [stablecoinId, result] of batchResults) {
        results.set(stablecoinId, result);
      }
      const returnedMetaSymbols = new Set([...batchResults.values()].map((result) => result.metaSymbol));
      for (const symbol of batch) {
        if (!returnedMetaSymbols.has(symbol)) {
          missingSymbols.push(symbol);
        }
      }
    }

    let recoveredCount = 0;
    let retries = 0;
    for (const symbol of missingSymbols) {
      if (retries >= REDSTONE_RETRY_BUDGET) break;
      retries++;
      await sleepWithSignal(REDSTONE_RETRY_SLEEP_MS, signal);
      transportAttempts++;
      const { results: retryResults, transportOk } = await fetchRedstoneBatch([symbol], signal);
      if (!transportOk) transportFailures++;
      const retryResult = [...retryResults.values()].find((result) => result.metaSymbol === symbol);
      if (retryResult) {
        results.set(retryResult.stablecoinId, retryResult);
        recoveredCount++;
      }
    }

    logWorkerEventArgs("lib", "info",
      `[redstone] requested ${requestedSymbols.length}, returned ${results.size}, recovered ${recoveredCount} via solo retry`,
    );
    if (results.size === 0) {
      logWorkerEventArgs("lib", "warn", `[redstone] Requested ${requestedSymbols.length} symbols but got 0 usable results`);
    }
  } catch (err) {
    if (signal?.aborted) throw err instanceof Error ? err : new Error(String(err));
    logWorkerEventArgs("lib", "warn", "[redstone] Fetch failed:", err);
    return { kind: "upstream-error", value: results, reason: toErrorMessage(err) };
  }

  if (transportAttempts > 0 && transportFailures === transportAttempts) {
    return { kind: "upstream-error", value: results, reason: "all RedStone batches failed" };
  }
  if (results.size === 0) {
    return { kind: "upstream-error", value: results, reason: "RedStone returned no usable prices" };
  }
  return { kind: "ok", value: results };
}
