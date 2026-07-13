import {
  DIRECT_API_POOL_MIN_TVL_USD,
  makeDexApiFetchResult,
  type DexApiFetchResult,
  type DexApiPool,
} from "../../lib/dex-api-common";
import { rethrowIfAborted, sleepWithSignal } from "../../lib/abort";
import { USER_AGENT } from "../../lib/constants";
import { cancelResponseBodyQuietly } from "../../lib/response-body";
import {
  buildDirectApiRequestSignal,
} from "./direct-api-policy";
import { isDexApiRecord } from "./direct-api-json";
import { toErrorMessage } from "../../lib/error-utils";
import {
  describeDexPaginationWriteFailure,
  isDegradingDexPaginationWriteFailure,
  readDexSourcePaginationState,
  summarizeDexSourcePaginationWrites,
  writeDexSourcePaginationState,
  type DexSourcePaginationWriteAttempt,
} from "./source-pagination-state";

const ORCA_API = "https://api.orca.so/v2/solana/pools";
const ORCA_RATE_LIMIT_RETRIES = 3;
const ORCA_RATE_LIMIT_BACKOFF_MS = 1_000;
const ORCA_PAGES_PER_RUN = 4;
const ORCA_SOURCE_KEY = "orca:solana";

function buildOrcaPoolsUrl(cursor?: string | null): string {
  const url = new URL(ORCA_API);
  url.searchParams.set("sortBy", "tvl");
  url.searchParams.set("sortDirection", "desc");
  url.searchParams.set("minTvl", String(DIRECT_API_POOL_MIN_TVL_USD));
  url.searchParams.set("size", "200");
  if (cursor) url.searchParams.set("next", cursor);
  return url.toString();
}

interface OrcaPool {
  address: string;
  price: string;
  tvlUsdc: string;
  feeRate: number;
  tokenA: { address: string; symbol: string; decimals: number };
  tokenB: { address: string; symbol: string; decimals: number };
  tokenBalanceA: string;
  tokenBalanceB: string;
  stats: { "24h"?: { volume?: string } };
}

interface OrcaResponse {
  data: unknown[];
  meta?: unknown;
}

function isOrcaToken(value: unknown): value is OrcaPool["tokenA"] {
  return isDexApiRecord(value) &&
    typeof value.address === "string" &&
    typeof value.symbol === "string" &&
    typeof value.decimals === "number" &&
    Number.isFinite(value.decimals);
}

function isOrcaPool(value: unknown): value is OrcaPool {
  return isDexApiRecord(value) &&
    typeof value.address === "string" &&
    typeof value.price === "string" &&
    typeof value.tvlUsdc === "string" &&
    typeof value.feeRate === "number" &&
    Number.isFinite(value.feeRate) &&
    isOrcaToken(value.tokenA) &&
    isOrcaToken(value.tokenB) &&
    typeof value.tokenBalanceA === "string" &&
    typeof value.tokenBalanceB === "string" &&
    (value.stats == null || isDexApiRecord(value.stats));
}

function isOrcaResponse(value: unknown): value is OrcaResponse {
  return isDexApiRecord(value) && Array.isArray(value.data);
}

function getOrcaNextCursor(meta: unknown): string | null {
  if (!isDexApiRecord(meta)) return null;
  const cursor = meta.cursor;
  if (isDexApiRecord(cursor) && typeof cursor.next === "string") return cursor.next;
  return typeof meta.next === "string" ? meta.next : null;
}

