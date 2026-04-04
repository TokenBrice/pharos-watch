"use client";

import { useMemo, useState } from "react";
import { GradeBadge } from "@/components/grade-badge";
import { StablecoinLogo } from "@/components/stablecoin-logo";
import type { TreasuryStableExposureEntity, TreasuryStableExposureResponse } from "@shared/types";
import { ChevronDown, ChevronUp } from "lucide-react";

export type TreasuryExposureSortKey =
  | "decentralizedStableUsd"
  | "decentralizedStablePctOfTreasury"
  | "decentralizedStablePctOfStableSleeve"
  | "trackedStableUsd"
  | "weightedSafetyScore";

const SORT_OPTIONS: Array<{ value: TreasuryExposureSortKey; label: string }> = [
  { value: "decentralizedStableUsd", label: "Decentralized Stable $" },
  { value: "decentralizedStablePctOfTreasury", label: "Decentralized Stable % of Treasury" },
  { value: "decentralizedStablePctOfStableSleeve", label: "Decentralized Stable % of Stable Sleeve" },
  { value: "trackedStableUsd", label: "Tracked Stable Sleeve $" },
  { value: "weightedSafetyScore", label: "Weighted Stable Grade" },
];

const usdCompactFormatter = new Intl.NumberFormat("en-US", {
  style: "currency",
  currency: "USD",
  maximumFractionDigits: 0,
});

function formatUsd(value: number): string {
  return usdCompactFormatter.format(value);
}

function formatUsdNullable(value: number | null): string {
  return value == null ? "N/A" : formatUsd(value);
}

function formatPct(value: number | null): string {
  return value == null ? "N/A" : `${value.toFixed(1)}%`;
}

function hasComparableTreasuryDenominator(entity: TreasuryStableExposureEntity): boolean {
  return entity.treasuryUsd != null
    && (entity.coverage.denominatorStatus === "direct-only" || entity.coverage.denominatorStatus === "adjusted-with-defi");
}

function coverageSummary(entity: TreasuryStableExposureEntity): string {
  const trackedPct = entity.coverage.trackedStablePctOfStableSleeve;
  if (entity.coverage.denominatorStatus === "invalid") return "Invalid treasury denominator";
  if (entity.coverage.denominatorStatus === "partial") {
    return trackedPct == null
      ? "Stable sleeve detected, treasury share unavailable"
      : `Tracked ${trackedPct.toFixed(1)}% of sleeve, treasury share unavailable`;
  }
  if (trackedPct == null) return "No stable sleeve detected";
  return `Tracked ${trackedPct.toFixed(1)}% of stable sleeve`;
}

function denominatorStatusLabel(entity: TreasuryStableExposureEntity): string {
  switch (entity.coverage.denominatorStatus) {
    case "adjusted-with-defi":
      return "Treasury-comparable";
    case "partial":
      return "Partial denominator";
    case "invalid":
      return "Invalid denominator";
    case "direct-only":
    default:
      return "Direct-only denominator";
  }
}

function denominatorStatusClassName(entity: TreasuryStableExposureEntity): string {
  switch (entity.coverage.denominatorStatus) {
    case "adjusted-with-defi":
      return "border-emerald-500/40 bg-emerald-500/10 text-emerald-700 dark:text-emerald-300";
    case "partial":
      return "border-amber-500/40 bg-amber-500/10 text-amber-700 dark:text-amber-300";
    case "invalid":
      return "border-rose-500/40 bg-rose-500/10 text-rose-700 dark:text-rose-300";
    case "direct-only":
    default:
      return "border-border/70 bg-background/60 text-muted-foreground";
  }
}

function compareEntities(a: TreasuryStableExposureEntity, b: TreasuryStableExposureEntity, sortKey: TreasuryExposureSortKey): number {
  switch (sortKey) {
    case "decentralizedStablePctOfTreasury":
      return (b.decentralizedStablePctOfTreasury ?? -1) - (a.decentralizedStablePctOfTreasury ?? -1);
    case "decentralizedStablePctOfStableSleeve":
      return (b.decentralizedStablePctOfStableSleeve ?? -1) - (a.decentralizedStablePctOfStableSleeve ?? -1);
    case "trackedStableUsd":
      return b.trackedStableUsd - a.trackedStableUsd;
    case "weightedSafetyScore":
      return (b.weightedSafetyScore ?? -1) - (a.weightedSafetyScore ?? -1);
    case "decentralizedStableUsd":
    default:
      return b.decentralizedStableUsd - a.decentralizedStableUsd;
  }
}

