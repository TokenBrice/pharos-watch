import { z } from "zod";
import type { ReserveSlice, ReserveAdapterCoin } from "@shared/types/core";
import type { LiveReservesConfig } from "@shared/types/live-reserves";
import { MAX_FUTURE_SOURCE_TIMESTAMP_SKEW_SEC } from "@shared/lib/live-reserve-freshness";
import { toErrorMessage } from "@shared/lib/error-utils";
import { isRecord } from "@shared/lib/type-guards";
import type { AdapterContext, AdapterResult } from "./types";
import {
  fetchPrimaryHtmlInput,
  htmlLayoutChangedError,
  htmlParseError,
  requireHtmlInput,
  verifiedFreshnessMetadata,
} from "./helpers";

export const AXIS_TRANSPARENCY_URL = "https://app.axis.to/transparency?tab=asset-composition";
const KEY = "axis-issuer-classes";
const PUSH_MARKER = "self.__next_f.push(";
const FLIGHT_MAX_CHARS = 4_000_000;
const ISO_DATETIME_PATTERN = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,9})?(?:Z|[+-]\d{2}:\d{2})$/;
/** The issuer publishes asset-class values and the whole-book total. Category sums and the
 *  same-day timeline point are dollar roundings of one accounting point, not a second book;
 *  $1 or 0.01% (whichever is looser) absorbs that rounding without admitting a missing class. */
const TOTAL_ABSOLUTE_TOLERANCE_USD = 1;
const TOTAL_RELATIVE_TOLERANCE = 0.0001;
/** Published percentages carry two decimals; a legitimate rounding of ~0.005 points must pass. */
const PERCENT_TOLERANCE = 0.01;

/** The five issuer categories are reviewed identities, not labels read from the page. Any
 *  addition, removal or rename is a source-shape change until the classification review
 *  admits it, so the parser fails closed instead of publishing an unreviewed class. */
const CLASS_IDS = ["cash_fiat", "stablecoins", "liquid_hedge", "staked_lst", "tbill_rwa"] as const;
type AxisClassId = (typeof CLASS_IDS)[number];

/** Classification metadata is owned by the reviewed sidecar
 *  (`shared/data/stablecoins/domains/reserves/usdx-axis.json`); these rows mirror it so the
 *  published live weights and the reviewed classes cannot drift apart silently. */
const CLASSIFICATION: Record<AxisClassId, Omit<ReserveSlice, "pct">> = {
  cash_fiat: {
    sourceKey: "axis:transparency:asset-class:cash_fiat",
    name: "Fiat cash and FX balances",
    risk: "medium",
    assetClass: "cash",
    issuerOrObligor: "Axis bank, venue and settlement-account counterparties for USD, EUR, JPY, TRY, GBP, HKD, SGD and other approved currencies",
    riskFactors: ["market", "credit", "counterparty", "custody", "legal"],
    liquidityHorizon: "unknown",
  },
  stablecoins: {
    sourceKey: "axis:transparency:asset-class:stablecoins",
    name: "Stablecoins and settlement tokens",
    risk: "medium",
    assetClass: "stablecoin",
    issuerOrObligor: "Approved fiat-backed stablecoin issuers and Axis settlement venues; constituent weights undisclosed",
    riskFactors: ["credit", "counterparty", "custody", "liquidity", "legal"],
    liquidityHorizon: "unknown",
  },
  liquid_hedge: {
    sourceKey: "axis:transparency:asset-class:liquid_hedge",
    name: "Liquid hedge inventory",
    risk: "high",
    assetClass: "other",
    issuerOrObligor: "Axis trading venues and instrument issuers for BTC, ETH, SOL, xNVDA and other approved liquid inventory",
    riskFactors: ["market", "basis", "counterparty", "custody", "liquidity", "concentration"],
    liquidityHorizon: "unknown",
  },
  staked_lst: {
    sourceKey: "axis:transparency:asset-class:staked_lst",
    name: "Yield-bearing and staked collateral",
    risk: "high",
    assetClass: "protocol-position",
    issuerOrObligor: "stETH, bnSOL and approved yield-bearing or staked instrument providers; constituent weights undisclosed",
    riskFactors: ["market", "basis", "smart-contract", "counterparty", "custody", "liquidity"],
    liquidityHorizon: "unknown",
  },
  tbill_rwa: {
    sourceKey: "axis:transparency:asset-class:tbill_rwa",
    name: "Tokenized Treasuries and reserve-backed cash equivalents",
    risk: "medium",
    assetClass: "other",
    issuerOrObligor: "USYC, USDG and approved short-duration Treasury or reserve-backed instrument issuers; constituent weights undisclosed",
    riskFactors: ["credit", "duration", "counterparty", "custody", "liquidity", "legal"],
    liquidityHorizon: "unknown",
  },
};

