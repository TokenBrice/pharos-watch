import { Card, CardContent } from "@/components/ui/card";
import { HOUR_SECONDS } from "@/lib/constants";

interface DataQualityCardsProps {
  dq: {
    nowSeconds: number;
    stablecoinsCacheStatus: "ok" | "degraded" | "error";
    stablecoinsCacheReason: string | null;
    blacklistGapStatus: "ok" | "failed";
    activeDepegStatus: "ok" | "failed";
    onchainSupplyQueryStatus: "ok" | "failed" | "unavailable";
    sourceFailures: Array<{
      source: "stablecoins-cache" | "blacklist-gaps" | "active-depegs" | "onchain-supply";
      message: string;
    }>;
    totalStablecoins: number;
    missingPrices: number;
    blacklistMissingAmounts: number;
    blacklistRecentMissingAmounts: number;
    blacklistRecentWindowSec: number;
    blacklistMissingRatio: number;
    blacklistTotal: number;
    onchainSupplyDivergences: number;
    onchainDivergenceRatio: number;
    onchainSupplyMonitoring: "active" | "unavailable";
    onchainSupplyLatestAt: number | null;
    onchainSupplyTrackedCoins: number;
    activeDepegs: number;
    staleOnchainSupply: number;
    onchainStaleRatio: number;
  };
}

