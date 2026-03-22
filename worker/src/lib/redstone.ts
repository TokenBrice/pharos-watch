import { fetchWithRetry } from "./fetch-retry";

export interface RedstoneResult {
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

export const REDSTONE_TRACKED_SYMBOL_ALLOWLIST = [
  "ALUSD",
  "AUSD",
  "CETES",
  "CEUR",
  "DAI",
  "DOLA",
  "EURC",
  "EURS",
  "EUSD",
  "FDUSD",
  "FRAX",
  "FRXUSD",
  "GHO",
  "GYEN",
  "HONEY",
  "LUSD",
  "MUSD",
  "OUSD",
  "PAXG",
  "PYUSD",
  "SUSD",
  "TUSD",
  "USD1",
  "USDC",
  "USDD",
  "USDH",
  "USDP",
  "USDT",
  "USDe",
  "USDf",
  "USR",
  "XAUT",
  "XSGD",
  "crvUSD",
  "fxUSD",
  "sUSDe",
] as const;

/**
 * Maps metadata symbol → RedStone API symbol when they differ.
 * RedStone is case-sensitive; some feeds use different casing or legacy names.
 */
const REDSTONE_API_SYMBOL_MAP: Record<string, string> = {
  AUSD: "aUSD",
  EURC: "EUROC",
  EUSD: "eUSD",
  FRXUSD: "frxUSD",
  XAUT: "XAUt",
};

function toApiSymbol(metaSymbol: string): string {
  return REDSTONE_API_SYMBOL_MAP[metaSymbol] ?? metaSymbol;
}

const REDSTONE_TRACKED_SYMBOL_SET = new Set<string>(REDSTONE_TRACKED_SYMBOL_ALLOWLIST);

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
  if (Array.isArray(entry)) return entry[0] ?? null;
  return entry;
}

function median(values: number[]): number {
  const sorted = [...values].sort((left, right) => left - right);
  const middle = Math.floor(sorted.length / 2);
  if (sorted.length === 0) return Number.NaN;
  if (sorted.length % 2 === 1) return sorted[middle]!;
  return (sorted[middle - 1]! + sorted[middle]!) / 2;
}

async function fetchRedstoneBatch(
  symbols: string[],
  signal?: AbortSignal,
): Promise<Map<string, RedstoneResult>> {
  const results = new Map<string, RedstoneResult>();
  if (symbols.length === 0) return results;

  // Translate metadata symbols to RedStone API symbols and build reverse map
  const apiToMeta = new Map<string, string>();
  const apiSymbols: string[] = [];
  for (const metaSym of symbols) {
    const apiSym = toApiSymbol(metaSym);
    apiSymbols.push(apiSym);
    apiToMeta.set(apiSym, metaSym);
  }

  const symbolsParam = apiSymbols.join(",");
  const res = await fetchWithRetry(
    `https://api.redstone.finance/prices?symbols=${encodeURIComponent(symbolsParam)}&provider=redstone-primary-prod`,
    { signal, headers: { Accept: "application/json" } },
    0,
    { timeoutMs: REDSTONE_REQUEST_TIMEOUT_MS },
  );
  if (!res?.ok) {
    console.warn(`[redstone] API returned ${res?.status ?? "no response"} for batch: ${symbolsParam}`);
    return results;
  }

  const data = (await res.json()) as Record<string, RedstoneEntry | RedstoneEntry[]>;
  for (const apiSym of apiSymbols) {
    const entry = normalizeEntry(data[apiSym]);
    if (!entry?.value || entry.value <= 0) continue;

    const timestampSec =
      typeof entry.timestamp === "number" && Number.isFinite(entry.timestamp)
        ? Math.floor(entry.timestamp / 1000)
        : null;
    const nowSec = Math.floor(Date.now() / 1000);
    if (timestampSec == null || nowSec - timestampSec > REDSTONE_MAX_STALENESS_SEC) {
      console.warn(`[redstone] Skipping stale or timestamp-less price for ${apiSym}`);
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
      console.warn(`[redstone] Skipping ${apiSym}: no per-venue breakdown`);
      continue;
    }

    const venuePrices = [...venues.values()];
    const derivedPrice = median(venuePrices);
    if (!Number.isFinite(derivedPrice) || derivedPrice <= 0) {
      console.warn(`[redstone] Skipping ${apiSym}: unusable venue median`);
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

    // Key results by metadata symbol so callers can look up by asset.symbol
    const metaSym = apiToMeta.get(apiSym) ?? apiSym;
    results.set(metaSym, {
      price: derivedPrice,
      venues,
      venueCount: venues.size,
      venueAgreementPct,
      timestamp: timestampSec,
    });
  }

  return results;
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
): Promise<Map<string, RedstoneResult>> {
  const results = new Map<string, RedstoneResult>();
  const requestedSymbols = normalizeSymbols(symbols);
  if (requestedSymbols.length === 0) return results;

  try {
    const missingSymbols: string[] = [];

    for (let i = 0; i < requestedSymbols.length; i += REDSTONE_BATCH_SIZE) {
      const batch = requestedSymbols.slice(i, i + REDSTONE_BATCH_SIZE);
      const batchResults = await fetchRedstoneBatch(batch, signal);
      for (const [symbol, result] of batchResults) {
        results.set(symbol, result);
      }
      for (const symbol of batch) {
        if (!batchResults.has(symbol)) {
          missingSymbols.push(symbol);
        }
      }
    }

    let recoveredCount = 0;
    for (const symbol of missingSymbols) {
      if (results.has(symbol)) continue;
      const retryResults = await fetchRedstoneBatch([symbol], signal);
      const retryResult = retryResults.get(symbol);
      if (retryResult) {
        results.set(symbol, retryResult);
        recoveredCount++;
      }
    }

    console.log(
      `[redstone] requested ${requestedSymbols.length}, returned ${results.size}, recovered ${recoveredCount} via solo retry`,
    );
    if (results.size === 0) {
      console.warn(`[redstone] Requested ${requestedSymbols.length} symbols but got 0 usable results`);
    }
  } catch (err) {
    if (signal?.aborted) throw err instanceof Error ? err : new Error(String(err));
    console.warn("[redstone] Fetch failed:", err);
  }

  return results;
}
