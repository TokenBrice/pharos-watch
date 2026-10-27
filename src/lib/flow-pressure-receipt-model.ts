import type {
  MintBurnCoinCoverage,
  MintBurnCoinFlow,
  MintBurnHourlyBucket,
  MintBurnSignedNetBound,
  MintBurnValuationCompleteness,
} from "@shared/types";
import {
  combineMintBurnValuationCompleteness,
  resolveMintBurnValuationCompleteness,
} from "@shared/lib/mint-burn-valuation";
import { hasCompleteCoinScan, resolveCoinNetFlow } from "@shared/lib/mint-burn-coin-helpers";
import { describeMintBurnVolumeBound, sumMintBurnSignedNets } from "@shared/lib/mint-burn-valuation-display";

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
  /** Scan completeness is separate from USD valuation completeness. */
  scanComplete?: boolean;
  /** Accessible reason for a lower bound, unavailable net, or unknown coverage; `null` when complete. */
  note: string | null;
  /** Proven one-sided bound on an unavailable net row. */
  bound?: MintBurnSignedNetBound | null;
}

export interface FlowPressureReceiptCoverageRow {
  status: MintBurnCoinCoverage["status"];
  count: number;
}

export interface FlowPressureReceiptModel {
  scopeLabel: string;
  topMint: FlowPressureReceiptLeader | null;
  topBurn: FlowPressureReceiptLeader | null;
  /** No coin has a displayable 7d net, so an absent leader is unavailable evidence, not an observed absence. */
  leadersUnavailable: boolean;
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
  coins,
  weeklyHourly,
  scopeLabel = "Configured issuance chains",
  syncWarning = null,
}: {
  coins: readonly MintBurnCoinFlow[];
  weeklyHourly?: readonly MintBurnHourlyBucket[];
  scopeLabel?: string;
  syncWarning?: string | null;
}): FlowPressureReceiptModel {
  const net7d = sumMintBurnSignedNets(coins.map((coin) => resolveCoinNetFlow(coin, "7d")));
  const weeklyCompleteness = combineMintBurnValuationCompleteness(
    ...(weeklyHourly ?? []).map((bucket) => resolveMintBurnValuationCompleteness(bucket.valuation)),
  );
  const weeklyScanComplete = coins.every((coin) => hasCompleteCoinScan(coin, "7d"))
    && (weeklyHourly ?? []).every((bucket) => bucket.scanCoverage?.complete !== false);

  const mint7dUsd = sumWeekly(weeklyHourly, "mintVolumeUsd");
  const burn7dUsd = sumWeekly(weeklyHourly, "burnVolumeUsd");
  // Leaders rank only displayable nets; an unavailable net is never ranked as 0.
  const rankedNets = coins.flatMap((coin) => {
    const valueUsd = resolveCoinNetFlow(coin, "7d").valueUsd;
    return valueUsd == null ? [] : [{ symbol: coin.symbol, valueUsd }];
  });
  const topMint =
    rankedNets.filter((entry) => entry.valueUsd > 0).sort((a, b) => b.valueUsd - a.valueUsd)[0] ?? null;
  const topBurn =
    rankedNets.filter((entry) => entry.valueUsd < 0).sort((a, b) => a.valueUsd - b.valueUsd)[0] ?? null;
  const coverageRows = buildCoverageRows(coins);

  return {
    scopeLabel,
    topMint,
    topBurn,
    leadersUnavailable: rankedNets.length === 0,
    coverageRows,
    coverageSummary: summarizeCoverage(coverageRows, syncWarning),
    rows: [
      {
        id: "mint-7d",
        label: "Printed 7d",
        valueUsd: mint7dUsd,
        tone: "mint",
        detail: "Hourly covered window",
        completeness: weeklyCompleteness,
        scanComplete: weeklyScanComplete,
        note: mint7dUsd == null ? null : describeMintBurnVolumeBound(weeklyCompleteness, null, weeklyScanComplete),
      },
      {
        id: "burn-7d",
        label: "Shredded 7d",
        valueUsd: burn7dUsd,
        tone: "burn",
        detail: "Hourly covered window",
        completeness: weeklyCompleteness,
        scanComplete: weeklyScanComplete,
        note: burn7dUsd == null ? null : describeMintBurnVolumeBound(weeklyCompleteness, null, weeklyScanComplete),
      },
      {
        id: "net-7d",
        label: "Net 7d",
        valueUsd: net7d.valueUsd,
        tone: "net",
        detail: "Per-coin covered window",
        completeness: net7d.completeness,
        note: net7d.note,
        bound: net7d.bound ?? null,
      },
    ],
  };
}