export function DataQualityCards({ dq }: DataQualityCardsProps) {
  type Severity = "green" | "amber" | "red" | "neutral";
  const onchainUnavailable = dq.onchainSupplyMonitoring === "unavailable";
  const blacklistQueryFailed = dq.blacklistGapStatus === "failed";
  const activeDepegQueryFailed = dq.activeDepegStatus === "failed";
  const onchainQueryFailed = dq.onchainSupplyQueryStatus === "failed";
  const missingPriceRatio = dq.totalStablecoins > 0 ? dq.missingPrices / dq.totalStablecoins : 0;
  const cacheIssueDetail = dq.stablecoinsCacheReason
    ? `cache ${dq.stablecoinsCacheStatus}: ${dq.stablecoinsCacheReason}`
    : "cache healthy";
  const onchainStalenessDetail = onchainUnavailable
    ? "monitor unavailable"
    : `${dq.staleOnchainSupply}/${dq.onchainSupplyTrackedCoins} >2h old`;
  const onchainLatestAge = dq.onchainSupplyLatestAt != null
    ? Math.max(0, dq.nowSeconds - dq.onchainSupplyLatestAt)
    : null;

  const cards: Array<{ label: string; value: number | string; detail: string; severity: Severity }> = [
    {
      label: "Missing Prices",
      value: dq.stablecoinsCacheStatus === "error" ? "ERR" : dq.missingPrices,
      detail: dq.stablecoinsCacheStatus === "ok"
        ? `${dq.missingPrices}/${dq.totalStablecoins} (${(missingPriceRatio * 100).toFixed(1)}%) · warn >15%, stale >40%`
        : dq.stablecoinsCacheStatus === "degraded"
          ? `${dq.missingPrices}/${dq.totalStablecoins} (${(missingPriceRatio * 100).toFixed(1)}%) · ${cacheIssueDetail}`
          : cacheIssueDetail,
      severity: dq.stablecoinsCacheStatus === "error"
        ? "red"
        : dq.stablecoinsCacheStatus === "degraded"
          ? "amber"
          : missingPriceRatio > 0.4
            ? "red"
            : missingPriceRatio > 0.15
              ? "amber"
              : "green",
    },
    {
      label: "Blacklist Gaps",
      value: blacklistQueryFailed ? "ERR" : dq.blacklistMissingAmounts,
      detail: blacklistQueryFailed
        ? `query failed: ${dq.sourceFailures.find((failure) => failure.source === "blacklist-gaps")?.message ?? "blacklist gaps unavailable"}`
        : `${dq.blacklistMissingAmounts}/${dq.blacklistTotal} (${(dq.blacklistMissingRatio * 100).toFixed(2)}%) · recent ${dq.blacklistRecentMissingAmounts}/${Math.round(dq.blacklistRecentWindowSec / HOUR_SECONDS)}h · warn >=0.5%, stale >=2%`,
      severity: blacklistQueryFailed
        ? "red"
        : dq.blacklistMissingRatio >= 0.02
        ? "red"
        : dq.blacklistRecentMissingAmounts > 0 || dq.blacklistMissingRatio >= 0.005
          ? "amber"
          : "green",
    },
    {
      label: "On-chain Divergences",
      value: onchainQueryFailed ? "ERR" : onchainUnavailable ? "—" : dq.onchainSupplyDivergences,
      detail: onchainQueryFailed
        ? `query failed: ${dq.sourceFailures.find((failure) => failure.source === "onchain-supply")?.message ?? "on-chain supply unavailable"}`
        : onchainUnavailable
        ? "monitor unavailable"
        : `${dq.onchainSupplyDivergences}/${dq.onchainSupplyTrackedCoins} (${(dq.onchainDivergenceRatio * 100).toFixed(1)}%) >5% off · warn >=10%, stale >=25%`,
      severity: onchainQueryFailed
        ? "red"
        : onchainUnavailable
        ? "neutral"
        : dq.onchainDivergenceRatio >= 0.25 ? "red" : dq.onchainDivergenceRatio >= 0.1 ? "amber" : "green",
    },
    {
      label: "Active Depegs",
      value: activeDepegQueryFailed ? "ERR" : dq.activeDepegs,
      detail: activeDepegQueryFailed
        ? `query failed: ${dq.sourceFailures.find((failure) => failure.source === "active-depegs")?.message ?? "active depegs unavailable"}`
        : "informational only; active depegs do not change /status health",
      severity: activeDepegQueryFailed ? "red" : "neutral",
    },
    {
      label: "Stale On-chain",
      value: onchainQueryFailed ? "ERR" : onchainUnavailable ? "—" : dq.staleOnchainSupply,
      detail: onchainQueryFailed
        ? `query failed: ${dq.sourceFailures.find((failure) => failure.source === "onchain-supply")?.message ?? "on-chain freshness unavailable"}`
        : onchainUnavailable
        ? onchainStalenessDetail
        : `${onchainStalenessDetail} · ${(dq.onchainStaleRatio * 100).toFixed(1)}% · latest sample ${onchainLatestAge != null ? `${Math.round(onchainLatestAge / HOUR_SECONDS)}h ago` : "—"} · warn >=10%, stale >=25%`,
      severity: onchainQueryFailed
        ? "red"
        : onchainUnavailable
        ? "neutral"
        : dq.onchainStaleRatio >= 0.25 ? "red" : dq.onchainStaleRatio >= 0.1 ? "amber" : "green",
    },
  ];

  const severityColor = {
    green: "text-green-600 dark:text-green-400",
    amber: "text-amber-600 dark:text-amber-400",
    red: "text-red-600 dark:text-red-400",
    neutral: "text-muted-foreground",
  };
  const severityRank = {
    red: 0,
    amber: 1,
    green: 2,
    neutral: 3,
  } as const;
  const orderedCards = [...cards].sort((a, b) => severityRank[a.severity] - severityRank[b.severity]);

  return (
    <div className="grid grid-cols-2 gap-4 sm:grid-cols-3 lg:grid-cols-5">
      {orderedCards.map((c) => (
        <Card key={c.label}>
          <CardContent className="pt-4">
            <div className="text-xs text-muted-foreground">{c.label}</div>
            <div className={`font-mono text-2xl font-extrabold tabular-nums ${severityColor[c.severity]}`}>{c.value}</div>
            <div className="text-xs text-muted-foreground">{c.detail}</div>
          </CardContent>
        </Card>
      ))}
    </div>
  );
}
