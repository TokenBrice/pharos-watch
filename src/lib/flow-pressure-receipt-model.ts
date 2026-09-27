import type {
  MintBurnCoinCoverage,
  MintBurnCoinFlow,
  MintBurnGauge,
  MintBurnHourlyBucket,
  MintBurnValuationCompleteness,
} from "@shared/types";
import {
  combineMintBurnValuationCompleteness,
  resolveMintBurnValuationCompleteness,
} from "@shared/lib/mint-burn-valuation";
import { aggregateCoinFlows24h, resolveCoinNetFlow } from "@/lib/mint-burn-coin-helpers";
import { describeMintBurnVolumeBound, sumMintBurnSignedNets } from "@/lib/mint-burn-valuation-display";

export type FlowReceiptTone = "mint" | "burn" | "net" | "scope";

export interface FlowPressureReceiptLeader {
  symbol: string;
  valueUsd: number;
}

export interface FlowPressureReceiptRow {
  id: string;
  label: string;
  /** `null` renders NR: no hourly data for volumes, or an unavailable signed net (never 0). */
  valueUsd: number | null;
  tone: FlowReceiptTone;
  detail: string;
  /** Valuation completeness; non-complete volumes are lower bounds, non-complete nets carry `note`. */
  completeness: MintBurnValuationCompleteness;
  /** Accessible reason for a lower bound, unavailable net, or unknown coverage; `null` when complete. */
  note: string | null;
}

export interface FlowPressureReceiptCoverageRow {
  status: MintBurnCoinCoverage["status"];
  count: number;
}

export interface FlowPressureReceiptModel {
  scopeLabel: string;
  syncWarning: string | null;
  trackedCoins: number;
  mint24hUsd: number;
  burn24hUsd: number;
  net24hUsd: number | null;
  mint7dUsd: number | null;
  burn7dUsd: number | null;
  net7dUsd: number | null;
  topMint: FlowPressureReceiptLeader | null;
  topBurn: FlowPressureReceiptLeader | null;
  coverageRows: FlowPressureReceiptCoverageRow[];
  coverageSummary: string;
  rows: FlowPressureReceiptRow[];
}

const COVERAGE_ORDER: MintBurnCoinCoverage["status"][] = [
  "full",
  "partial-history",
  "lagging",
  "bootstrapping",
  "unknown",
  "disabled",
];

function buildCoverageRows(coins: readonly MintBurnCoinFlow[]): FlowPressureReceiptCoverageRow[] {
  const counts = new Map<MintBurnCoinCoverage["status"], number>();
  for (const coin of coins) {
    const status = coin.coverage?.status;
    if (!status) continue;
    counts.set(status, (counts.get(status) ?? 0) + 1);
  }
  return COVERAGE_ORDER
    .map((status) => ({ status, count: counts.get(status) ?? 0 }))
    .filter((row) => row.count > 0);
}

function summarizeCoverage(rows: readonly FlowPressureReceiptCoverageRow[], syncWarning: string | null): string {
  if (syncWarning) return "Lag warning active";
  if (rows.length === 0) return "Coverage metadata unavailable";
  const lagging = rows.find((row) => row.status === "lagging")?.count ?? 0;
  if (lagging > 0) return `${lagging} lagging ${lagging === 1 ? "coin" : "coins"}`;
  const unknown = rows.find((row) => row.status === "unknown")?.count ?? 0;
  if (unknown > 0) return `${unknown} unknown ${unknown === 1 ? "coin" : "coins"}`;
  const partial = rows
    .filter((row) => row.status === "partial-history" || row.status === "bootstrapping")
    .reduce((sum, row) => sum + row.count, 0);
  if (partial > 0) return `${partial} partial ${partial === 1 ? "coin" : "coins"}`;
  const full = rows.find((row) => row.status === "full")?.count ?? 0;
  if (full > 0) return "Covered window";
  return "Coverage limited";
}

function sumWeekly(hourly: readonly MintBurnHourlyBucket[] | undefined, key: "mintVolumeUsd" | "burnVolumeUsd"): number | null {
  if (!hourly?.length) return null;
  return hourly.reduce((sum, bucket) => sum + bucket[key], 0);
}

