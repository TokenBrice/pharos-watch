"use client";

import { Skeleton } from "@/components/ui/skeleton";
import { useDigestSnapshot } from "@/hooks/api-hooks";
import { formatCurrency, formatAddress, formatPercentChange, formatScore } from "@shared/lib/format";
import { PSI_BAND_CLASSES, PSI_BORDER_CLASSES, type ConditionBand } from "@shared/lib/psi-colors";
import { Activity, ArrowDownUp, BarChart3, CheckCircle, Shield, ShieldBan, TrendingUp, TriangleAlert } from "lucide-react";

/* ---------- sub-section wrapper ---------- */

function SnapshotCard({
  title,
  icon,
  borderClass,
  children,
}: {
  title: string;
  icon: React.ReactNode;
  borderClass: string;
  children: React.ReactNode;
}) {
  return (
    <div className={`rounded-lg border border-border/50 border-l-[3px] ${borderClass} p-3 space-y-1.5`}>
      <p className="pharos-kicker">
        <span className="flex items-center gap-1.5">
          {icon}
          {title}
        </span>
      </p>
      {children}
    </div>
  );
}

/** Green for positive, red for negative, muted for zero. */
function deltaColor(value: number): string {
  if (value > 0) return "text-green-700 dark:text-green-400";
  if (value < 0) return "text-red-700 dark:text-red-400";
  return "text-muted-foreground";
}

/* ---------- main component ---------- */

