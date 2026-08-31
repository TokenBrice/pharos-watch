"use client";

import { Skeleton } from "@/components/ui/skeleton";
import { DigestIntelligencePanel } from "@/components/digest-intelligence";
import { useDigestSnapshot } from "@/hooks/api-hooks";
import { useImageUnavailable } from "@/hooks/use-image-unavailable";
import { formatCurrency, formatAddress, formatPercentChange, formatScore, getNetColor } from "@shared/lib/format";
import { PSI_BAND_CLASSES, type ConditionBand } from "@shared/lib/psi-colors";
import type { DigestSnapshotInputData, DigestSnapshotResponse } from "@shared/types";
import { Activity, ArrowDownUp, BarChart3, CheckCircle, ImageOff, Shield, ShieldBan, TrendingUp, TriangleAlert } from "lucide-react";
import { formatDigestDateLabel } from "@/lib/digest";

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

type StoredSafetyMapTier = {
  tier: "A" | "B" | "C" | "D" | "F";
  count: number;
  mcapUsd: number;
  sharePct: number;
};

type StoredSafetyMap = {
  imageUrl: string;
  freshness: "current" | "carried-forward";
  ageDays: number | null;
  manifest: {
    date: string;
    mapSummary: {
      date: string;
      asOfSec: number;
      methodologyVersion: string;
      gradedCount: number;
      notRatedCount: number;
      totalMcapUsd: number;
      tiers: StoredSafetyMapTier[];
    };
  };
};

const SAFETY_MAP_TIERS = ["A", "B", "C", "D", "F"] as const;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function isNonNegativeFinite(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value) && value >= 0;
}

