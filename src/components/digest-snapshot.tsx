"use client";

import { Skeleton } from "@/components/ui/skeleton";
import { LazySection } from "@/components/lazy-section";
import { DigestIntelligencePanel } from "@/components/digest-intelligence";
import { useDigestSnapshot } from "@/hooks/api-hooks";
import { useImageUnavailable } from "@/hooks/use-image-unavailable";
import { parseDigestSafetyMapCapture, type DigestSafetyMapArchiveTier as StoredSafetyMapTier } from "@shared/types/digest-safety-map-contract";
import { formatCurrency, formatAddress, formatPercentChange, formatScore, getNetColor } from "@shared/lib/format";
import { PSI_BAND_CLASSES, type ConditionBand } from "@shared/lib/classification";
import type { DigestSnapshotInputData, DigestSnapshotResponse } from "@shared/types";
import { Activity, ArrowDownUp, BarChart3, CheckCircle, ImageOff, Shield, ShieldBan, TrendingUp, TriangleAlert } from "lucide-react";
import { formatDigestDateLabel } from "@/lib/digest";
import { formatV9ReasonCodeLabel } from "@/lib/safety-score-data-coverage";
import { humanizeSafetyScoreV9Value } from "@/lib/stablecoin-safety-score-v9-presentation-helpers";
import { formatYieldWarningSignal } from "@/lib/yield-constants";
import { selectInvestmentWarningSignals } from "@shared/lib/yield-warning-signals";
import { describePartialEvidence, formatPartialEvidenceGap } from "@/lib/safety-score-reason-labels";

/** Stored pillar scores are unrounded floats (53.239999999999995); readers get one decimal at most. */
function formatDigestScore(score: number | null | undefined): string {
  return score == null ? "—" : formatScore(score, { trimInteger: true });
}

/* ---------- sub-section wrapper ---------- */

function SnapshotCard({
  title,
  icon,
  children,
}: {
  title: string;
  icon: React.ReactNode;
  children: React.ReactNode;
}) {
  return (
    <div className="rounded-lg border border-border/50 p-3 space-y-1.5">
      <h3 className="pharos-kicker">
        <span className="flex items-center gap-1.5">
          {icon}
          {title}
        </span>
      </h3>
      {children}
    </div>
  );
}


function SnapshotUnavailable() {
  return (
    <section className="mt-8 space-y-3">
      <p className="pharos-kicker">The data behind this digest</p>
      <div className="rounded-lg border border-border/50 p-3 text-sm text-muted-foreground">
        Digest context is unavailable for this archive entry.
      </div>
    </section>
  );
}

function SafetyMapUnavailable() {
  return (
    <div className="pharos-card-shell p-4 sm:p-5">
      <div className="flex items-start gap-3">
        <ImageOff className="mt-0.5 h-5 w-5 shrink-0 text-muted-foreground" aria-hidden="true" />
        <div className="space-y-1.5">
          <p className="pharos-section-title">The map is not available right now</p>
          <p className="text-sm leading-relaxed text-muted-foreground">
            This edition keeps its original map citation, but the poster bytes are currently unavailable.
            Every grade the map draws is available as live, sortable data on the{" "}
            <a href="/safety-scores/" className="pharos-prose-link">
              Safety Scores page
            </a>
            .
          </p>
        </div>
      </div>
    </div>
  );
}

