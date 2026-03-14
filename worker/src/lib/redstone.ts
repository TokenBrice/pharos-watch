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

export const REDSTONE_TRACKED_SYMBOL_ALLOWLIST = [
  "ALUSD",
  "CEUR",
  "DAI",
  "DOLA",
  "EURS",
  "FDUSD",
  "FRAX",
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
] as const;

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

async function fetchRedstoneBatch(
  symbols: string[],
  signal?: AbortSignal,
): Promise<Map<string, RedstoneResult>> {
  const results = new Map<string, RedstoneResult>();
  if (symbols.length === 0) return results;

  const symbolsParam = symbols.join(",");
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
  for (const symbol of symbols) {
    const entry = normalizeEntry(data[symbol]);
    if (!entry?.value || entry.value <= 0) continue;

    const venues = new Map<string, number>();
    if (entry.source) {
      for (const [venue, price] of Object.entries(entry.source)) {
        if (typeof price === "number" && price > 0) {
          venues.set(venue, price);
        }
      }
    }

    let agreeCount = 0;
    for (const venuePrice of venues.values()) {
      const bps = Math.abs(((venuePrice / entry.value) - 1) * 10000);
      if (bps <= 50) agreeCount++;
    }
    const venueAgreementPct = venues.size > 0
      ? Math.round((agreeCount / venues.size) * 100)
      : 100;

    results.set(symbol, {
      price: entry.value,
      venues,
      venueCount: venues.size,
      venueAgreementPct,
      timestamp: entry.timestamp ? Math.floor(entry.timestamp / 1000) : Math.floor(Date.now() / 1000),
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