export function DigestSnapshot({ date }: { date: string }) {
  const { data, isLoading, isError } = useDigestSnapshot(date);

  if (isError) return null;

  if (isLoading) {
    return (
      <section className="mt-8 space-y-3">
        <p className="pharos-kicker">The data behind this digest</p>
        <Skeleton className="h-4 w-3/4" />
        <Skeleton className="h-4 w-1/2" />
        <Skeleton className="h-4 w-2/3" />
      </section>
    );
  }

  if (!data?.inputData) return null;

  const { inputData, prevInputData, blacklistEvents } = data;
  const prev = prevInputData ?? undefined;

  const mcapDelta = prev ? inputData.totalMcapUsd - prev.totalMcapUsd : 0;

  return (
    <section className="mt-8 space-y-4 animate-in fade-in duration-300">
      <p className="pharos-kicker">
        The data behind this digest
      </p>

      <div className="grid gap-3 sm:grid-cols-2">
        {/* 1. Market Snapshot — always shown */}
        <SnapshotCard
          title="Market Snapshot"
          icon={<BarChart3 className="h-4 w-4" aria-hidden="true" />}
          borderClass="border-l-blue-500"
        >
          <p className="text-sm text-foreground/90">
            Total mcap:{" "}
            <span className="font-medium">
              {formatCurrency(inputData.totalMcapUsd)}
            </span>
            {prev && (
              <span className={deltaColor(mcapDelta)}>
                {" "}({mcapDelta >= 0 ? "+" : ""}
                {formatCurrency(mcapDelta)} from yesterday)
              </span>
            )}
          </p>
          <p className="text-sm text-muted-foreground">
            7d change:{" "}
            <span className={`font-medium ${deltaColor(inputData.mcap7dDelta)}`}>
              {formatCurrency(inputData.mcap7dDelta)}
            </span>
            {inputData.totalMcapUsd - inputData.mcap7dDelta !== 0 && (
              <span className={deltaColor(inputData.mcap7dDelta)}>
                {" "}
                ({formatPercentChange(
                  inputData.totalMcapUsd,
                  inputData.totalMcapUsd - inputData.mcap7dDelta
                )})
              </span>
            )}
          </p>
        </SnapshotCard>

        {/* 2. Stability Index */}
        {inputData.stabilityIndex && (
          <SnapshotCard
            title="Stability Index"
            icon={<Activity className="h-4 w-4" aria-hidden="true" />}
            borderClass={PSI_BORDER_CLASSES[inputData.stabilityIndex.band as ConditionBand] ?? "border-l-muted-foreground"}
          >
            <p className="text-sm text-foreground/90">
              Score:{" "}
              {prev?.stabilityIndex && (
                <span className="text-muted-foreground">
                  {formatScore(prev.stabilityIndex.score)} &rarr;{" "}
                </span>
              )}
              <span className="font-medium">
                {formatScore(inputData.stabilityIndex.score)}
              </span>
            </p>
            <p className="text-sm">
              Band:{" "}
              <span
                className={
                  PSI_BAND_CLASSES[inputData.stabilityIndex.band as ConditionBand] ??
                  "text-muted-foreground"
                }
              >
                {inputData.stabilityIndex.band}
              </span>
            </p>
            <p className="text-xs text-muted-foreground">
              Severity {formatScore(inputData.stabilityIndex.components.severity)}
              {" / "}
              Breadth {formatScore(inputData.stabilityIndex.components.breadth)}
              {" / "}
              Trend {formatScore(inputData.stabilityIndex.components.trend)}
            </p>
          </SnapshotCard>
        )}

        {/* 3. Biggest Supply Mover */}
        {inputData.biggestSupplyChange && (
          <SnapshotCard
            title="Biggest Supply Mover"
            icon={<TrendingUp className="h-4 w-4" aria-hidden="true" />}
            borderClass="border-l-cyan-500"
          >
            <p className="text-sm text-foreground/90">
              <span className="font-medium">
                {inputData.biggestSupplyChange.symbol}
              </span>{" "}
              <span className="text-muted-foreground">
                {inputData.biggestSupplyChange.name}
              </span>
            </p>
            <p className="text-sm text-foreground/90">
              7d change:{" "}
              <span className={`font-medium ${deltaColor(inputData.biggestSupplyChange.changeUsd)}`}>
                {inputData.biggestSupplyChange.changeUsd >= 0 ? "+" : ""}
                {formatCurrency(inputData.biggestSupplyChange.changeUsd)}
              </span>
            </p>
            <p className="text-xs text-muted-foreground">
              Current mcap:{" "}
              {formatCurrency(inputData.biggestSupplyChange.currentMcap)}
            </p>
          </SnapshotCard>
        )}

        {/* 4. Active Depegs */}
        {inputData.activeDepegCount > 0 && (
          <SnapshotCard
            title="Active Depegs"
            icon={<TriangleAlert className="h-4 w-4" aria-hidden="true" />}
            borderClass="border-l-amber-500"
          >
            <p className="text-sm text-foreground/90">
              <span className="font-medium">{inputData.activeDepegCount}</span>{" "}
              active depeg{inputData.activeDepegCount !== 1 ? "s" : ""}
            </p>
            {inputData.topDepegs.length > 0 && (
              <ul className="space-y-0.5">
                {inputData.topDepegs.map((d) => (
                  <li
                    key={d.symbol}
                    className="text-xs text-muted-foreground"
                  >
                    {d.symbol}: {d.bps > 0 ? "+" : ""}
                    {d.bps} bps ({formatCurrency(d.mcapUsd)})
                  </li>
                ))}
              </ul>
            )}
          </SnapshotCard>
        )}

        {/* 5. Blacklist Activity — spans full width since it's a list */}
        {blacklistEvents.length > 0 && (
          <div className="sm:col-span-2">
            <SnapshotCard
              title="Blacklist Activity"
              icon={<ShieldBan className="h-4 w-4" aria-hidden="true" />}
              borderClass="border-l-red-500"
            >
              <p className="text-sm text-foreground/90">
                <span className="font-medium">{blacklistEvents.length}</span>{" "}
                event{blacklistEvents.length !== 1 ? "s" : ""} on this day
                {(() => {
                  const total = blacklistEvents.reduce((sum, e) => sum + (e.amountUsdAtEvent ?? 0), 0);
                  return total > 0 ? (
                    <span className="text-muted-foreground"> totaling {formatCurrency(total)}</span>
                  ) : null;
                })()}
              </p>
              <ul className="space-y-0.5">
                {blacklistEvents.slice(0, 5).map((e) => (
                  <li key={`${e.timestamp}-${e.address}`} className="text-xs text-muted-foreground">
                    {e.stablecoin} on {e.chainName} &mdash; {e.eventType}
                    {e.amountUsdAtEvent != null ? (
                      <span> ({formatCurrency(e.amountUsdAtEvent)})</span>
                    ) : e.amountNative != null ? (
                      <span> ({e.amountNative.toLocaleString(undefined, { maximumFractionDigits: 4 })} native)</span>
                    ) : null}
                    <span className="ml-1">{formatAddress(e.address)}</span>
                  </li>
                ))}
              </ul>
              {blacklistEvents.length > 5 && (
                <p className="text-xs text-muted-foreground mt-1">
                  and {blacklistEvents.length - 5} more
                </p>
              )}
            </SnapshotCard>
          </div>
        )}

        {/* 6. Safety Scores */}
        {inputData.safetyScores && (
          <SnapshotCard
            title="Safety Scores"
            icon={<Shield className="h-4 w-4" aria-hidden="true" />}
            borderClass="border-l-violet-500"
          >
            {inputData.safetyScores.mentionedCoins.length > 0 && (
              <ul className="space-y-0.5">
                {inputData.safetyScores.mentionedCoins.map((c) => (
                  <li key={c.symbol} className="text-xs text-foreground/90">
                    <span className="font-medium">{c.symbol}</span>:{" "}
                    <span className="font-medium">{c.grade}</span>{" "}
                    <span className="text-muted-foreground">
                      ({c.score}
                      {c.peg !== null && `, peg=${c.peg}`}
                      {c.liq !== null && `, liq=${c.liq}`})
                    </span>
                  </li>
                ))}
              </ul>
            )}
            <p className="text-xs text-muted-foreground">
              Median {inputData.safetyScores.medianGrade},{" "}
              {inputData.safetyScores.aboveBCount} above B,{" "}
              {inputData.safetyScores.fCount} rated F
            </p>
          </SnapshotCard>
        )}

        {/* 7. Yield Anomalies */}
        {inputData.yieldAnomalies && inputData.yieldAnomalies.length > 0 && (
          <SnapshotCard title="Yield Anomalies" icon={<TrendingUp className="h-4 w-4" />} borderClass="border-l-amber-500">
            {inputData.yieldAnomalies.map((y) => (
              <div key={y.symbol} className="flex items-baseline justify-between gap-2 text-sm">
                <span className="font-mono font-medium">{y.symbol}</span>
                <span className="text-muted-foreground">
                  {y.currentApy}% APY (7d: {y.apy7d}%, 30d: {y.apy30d}%)
                </span>
                <span className="text-xs text-amber-600 dark:text-amber-400">
                  {y.warnings.join(", ")}
                </span>
              </div>
            ))}
          </SnapshotCard>
        )}

        {/* 8. Liquidity Shifts */}
        {inputData.liquidityShifts && inputData.liquidityShifts.length > 0 && (
          <SnapshotCard title="DEX Liquidity Shifts" icon={<BarChart3 className="h-4 w-4" />} borderClass="border-l-blue-500">
            {inputData.liquidityShifts.map((l) => (
              <div key={l.symbol} className="flex items-baseline justify-between gap-2 text-sm">
                <span className="font-mono font-medium">{l.symbol}</span>
                <span className={l.scoreDelta > 0 ? "text-emerald-600" : "text-red-600"}>
                  {l.previousScore} → {l.currentScore} ({l.scoreDelta > 0 ? "+" : ""}{l.scoreDelta})
                </span>
                <span className="text-xs text-muted-foreground">
                  TVL {formatCurrency(l.currentTvl)}
                </span>
              </div>
            ))}
          </SnapshotCard>
        )}

        {/* 9. Supply Velocity */}
        {inputData.supplyVelocity && inputData.supplyVelocity.length > 0 && (
          <SnapshotCard
            title="Supply Velocity"
            icon={<ArrowDownUp className="h-4 w-4" aria-hidden="true" />}
            borderClass="border-l-emerald-500"
          >
            <ul className="space-y-0.5">
              {inputData.supplyVelocity.map((v) => (
                <li key={v.coin} className="text-xs text-foreground/90">
                  <span className="font-medium">{v.coin}</span>:{" "}
                  <span className={deltaColor(v.change1d)}>
                    {v.change1d >= 0 ? "+" : ""}{formatCurrency(v.change1d)}/1d
                  </span>{" "}
                  <span className="text-muted-foreground">
                    vs {v.change7d >= 0 ? "+" : ""}{formatCurrency(v.change7d)}/7d
                  </span>{" "}
                  <span className="text-muted-foreground italic">{v.signal}</span>
                </li>
              ))}
            </ul>
          </SnapshotCard>
        )}

        {/* 10. Resolved Depegs */}
        {inputData.resolvedDepegs && inputData.resolvedDepegs.length > 0 && (
          <SnapshotCard
            title="Resolved Depegs"
            icon={<CheckCircle className="h-4 w-4" aria-hidden="true" />}
            borderClass="border-l-teal-500"
          >
            <ul className="space-y-0.5">
              {inputData.resolvedDepegs.map((r) => (
                <li key={`${r.symbol}-${r.peakBps}`} className="text-xs text-foreground/90">
                  <span className="font-medium">{r.symbol}</span>{" "}
                  recovered from {r.peakBps}bps after {r.durationHours}h{" "}
                  <span className="text-muted-foreground">
                    ({formatCurrency(r.mcapUsd)} mcap)
                  </span>
                </li>
              ))}
            </ul>
          </SnapshotCard>
        )}
      </div>
    </section>
  );
}