function DigestSafetyMapCard({ inputData }: { inputData: DigestSnapshotInputData }) {
  const map = parseDigestSafetyMapCapture(inputData.safetyMap, "archive-compatible");
  const { unavailable, checkAlreadyFailed, onError } = useImageUnavailable();
  if (!map) return null;
  if (unavailable) return <SafetyMapUnavailable />;

  const summary = map.manifest.mapSummary;
  const byTier = new Map(summary.tiers.map((tier) => [tier.tier, tier]));
  const aTier = byTier.get("A");
  const outerTiers = ["C", "D", "F"]
    .map((tier) => byTier.get(tier as StoredSafetyMapTier["tier"]))
    .filter((tier): tier is StoredSafetyMapTier => tier !== undefined);
  if (!aTier || outerTiers.length !== 3) return null;
  const outerCount = outerTiers.reduce((sum, tier) => sum + tier.count, 0);
  const outerMcapUsd = outerTiers.reduce((sum, tier) => sum + tier.mcapUsd, 0);
  const aSharePct = ((aTier.mcapUsd / summary.totalMcapUsd) * 100).toFixed(1);
  const outerSharePct = ((outerMcapUsd / summary.totalMcapUsd) * 100).toFixed(1);
  const mapDateLabel = formatDigestDateLabel(map.manifest.date, "long");
  const freshnessLabel = map.freshness === "current"
    ? `Dated ${mapDateLabel} map`
    : `Carried from the ${mapDateLabel} map${map.ageDays != null ? ` (${map.ageDays}d old)` : ""}`;

  return (
    <section aria-labelledby="digest-safety-map" className="space-y-3">
      <div className="flex flex-wrap items-baseline justify-between gap-2">
        <div>
          <p className="pharos-kicker">Safety Map</p>
          <h3 id="digest-safety-map" className="text-base font-semibold text-foreground">
            The dated market census behind this edition
          </h3>
        </div>
        <p className="pharos-meta">{freshnessLabel}</p>
      </div>
      <div className="grid gap-3 rounded-lg border border-border/60 bg-muted/10 p-3 sm:grid-cols-[minmax(0,1.6fr)_minmax(12rem,0.8fr)] sm:items-stretch">
        <figure className="overflow-hidden rounded-md border border-border/50 bg-[#05070d]">
          <img
            ref={checkAlreadyFailed}
            src={map.imageUrl}
            alt={`Pharos Safety Score Map for ${mapDateLabel}; ${summary.gradedCount} graded coins across A, B, C, D, and F tiers.`}
            width={3200}
            height={1800}
            className="aspect-[16/9] w-full object-contain"
            onError={onError}
          />
          <figcaption className="border-t border-white/10 px-2.5 py-2 text-[0.68rem] leading-relaxed text-white/70">
            V{summary.methodologyVersion.replace(/^v/i, "")} · {summary.notRatedCount} not rated · as of {mapDateLabel}
          </figcaption>
        </figure>
        <div className="flex flex-col justify-center gap-2 rounded-md border border-border/50 bg-background/45 p-3">
          <p className="font-mono text-[0.68rem] font-semibold uppercase tracking-[0.2em] text-muted-foreground">
            {freshnessLabel}
          </p>
          <div className="space-y-1.5 text-sm text-foreground/90">
            <p>Mapped supply: <span className="font-medium">{formatCurrency(summary.totalMcapUsd, 1)}</span> across {summary.gradedCount} coins</p>
            <p>A tier: <span className="font-medium">{aTier.count} coins</span> · {aSharePct}%</p>
            <p>C/D/F tiers: <span className="font-medium">{outerCount} coins</span> · {outerSharePct}%</p>
          </div>
          <a
            href={map.imageUrl}
            target="_blank"
            rel="noopener noreferrer"
            className="pharos-focus-ring mt-1 inline-flex w-fit rounded-sm text-xs font-medium text-muted-foreground underline underline-offset-4 transition-colors hover:text-foreground"
          >
            Open the dated poster&nbsp;&rarr;
          </a>
        </div>
      </div>
    </section>
  );
}

interface VisibleDepeg {
  key: string;
  symbol: string;
  bps: number;
  direction: string | null;
  mcapUsd: number | null;
  peakBps: number;
  currentAvailable: boolean;
}

/**
 * The edition's own capture. Day-overlap episodes from the archive API describe the UTC day,
 * not what this edition published, so they never replace `activeDepegCount`/`topDepegs`.
 */
function getCapturedDepegs(inputData: DigestSnapshotInputData): { count: number | null; rows: VisibleDepeg[] } {
  const inputTopDepegs = inputData.topDepegs ?? [];
  return {
    count: inputData.degradedSources?.includes("active-depegs-query") ? null : inputData.activeDepegCount ?? null,
    rows: inputTopDepegs.slice(0, 5).map((depeg) => ({
      key: `${depeg.stablecoinId ?? depeg.symbol}-${depeg.startedAt ?? depeg.bps}`,
      symbol: depeg.symbol,
      bps: depeg.severityBasis === "current" && depeg.currentBps != null ? depeg.currentBps : depeg.bps,
      direction: depeg.severityBasis === "current" && depeg.currentBps != null
        ? (depeg.currentBps >= 0 ? "above" : "below")
        : depeg.direction ?? (depeg.bps >= 0 ? "above" : "below"),
      peakBps: depeg.bps,
      currentAvailable: depeg.severityBasis === "current" && depeg.currentBps != null,
      mcapUsd: depeg.mcapUsd,
    })),
  };
}