function isUtcDate(value: unknown): value is string {
  if (typeof value !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  const date = new Date(`${value}T00:00:00Z`);
  return Number.isFinite(date.getTime()) && date.toISOString().slice(0, 10) === value;
}

function parseStoredSafetyMap(inputData: DigestSnapshotInputData): StoredSafetyMap | null {
  const input = isRecord(inputData) ? inputData : null;
  const rawMap = input?.safetyMap;
  if (!isRecord(rawMap)) return null;

  const manifest = isRecord(rawMap.manifest) ? rawMap.manifest : null;
  const date = manifest?.date;
  const imageUrl = rawMap.imageUrl;
  const freshness = rawMap.freshness;
  const ageDays = rawMap.ageDays;
  if (
    !isUtcDate(date)
    || typeof imageUrl !== "string"
    || imageUrl.trim().length === 0
    || (freshness !== "current" && freshness !== "carried-forward")
    || (ageDays !== undefined && (!isNonNegativeFinite(ageDays) || !Number.isInteger(ageDays)))
  ) {
    return null;
  }

  let parsedUrl: URL;
  try {
    parsedUrl = new URL(imageUrl, "https://pharos.watch");
  } catch {
    return null;
  }
  if (
    !parsedUrl.pathname.endsWith("/safety-scores/map.png")
    || parsedUrl.searchParams.get("date") !== date
    || parsedUrl.searchParams.get("date") === "latest"
  ) {
    return null;
  }

  const rawSummary = manifest?.mapSummary ?? rawMap.mapSummary ?? rawMap.summary;
  if (!isRecord(rawSummary)) return null;
  const summaryDate = rawSummary.date;
  const asOfSec = rawSummary.asOfSec;
  const methodologyVersion = rawSummary.methodologyVersion;
  const gradedCount = rawSummary.gradedCount;
  const notRatedCount = rawSummary.notRatedCount;
  const totalMcapUsd = rawSummary.totalMcapUsd;
  const rawTiers = rawSummary.tiers;
  if (
    !isUtcDate(summaryDate)
    || summaryDate !== date
    || !isNonNegativeFinite(asOfSec)
    || !Number.isInteger(asOfSec)
    || typeof methodologyVersion !== "string"
    || methodologyVersion.trim().length === 0
    || !isNonNegativeFinite(gradedCount)
    || !Number.isInteger(gradedCount)
    || !isNonNegativeFinite(notRatedCount)
    || !Number.isInteger(notRatedCount)
    || !isNonNegativeFinite(totalMcapUsd)
    || totalMcapUsd <= 0
    || !Array.isArray(rawTiers)
    || rawTiers.length !== SAFETY_MAP_TIERS.length
  ) {
    return null;
  }

  const seen = new Set<StoredSafetyMapTier["tier"]>();
  const tiers: StoredSafetyMapTier[] = [];
  for (const rawTier of rawTiers) {
    if (!isRecord(rawTier)) return null;
    const tier = rawTier.tier;
    const count = rawTier.count;
    const mcapUsd = rawTier.mcapUsd;
    const sharePct = rawTier.sharePct;
    if (
      typeof tier !== "string"
      || !SAFETY_MAP_TIERS.includes(tier as StoredSafetyMapTier["tier"])
      || seen.has(tier as StoredSafetyMapTier["tier"])
      || !isNonNegativeFinite(count)
      || !Number.isInteger(count)
      || !isNonNegativeFinite(mcapUsd)
      || !isNonNegativeFinite(sharePct)
      || sharePct > 100
    ) {
      return null;
    }
    seen.add(tier as StoredSafetyMapTier["tier"]);
    tiers.push({ tier: tier as StoredSafetyMapTier["tier"], count, mcapUsd, sharePct });
  }
  if (!SAFETY_MAP_TIERS.every((tier) => seen.has(tier))) return null;
  if (tiers.reduce((sum, tier) => sum + tier.count, 0) !== gradedCount) return null;
  const mcapTolerance = Math.max(0.01, totalMcapUsd * 1e-9);
  if (Math.abs(tiers.reduce((sum, tier) => sum + tier.mcapUsd, 0) - totalMcapUsd) > mcapTolerance) return null;
  if (tiers.some((tier) => Math.abs((tier.mcapUsd / totalMcapUsd) * 100 - tier.sharePct) > 0.11)) return null;

  return {
    imageUrl,
    freshness,
    ageDays: typeof ageDays === "number" ? ageDays : null,
    manifest: {
      date,
      mapSummary: {
        date: summaryDate,
        asOfSec,
        methodologyVersion,
        gradedCount,
        notRatedCount,
        totalMcapUsd,
        tiers,
      },
    },
  };
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
  const map = parseStoredSafetyMap(inputData);
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
}

function getVisibleDepegs(
  inputData: DigestSnapshotInputData,
  depegEvents: DigestSnapshotResponse["depegEvents"],
): { count: number; rows: VisibleDepeg[] } {
  const inputTopDepegs = inputData.topDepegs ?? [];
  if (depegEvents.length > 0) {
    return {
      count: depegEvents.length,
      rows: depegEvents.slice(0, 5).map((depeg) => ({
        key: `${depeg.stablecoinId}-${depeg.startedAt}`,
        symbol: depeg.symbol,
        bps: depeg.peakDeviationBps,
        direction: depeg.direction,
        mcapUsd: null,
      })),
    };
  }
  return {
    count: inputData.activeDepegCount ?? inputTopDepegs.length,
    rows: inputTopDepegs.slice(0, 5).map((depeg) => ({
      key: `${depeg.stablecoinId ?? depeg.symbol}-${depeg.startedAt ?? depeg.bps}`,
      symbol: depeg.symbol,
      bps: depeg.bps,
      direction: depeg.direction ?? (depeg.bps >= 0 ? "above" : "below"),
      mcapUsd: depeg.mcapUsd,
    })),
  };
}

function ActiveDepegsCard({
  inputData,
  depegEvents,
}: {
  inputData: DigestSnapshotInputData;
  depegEvents: DigestSnapshotResponse["depegEvents"];
}) {
  const { count, rows } = getVisibleDepegs(inputData, depegEvents);
  if (count <= 0) return null;
  return (
    <SnapshotCard
      title="Active Depegs"
      icon={<TriangleAlert className="h-4 w-4" aria-hidden="true" />}
    >
      <p className="text-sm text-foreground/90">
        <span className="font-medium">{count}</span>{" "}
        active depeg{count !== 1 ? "s" : ""}
      </p>
      {rows.length > 0 && (
        <ul className="space-y-0.5">
          {rows.map((d) => (
            <li key={d.key} className="text-xs text-muted-foreground">
              {d.symbol}: {d.bps > 0 ? "+" : ""}
              {d.bps} bps {d.direction ? `${d.direction} peg` : "off peg"}
              {d.mcapUsd != null ? ` (${formatCurrency(d.mcapUsd)})` : ""}
            </li>
          ))}
        </ul>
      )}
    </SnapshotCard>
  );
}

/* ---------- main component ---------- */

export function DigestSnapshot({ date }: { date: string }) {
  const { data, isLoading, isError } = useDigestSnapshot(date);

  if (isError) {
    return <SnapshotUnavailable />;
  }

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

  const { inputData, prevInputData, depegEvents, blacklistEvents } = data;
  const prev = prevInputData ?? undefined;
  const totalMcapUsd = inputData.totalMcapUsd ?? 0;
  const mcap7dDelta = inputData.mcap7dDelta ?? 0;
  const prevTotalMcapUsd = prev?.totalMcapUsd;

  const mcapDelta = prevTotalMcapUsd != null ? totalMcapUsd - prevTotalMcapUsd : 0;

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
            Total mcap:{" "}
            <span className="font-medium">
              {formatCurrency(totalMcapUsd)}
            </span>
            {prevTotalMcapUsd != null && (
              <span className={getNetColor(mcapDelta)}>
                {" "}({mcapDelta >= 0 ? "+" : ""}
                {formatCurrency(mcapDelta)} from yesterday)
              </span>
            )}
          </p>
          <p className="text-sm text-muted-foreground">
            7d change:{" "}
            <span className={`font-medium ${getNetColor(mcap7dDelta)}`}>
              {formatCurrency(mcap7dDelta)}
            </span>
            {totalMcapUsd - mcap7dDelta !== 0 && (
              <span className={getNetColor(mcap7dDelta)}>
                {" "}
                ({formatPercentChange(
                  totalMcapUsd,
                  totalMcapUsd - mcap7dDelta
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
          >
            {inputData.safetyScores.model === "v9" ? (
              <>
                {inputData.safetyScores.mentionedCoins.length > 0 && (
                  <ul className="space-y-1">
                    {inputData.safetyScores.mentionedCoins.map((coin) => (
                      <li key={coin.symbol} className="text-xs text-foreground/90">
                        <span className="font-medium">{coin.symbol}</span>:{" "}
                        <span className="font-medium">{coin.grade}</span>{" "}
                        <span className="text-muted-foreground">
                          ({coin.score ?? "NR"}; backing={coin.pillars.backing.score ?? "NR"},{" "}
                          exit={coin.pillars.exit.score ?? "NR"}, control={coin.pillars.control.score ?? "NR"})
                        </span>
                        {coin.bindingCap && (
                          <span className="block text-muted-foreground">
                            Cap {coin.bindingCap.kind} at {coin.bindingCap.limit}: {coin.bindingCap.reason}
                          </span>
                        )}
                        {coin.reasonCodes.length > 0 && (
                          <span className="block text-muted-foreground">
                            {coin.reasonCodes.join(", ")}
                          </span>
                        )}
                      </li>
                    ))}
                  </ul>
                )}
                <p className="text-xs text-muted-foreground">
                  V9 distribution:{" "}
                  {Object.entries(inputData.safetyScores.gradeDistribution)
                    .map(([grade, count]) => `${grade} ${count}`)
                    .join(", ")}
                </p>
              </>
            ) : (
              <>
                {inputData.safetyScores.mentionedCoins.length > 0 && (
                  <ul className="space-y-0.5">
                    {inputData.safetyScores.mentionedCoins.map((coin) => (
                      <li key={coin.symbol} className="text-xs text-foreground/90">
                        <span className="font-medium">{coin.symbol}</span>:{" "}
                        <span className="font-medium">{coin.grade ?? "n/a"}</span>{" "}
                        <span className="text-muted-foreground">
                          ({coin.score ?? "n/a"}
                          {coin.peg != null && `, peg=${coin.peg}`}
                          {coin.liq != null && `, liq=${coin.liq}`})
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
        {inputData.yieldAnomalies && inputData.yieldAnomalies.length > 0 && (
          <SnapshotCard title="Yield Anomalies" icon={<TrendingUp className="h-4 w-4" aria-hidden="true" />}>
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
          <SnapshotCard title="DEX Liquidity Shifts" icon={<BarChart3 className="h-4 w-4" aria-hidden="true" />}>
            {inputData.liquidityShifts.map((l) => (
              <div key={l.symbol} className="flex items-baseline justify-between gap-2 text-sm">
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