/** The issuer marks assets it cannot classify. They stay inside the liquid-hedge category, so
 *  publishing them as one keyed residual keeps the unclassified share visible as one question
 *  instead of hiding it in a category or exploding it across the five reviewed classes. */
const UNCLASSIFIED_RESIDUAL_SOURCE_KEY = "axis:transparency:unclassified-residual";
const UNCLASSIFIED_RESIDUAL_NAME = "Unclassified liquid hedge inventory";

const AxisClassUnclassifiedSchema = z.object({
  gross_usd: z.number().finite().nonnegative(),
  asset_count: z.number().int().nonnegative(),
  percent_of_class: z.number().finite().nonnegative(),
}).passthrough();

const AxisAssetClassSchema = z.object({
  id: z.string().min(1),
  label: z.string().min(1),
  value: z.number().finite().positive(),
  percent: z.number().finite().nonnegative(),
  asset_count: z.number().int().nonnegative(),
  unclassified: AxisClassUnclassifiedSchema,
}).passthrough();

const AxisDashboardSchema = z.object({
  overview: z.object({
    last_updated: z.string().min(1),
    total_reserves: z.object({ value: z.number().finite().positive() }).passthrough(),
    usdx_total_supply: z.number().finite().positive(),
    collateralization_ratio: z.number().finite().positive(),
  }).passthrough(),
  dashboard_details: z.object({
    asset_classes: z.object({
      total: z.number().finite().positive(),
      breakdown: z.array(AxisAssetClassSchema).min(1),
      unclassified: z.object({
        percent: z.number().finite().nonnegative(),
        gross_usd: z.number().finite().nonnegative(),
        asset_count: z.number().int().nonnegative(),
      }).passthrough(),
    }).passthrough(),
  }).passthrough(),
  reserves_history: z.object({
    data: z.array(z.object({
      value: z.number().finite().nonnegative(),
      timestamp: z.string().min(1),
    }).passthrough()).min(1),
  }).passthrough(),
}).passthrough();

type AxisDashboard = z.output<typeof AxisDashboardSchema>;

/** Return the index of the `]` that closes the array starting at `start`, honoring JSON
 *  string escapes. Returns -1 when the page truncates the payload. */
function findBalancedArrayEnd(text: string, start: number): number {
  let depth = 0;
  let inString = false;
  let escaped = false;
  for (let index = start; index < text.length; index += 1) {
    const char = text[index];
    if (inString) {
      if (escaped) escaped = false;
      else if (char === "\\") escaped = true;
      else if (char === "\"") inString = false;
      continue;
    }
    if (char === "\"") inString = true;
    else if (char === "[") depth += 1;
    else if (char === "]") {
      depth -= 1;
      if (depth === 0) return index;
    }
  }
  return -1;
}

/** Next.js streams the RSC flight text through `self.__next_f.push([1, "…"])` calls. Only the
 *  decoded text is read: no upstream JavaScript runs. Control rows without text are skipped,
 *  and an oversized or truncated stream fails closed. */
function extractFlightText(html: string): string {
  let flight = "";
  let chunks = 0;
  let index = 0;
  for (;;) {
    const marker = html.indexOf(PUSH_MARKER, index);
    if (marker < 0) break;
    const argumentStart = html.indexOf("[", marker + PUSH_MARKER.length);
    if (argumentStart < 0 || argumentStart > marker + PUSH_MARKER.length + 8) {
      throw htmlParseError(KEY, "flight push call has no array argument");
    }
    const argumentEnd = findBalancedArrayEnd(html, argumentStart);
    if (argumentEnd < 0) throw htmlParseError(KEY, "flight push array is truncated");
    let chunk: unknown;
    try {
      chunk = JSON.parse(html.slice(argumentStart, argumentEnd + 1)) as unknown;
    } catch (error) {
      throw htmlParseError(KEY, `flight push array is malformed: ${toErrorMessage(error)}`);
    }
    index = argumentEnd + 1;
    if (!Array.isArray(chunk)) throw htmlLayoutChangedError(KEY, "flight push argument is not an array");
    if (chunk[0] !== 1) continue;
    if (chunk.length !== 2 || typeof chunk[1] !== "string") {
      throw htmlLayoutChangedError(KEY, "flight text chunk is not a single string");
    }
    flight += chunk[1];
    chunks += 1;
    if (flight.length > FLIGHT_MAX_CHARS) {
      throw htmlParseError(KEY, "flight payload exceeds the reviewed size bound");
    }
  }
  if (chunks === 0) throw htmlLayoutChangedError(KEY, "missing Next.js flight payload");
  return flight;
}