function sortTreasuryExposureEntities(
  entities: readonly TreasuryStableExposureEntity[],
  sortKey: TreasuryExposureSortKey,
): TreasuryStableExposureEntity[] {
  return [...entities].sort((a, b) => {
    const sortDiff = compareEntities(a, b, sortKey);
    if (sortDiff !== 0) return sortDiff;
    return a.name.localeCompare(b.name);
  });
}

export function TreasuryStableExposureTable({
  data,
  logos,
}: {
  data: TreasuryStableExposureResponse;
  logos?: Record<string, string>;
}) {
  const [sortKey, setSortKey] = useState<TreasuryExposureSortKey>("decentralizedStableUsd");
  const [expandedSlug, setExpandedSlug] = useState<string | null>(null);

  const rows = useMemo(() => sortTreasuryExposureEntities(data.entities, sortKey), [data.entities, sortKey]);
  const aboveFivePctCount = rows.filter(
    (row) => hasComparableTreasuryDenominator(row) && (row.decentralizedStablePctOfTreasury ?? 0) >= 5,
  ).length;

  if (rows.length === 0) {
    return <p className="text-sm text-muted-foreground">Treasury stable exposure data is not available yet.</p>;
  }

  return (
    <div className="space-y-4">
      <div className="flex flex-col gap-3 md:flex-row md:items-end md:justify-between">
        <div className="space-y-1">
          <p className="text-sm text-muted-foreground">
            Onchain-only, EVM-first, and based on reviewed public treasury wallets.
          </p>
          <p className="text-xs text-muted-foreground">
            {data.coverage.comparableEntityCount} treasury-comparable rows and{" "}
            {data.coverage.partialEntityCount + data.coverage.invalidEntityCount} partial or invalid rows across{" "}
            {data.coverage.entityCount} launch entities from {data.coverage.registryCount} reviewed seeds.{" "}
            {aboveFivePctCount} comparable entities currently show at least 5% decentralized stable exposure versus treasury value.
          </p>
        </div>
        <label className="flex flex-col gap-1 text-xs text-muted-foreground">
          Sort by
          <select
            value={sortKey}
            onChange={(event) => setSortKey(event.target.value as TreasuryExposureSortKey)}
            className="pharos-focus-ring rounded-md border bg-background px-3 py-2 text-sm text-foreground outline-none"
          >
            {SORT_OPTIONS.map((option) => (
              <option key={option.value} value={option.value}>
                {option.label}
              </option>
            ))}
          </select>
        </label>
      </div>

      <div className="rounded-2xl border border-border/70 overflow-hidden">
        <div className="hidden grid-cols-[minmax(0,1.4fr)_0.8fr_0.8fr_0.8fr_0.8fr_0.9fr_1fr] gap-3 border-b border-border/70 bg-muted/20 px-4 py-3 text-[11px] font-medium uppercase tracking-[0.18em] text-muted-foreground md:grid">
          <div>Treasury</div>
          <div>DeFi Stable $</div>
          <div>% Treasury</div>
          <div>% Stable Sleeve</div>
          <div>Tracked Sleeve</div>
          <div>Stable Grade</div>
          <div>Coverage</div>
        </div>

        {rows.map((entity) => {
          const isExpanded = expandedSlug === entity.slug;
          const hasNotes = entity.coverage.notes.length > 0;

          return (
            <div key={entity.slug} className="border-b border-border/60 last:border-b-0">
              <button
                type="button"
                onClick={() => setExpandedSlug(isExpanded ? null : entity.slug)}
                className="pharos-focus-ring w-full px-4 py-4 text-left transition-colors hover:bg-muted/15"
                aria-expanded={isExpanded}
              >
                <div className="grid gap-3 md:grid-cols-[minmax(0,1.4fr)_0.8fr_0.8fr_0.8fr_0.8fr_0.9fr_1fr] md:items-center">
                  <div className="min-w-0">
                    <div className="flex items-start justify-between gap-3">
                      <div className="min-w-0">
                        <div className="truncate text-sm font-semibold text-foreground">{entity.name}</div>
                        <div className="mt-1 flex flex-wrap items-center gap-2 text-xs text-muted-foreground">
                          <span>{entity.category ?? "Treasury"}</span>
                          <span className="rounded-full border border-border/70 px-2 py-0.5">
                            {entity.coverage.extractionMode}
                          </span>
                          <span className={`rounded-full border px-2 py-0.5 ${denominatorStatusClassName(entity)}`}>
                            {denominatorStatusLabel(entity)}
                          </span>
                          {hasComparableTreasuryDenominator(entity) && (entity.decentralizedStablePctOfTreasury ?? 0) >= 5 ? (
                            <span className="rounded-full border border-emerald-500/40 bg-emerald-500/10 px-2 py-0.5 text-emerald-700 dark:text-emerald-300">
                              5%+ DeFi stable
                            </span>
                          ) : null}
                        </div>
                      </div>
                      <span className="shrink-0 text-muted-foreground md:hidden">
                        {isExpanded ? <ChevronUp className="h-4 w-4" /> : <ChevronDown className="h-4 w-4" />}
                      </span>
                    </div>
                    <div className="mt-3 grid grid-cols-2 gap-2 text-xs text-muted-foreground md:hidden">
                      <div>
                        <div className="uppercase tracking-[0.16em]">DeFi Stable $</div>
                        <div className="mt-1 text-sm font-medium text-foreground">{formatUsd(entity.decentralizedStableUsd)}</div>
                      </div>
                      <div>
                        <div className="uppercase tracking-[0.16em]">% Treasury</div>
                        <div className="mt-1 text-sm font-medium text-foreground">{formatPct(entity.decentralizedStablePctOfTreasury)}</div>
                      </div>
                      <div>
                        <div className="uppercase tracking-[0.16em]">% Stable Sleeve</div>
                        <div className="mt-1 text-sm font-medium text-foreground">{formatPct(entity.decentralizedStablePctOfStableSleeve)}</div>
                      </div>
                      <div>
                        <div className="uppercase tracking-[0.16em]">Tracked Sleeve</div>
                        <div className="mt-1 text-sm font-medium text-foreground">{formatUsd(entity.trackedStableUsd)}</div>
                      </div>
                    </div>
                  </div>

                  <div className="hidden text-sm font-medium text-foreground md:block">{formatUsd(entity.decentralizedStableUsd)}</div>
                  <div className="hidden text-sm text-foreground md:block">{formatPct(entity.decentralizedStablePctOfTreasury)}</div>
                  <div className="hidden text-sm text-foreground md:block">{formatPct(entity.decentralizedStablePctOfStableSleeve)}</div>
                  <div className="hidden text-sm text-foreground md:block">{formatUsd(entity.trackedStableUsd)}</div>
                  <div className="hidden md:block">
                    <GradeBadge
                      grade={entity.weightedSafetyGrade ?? "NR"}
                      score={entity.weightedSafetyScore}
                    />
                  </div>
                  <div className="hidden min-w-0 md:block">
                    <div className="truncate text-sm text-foreground">{coverageSummary(entity)}</div>
                    <div className="mt-1 text-xs text-muted-foreground">
                      {entity.coverage.untrackedStableUsd > 0 ? `${formatUsd(entity.coverage.untrackedStableUsd)} untracked stable` : "No untracked stable detected"}
                    </div>
                  </div>
                </div>
              </button>

              {isExpanded ? (
                <div className="border-t border-border/60 bg-muted/10 px-4 py-4">
                  <div className="grid gap-4 lg:grid-cols-[1.3fr_0.7fr]">
                    <div className="space-y-3">
                      <div className="flex flex-wrap items-center gap-3 text-xs text-muted-foreground">
                        <span>Direct wallet total {formatUsd(entity.directWalletUsd)}</span>
                        <span>Effective treasury denominator {formatUsdNullable(entity.treasuryUsd)}</span>
                        <span>Stable sleeve {formatUsd(entity.stablecoinSleeveUsd)}</span>
                        <span>Owner-chain tuples {entity.coverage.ownerChainCount}</span>
                      </div>
                      <div className="space-y-2">
                        {entity.holdings.map((holding) => (
                          <div key={holding.stablecoinId} className="flex items-center justify-between gap-3 rounded-xl border border-border/60 bg-background/70 px-3 py-2">
                            <div className="flex min-w-0 items-center gap-3">
                              <StablecoinLogo src={logos?.[holding.stablecoinId]} name={holding.name} size={20} />
                              <div className="min-w-0">
                                <div className="truncate text-sm font-medium text-foreground">{holding.name}</div>
                                <div className="text-xs text-muted-foreground">
                                  {holding.symbol} · {holding.governance}
                                </div>
                              </div>
                            </div>
                            <div className="text-right text-xs text-muted-foreground">
                              <div className="text-sm font-medium text-foreground">{formatUsd(holding.usdValue)}</div>
                              <div>
                                {formatPct(holding.pctOfTreasury)} of treasury · {formatPct(holding.pctOfStableSleeve)} of sleeve
                              </div>
                            </div>
                          </div>
                        ))}
                      </div>
                    </div>

                    <div className="space-y-3 rounded-xl border border-border/60 bg-background/70 p-4">
                      <div>
                        <div className="text-xs uppercase tracking-[0.18em] text-muted-foreground">Coverage</div>
                        <div className="mt-2 text-sm text-foreground">{coverageSummary(entity)}</div>
                      </div>
                      <div className="grid grid-cols-2 gap-3 text-xs text-muted-foreground">
                        <div>
                          <div className="uppercase tracking-[0.16em]">Denominator</div>
                          <div className="mt-1 text-sm font-medium text-foreground">{denominatorStatusLabel(entity)}</div>
                        </div>
                        <div>
                          <div className="uppercase tracking-[0.16em]">DeFi Included</div>
                          <div className="mt-1 text-sm font-medium text-foreground">{formatUsd(entity.coverage.defiPositionUsd)}</div>
                        </div>
                        <div>
                          <div className="uppercase tracking-[0.16em]">Tracked / Treasury</div>
                          <div className="mt-1 text-sm font-medium text-foreground">{formatPct(entity.coverage.trackedStablePctOfTreasury)}</div>
                        </div>
                        <div>
                          <div className="uppercase tracking-[0.16em]">Rated / Tracked</div>
                          <div className="mt-1 text-sm font-medium text-foreground">{formatPct(entity.coverage.ratedTrackedStablePct)}</div>
                        </div>
                        <div>
                          <div className="uppercase tracking-[0.16em]">Consumed Direct</div>
                          <div className="mt-1 text-sm font-medium text-foreground">{formatUsd(entity.coverage.consumedDirectBalanceUsd)}</div>
                        </div>
                        <div>
                          <div className="uppercase tracking-[0.16em]">Derived Untracked</div>
                          <div className="mt-1 text-sm font-medium text-foreground">{formatUsd(entity.coverage.derivedUntrackedStableUsd)}</div>
                        </div>
                        <div>
                          <div className="uppercase tracking-[0.16em]">Skipped Derived</div>
                          <div className="mt-1 text-sm font-medium text-foreground">{entity.coverage.skippedDerivedPositionCount}</div>
                        </div>
                      </div>
                      {hasNotes ? (
                        <ul className="space-y-2 text-xs text-muted-foreground">
                          {entity.coverage.notes.map((note) => (
                            <li key={note} className="rounded-lg border border-border/60 bg-muted/20 px-3 py-2">
                              {note}
                            </li>
                          ))}
                        </ul>
                      ) : (
                        <p className="text-xs text-muted-foreground">No additional coverage notes for this treasury.</p>
                      )}
                    </div>
                  </div>
                </div>
              ) : null}
            </div>
          );
        })}
      </div>
    </div>
  );
}