function DepegRowList({ rows }: { rows: VisibleDepeg[] }) {
  return (
    <ul className="space-y-0.5">
      {rows.map((d) => (
        <li key={d.key} className="text-xs text-muted-foreground">
          {d.symbol}: {d.bps > 0 ? "+" : ""}
          {d.bps} bps {d.direction ? `${d.direction} peg` : "off peg"}
          {d.mcapUsd != null ? ` (${formatCurrency(d.mcapUsd)})` : ""}
          {d.currentAvailable ? ` (historical peak ${d.peakBps} bps)` : " (historical peak; current unavailable)"}
        </li>
      ))}
    </ul>
  );
}

function ActiveDepegsCard({
  inputData,
  depegEvents,
}: {
  inputData: DigestSnapshotInputData;
  depegEvents: DigestSnapshotResponse["depegEvents"];
}) {
  const { count, rows } = getCapturedDepegs(inputData);
  const dayRows: VisibleDepeg[] = depegEvents.slice(0, 5).map((depeg) => ({
    key: `${depeg.stablecoinId}-${depeg.startedAt}`,
    symbol: depeg.symbol,
    bps: depeg.peakDeviationBps,
    direction: depeg.direction,
    mcapUsd: null,
    peakBps: depeg.peakDeviationBps,
    currentAvailable: false,
  }));
  if (count === 0 && dayRows.length === 0) return null;
  return (
    <SnapshotCard
      title="Active Depegs"
      icon={<TriangleAlert className="h-4 w-4" aria-hidden="true" />}
    >
      {count == null ? (
        <p className="text-sm text-muted-foreground">Active depeg count unavailable for this edition</p>
      ) : count > 0 ? (
        <>
          <p className="text-sm text-foreground/90">
            <span className="font-medium">{count}</span>{" "}
            active depeg{count !== 1 ? "s" : ""} at publication
          </p>
          {rows.length > 0 && <DepegRowList rows={rows} />}
        </>
      ) : (
        <p className="text-sm text-foreground/90">No active depegs at publication</p>
      )}
      {dayRows.length > 0 && (
        <div className="space-y-0.5 border-t border-border/40 pt-1.5">
          <p className="text-xs font-medium text-foreground/80">
            Episodes active at any point this day
          </p>
          <DepegRowList rows={dayRows} />
          <p className="text-[11px] text-muted-foreground/80">
            Day-overlap sample from the archive query, not this edition&rsquo;s count.
          </p>
        </div>
      )}
    </SnapshotCard>
  );
}

/* ---------- main component ---------- */

export function DigestSnapshot({ date }: { date: string }) {
  return (
    <LazySection minHeight={480} rootMargin="0px" placeholder={<Skeleton className="mt-8 h-[480px] w-full rounded-xl" />}>
      <DigestSnapshotContent date={date} />
    </LazySection>
  );
}

