import type {
  MintBurnCoinCoverage,
  MintBurnCoinFlow,
  MintBurnGauge,
  MintBurnHourlyBucket,
} from "@shared/types";

export type FlowReceiptTone = "mint" | "burn" | "net" | "scope";

export interface FlowPressureReceiptLeader {
  symbol: string;
  valueUsd: number;
}

export interface FlowPressureReceiptRow {
  id: string;
  label: string;
  valueUsd: number | null;
  tone: FlowReceiptTone;
  detail: string;
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
  net24hUsd: number;
  mint7dUsd: number | null;
  burn7dUsd: number | null;
  net7dUsd: number;
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
  let mint24hUsd = 0;
  let burn24hUsd = 0;
  let net24hUsd = 0;
  let net7dUsd = 0;

  for (const coin of coins) {
    mint24hUsd += coin.mintVolume24hUsd;
    burn24hUsd += coin.burnVolume24hUsd;
    net24hUsd += coin.netFlow24hUsd;
    net7dUsd += coin.netFlow7dUsd;
  }

  const mint7dUsd = sumWeekly(weeklyHourly, "mintVolumeUsd");
  const burn7dUsd = sumWeekly(weeklyHourly, "burnVolumeUsd");
  const topMintCoin =
    [...coins]
      .filter((coin) => coin.netFlow24hUsd > 0)
      .sort((a, b) => b.netFlow24hUsd - a.netFlow24hUsd)[0] ?? null;
  const topBurnCoin =
    [...coins]
      .filter((coin) => coin.netFlow24hUsd < 0)
      .sort((a, b) => a.netFlow24hUsd - b.netFlow24hUsd)[0] ?? null;
  const coverageRows = buildCoverageRows(coins);

  return {
    scopeLabel,
    syncWarning,
    trackedCoins: gauge?.trackedCoins ?? coins.length,
    mint24hUsd,
    burn24hUsd,
    net24hUsd,
    mint7dUsd,
    burn7dUsd,
    net7dUsd,
    topMint: topMintCoin ? { symbol: topMintCoin.symbol, valueUsd: topMintCoin.netFlow24hUsd } : null,
    topBurn: topBurnCoin ? { symbol: topBurnCoin.symbol, valueUsd: topBurnCoin.netFlow24hUsd } : null,
    coverageRows,
    coverageSummary: summarizeCoverage(coverageRows, syncWarning),
    rows: [
      {
        id: "mint-24h",
        label: "Printed 24h",
        valueUsd: mint24hUsd,
        tone: "mint",
        detail: "Tracked mints",
      },
      {
        id: "burn-24h",
        label: "Shredded 24h",
        valueUsd: burn24hUsd,
        tone: "burn",
        detail: "Tracked burns",
      },
      {
        id: "net-24h",
        label: "Net 24h",
        valueUsd: net24hUsd,
        tone: "net",
        detail: "Mint minus burn",
      },
      {
        id: "mint-7d",
        label: "Printed 7d",
        valueUsd: mint7dUsd,
        tone: "mint",
        detail: "Hourly covered window",
      },
      {
        id: "burn-7d",
        label: "Shredded 7d",
        valueUsd: burn7dUsd,
        tone: "burn",
        detail: "Hourly covered window",
      },
      {
        id: "net-7d",
        label: "Net 7d",
        valueUsd: net7dUsd,
        tone: "net",
        detail: "Per-coin covered window",
      },
    ],
  };
}