function collectInitialDashboard(value: unknown, matches: unknown[], depth: number): void {
  if (matches.length > 1 || depth > 40) return;
  if (Array.isArray(value)) {
    for (const item of value.slice(0, 256)) collectInitialDashboard(item, matches, depth + 1);
    return;
  }
  if (!isRecord(value)) return;
  if (Object.prototype.hasOwnProperty.call(value, "initialDashboard")) {
    matches.push(value.initialDashboard);
    return;
  }
  for (const child of Object.values(value)) collectInitialDashboard(child, matches, depth + 1);
}

/** Flight rows are `<id>:<JSON value>`. Locate the one row that carries the dashboard, parse
 *  only its value, and require exactly one dashboard instance. */
function findInitialDashboard(flight: string): unknown {
  const matches: unknown[] = [];
  for (const row of flight.split("\n")) {
    if (!row.includes("\"initialDashboard\"")) continue;
    const separator = row.indexOf(":");
    if (separator <= 0) throw htmlLayoutChangedError(KEY, "flight dashboard row has no row id");
    let parsed: unknown;
    try {
      parsed = JSON.parse(row.slice(separator + 1)) as unknown;
    } catch (error) {
      throw htmlParseError(KEY, `flight dashboard row is malformed: ${toErrorMessage(error)}`);
    }
    collectInitialDashboard(parsed, matches, 0);
    if (matches.length > 1) throw htmlLayoutChangedError(KEY, "multiple initialDashboard payloads");
  }
  if (matches.length !== 1) throw htmlLayoutChangedError(KEY, "initialDashboard payload is missing");
  return matches[0];
}

function parseDashboard(raw: unknown): AxisDashboard {
  try {
    return AxisDashboardSchema.parse(raw);
  } catch (error) {
    throw htmlLayoutChangedError(KEY, `asset-composition payload is not the reviewed shape: ${toErrorMessage(error)}`);
  }
}

function requireClose(actual: number, expected: number, tolerance: number, detail: string): void {
  if (!Number.isFinite(actual) || Math.abs(actual - expected) > tolerance) {
    throw htmlLayoutChangedError(KEY, detail);
  }
}

function requireSameDayTimelinePoint(dashboard: AxisDashboard, sourceTimestamp: number, tolerance: number): void {
  const day = new Date(sourceTimestamp * 1000).toISOString().slice(0, 10);
  const points = dashboard.reserves_history.data.filter((point) => {
    const parsed = Date.parse(point.timestamp);
    return Number.isFinite(parsed) && new Date(parsed).toISOString().slice(0, 10) === day;
  });
  const point = points[points.length - 1];
  if (point === undefined) {
    throw htmlLayoutChangedError(KEY, `reserves history has no ${day} accounting point`);
  }
  requireClose(
    point.value,
    dashboard.dashboard_details.asset_classes.total,
    tolerance,
    `the ${day} timeline point does not match the asset-class total`,
  );
}

function readSourceTimestamp(lastUpdated: string, nowSec: number): number {
  if (!ISO_DATETIME_PATTERN.test(lastUpdated)) {
    throw htmlLayoutChangedError(KEY, "overview.last_updated is not an ISO datetime");
  }
  const milliseconds = Date.parse(lastUpdated);
  if (!Number.isFinite(milliseconds)) {
    throw htmlLayoutChangedError(KEY, "overview.last_updated is not a valid calendar instant");
  }
  const seconds = Math.floor(milliseconds / 1000);
  if (seconds > nowSec + MAX_FUTURE_SOURCE_TIMESTAMP_SKEW_SEC) {
    throw htmlLayoutChangedError(KEY, "overview.last_updated is beyond the source-clock skew allowance");
  }
  return seconds;
}