export function buildFlowPressureReceiptModel({
  gauge,
  coins,
  weeklyHourly,
  scopeLabel = "Configured issuance chains",
  syncWarning = null,
}: {
  gauge: MintBurnGauge | null;
  coins: readonly MintBurnCoinFlow[];
  weeklyHourly?: readonly MintBurnHourlyBucket[];
  scopeLabel?: string;
  syncWarning?: string | null;
}): FlowPressureReceiptModel {
  const aggregate = aggregateCoinFlows24h(coins);
  const net7d = sumMintBurnSignedNets(coins.map((coin) => resolveCoinNetFlow(coin, "7d")));
  const weeklyCompleteness = combineMintBurnValuationCompleteness(
    ...(weeklyHourly ?? []).map((bucket) => resolveMintBurnValuationCompleteness(bucket.valuation)),
  );

  const mint7dUsd = sumWeekly(weeklyHourly, "mintVolumeUsd");
  const burn7dUsd = sumWeekly(weeklyHourly, "burnVolumeUsd");
  // Leaders rank only displayable nets; an unavailable net is never ranked as 0.
  const rankedNets = coins.flatMap((coin) => {
    const valueUsd = resolveCoinNetFlow(coin, "24h").valueUsd;
    return valueUsd == null ? [] : [{ symbol: coin.symbol, valueUsd }];
  });
  const topMint =
    rankedNets.filter((entry) => entry.valueUsd > 0).sort((a, b) => b.valueUsd - a.valueUsd)[0] ?? null;
  const topBurn =
    rankedNets.filter((entry) => entry.valueUsd < 0).sort((a, b) => a.valueUsd - b.valueUsd)[0] ?? null;
  const coverageRows = buildCoverageRows(coins);

  return {
    scopeLabel,
    syncWarning,
    trackedCoins: gauge?.trackedCoins ?? coins.length,
    mint24hUsd: aggregate.mintVolumeUsd,
    burn24hUsd: aggregate.burnVolumeUsd,
    net24hUsd: aggregate.net.valueUsd,
    mint7dUsd,
    burn7dUsd,
    net7dUsd: net7d.valueUsd,
    topMint,
    topBurn,
    coverageRows,
    coverageSummary: summarizeCoverage(coverageRows, syncWarning),
    rows: [
      {
        id: "mint-24h",
        label: "Printed 24h",
        valueUsd: aggregate.mintVolumeUsd,
        tone: "mint",
        detail: "Tracked mints",
        completeness: aggregate.mintCompleteness,
        note: describeMintBurnVolumeBound(aggregate.mintCompleteness, aggregate.unpricedMintEventCount),
      },
      {
        id: "burn-24h",
        label: "Shredded 24h",
        valueUsd: aggregate.burnVolumeUsd,
        tone: "burn",
        detail: "Tracked burns",
        completeness: aggregate.burnCompleteness,
        note: describeMintBurnVolumeBound(aggregate.burnCompleteness, aggregate.unpricedBurnEventCount),
      },
      {
        id: "net-24h",
        label: "Net 24h",
        valueUsd: aggregate.net.valueUsd,
        tone: "net",
        detail: "Mint minus burn",
        completeness: aggregate.net.completeness,
        note: aggregate.net.note,
      },
      {
        id: "mint-7d",
        label: "Printed 7d",
        valueUsd: mint7dUsd,
        tone: "mint",
        detail: "Hourly covered window",
        completeness: weeklyCompleteness,
        note: mint7dUsd == null ? null : describeMintBurnVolumeBound(weeklyCompleteness),
      },
      {
        id: "burn-7d",
        label: "Shredded 7d",
        valueUsd: burn7dUsd,
        tone: "burn",
        detail: "Hourly covered window",
        completeness: weeklyCompleteness,
        note: burn7dUsd == null ? null : describeMintBurnVolumeBound(weeklyCompleteness),
      },
      {
        id: "net-7d",
        label: "Net 7d",
        valueUsd: net7d.valueUsd,
        tone: "net",
        detail: "Per-coin covered window",
        completeness: net7d.completeness,
        note: net7d.note,
      },
    ],
  };
}
