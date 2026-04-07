#!/usr/bin/env npx tsx

import { execSync } from "child_process";
import { existsSync, readFileSync, unlinkSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join, resolve } from "path";
import { fileURLToPath } from "url";
import { DAY_SECONDS } from "../../shared/lib/time-constants";
import { derivePegRates } from "../../shared/lib/peg-rates";
import { PSI_ELIGIBLE_META_BY_ID, PSI_ELIGIBLE_STABLECOINS } from "../../shared/lib/psi-eligible";
import type { StablecoinMeta } from "../../shared/types/core";
import {
  COMMODITY_PEGS,
  OTHER_COIN_FX,
  PEG_TO_FX,
  SECONDARY_PEG_TO_FX,
  buildFxLookup,
  enumerateDates,
  fetchHistoricalFxRates,
} from "../src/api/backfill-fx";
import {
  collapsePricesToDailyTimestamps,
  fetchMarketBackfillPriceSeries,
  type HistoricalMarketSourceDiagnostics,
  type PricePoint,
} from "../src/api/backfill-price-sources";
import {
  extractDepegEvents,
  parseSupplyData,
  summarizeBackfillReplayDiff,
  type ExistingDepegEventRow,
} from "../src/api/backfill-depegs";
import { DEFILLAMA_BASE, USER_AGENT } from "../src/lib/constants";
import { fetchAuthoritativeHistoricalPriceSeries } from "../src/lib/authoritative-price-sources";
import { fetchWithRetry } from "../src/lib/fetch-retry";
import { normalizeSupportedPegCurrency } from "../src/lib/native-peg-quotes";
import { buildPriceReasonablenessOptions } from "../src/lib/price-validation";

const DB_NAME = "stablecoin-db";
const SQL_BATCH_SIZE = 200;
const REPLAY_CONTEXT_DAYS = 30;
const DRY_RUN = process.argv.includes("--dry-run");
const TARGET_IDS = parseListArg("--stablecoin");
const TARGET_PEGS = parseListArg("--peg");
const REPO_ROOT = resolve(fileURLToPath(new URL("../..", import.meta.url)));
const WORKER_ROOT = resolve(fileURLToPath(new URL("..", import.meta.url)));
const OPS_API_BASE = "https://ops-api.pharos.watch";
const SECONDARY_FX_FETCH_CONCURRENCY = 8;
const LEGACY_CANONICAL_ID_MAP: Record<string, string> = {
  "300": "tryb-bilira",
  "cg-idrt": "idrt-rupiah-token",
};
const PURGE_ONLY_ORPHAN_IDS: Record<string, { symbol: string; pegCurrency: string; reason: string }> = {
  "eura-angle": {
    symbol: "EURA",
    pegCurrency: "EUR",
    reason: "dead-orphan",
  },
};

interface SupplyPoint {
  date: string;
  circulating?: Record<string, number>;
}

interface CoinDetail {
  gecko_id?: string;
  tokens?: SupplyPoint[];
}

interface PreparedCoin {
  meta: StablecoinMeta;
  geckoId: string;
  supplyByDate: Array<{ ts: number; supply: number }>;
  sourceIds: string[];
}

interface PurgeTarget {
  stablecoinId: string;
  symbol: string;
  sourceIds: string[];
  reason: string;
}

interface RepairSummary {
  stablecoinId: string;
  symbol: string;
  sourceIds: string[];
  existingBackfillEventCount: number;
  recomputedBackfillEventCount: number | null;
  removedBackfillEventCount: number;
  addedBackfillEventCount: number;
  replaySource: "market" | "authoritative" | "preserve-existing" | "purge";
  authoritativeSource: string | null;
  quoteMode: "usd" | "native-peg" | null;
  quoteCurrency: string | null;
  marketSourcesUsed: string[];
}

function parseListArg(flag: string): Set<string> | null {
  const raw = process.argv.find((arg) => arg.startsWith(`${flag}=`));
  if (!raw) return null;
  const values = raw
    .slice(flag.length + 1)
    .split(",")
    .map((value) => value.trim().toLowerCase())
    .filter((value) => value.length > 0);
  return values.length > 0 ? new Set(values) : null;
}