export async function fetchOrcaPools(signal?: AbortSignal, db?: D1Database): Promise<DexApiFetchResult> {
  const results: DexApiPool[] = [];
  const errors: string[] = [];
  const warnings: string[] = [];
  let successfulPages = 0;
  let degraded = false;
  let url: string | null = buildOrcaPoolsUrl();
  const nowSec = Math.floor(Date.now() / 1000);
  const paginationState = await readDexSourcePaginationState(db, ORCA_SOURCE_KEY);
  const storedTailCursor = paginationState.cursor;
  let refreshedHeadCursor: string | null = null;
  let resumeCursor: string | null = storedTailCursor;
  let cycleCompleted = false;
  const seenCursors = new Set<string>();
  const paginationWriteAttempts: DexSourcePaginationWriteAttempt[] = [];
  let page = 0;

  while (url) {
    page++;
    let res: Response | null = null;
    let pageError: string | null = null;

    for (let attempt = 0; attempt <= ORCA_RATE_LIMIT_RETRIES; attempt++) {
      try {
        res = await fetch(url, {
          headers: { "User-Agent": USER_AGENT },
          signal: buildDirectApiRequestSignal(signal),
        });
      } catch (err) {
        rethrowIfAborted(err, signal);
        pageError = toErrorMessage(err);
        break;
      }

      if (res.status !== 429) break;

      degraded = true;
      if (attempt === ORCA_RATE_LIMIT_RETRIES) {
        pageError = "rate limited (429) after retries";
        await cancelResponseBodyQuietly(res);
        break;
      }
      await cancelResponseBodyQuietly(res);
      await sleepWithSignal(ORCA_RATE_LIMIT_BACKOFF_MS * 2 ** attempt, signal);
    }

    if (!res) {
      errors.push(pageError ?? "request failed");
      break;
    }

    if (pageError) {
      errors.push(pageError);
      break;
    }

    if (!res.ok) {
      const tailCursorRejected = page > 1 && (res.status === 400 || res.status === 404);
      errors.push(tailCursorRejected
        ? `API rejected tail cursor (${res.status}); restarting from refreshed head`
        : `API returned ${res.status}`);
      await cancelResponseBodyQuietly(res);
      if (tailCursorRejected) resumeCursor = refreshedHeadCursor;
      break;
    }

    let json: unknown;
    try {
      json = await res.json() as unknown;
    } catch (error) {
      rethrowIfAborted(error, signal);
      errors.push(`returned invalid JSON: ${toErrorMessage(error)}`);
      break;
    }
    if (!isOrcaResponse(json)) {
      errors.push("returned malformed body");
      break;
    }

    successfulPages++;
    if (json.data.length === 0) {
      cycleCompleted = true;
      resumeCursor = page === 1 ? null : refreshedHeadCursor;
      break;
    }

    let pageHasEligiblePool = false;
    let malformedRows = 0;
    for (const rawPool of json.data) {
      if (!isOrcaPool(rawPool)) {
        malformedRows++;
        continue;
      }

      const pool = rawPool;
      const tvlUsd = parseFloat(pool.tvlUsdc);
      const price = parseFloat(pool.price);
      const volume = parseFloat(pool.stats?.["24h"]?.volume ?? "0");
      const balA = parseFloat(pool.tokenBalanceA);
      const balB = parseFloat(pool.tokenBalanceB);
      const normalizedBalA = Number.isFinite(balA) ? balA / 10 ** pool.tokenA.decimals : NaN;
      const normalizedBalB = Number.isFinite(balB) ? balB / 10 ** pool.tokenB.decimals : NaN;

      if (!Number.isFinite(tvlUsd) || tvlUsd < DIRECT_API_POOL_MIN_TVL_USD) continue;
      pageHasEligiblePool = true;

      results.push({
        source: "orca",
        chain: "solana",
        poolAddress: pool.address,
        poolType: "orca-whirlpool",
        tokens: [
          { address: pool.tokenA.address, symbol: pool.tokenA.symbol, decimals: pool.tokenA.decimals },
          { address: pool.tokenB.address, symbol: pool.tokenB.symbol, decimals: pool.tokenB.decimals },
        ],
        price: Number.isFinite(price) && price > 0 ? price : null,
        tvlUsd,
        volume24hUsd: Number.isFinite(volume) ? volume : 0,
        // Orca feeRate is in hundredths of a basis point (100 = 1bp = 0.0001)
        feeRate: Number.isFinite(pool.feeRate) ? pool.feeRate / 1_000_000 : null,
        balances: Number.isFinite(normalizedBalA) && Number.isFinite(normalizedBalB)
          ? [normalizedBalA, normalizedBalB]
          : null,
      });
    }
    if (malformedRows > 0) {
      warnings.push(`page ${page} skipped ${malformedRows} malformed pool rows`);
    }

    if (!pageHasEligiblePool) {
      degraded = true;
      errors.push(`page ${page} had no eligible pools despite minTvl filter`);
    }

    // Cursor-based pagination
    const nextCursor = getOrcaNextCursor(json.meta);
    if (nextCursor && seenCursors.has(nextCursor)) {
      degraded = true;
      errors.push("cursor loop detected");
      resumeCursor = refreshedHeadCursor;
      break;
    }
    if (nextCursor) seenCursors.add(nextCursor);
    if (page === 1) {
      refreshedHeadCursor = nextCursor;
      resumeCursor = nextCursor ? (storedTailCursor ?? nextCursor) : null;
      url = resumeCursor ? buildOrcaPoolsUrl(resumeCursor) : null;
      if (!url) cycleCompleted = true;
      continue;
    }
    resumeCursor = nextCursor;
    if (!nextCursor) {
      cycleCompleted = true;
      resumeCursor = refreshedHeadCursor;
      url = null;
      break;
    }
    if (page >= ORCA_PAGES_PER_RUN) {
      warnings.push(`pagination partial; resumeFromCursor=${nextCursor}`);
      break;
    }
    url = nextCursor ? buildOrcaPoolsUrl(nextCursor) : null;
  }

  if (successfulPages > 0) {
    const outcome = await writeDexSourcePaginationState({
      db,
      sourceKey: ORCA_SOURCE_KEY,
      cursor: resumeCursor,
      cycleStartedAt: cycleCompleted ? nowSec : (paginationState.cycleStartedAt ?? nowSec),
      nowSec,
      completed: cycleCompleted,
      pagesFetched: successfulPages,
      diagnostics: [...errors, ...warnings],
    });
    paginationWriteAttempts.push({ sourceKey: ORCA_SOURCE_KEY, outcome });
    const persistenceWarning = describeDexPaginationWriteFailure("orca", outcome);
    if (persistenceWarning) warnings.push(persistenceWarning);
    if (isDegradingDexPaginationWriteFailure(outcome)) degraded = true;
  }

  if (results.length > 0) {
    console.log(`[fetch-orca] Fetched ${results.length} pools`);
  }
  for (const error of errors) {
    console.warn("[fetch-orca]", error);
  }
  return makeDexApiFetchResult(results, {
    ok: successfulPages > 0,
    degraded: degraded || errors.length > 0,
    errors,
    warnings,
    pagination: {
      state: cycleCompleted ? "complete" : "partial",
      headRefreshed: successfulPages > 0,
      pagesFetched: successfulPages,
      cursor: resumeCursor,
      cycleCompleted,
      cursorPersistence: summarizeDexSourcePaginationWrites(paginationWriteAttempts),
    },
  });
}