function DigestSnapshotContent({ date }: { date: string }) {
  // A dated snapshot is immutable: a failed refetch never withdraws retained inputData.
  const { data, isLoading } = useDigestSnapshot(date);

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

  if (!data?.inputData) {
    return <SnapshotUnavailable />;
  }

  const { inputData, prevInputData, comparison, depegEvents, blacklistEvents, blacklistSummary } = data;
  const prev = prevInputData ?? undefined;
  const coverage = inputData.supplyCoverage;
  const totalMcapUsd = coverage?.observedCount === 0 ? null : inputData.totalMcapUsd ?? null;
  // Archived snapshots may still list operational advisories; keep investment warnings only.
  const investmentYieldAnomalies = (inputData.yieldAnomalies ?? []).flatMap((anomaly) => {
    const warnings = selectInvestmentWarningSignals(anomaly.warnings);
    return warnings.length === 0 ? [] : [{ ...anomaly, warnings }];
  });
  const mcap7dCoverage = inputData.mcap7dDeltaCoverage;
  const mcap7dDelta = mcap7dCoverage && mcap7dCoverage.coveredCoins > 0 ? inputData.mcap7dDelta ?? null : null;
  const prevTotalMcapUsd = prev?.totalMcapUsd ?? null;
  const mcapDelta = comparison?.supplyComparable && totalMcapUsd != null && prevTotalMcapUsd != null
    ? totalMcapUsd - prevTotalMcapUsd : null;
  const coveredMcapUsd = mcap7dCoverage?.coveredMcapUsd;
  const mcap7dPercent = coveredMcapUsd != null && mcap7dDelta != null && coveredMcapUsd - mcap7dDelta > 0
    ? formatPercentChange(coveredMcapUsd, coveredMcapUsd - mcap7dDelta) : null;

  return (
    <section className="mt-8 space-y-4 animate-in fade-in duration-300">
      <p className="pharos-kicker">
        The data behind this digest
      </p>

      <DigestIntelligencePanel
        changeSummary={inputData.changeSummary}
        nextTriggers={inputData.nextTriggers}
        forwardLookOutcomes={inputData.forwardLookOutcomes}
        standingConditions={inputData.standingConditions}
        riskTape={inputData.riskTape}
      />

      <DigestSafetyMapCard inputData={inputData} />

      <div className="grid gap-3 sm:grid-cols-2">
        {/* 1. Market Snapshot — always shown */}
        <SnapshotCard
          title="Market Snapshot"
          icon={<BarChart3 className="h-4 w-4" aria-hidden="true" />}
        >
          <p className="text-sm text-foreground/90">
            {coverage?.complete && coverage.observedCount > 0 ? "Total mcap" : "Known mcap subtotal"}:{" "}
            {totalMcapUsd == null ? (
              <span className="text-muted-foreground">Not captured for this edition</span>
            ) : (
              <>
                <span className="font-medium">
                  {formatCurrency(totalMcapUsd)}
                </span>
                {" "}{coverage
                  ? `(${coverage.observedCount}/${coverage.observedCount + coverage.unavailableCount} coins observed)`
                  : "(coverage unproven)"}
              </>
            )}
            {mcapDelta != null && (
              <span className={getNetColor(mcapDelta)}>
                {" "}({mcapDelta >= 0 ? "+" : ""}
                {formatCurrency(mcapDelta)} from {comparison?.fromDate} to {comparison?.toDate})
              </span>
            )}
          </p>
          <p className="text-sm text-muted-foreground">
            7d matched-cohort change:{" "}
            {mcap7dDelta == null ? (
              <span>—</span>
            ) : (
              <>
                <span className={`font-medium ${getNetColor(mcap7dDelta)}`}>
                  {formatCurrency(mcap7dDelta)}
                </span>
                {mcap7dPercent != null && (
                  <span className={getNetColor(mcap7dDelta)}>
                    {" "}
                    ({mcap7dPercent})
                  </span>
                )}
              </>
            )}
          </p>
        </SnapshotCard>

        {/* 2. Stability Index */}
        {inputData.stabilityIndex && (
          <SnapshotCard
            title="Stability Index"
            icon={<Activity className="h-4 w-4" aria-hidden="true" />}
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
              <span className={`font-medium ${getNetColor(inputData.biggestSupplyChange.changeUsd)}`}>
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
        <ActiveDepegsCard inputData={inputData} depegEvents={depegEvents} />

        {/* 5. Blacklist Activity — spans full width since it's a list */}
        {blacklistEvents.length > 0 && (
          <div className="sm:col-span-2">
            <SnapshotCard
              title="Blacklist Activity"
              icon={<ShieldBan className="h-4 w-4" aria-hidden="true" />}
            >
              <p className="text-sm text-foreground/90">
                {blacklistSummary ? (
                  <>
                    <span className="font-medium">{blacklistSummary.totalEvents}</span>{" "}
                    event{blacklistSummary.totalEvents !== 1 ? "s" : ""} on this day
                    <span className="text-muted-foreground">
                      {blacklistSummary.knownAmountUsd === null
                        ? "; USD valuation unavailable"
                        : blacklistSummary.unavailableAmountEvents > 0
                          ? `; known subtotal ${formatCurrency(blacklistSummary.knownAmountUsd)} (${blacklistSummary.unavailableAmountEvents} unvalued)`
                          : ` totaling ${formatCurrency(blacklistSummary.knownAmountUsd)}`}
                    </span>
                  </>
                ) : (
                  <span>Daily event count and valuation unavailable</span>
                )}
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
              <p className="text-xs text-muted-foreground mt-1">
                Showing latest {Math.min(5, blacklistEvents.length)} of{" "}
                {blacklistSummary?.totalEvents ?? "unknown total"} events
              </p>
            </SnapshotCard>
          </div>
        )}

        {/* 6. Safety Scores */}
        {inputData.safetyScores && (
          <SnapshotCard
            title="Safety Scores"
            icon={<Shield className="h-4 w-4" aria-hidden="true" />}
          >
            {inputData.safetyScores.model === "v9" ? (
              <>
                {inputData.safetyScores.mentionedCoins.length > 0 && (
                  <ul className="space-y-1">
                    {inputData.safetyScores.mentionedCoins.map((coin, index, coins) => {
                      const partial = describePartialEvidence(coin);
                      return (
                      // Symbols are not unique (several USDA coins), so the row keys by position.
                      <li key={`${coin.symbol}-${index}`} className="text-xs text-foreground/90">
                        <span className="font-medium">{coin.symbol}</span>
                        {coins.filter((other) => other.symbol === coin.symbol).length > 1 && typeof coin.name === "string" ? (
                          <span className="text-muted-foreground"> ({coin.name})</span>
                        ) : null}
                        :{" "}
                        <span className="font-medium">{coin.grade === null ? "Pipeline gap" : coin.grade}</span>{" "}
                        <span className="text-muted-foreground">
                          ({formatDigestScore(coin.score)}; backing {formatDigestScore(coin.pillars.backing.score)},{" "}
                          exit {formatDigestScore(coin.pillars.exit.score)}, control {formatDigestScore(coin.pillars.control.score)})
                        </span>
                        {partial ? (
                          <span className="block text-muted-foreground" title={partial.summary}>
                            {partial.gaps.map(formatPartialEvidenceGap).join(" · ")}
                          </span>
                        ) : null}
                        {coin.bindingCap && (
                          <span className="block text-muted-foreground">
                            {humanizeSafetyScoreV9Value(coin.bindingCap.kind)} cap at {coin.bindingCap.limit}: {coin.bindingCap.reason}
                          </span>
                        )}
                        {coin.reasonCodes.length > 0 && (
                          <span className="block text-muted-foreground">
                            {coin.reasonCodes.map(formatV9ReasonCodeLabel).join(" · ")}
                          </span>
                        )}
                      </li>
                    ); })}
                  </ul>
                )}
                <p className="text-xs text-muted-foreground">
                  V{inputData.safetyScores.provenance.methodologyVersion.replace(/^v/i, "").split(".")[0]} distribution:{" "}
                  {Object.entries(inputData.safetyScores.gradeDistribution)
                    .map(([grade, count]) => `${grade} ${count}`)
                    .join(", ")}
                </p>
              </>
            ) : (
              <>
                {inputData.safetyScores.mentionedCoins.length > 0 && (
                  <ul className="space-y-0.5">
                    {inputData.safetyScores.mentionedCoins.map((coin, index) => (
                      <li key={`${coin.symbol}-${index}`} className="text-xs text-foreground/90">
                        <span className="font-medium">{coin.symbol}</span>:{" "}
                        <span className="font-medium">{coin.grade ?? "n/a"}</span>{" "}
                        <span className="text-muted-foreground">
                          ({formatDigestScore(coin.score)}
                          {coin.peg != null && `, peg ${formatDigestScore(coin.peg)}`}
                          {coin.liq != null && `, liquidity ${formatDigestScore(coin.liq)}`})
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
              </>
            )}
          </SnapshotCard>
        )}

        {/* 7. Yield Anomalies */}
        {investmentYieldAnomalies.length > 0 && (
          <SnapshotCard title="Yield Anomalies" icon={<TrendingUp className="h-4 w-4" aria-hidden="true" />}>
            {investmentYieldAnomalies.map((y, index) => (
              <div key={`${y.symbol}-${index}`} className="flex items-baseline justify-between gap-2 text-sm">
                <span className="font-mono font-medium">{y.symbol}</span>
                <span className="text-muted-foreground">
                  {y.currentApy.toFixed(2)}% APY (7d: {y.apy7d.toFixed(2)}%, 30d: {y.apy30d.toFixed(2)}%)
                </span>
                <span className="text-xs text-amber-600 dark:text-amber-400">
                  {y.warnings.map(formatYieldWarningSignal).join(" · ")}
                </span>
              </div>
            ))}
          </SnapshotCard>
        )}

        {/* 8. Liquidity Shifts */}
        {inputData.liquidityShifts && inputData.liquidityShifts.length > 0 && (
          <SnapshotCard title="DEX Liquidity Shifts" icon={<BarChart3 className="h-4 w-4" aria-hidden="true" />}>
            {inputData.liquidityShifts.map((l, index) => (
              <div key={`${l.symbol}-${index}`} className="flex items-baseline justify-between gap-2 text-sm">
                <span className="font-mono font-medium">{l.symbol}</span>
                <span className={getNetColor(l.scoreDelta)}>
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
          >
            <ul className="space-y-0.5">
              {inputData.supplyVelocity.map((v) => (
                <li key={v.coin} className="text-xs text-foreground/90">
                  <span className="font-medium">{v.coin}</span>:{" "}
                  <span className={getNetColor(v.change1d)}>
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
          >
            <ul className="space-y-0.5">
              {inputData.resolvedDepegs.map((r) => (
                <li key={`${r.symbol}-${r.peakBps}`} className="text-xs text-foreground/90">
                  <span className="font-medium">{r.symbol}</span>{" "}
                  recovered from {r.peakBps.toLocaleString("en-US")} bps after {r.durationHours}h{" "}
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