export function adaptAxisIssuerClasses(html: string, nowSec: number): AdapterResult {
  const dashboard = parseDashboard(findInitialDashboard(extractFlightText(html)));
  const { overview, dashboard_details: details, reserves_history: history } = dashboard;
  const classes = details.asset_classes;
  const total = classes.total;
  if (!Number.isFinite(nowSec)) throw new Error(`${KEY}: adapter clock is not finite`);
  const sourceTimestamp = readSourceTimestamp(overview.last_updated, nowSec);
  const totalTolerance = Math.max(TOTAL_ABSOLUTE_TOLERANCE_USD, total * TOTAL_RELATIVE_TOLERANCE);

  requireClose(overview.total_reserves.value, total, totalTolerance, "overview total reserves differ from the asset-class total");
  requireSameDayTimelinePoint(dashboard, sourceTimestamp, totalTolerance);

  const byId = new Map<string, z.output<typeof AxisAssetClassSchema>>();
  for (const row of classes.breakdown) {
    if (!(CLASS_IDS as readonly string[]).includes(row.id) || byId.has(row.id)) {
      throw htmlLayoutChangedError(KEY, `unreviewed or duplicate asset-class identity ${row.id}`);
    }
    byId.set(row.id, row);
  }
  if (byId.size !== CLASS_IDS.length) {
    throw htmlLayoutChangedError(KEY, `expected the five reviewed asset-class identities, found ${byId.size}`);
  }
  const rows = CLASS_IDS.map((id) => byId.get(id)!);
  const sum = rows.reduce((value, row) => value + row.value, 0);
  if (Math.abs(sum - total) > totalTolerance) {
    throw htmlLayoutChangedError(KEY, "asset-class values do not sum to the published total");
  }

  let unclassifiedGross = 0;
  for (const row of rows) {
    requireClose(row.percent, row.value / total * 100, PERCENT_TOLERANCE, `published percent for ${row.id} is inconsistent`);
    if (!(row.unclassified.gross_usd <= row.value)) {
      throw htmlLayoutChangedError(KEY, `unclassified amount exceeds the ${row.id} category value`);
    }
    if (row.id !== "liquid_hedge" && row.unclassified.gross_usd !== 0) {
      throw htmlLayoutChangedError(KEY, `${row.id} publishes an unreviewed unclassified portion`);
    }
    requireClose(
      row.unclassified.percent_of_class,
      row.value > 0 ? row.unclassified.gross_usd / row.value * 100 : 0,
      PERCENT_TOLERANCE,
      `unclassified percent for ${row.id} is inconsistent`,
    );
    unclassifiedGross += row.unclassified.gross_usd;
  }
  requireClose(classes.unclassified.gross_usd, unclassifiedGross, TOTAL_ABSOLUTE_TOLERANCE_USD,
    "whole-book unclassified amount differs from the category amounts");
  requireClose(classes.unclassified.percent, unclassifiedGross / total * 100, PERCENT_TOLERANCE,
    "whole-book unclassified percent is inconsistent");
  requireClose(overview.collateralization_ratio, total / overview.usdx_total_supply * 100, PERCENT_TOLERANCE,
    "reported collateralization ratio does not reconcile to reserves and supply");

  const slices: ReserveSlice[] = rows.map((row) => {
    const unclassified = row.id === "liquid_hedge" ? row.unclassified.gross_usd : 0;
    return {
      ...CLASSIFICATION[row.id as AxisClassId],
      pct: (row.value - unclassified) / total * 100,
    };
  });
  const residualPct = unclassifiedGross / total * 100;
  if (unclassifiedGross > 0) {
    slices.push({
      sourceKey: UNCLASSIFIED_RESIDUAL_SOURCE_KEY,
      name: UNCLASSIFIED_RESIDUAL_NAME,
      pct: residualPct,
      risk: "high",
      assetClass: "other",
      unclassifiedResidual: true,
      residualReason: "insufficient-evidence",
    });
  }

  return {
    slices,
    metadata: {
      ...verifiedFreshnessMetadata(sourceTimestamp),
      totalReserveUsd: total,
      supplyUsd: overview.usdx_total_supply,
      collateralizationRatio: total / overview.usdx_total_supply,
      unknownExposurePct: residualPct,
      details: {
        sourceUrl: AXIS_TRANSPARENCY_URL,
        tab: "asset-composition",
        lastUpdated: overview.last_updated,
        classCount: rows.length,
        classSumUsd: sum,
        unclassifiedGrossUsd: unclassifiedGross,
        unclassifiedSharePct: residualPct,
        unclassifiedAssetCount: classes.unclassified.asset_count,
        unclassifiedAssetOfClassPct: rows.find((row) => row.id === "liquid_hedge")?.unclassified.percent_of_class ?? null,
        compositionBasis: "issuer asset-class categories; constituents, venues and obligors are not itemized",
        unclassifiedResidualSourceKey: unclassifiedGross > 0 ? UNCLASSIFIED_RESIDUAL_SOURCE_KEY : null,
      },
    },
  };
}

export async function fetchAxisIssuerClassesReserves(
  coin: ReserveAdapterCoin,
  config: LiveReservesConfig,
  signal: AbortSignal,
  ctx?: AdapterContext,
): Promise<AdapterResult> {
  const input = requireHtmlInput(config.inputs.primary, KEY);
  if (
    coin.id !== "usdx-axis" ||
    input.url !== AXIS_TRANSPARENCY_URL ||
    (config.params != null && Object.keys(config.params).length > 0)
  ) {
    throw new Error(`${KEY}: unexpected coin, input URL or params`);
  }
  const nowSec = ctx?.nowSec ?? Math.floor(Date.now() / 1000);
  return adaptAxisIssuerClasses(await fetchPrimaryHtmlInput(config, KEY, signal, ctx), nowSec);
}