function loadDotVarsIfNeeded(): void {
  const dotVarsPath = join(REPO_ROOT, ".dev.vars");
  if (!existsSync(dotVarsPath)) return; // eslint-disable-line security/detect-non-literal-fs-filename
  const raw = readFileSync(dotVarsPath, "utf8"); // eslint-disable-line security/detect-non-literal-fs-filename
  for (const line of raw.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;
    const separator = trimmed.indexOf("=");
    if (separator <= 0) continue;
    const key = trimmed.slice(0, separator).trim();
    if (!key || process.env[key]) continue;
    process.env[key] = trimmed.slice(separator + 1).trim();
  }
}

function escapeSqlString(value: string): string {
  return value.replace(/'/g, "''");
}

function sqlNumber(value: number | null): string {
  return value == null ? "NULL" : Number.isFinite(value) ? String(value) : "NULL";
}

function d1Query(sql: string): string {
  return execSync(
    `npx wrangler d1 execute ${DB_NAME} --remote --command ${JSON.stringify(sql)} --json`,
    {
      cwd: WORKER_ROOT,
      encoding: "utf-8",
      maxBuffer: 50 * 1024 * 1024,
      stdio: "pipe",
    },
  );
}

function d1QueryParsed<T>(sql: string): T[] {
  const parsed = JSON.parse(d1Query(sql));
  return parsed[0]?.results ?? [];
}

function d1ExecFile(statements: string[]): void {
  if (statements.length === 0) return;
  const tmpFile = join(tmpdir(), `repair-non-usd-fiat-${Date.now()}.sql`);
  try {
    writeFileSync(tmpFile, statements.join("\n")); // eslint-disable-line security/detect-non-literal-fs-filename
    execSync(
      `npx wrangler d1 execute ${DB_NAME} --remote --file ${JSON.stringify(tmpFile)} --json`,
      {
        cwd: WORKER_ROOT,
        encoding: "utf-8",
        maxBuffer: 50 * 1024 * 1024,
        stdio: "pipe",
      },
    );
  } finally {
    try {
      unlinkSync(tmpFile); // eslint-disable-line security/detect-non-literal-fs-filename
    } catch {
      // Ignore temp cleanup errors.
    }
  }
}

function d1BatchExec(statements: string[]): void {
  for (let index = 0; index < statements.length; index += SQL_BATCH_SIZE) {
    const chunk = statements.slice(index, index + SQL_BATCH_SIZE);
    d1ExecFile(chunk);
  }
}

function buildSqlInList(values: string[]): string {
  return values.map((value) => `'${escapeSqlString(value)}'`).join(", ");
}

function buildAffectedRange(
  existingRows: ExistingDepegEventRow[],
  recomputedEvents: Array<{ startedAt: number; endedAt: number | null }>,
): { startDay: number; endDay: number } | null {
  let minTs: number | null = null;
  let maxTs: number | null = null;

  for (const row of existingRows) {
    const start = row.started_at;
    const end = row.ended_at ?? row.started_at;
    minTs = minTs == null ? start : Math.min(minTs, start);
    maxTs = maxTs == null ? end : Math.max(maxTs, end);
  }
  for (const event of recomputedEvents) {
    const start = event.startedAt;
    const end = event.endedAt ?? event.startedAt;
    minTs = minTs == null ? start : Math.min(minTs, start);
    maxTs = maxTs == null ? end : Math.max(maxTs, end);
  }

  if (minTs == null || maxTs == null) return null;
  return {
    startDay: Math.floor(minTs / DAY_SECONDS) * DAY_SECONDS,
    endDay: Math.floor(maxTs / DAY_SECONDS) * DAY_SECONDS,
  };
}

async function fetchOpsJson<T>(path: string, init?: RequestInit): Promise<T> {
  const id = process.env.OPS_API_SERVICE_TOKEN_ID;
  const secret = process.env.OPS_API_SERVICE_TOKEN_SECRET;
  if (!id || !secret) {
    throw new Error("OPS_API_SERVICE_TOKEN_ID / OPS_API_SERVICE_TOKEN_SECRET are required");
  }

  const headers = new Headers(init?.headers ?? {});
  headers.set("CF-Access-Client-Id", id);
  headers.set("CF-Access-Client-Secret", secret);
  if (init?.method && init.method !== "GET" && !headers.has("Content-Type")) {
    headers.set("Content-Type", "application/json");
  }

  const response = await fetch(`${OPS_API_BASE}${path}`, {
    ...init,
    headers,
  });
  if (!response.ok) {
    const body = await response.text().catch(() => "");
    throw new Error(`ops-api ${response.status} for ${path}: ${body.slice(0, 500)}`);
  }
  return response.json() as Promise<T>;
}

async function fetchStablecoinsPayload(): Promise<{
  peggedAssets: Array<Record<string, unknown>>;
  fxFallbackRates?: Record<string, number>;
}> {
  return fetchOpsJson("/api/stablecoins");
}

async function fetchDefiLlamaCoinDetail(meta: StablecoinMeta): Promise<CoinDetail | null> {
  const dlId = meta.llamaId ?? meta.id;
  const response = await fetch(`${DEFILLAMA_BASE}/stablecoin/${encodeURIComponent(dlId)}`, {
    headers: { "User-Agent": USER_AGENT },
  });
  if (!response.ok) return null;
  const raw = await response.json();
  return raw && typeof raw === "object" ? raw as CoinDetail : null;
}

async function fetchHistoricalSecondaryFxRatesDirect(
  currencies: string[],
  startDate: string,
  endDate: string,
): Promise<Record<string, Array<{ timestamp: number; rate: number }>>> {
  if (currencies.length === 0) return {};
  const normalized = Array.from(new Set(currencies.map((currency) => currency.toUpperCase())));
  const result: Record<string, Array<{ timestamp: number; rate: number }>> = Object.fromEntries(
    normalized.map((currency) => [currency, []]),
  );

  const dates = enumerateDates(startDate, endDate);
  for (let index = 0; index < dates.length; index += SECONDARY_FX_FETCH_CONCURRENCY) {
    const chunk = dates.slice(index, index + SECONDARY_FX_FETCH_CONCURRENCY);
    const chunkPayloads = await Promise.all(
      chunk.map(async (date) => {
        const primaryUrl = `https://cdn.jsdelivr.net/npm/@fawazahmed0/currency-api@${date}/v1/currencies/usd.min.json`;
        const fallbackUrl = `https://${date}.currency-api.pages.dev/v1/currencies/usd.min.json`;
        for (const url of [primaryUrl, fallbackUrl]) {
          try {
            const response = await fetchWithRetry(
              url,
              { headers: { "User-Agent": USER_AGENT } },
              1,
              { timeoutMs: 20_000, passthrough404: true },
            );
            if (!response?.ok) continue;
            const payload = await response.json() as { usd?: Record<string, number> };
            if (payload?.usd) return [date, payload] as const;
          } catch {
            // Try the next mirror.
          }
        }
        return [date, null] as const;
      }),
    );

    for (const [date, payload] of chunkPayloads) {
      if (!payload?.usd) continue;

      const timestamp = Math.floor(new Date(`${date}T00:00:00Z`).getTime() / 1000);
      for (const currency of normalized) {
        const unitsPerUsd = payload.usd[currency.toLowerCase()];
        if (typeof unitsPerUsd !== "number" || unitsPerUsd <= 0) continue;
        result[currency].push({ timestamp, rate: 1 / unitsPerUsd });
      }
    }
  }

  return result;
}

async function replayCoinHistory(
  meta: StablecoinMeta,
  geckoId: string,
  supplyByDate: Array<{ ts: number; supply: number }>,
  getPegRef: (timestamp: number) => number,
  fxFallbackRates: Record<string, number> | undefined,
  coingeckoApiKey: string | null,
  replayRange?: { startSec: number; endSec: number },
): Promise<{
  events: ReturnType<typeof extractDepegEvents> | null;
  sourceKind: "market" | "authoritative" | "preserve-existing";
  authoritativeSource: string | null;
  marketDiagnostics: HistoricalMarketSourceDiagnostics | null;
}> {
  const pegType = `pegged${meta.flags.pegCurrency}`;
  const nativePegCurrency = normalizeSupportedPegCurrency(meta.flags.pegCurrency);

  let marketSeries: HistoricalMarketSourceDiagnostics | null = null;
  const loadMarketSeries = async (
    quoteMode: "native-peg" | "usd",
  ): Promise<{
    prices: PricePoint[] | null;
    diagnostics: HistoricalMarketSourceDiagnostics;
  }> => {
    const series = await fetchMarketBackfillPriceSeries(meta, geckoId, {
      granularity: quoteMode === "native-peg" ? "daily" : "hourly",
      range: replayRange,
      quote: {
        pegCurrency: meta.flags.pegCurrency,
        useNativePegQuote: quoteMode === "native-peg",
      },
      coingeckoApiKey,
    });
    return series;
  };

  let candidateTimestamps: number[];
  const candidateSupplyByDate = replayRange
    ? supplyByDate.filter((snapshot) => snapshot.ts >= replayRange.startSec && snapshot.ts <= replayRange.endSec)
    : supplyByDate;
  if (candidateSupplyByDate.length > 0) {
    candidateTimestamps = candidateSupplyByDate.map((snapshot) => snapshot.ts);
  } else {
    let candidateSeries = nativePegCurrency ? await loadMarketSeries("native-peg") : await loadMarketSeries("usd");
    if ((!candidateSeries.prices || candidateSeries.prices.length === 0) && nativePegCurrency) {
      candidateSeries = await loadMarketSeries("usd");
    }
    candidateTimestamps = collapsePricesToDailyTimestamps(candidateSeries.prices ?? []);
  }

  const authoritativeHistory = await fetchAuthoritativeHistoricalPriceSeries(meta, {
    candidateTimestamps,
    supplySnapshots: candidateSupplyByDate,
    coingeckoApiKey,
  });

  let prices: PricePoint[] | null;
  let sourceKind: "market" | "authoritative" | "preserve-existing";
  let diagnostics: HistoricalMarketSourceDiagnostics | null = null;
  if (authoritativeHistory.matched) {
    prices = authoritativeHistory.prices;
    if (!prices || prices.length === 0) {
      return {
        events: null,
        sourceKind: "preserve-existing",
        authoritativeSource: authoritativeHistory.source,
        marketDiagnostics: null,
      };
    }
    sourceKind = "authoritative";
  } else {
    const nativeSeries = nativePegCurrency ? await loadMarketSeries("native-peg") : null;
    const selectedSeries =
      nativeSeries && nativeSeries.prices && nativeSeries.prices.length > 0
        ? nativeSeries
        : await loadMarketSeries("usd");
    prices = selectedSeries.prices;
    diagnostics = selectedSeries.diagnostics;
    marketSeries = diagnostics;
    if (!prices || prices.length === 0) {
      return {
        events: null,
        sourceKind: "preserve-existing",
        authoritativeSource: null,
        marketDiagnostics: diagnostics,
      };
    }
    sourceKind = "market";
  }

  return {
    events: extractDepegEvents(
      prices,
      marketSeries?.quoteMode === "native-peg" ? () => 1 : getPegRef,
      pegType,
      supplyByDate,
      fxFallbackRates,
      buildPriceReasonablenessOptions({
        navToken: meta.flags.navToken,
        commodityOunces: meta.commodityOunces,
      }),
      marketSeries?.quoteMode === "native-peg"
        ? {
            forceConfirmation: true,
            confirmationMinPoints: 2,
            confirmationMaxGapSec: 36 * 3_600,
            extremeSinglePointBps: 5_000,
          }
        : undefined,
    ).filter((event) => !replayRange || !(
      (event.endedAt ?? event.startedAt) < replayRange.startSec || event.startedAt > replayRange.endSec
    )),
    sourceKind,
    authoritativeSource: authoritativeHistory.matched ? authoritativeHistory.source : null,
    marketDiagnostics: diagnostics,
  };
}

function buildInsertStatements(stablecoinId: string, symbol: string, pegType: string, events: ReturnType<typeof extractDepegEvents>): string[] {
  const escapedStablecoinId = escapeSqlString(stablecoinId);
  const escapedSymbol = escapeSqlString(symbol);
  const escapedPegType = escapeSqlString(pegType);

  return events.map((event) => (
    `INSERT INTO depeg_events (stablecoin_id, symbol, peg_type, direction, peak_deviation_bps, started_at, ended_at, start_price, peak_price, recovery_price, peg_reference, source) VALUES (` +
      `'${escapedStablecoinId}', '${escapedSymbol}', '${escapedPegType}', '${escapeSqlString(event.direction)}', ` +
      `${event.peakDeviationBps}, ${event.startedAt}, ${sqlNumber(event.endedAt)}, ${sqlNumber(event.startPrice)}, ` +
      `${sqlNumber(event.peakPrice)}, ${sqlNumber(event.recoveryPrice)}, ${sqlNumber(event.pegRef)}, 'backfill');`
  ));
}

function collectYearRanges(startDay: number, endDay: number): Array<{ startDay: number; endDay: number }> {
  const ranges: Array<{ startDay: number; endDay: number }> = [];
  let current = startDay;
  while (current <= endDay) {
    const year = new Date(current * 1000).getUTCFullYear();
    const yearStart = Math.floor(new Date(`${year}-01-01T00:00:00Z`).getTime() / 1000);
    const yearEnd = Math.floor(new Date(`${year}-12-31T00:00:00Z`).getTime() / 1000);
    ranges.push({
      startDay: Math.max(current, yearStart),
      endDay: Math.min(endDay, yearEnd),
    });
    current = yearEnd + DAY_SECONDS;
  }
  return ranges;
}

async function recomputePsiRanges(ranges: Array<{ startDay: number; endDay: number }>): Promise<number> {
  let totalDaysBackfilled = 0;
  for (const range of ranges) {
    const startDay = new Date(range.startDay * 1000).toISOString().slice(0, 10);
    const endDay = new Date(range.endDay * 1000).toISOString().slice(0, 10);
    const body = await fetchOpsJson<{
      daysBackfilled?: number;
      daysChanged?: number;
    }>(`/api/backfill-stability-index?startDay=${startDay}&endDay=${endDay}`, {
      method: "POST",
    });
    totalDaysBackfilled += body.daysBackfilled ?? 0;
    console.log(`  PSI ${startDay} -> ${endDay}: ${body.daysBackfilled ?? 0} days backfilled`);
  }
  return totalDaysBackfilled;
}

async function main(): Promise<void> {
  loadDotVarsIfNeeded();

  const coingeckoApiKey = process.env.COINGECKO_API_KEY?.trim() || null;
  if (!coingeckoApiKey) {
    throw new Error("COINGECKO_API_KEY is required in .dev.vars or env");
  }

  const targetCounts = d1QueryParsed<{
    stablecoin_id: string;
    cnt: number;
    min_started_at: number | null;
    max_ended_at: number | null;
  }>(
    [
      "SELECT stablecoin_id, COUNT(*) as cnt, MIN(started_at) as min_started_at, MAX(COALESCE(ended_at, started_at)) as max_ended_at",
      "FROM depeg_events",
      "WHERE source = 'backfill'",
      "AND peg_type NOT IN ('peggedUSD', 'peggedGOLD', 'peggedSILVER')",
      "GROUP BY stablecoin_id",
      "ORDER BY cnt DESC, stablecoin_id ASC",
    ].join(" "),
  );

  const targetStatsById = new Map(targetCounts.map((row) => [row.stablecoin_id, row]));

  const matchesTargetFilters = (rawId: string, canonicalId: string, pegCurrency: string): boolean => {
    if (TARGET_IDS) {
      const loweredRaw = rawId.toLowerCase();
      const loweredCanonical = canonicalId.toLowerCase();
      if (!TARGET_IDS.has(loweredRaw) && !TARGET_IDS.has(loweredCanonical)) return false;
    }
    if (TARGET_PEGS && !TARGET_PEGS.has(pegCurrency.toLowerCase())) return false;
    return true;
  };

  const replayTargetsByCanonicalId = new Map<string, { meta: StablecoinMeta; sourceIds: Set<string> }>();
  const purgeTargets: PurgeTarget[] = [];
  const unresolvedOrphans: string[] = [];

  for (const row of targetCounts) {
    const rawId = row.stablecoin_id;
    const canonicalId = LEGACY_CANONICAL_ID_MAP[rawId] ?? rawId;
    const canonicalMeta = PSI_ELIGIBLE_META_BY_ID.get(canonicalId);
    if (canonicalMeta) {
      if (canonicalMeta.flags.navToken) continue;
      if (canonicalMeta.flags.pegCurrency === "USD") continue;
      if (COMMODITY_PEGS.has(canonicalMeta.flags.pegCurrency)) continue;
      if (!matchesTargetFilters(rawId, canonicalId, canonicalMeta.flags.pegCurrency)) continue;

      const existing = replayTargetsByCanonicalId.get(canonicalId);
      if (existing) {
        existing.sourceIds.add(rawId);
      } else {
        replayTargetsByCanonicalId.set(canonicalId, {
          meta: canonicalMeta,
          sourceIds: new Set([rawId]),
        });
      }
      continue;
    }

    const purgeConfig = PURGE_ONLY_ORPHAN_IDS[rawId];
    if (purgeConfig) {
      if (!matchesTargetFilters(rawId, rawId, purgeConfig.pegCurrency)) continue;
      purgeTargets.push({
        stablecoinId: rawId,
        symbol: purgeConfig.symbol,
        sourceIds: [rawId],
        reason: purgeConfig.reason,
      });
      continue;
    }

    unresolvedOrphans.push(rawId);
  }

  if (unresolvedOrphans.length > 0) {
    throw new Error(`Unhandled orphan non-USD backfill ids: ${unresolvedOrphans.join(", ")}`);
  }

  const replayTargets = Array.from(replayTargetsByCanonicalId.values());

  if (replayTargets.length === 0 && purgeTargets.length === 0) {
    console.log("No matching non-USD non-commodity backfill targets.");
    return;
  }

  console.log(`Mode: ${DRY_RUN ? "DRY RUN" : "LIVE"}`);
  console.log(`Targets: ${replayTargets.length} replay assets, ${purgeTargets.length} purge-only assets`);

  const stablecoinsPayload = await fetchStablecoinsPayload();
  const { rates: pegRates } = derivePegRates(
    stablecoinsPayload.peggedAssets as never[],
    new Map(PSI_ELIGIBLE_STABLECOINS.map((meta) => [meta.id, meta])),
    stablecoinsPayload.fxFallbackRates,
  );

  const neededFxCurrencies = new Set<string>();
  const neededSecondaryFxCurrencies = new Set<string>();
  const preparedCoins: PreparedCoin[] = [];

  const tenYearsAgoMs = Date.now() - 10 * 365 * DAY_SECONDS * 1000;
  const defaultStartDate = new Date(tenYearsAgoMs).toISOString().slice(0, 10);
  const endDate = new Date().toISOString().slice(0, 10);
  let historicalFxStartDate = endDate;
  let historicalSecondaryFxStartDate = endDate;

  for (const target of replayTargets) {
    const { meta } = target;
    process.stdout.write(`Preparing ${meta.symbol}...\n`);
    const detail = await fetchDefiLlamaCoinDetail(meta);
    const geckoId = PSI_ELIGIBLE_META_BY_ID.get(meta.id)?.geckoId ?? detail?.gecko_id;
    if (!geckoId) {
      console.log(`  Skipping ${meta.symbol}: no geckoId`);
      continue;
    }

    const supplyByDate = parseSupplyData(detail?.tokens ?? []);
    preparedCoins.push({ meta, geckoId, supplyByDate, sourceIds: [...target.sourceIds] });

    const earliestRelevantTs = [...target.sourceIds]
      .map((sourceId) => targetStatsById.get(sourceId)?.min_started_at ?? null)
      .filter((ts): ts is number => ts != null)
      .reduce<number | null>((minTs, ts) => (
        minTs == null ? ts : Math.min(minTs, ts)
      ), null);
    const earliestAnchorTs = earliestRelevantTs != null
      ? Math.max(0, earliestRelevantTs - REPLAY_CONTEXT_DAYS * DAY_SECONDS)
      : supplyByDate[0]?.ts ?? null;
    const earliestDateText = earliestAnchorTs != null
      ? new Date(earliestAnchorTs * 1000).toISOString().slice(0, 10)
      : defaultStartDate;
    if (earliestDateText < historicalFxStartDate) {
      historicalFxStartDate = earliestDateText;
    }

    const secondaryFx = SECONDARY_PEG_TO_FX[meta.flags.pegCurrency];
    if (secondaryFx) {
      neededSecondaryFxCurrencies.add(secondaryFx);
      if (earliestDateText < historicalSecondaryFxStartDate) {
        historicalSecondaryFxStartDate = earliestDateText;
      }
      continue;
    }
    const fx = PEG_TO_FX[meta.flags.pegCurrency] ?? OTHER_COIN_FX[meta.id];
    if (fx) {
      neededFxCurrencies.add(fx);
    }
  }

  const fxSeries = await fetchHistoricalFxRates([...neededFxCurrencies], historicalFxStartDate, endDate);
  const secondaryFxSeries = await fetchHistoricalSecondaryFxRatesDirect(
    [...neededSecondaryFxCurrencies],
    historicalSecondaryFxStartDate,
    endDate,
  );

  const summaries: RepairSummary[] = [];
  let totalRemoved = 0;
  let totalAdded = 0;
  let totalPreserved = 0;
  let affectedStartDay: number | null = null;
  let affectedEndDay: number | null = null;

  for (const prepared of preparedCoins) {
    const { meta, geckoId, supplyByDate, sourceIds } = prepared;
    const pegType = `pegged${meta.flags.pegCurrency}`;
    const fxCode = SECONDARY_PEG_TO_FX[meta.flags.pegCurrency]
      ?? PEG_TO_FX[meta.flags.pegCurrency]
      ?? OTHER_COIN_FX[meta.id]
      ?? null;
    const series = fxCode
      ? (secondaryFxSeries[fxCode] as Array<{ timestamp: number; rate: number }> | undefined)
          ?? fxSeries[fxCode]
          ?? []
      : [];
    const getPegRef = buildFxLookup(series, pegRates[pegType] ?? 0);

    console.log(`Replaying ${meta.symbol} (${meta.id})...`);
    const existingRows = d1QueryParsed<ExistingDepegEventRow>(
      [
        "SELECT id, stablecoin_id, symbol, peg_type, direction, peak_deviation_bps, started_at, ended_at, start_price, peak_price, recovery_price, peg_reference, source",
        "FROM depeg_events",
        `WHERE stablecoin_id IN (${buildSqlInList(sourceIds)})`,
        "AND source = 'backfill'",
        "ORDER BY started_at ASC, id ASC",
      ].join(" "),
    );
    const minExistingStart = existingRows[0]?.started_at ?? null;
    const maxExistingEnd = existingRows.reduce<number | null>(
      (maxTs, row) => {
        const rowEnd = row.ended_at ?? row.started_at;
        return maxTs == null ? rowEnd : Math.max(maxTs, rowEnd);
      },
      null,
    );
    const replayRange =
      minExistingStart != null && maxExistingEnd != null
        ? {
            startSec: Math.max(0, minExistingStart - REPLAY_CONTEXT_DAYS * DAY_SECONDS),
            endSec: maxExistingEnd + REPLAY_CONTEXT_DAYS * DAY_SECONDS,
          }
        : undefined;
    const replay = await replayCoinHistory(
      meta,
      geckoId,
      supplyByDate,
      getPegRef,
      stablecoinsPayload.fxFallbackRates,
      coingeckoApiKey,
      replayRange,
    );

    if (!replay.events) {
      totalPreserved += existingRows.length;
      summaries.push({
        stablecoinId: meta.id,
        symbol: meta.symbol,
        sourceIds,
        existingBackfillEventCount: existingRows.length,
        recomputedBackfillEventCount: null,
        removedBackfillEventCount: 0,
        addedBackfillEventCount: 0,
        replaySource: replay.sourceKind,
        authoritativeSource: replay.authoritativeSource,
        quoteMode: replay.marketDiagnostics?.quoteMode ?? null,
        quoteCurrency: replay.marketDiagnostics?.quoteCurrency ?? null,
        marketSourcesUsed: replay.marketDiagnostics?.sourcesUsed ?? [],
      });
      console.log(`  preserved existing rows (${replay.sourceKind})`);
      continue;
    }

    const diff = summarizeBackfillReplayDiff(existingRows, replay.events);
    summaries.push({
      stablecoinId: meta.id,
      symbol: meta.symbol,
      sourceIds,
      existingBackfillEventCount: existingRows.length,
      recomputedBackfillEventCount: replay.events.length,
      removedBackfillEventCount: diff.removedBackfillEventCount,
      addedBackfillEventCount: diff.addedBackfillEventCount,
      replaySource: replay.sourceKind,
      authoritativeSource: replay.authoritativeSource,
      quoteMode: replay.marketDiagnostics?.quoteMode ?? null,
      quoteCurrency: replay.marketDiagnostics?.quoteCurrency ?? null,
      marketSourcesUsed: replay.marketDiagnostics?.sourcesUsed ?? [],
    });

    console.log(
      `  existing=${existingRows.length} replay=${replay.events.length} remove=${diff.removedBackfillEventCount} add=${diff.addedBackfillEventCount}`
        + ` source=${replay.sourceKind}`
        + ` quote=${replay.marketDiagnostics?.quoteCurrency ?? "n/a"}`,
    );

    if (diff.exactMatch) continue;

    totalRemoved += diff.removedBackfillEventCount;
    totalAdded += diff.addedBackfillEventCount;
    const affectedRange = buildAffectedRange(existingRows, replay.events);
    if (affectedRange) {
      affectedStartDay = affectedStartDay == null ? affectedRange.startDay : Math.min(affectedStartDay, affectedRange.startDay);
      affectedEndDay = affectedEndDay == null ? affectedRange.endDay : Math.max(affectedEndDay, affectedRange.endDay);
    }

    if (DRY_RUN) continue;

    const statements = [
      `DELETE FROM depeg_events WHERE stablecoin_id IN (${buildSqlInList(sourceIds)}) AND source = 'backfill';`,
      ...buildInsertStatements(meta.id, meta.symbol, pegType, replay.events),
    ];
    d1BatchExec(statements);
  }

  for (const purgeTarget of purgeTargets) {
    console.log(`Purging ${purgeTarget.symbol} (${purgeTarget.stablecoinId})...`);
    const existingRows = d1QueryParsed<ExistingDepegEventRow>(
      [
        "SELECT id, stablecoin_id, symbol, peg_type, direction, peak_deviation_bps, started_at, ended_at, start_price, peak_price, recovery_price, peg_reference, source",
        "FROM depeg_events",
        `WHERE stablecoin_id IN (${buildSqlInList(purgeTarget.sourceIds)})`,
        "AND source = 'backfill'",
        "ORDER BY started_at ASC, id ASC",
      ].join(" "),
    );

    summaries.push({
      stablecoinId: purgeTarget.stablecoinId,
      symbol: purgeTarget.symbol,
      sourceIds: purgeTarget.sourceIds,
      existingBackfillEventCount: existingRows.length,
      recomputedBackfillEventCount: 0,
      removedBackfillEventCount: existingRows.length,
      addedBackfillEventCount: 0,
      replaySource: "purge",
      authoritativeSource: purgeTarget.reason,
      quoteMode: null,
      quoteCurrency: null,
      marketSourcesUsed: [],
    });

    console.log(`  existing=${existingRows.length} replay=0 remove=${existingRows.length} add=0 source=purge`);

    if (existingRows.length === 0) continue;

    totalRemoved += existingRows.length;
    const affectedRange = buildAffectedRange(existingRows, []);
    if (affectedRange) {
      affectedStartDay = affectedStartDay == null ? affectedRange.startDay : Math.min(affectedStartDay, affectedRange.startDay);
      affectedEndDay = affectedEndDay == null ? affectedRange.endDay : Math.max(affectedEndDay, affectedRange.endDay);
    }

    if (DRY_RUN) continue;

    d1BatchExec([
      `DELETE FROM depeg_events WHERE stablecoin_id IN (${buildSqlInList(purgeTarget.sourceIds)}) AND source = 'backfill';`,
    ]);
  }

  console.log("\nSummary:");
  for (const summary of summaries) {
    console.log(
      `  ${summary.symbol}: existing=${summary.existingBackfillEventCount} replay=${summary.recomputedBackfillEventCount ?? "preserve"}`
        + ` remove=${summary.removedBackfillEventCount} add=${summary.addedBackfillEventCount}`
        + ` source=${summary.replaySource}`
        + ` quote=${summary.quoteCurrency ?? "n/a"}`
        + `${summary.sourceIds.length > 1 ? ` ids=${summary.sourceIds.join("+")}` : ""}`,
    );
  }

  console.log(`\nTotals: remove=${totalRemoved} add=${totalAdded} preserved=${totalPreserved}`);

  if (!DRY_RUN && affectedStartDay != null && affectedEndDay != null) {
    console.log("\nRecomputing PSI history...");
    const psiRanges = collectYearRanges(affectedStartDay, affectedEndDay);
    const psiDaysBackfilled = await recomputePsiRanges(psiRanges);
    console.log(`PSI days backfilled: ${psiDaysBackfilled}`);
  } else if (DRY_RUN) {
    console.log("Dry run complete. No database mutations applied.");
  }

  const remainingCounts = d1QueryParsed<{ stablecoin_id: string; cnt: number }>(
    [
      "SELECT stablecoin_id, COUNT(*) as cnt",
      "FROM depeg_events",
      "WHERE source = 'backfill'",
      "AND peg_type NOT IN ('peggedUSD', 'peggedGOLD', 'peggedSILVER')",
      "GROUP BY stablecoin_id",
      "ORDER BY cnt DESC, stablecoin_id ASC",
    ].join(" "),
  );
  console.log("\nRemaining non-USD non-commodity backfill rows:");
  for (const row of remainingCounts) {
    console.log(`  ${row.stablecoin_id}: ${row.cnt}`);
  }
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
