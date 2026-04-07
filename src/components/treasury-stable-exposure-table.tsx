"use client";

import { useMemo, useState } from "react";
import { GradeBadge } from "@/components/grade-badge";
import { StablecoinLogo } from "@/components/stablecoin-logo";
import type { TreasuryStableExposureResponse } from "@shared/types";
import { ChevronDown, ChevronUp, ExternalLink } from "lucide-react";
import {
  type TreasuryExposureSortKey,
  TREASURY_SORT_OPTIONS,
  formatTreasuryUsd,
  formatTreasuryUsdNullable,
  isTreasuryComparableEntity,
  denominatorStatusLabel,
  denominatorStatusClassName,
  coverageSummary,
  sortTreasuryExposureEntities,
} from "@/lib/treasury-table-utils";
import { getTreasuryDebankProfiles } from "@/lib/treasury-debank";
import { formatPercent } from "@shared/lib/format";

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
    (row) => isTreasuryComparableEntity(row) && (row.decentralizedStablePctOfTreasury ?? 0) >= 5,
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
            {TREASURY_SORT_OPTIONS.map((option) => (
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
          const debankProfiles = getTreasuryDebankProfiles(entity.slug);

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
                          {isTreasuryComparableEntity(entity) && (entity.decentralizedStablePctOfTreasury ?? 0) >= 5 ? (
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
                        <div className="mt-1 text-sm font-medium text-foreground">{formatTreasuryUsd(entity.decentralizedStableUsd)}</div>
                      </div>
                      <div>
                        <div className="uppercase tracking-[0.16em]">% Treasury</div>
                        <div className="mt-1 text-sm font-medium text-foreground">{formatPercent(entity.decentralizedStablePctOfTreasury, 1)}</div>
                      </div>
                      <div>
                        <div className="uppercase tracking-[0.16em]">% Stable Sleeve</div>
                        <div className="mt-1 text-sm font-medium text-foreground">{formatPercent(entity.decentralizedStablePctOfStableSleeve, 1)}</div>
                      </div>
                      <div>
                        <div className="uppercase tracking-[0.16em]">Tracked Sleeve</div>
                        <div className="mt-1 text-sm font-medium text-foreground">{formatTreasuryUsd(entity.trackedStableUsd)}</div>
                      </div>
                    </div>
                  </div>

                  <div className="hidden text-sm font-medium text-foreground md:block">{formatTreasuryUsd(entity.decentralizedStableUsd)}</div>
                  <div className="hidden text-sm text-foreground md:block">{formatPercent(entity.decentralizedStablePctOfTreasury, 1)}</div>
                  <div className="hidden text-sm text-foreground md:block">{formatPercent(entity.decentralizedStablePctOfStableSleeve, 1)}</div>
                  <div className="hidden text-sm text-foreground md:block">{formatTreasuryUsd(entity.trackedStableUsd)}</div>
                  <div className="hidden md:block">
                    <GradeBadge
                      grade={entity.weightedSafetyGrade ?? "NR"}
                      score={entity.weightedSafetyScore}
                    />
                  </div>
                  <div className="hidden min-w-0 md:block">
                    <div className="truncate text-sm text-foreground">{coverageSummary(entity)}</div>
                    <div className="mt-1 text-xs text-muted-foreground">
                      {entity.coverage.untrackedStableUsd > 0 ? `${formatTreasuryUsd(entity.coverage.untrackedStableUsd)} untracked stable` : "No untracked stable detected"}
                    </div>
                  </div>
                </div>
              </button>

              {isExpanded ? (
                <div className="border-t border-border/60 bg-muted/10 px-4 py-4">
                  <div className="grid gap-4 lg:grid-cols-[1.3fr_0.7fr]">
                    <div className="space-y-3">
                      <div className="flex flex-wrap items-center gap-3 text-xs text-muted-foreground">
                        <span>Direct wallet total {formatTreasuryUsd(entity.directWalletUsd)}</span>
                        <span>Effective treasury denominator {formatTreasuryUsdNullable(entity.treasuryUsd)}</span>
                        <span>Stable sleeve {formatTreasuryUsd(entity.stablecoinSleeveUsd)}</span>
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
                              <div className="text-sm font-medium text-foreground">{formatTreasuryUsd(holding.usdValue)}</div>
                              <div>
                                {formatPercent(holding.pctOfTreasury, 1)} of treasury · {formatPercent(holding.pctOfStableSleeve, 1)} of sleeve
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
                          <div className="mt-1 text-sm font-medium text-foreground">{formatTreasuryUsd(entity.coverage.defiPositionUsd)}</div>
                        </div>
                        <div>
                          <div className="uppercase tracking-[0.16em]">Tracked / Treasury</div>
                          <div className="mt-1 text-sm font-medium text-foreground">{formatPercent(entity.coverage.trackedStablePctOfTreasury, 1)}</div>
                        </div>
                        <div>
                          <div className="uppercase tracking-[0.16em]">Rated / Tracked</div>
                          <div className="mt-1 text-sm font-medium text-foreground">{formatPercent(entity.coverage.ratedTrackedStablePct, 1)}</div>
                        </div>
                        <div>
                          <div className="uppercase tracking-[0.16em]">Consumed Direct</div>
                          <div className="mt-1 text-sm font-medium text-foreground">{formatTreasuryUsd(entity.coverage.consumedDirectBalanceUsd)}</div>
                        </div>
                        <div>
                          <div className="uppercase tracking-[0.16em]">Derived Untracked</div>
                          <div className="mt-1 text-sm font-medium text-foreground">{formatTreasuryUsd(entity.coverage.derivedUntrackedStableUsd)}</div>
                        </div>
                        <div>
                          <div className="uppercase tracking-[0.16em]">Skipped Derived</div>
                          <div className="mt-1 text-sm font-medium text-foreground">{entity.coverage.skippedDerivedPositionCount}</div>
                        </div>
                      </div>
                      <div>
                        <div className="text-xs uppercase tracking-[0.18em] text-muted-foreground">DeBank</div>
                        {debankProfiles.length > 0 ? (
                          <div className="mt-2 flex flex-wrap gap-2">
                            {debankProfiles.map((profile) => (
                              <a
                                key={profile.address.toLowerCase()}
                                href={profile.href}
                                target="_blank"
                                rel="noreferrer"
                                className="pharos-focus-ring inline-flex items-center gap-2 rounded-full border border-border/70 bg-muted/20 px-3 py-1.5 text-xs text-foreground transition-colors hover:bg-muted/35"
                              >
                                <span>{profile.chainLabel}</span>
                                <span className="font-mono text-[11px] text-muted-foreground">{profile.displayAddress}</span>
                                <ExternalLink className="h-3 w-3 text-muted-foreground" aria-hidden="true" />
                              </a>
                            ))}
                          </div>
                        ) : (
                          <p className="mt-2 text-xs text-muted-foreground">
                            No reviewed Debank wallet links are configured for this treasury yet.
                          </p>
                        )}
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
