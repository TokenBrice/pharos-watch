import { Card, CardContent } from "@/components/ui/card";
import { HOUR_SECONDS } from "@/lib/constants";

interface DataQualityCardsProps {
  dq: {
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
  const onchainStalenessDetail = onchainUnavailable
    ? "monitor unavailable"
    : `/${dq.onchainSupplyTrackedCoins} coins >2h old`;

  const cards: Array<{ label: string; value: number | string; detail: string; severity: Severity }> = [
    {
      label: "Missing Prices",
      value: dq.missingPrices,
      detail: `/ ${dq.totalStablecoins} coins`,
      severity: dq.missingPrices > 5 ? "red" : dq.missingPrices > 0 ? "amber" : "green",
    },
    {
      label: "Blacklist Gaps",
      value: dq.blacklistMissingAmounts,
      detail: `${dq.blacklistRecentMissingAmounts} in last ${Math.round(dq.blacklistRecentWindowSec / HOUR_SECONDS)}h`,
      severity: dq.blacklistMissingRatio >= 0.02
        ? "red"
        : dq.blacklistRecentMissingAmounts > 0 || dq.blacklistMissingRatio >= 0.005
          ? "amber"
          : "green",
    },
    {
      label: "On-chain Divergences",
      value: onchainUnavailable ? "N/A" : dq.onchainSupplyDivergences,
      detail: onchainUnavailable ? "monitor unavailable" : "coins >5% off",
      severity: onchainUnavailable
        ? "neutral"
        : dq.onchainDivergenceRatio >= 0.25 ? "red" : dq.onchainDivergenceRatio >= 0.1 ? "amber" : "green",
    },
    {
      label: "Active Depegs",
      value: dq.activeDepegs,
      detail: "open events",
      severity: dq.activeDepegs > 5 ? "red" : dq.activeDepegs > 0 ? "amber" : "green",
    },
    {
      label: "Stale On-chain",
      value: onchainUnavailable ? "N/A" : dq.staleOnchainSupply,
      detail: onchainStalenessDetail,
      severity: onchainUnavailable
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

  return (
    <div className="grid grid-cols-2 gap-4 sm:grid-cols-3 lg:grid-cols-5">
      {cards.map((c) => (
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
