"use client";

import { useEffect, useMemo } from "react";
import Image from "next/image";
import { useRouter } from "next/navigation";
import { useChains } from "@/hooks/use-chains";
import { useSort } from "@/hooks/use-sort";
import { TableCell } from "@/components/table";
import { DataTableShell, type DataTableColumn, type DataTableSortControls } from "@/components/data-table-shell";
import { InteractiveTableRow } from "@/components/interactive-table-row";
import { SectionErrorBoundary } from "@/components/section-error-boundary";
import { QueryFreshnessNotices } from "@/components/query-freshness-notices";
import { QueryErrorNotice } from "@/components/query-error-notice";
import { Skeleton } from "@/components/ui/skeleton";
import { cn } from "@/lib/utils";
import { formatChainShare, trendColor } from "@/lib/chain-ui";
import { formatEventTimestamp } from "@/lib/depeg-event-display";
import { formatCompactUsd, formatSignedPercent } from "@shared/lib/format";
import { harborFlag, isSupplyRetained, type HarborSceneInput } from "@shared/lib/harbor-scene";
import type { ApiMeta } from "@/lib/api";
import { FeatureHeroSplit, HeroMetricRow } from "@/components/feature-hero-split";
import { OpsStatusChip } from "@/components/ops-status-chip";
import { UniverseChip } from "@/components/universe-chip";
import { ChainTypeBadge } from "@/components/chain-type-badge";
import { CHAIN_META } from "@shared/types/chain-identity";
import { StablecoinLogo } from "@/components/stablecoin-logo";
import { getLogoSrc, logosById } from "@/lib/logos";
import { resolveCompactLogoSrc } from "@/lib/logo-variants";
import { usePrefersReducedMotion } from "@/hooks/use-prefers-reduced-motion";
import { HarborHero } from "@/components/harbor/harbor-hero";
import { HarborSelectionProvider, useHarborSelection } from "@/components/harbor/harbor-selection-context";
import type { ChainSummary, ChainsResponse } from "@shared/types/chains";
import { sortChains, type ChainSortKey } from "./chain-model";
import { DominanceBreakdown } from "./dominance-breakdown";
import { ChainsFreshnessChip } from "./freshness-chip";
import { HealthBadge } from "./health-badge";

// Supply sits beside Chain so a phone shows the ranking key before the swipe.
const CHAIN_COLUMNS: readonly DataTableColumn<ChainSortKey>[] = [
  { id: "rank", label: "#", className: "w-[40px] text-right" },
  { id: "chain", label: "Chain" },
  { id: "supply", label: "Supply", sortKey: "totalUsd", className: "text-right" },
  { id: "health", label: "Health", sortKey: "healthScore" },
  { id: "change7d", label: "7d", sortKey: "change7dPct", className: "text-right", title: "7-day supply change" },
  { id: "globalShare", label: "Global share", sortKey: "dominanceShare", className: "text-right" },
  { id: "stablecoins", label: "Stablecoins", sortKey: "stablecoinCount", className: "text-right" },
  { id: "dominant", label: "Dominant", className: "hidden lg:table-cell" },
] as const;

export function ChainsLeaderboardClient() {
  const { data, isLoading, isError, error, refetch, dataUpdatedAt, meta } = useChains();
  const { sortKey, sortDirection, toggleSort, getAriaSortValue } = useSort<ChainSortKey>("totalUsd", "desc");
  const chains = data?.chains;

  const sorted = useMemo(() => {
    if (!chains) return [];
    return sortChains(chains, sortKey, sortDirection);
  }, [chains, sortKey, sortDirection]);

  const chainIds = useMemo(() => (chains ?? []).map((chain) => chain.id), [chains]);
  // `src/lib/api.ts` moves the body's `_meta` into `meta`; Harbor's flag and retained state read it from the input.
  const harborInput = useMemo<HarborSceneInput | null>(
    () => (data ? { ...data, _meta: meta ?? undefined } : null),
    [data, meta],
  );

  if (isLoading) {
    return (
      <div className="space-y-6">
        <div className="pharos-card-shell space-y-4 p-5 sm:p-6 lg:p-7">
          <div className="flex flex-wrap items-end justify-between gap-4">
            <div>
              <Skeleton className="h-4 w-64" />
              <Skeleton className="mt-3 h-10 w-36" />
              <Skeleton className="mt-3 h-6 w-48 rounded-full" />
            </div>
            <div className="w-full max-w-md space-y-3">
              {Array.from({ length: 3 }).map((_, i) => (
                <Skeleton key={i} className="h-5 w-full" />
              ))}
            </div>
          </div>
          <Skeleton className="h-3 w-full rounded-full" />
          <div className="flex gap-4">
            {Array.from({ length: 5 }).map((_, i) => (
              <Skeleton key={i} className="h-4 w-20" />
            ))}
          </div>
        </div>
        {/* the harbor's box at its drawn aspect (wide plan / phone portrait), so the scene lands without a shift */}
        <Skeleton className="aspect-[1/2.1] w-full rounded-lg min-[761px]:aspect-[2.6/1]" />
        <div className="pharos-table-shell">
          {Array.from({ length: 10 }).map((_, i) => (
            <Skeleton key={i} className="mx-3 my-2.5 h-8 rounded-sm" />
          ))}
        </div>
      </div>
    );
  }
  if (isError && !data) {
    return (
      <QueryErrorNotice
        error={error}
        onRetry={() => {
          void refetch();
        }}
      />
    );
  }
  if (!data || !harborInput) return null;
  // the stamp dates the supply generation: it reads retained on the same rule as Harbor's scene, not on Chain Health lag
  const retained = isError || isSupplyRetained(harborInput._meta);

  return (
    <SectionErrorBoundary name="Chains">
      <HarborSelectionProvider chainIds={chainIds}>
        <div className="space-y-6">
          <QueryFreshnessNotices
            error={error}
            hasData={!!data?.chains?.length}
            onRetry={() => {
              void refetch();
            }}
            queries={[{ preset: "chains", dataUpdatedAt, error, hasData: !!data?.chains?.length, meta }]}
            // Degraded or stale data is the hero's status chip; the body only reports a hard error.
            showFreshnessBanner={false}
          />

          <ChainsHero data={data} meta={meta} retained={retained} />

          <HarborHero data={harborInput} retainedAfterError={isError} />

          <ChainsLeaderboardTable
            data={harborInput}
            sorted={sorted}
            sort={{ sortKey, sortDirection, toggleSort, getAriaSortValue }}
          />
        </div>
      </HarborSelectionProvider>
    </SectionErrorBoundary>
  );
}

const REGISTERED_CHAIN_COUNT = Object.keys(CHAIN_META).length;
const PARTIAL_CHAIN_NAME_LIMIT = 4;

function utcStamp(seconds: number): string {
  const d = new Date(seconds * 1000);
  return `${String(d.getUTCHours()).padStart(2, "0")}:${String(d.getUTCMinutes()).padStart(2, "0")} UTC`;
}

/**
 * One Beam hero: the largest chain's share of observed global supply (max `dominanceShare`, never a hard-coded
 * chain), the snapshot stamp, and the neutral dominance bar as the single visual. Partial inputs are named on the
 * beam label and carried, with both excluded counts, by the status chip.
 */
export function ChainsHero({ data, meta, retained }: { data: ChainsResponse; meta: ApiMeta | null | undefined; retained: boolean }) {
  const byShare = data.chains.every((chain) => chain.dominanceShare != null)
    ? [...data.chains].sort((a, b) => b.dominanceShare! - a.dominanceShare!)
    : [];
  const [first, second] = byShare;
  const topBySupply = [...data.chains].sort((a, b) => b.totalUsd - a.totalUsd).slice(0, 5);
  const coverage = data.supplyCoverage;
  const excludedAssets = coverage?.aggregateUnavailableAssetCount ?? 0;
  const excludedObservations = coverage?.chainUnavailableObservationCount ?? 0;
  const partial = excludedAssets > 0 || excludedObservations > 0;
  const change7dPct = data.globalChange7dPct;
  const stamp = retained ? `Retained · as of ${formatEventTimestamp(data.updatedAt, true)}` : `as of ${utcStamp(data.updatedAt)}`;

  const partialChainNames = (coverage?.chainIdsWithUnavailableObservations ?? []).map(
    (id) => data.chains.find((chain) => chain.id === id)?.name ?? CHAIN_META[id]?.name ?? id,
  );
  const coverageChip = partial ? (
    <OpsStatusChip
      label="Partial coverage"
      reasonCodes={[
        ...(excludedAssets > 0 ? ["aggregate-unavailable-assets"] : []),
        ...(excludedObservations > 0 ? ["chain-unavailable-observations"] : []),
      ]}
    >
      {excludedAssets > 0 ? (
        <p>
          {excludedAssets} {excludedAssets === 1 ? "asset" : "assets"} had no usable supply this run and{" "}
          {excludedAssets === 1 ? "is" : "are"} excluded from global supply, so the total is a known subtotal.
        </p>
      ) : null}
      {excludedObservations > 0 ? (
        <p>
          {excludedObservations} chain {excludedObservations === 1 ? "observation was" : "observations were"} unavailable
          and excluded from chain totals
          {partialChainNames.length > 0
            ? ` (${partialChainNames.slice(0, PARTIAL_CHAIN_NAME_LIMIT).join(", ")}${partialChainNames.length > PARTIAL_CHAIN_NAME_LIMIT ? ` and ${partialChainNames.length - PARTIAL_CHAIN_NAME_LIMIT} more` : ""})`
            : ""}
          .
        </p>
      ) : null}
      <p className="text-muted-foreground">Shares divide by observed global supply. Snapshot {stamp}.</p>
    </OpsStatusChip>
  ) : null;
  const freshnessChip = <ChainsFreshnessChip meta={meta} />;
  const status = coverageChip || freshnessChip ? (
    <>
      {coverageChip}
      {freshnessChip}
    </>
  ) : null;

  return (
    <FeatureHeroSplit
      layout="stacked"
      ariaLabel="Chain concentration"
      beamLabel={
        first
          ? `Largest chain's share · ${first.name}${partial ? " · partial" : ""}`
          : `Largest chain's share${partial ? " · partial" : ""}`
      }
      beamTitle="Share of observed global stablecoin supply held on the largest chain"
      beamValue={first ? formatChainShare(first.dominanceShare) : "Unavailable"}
      status={status}
      universe={<UniverseChip universe="core" value={`${data.chains.length} of ${REGISTERED_CHAIN_COUNT} chains with supply`} />}
      expand={{ href: "#chains-leaderboard", label: "Jump to the chain leaderboard" }}
      sub={
        <div className="divide-y divide-border/50">
          <HeroMetricRow
            label={excludedAssets > 0 ? "Known supply subtotal" : "Observed stablecoin supply"}
            value={data.globalTotalUsd == null ? "Unavailable" : formatCompactUsd(data.globalTotalUsd)}
          />
          <HeroMetricRow
            label="7d change"
            value={
              change7dPct == null ? (
                <span className="text-muted-foreground">—</span>
              ) : (
                <span className={trendColor(change7dPct)}>{formatSignedPercent(change7dPct * 100, 1)}</span>
              )
            }
          />
          {first && second ? (
            <HeroMetricRow
              label="Top two chains"
              value={formatChainShare(first.dominanceShare! + second.dominanceShare!)}
              detail={`${first.name} + ${second.name}`}
            />
          ) : null}
        </div>
      }
    >
      <div className="space-y-2.5 p-5 sm:p-6 lg:px-7 lg:py-6">
        <div className="flex flex-wrap items-baseline justify-between gap-x-4 gap-y-1">
          <p className="pharos-label">Observed supply by chain</p>
          <span className={cn("pharos-numeric text-2xs", retained ? "text-foreground" : "text-muted-foreground")}>{stamp}</span>
        </div>
        {topBySupply.length > 0 ? (
          <DominanceBreakdown
            topBySupply={topBySupply}
            globalTotalUsd={data.globalTotalUsd}
            chainAttributedTotalUsd={data.chainAttributedTotalUsd}
            unattributedTotalUsd={data.unattributedTotalUsd}
            attributionDiscrepancyUsd={data.attributionDiscrepancyUsd}
            dominanceGeometryTotalUsd={data.dominanceGeometryTotalUsd}
            chains={data.chains}
            beamChainId={first?.id}
          />
        ) : null}
      </div>
    </FeatureHeroSplit>
  );
}

/**
 * The leaderboard: the harbor's equivalent data surface. Row hover/focus lights the matching berth; the harbor's
 * "Show in table" scrolls to the row (smoothly only when motion is allowed), focuses it and highlights it.
 */
function ChainsLeaderboardTable({
  data,
  sorted,
  sort,
}: {
  data: HarborSceneInput;
  sorted: readonly ChainSummary[];
  sort: DataTableSortControls<ChainSortKey>;
}) {
  // One Harbor flag per row; an NR reason is shown once above the table, since a title tooltip never reaches touch.
  const flags = new Map(sorted.map((chain) => [chain.id, harborFlag(chain, data)]));
  const nrReasons = new Map<string, number>();
  for (const flag of flags.values()) if (flag.kind === "unrated") nrReasons.set(flag.reason, (nrReasons.get(flag.reason) ?? 0) + 1);
  const router = useRouter();
  const reducedMotion = usePrefersReducedMotion();
  const { revealedChainId, setHoverChainId, registerRevealRow } = useHarborSelection();

  useEffect(
    () =>
      registerRevealRow((chainId) => {
        const row = document.getElementById(`chain-row-${chainId}`);
        if (!row) return;
        row.scrollIntoView({ block: "center", behavior: reducedMotion ? "auto" : "smooth" });
        row.focus({ preventScroll: true });
      }),
    [registerRevealRow, reducedMotion],
  );

  return (
    <div
      id="chains-leaderboard"
      tabIndex={-1}
      className="space-y-4 outline-none"
      onMouseLeave={() => setHoverChainId(null)}
      onBlur={(event) => {
        // rows light their berth on focus too: clear it once focus leaves the leaderboard
        if (!event.currentTarget.contains(event.relatedTarget as Node | null)) setHoverChainId(null);
      }}
    >
      <DataTableShell
        tableId="chains-leaderboard"
        testId="chains-leaderboard-table"
        columns={CHAIN_COLUMNS}
        striped
        sort={sort}
        // At lg+ the 760px table fits, so drop the scrollers (overflow-clip
        // on the shell, visible viewport) and let the sticky header pin to
        // the page under the site chrome (--table-header-top).
        containerClassName="lg:overflow-clip"
        viewportClassName="pb-[calc(var(--mobile-utility-safe-offset)-1rem)] sm:pb-0 lg:overflow-visible"
        viewportProps={{ compactBottomPadding: false, vertical: true }}
        tableClassName="min-w-[760px] w-full"
        stickyHeader
        topSlot={
          nrReasons.size > 0 ? (
            <ul className="border-b border-border/50 px-3 py-2 text-2xs text-muted-foreground" aria-label="Chain Health not rated">
              {[...nrReasons].map(([reason, count]) => (
                <li key={reason}>
                  <span className="font-medium text-foreground">Health NR</span> · {count} {count === 1 ? "chain" : "chains"} · {reason}
                </li>
              ))}
            </ul>
          ) : null
        }
      >
        {sorted.map((chain, i) => {
          const rank = i + 1;
          return (
            <InteractiveTableRow
              key={chain.id}
              id={`chain-row-${chain.id}`}
              role="link"
              ariaLabel={`${chain.name} — ${formatCompactUsd(chain.totalUsd)} supply`}
              className={cn(
                "group h-11 border-l-2 border-l-transparent transition-all duration-150 hover:border-l-frost-blue hover:bg-muted/30 hover:translate-x-[1px] data-[state=selected]:border-l-frost-blue sm:h-auto",
                revealedChainId === chain.id ? "border-l-frost-blue bg-muted/40" : "",
              )}
              onHover={() => setHoverChainId(chain.id)}
              onActivate={() => router.push(`/chains/${chain.id}/`)}
            >
              <TableCell className="pharos-numeric text-right text-muted-foreground">{rank}</TableCell>
              <TableCell>
                <div className="flex items-center gap-2">
                  {chain.logoPath ? (
                    <Image
                      src={resolveCompactLogoSrc(chain.logoPath, 20)!}
                      alt=""
                      width={20}
                      height={20}
                      className={cn("rounded-full", CHAIN_META[chain.id]?.darkInvert ? "dark:invert" : "")}
                      style={{ width: 20, height: 20 }}
                    />
                  ) : (
                    <span aria-hidden="true" className="inline-block h-5 w-5 rounded-full bg-muted" />
                  )}
                  <span className="font-medium">{chain.name}</span>
                  <span className="hidden sm:inline-flex">
                    <ChainTypeBadge type={chain.type} />
                  </span>
                </div>
              </TableCell>
              <TableCell className="text-right pharos-numeric">
                {/* a sub-dollar observed supply is not an observed zero */}
                {chain.totalUsd > 0 && chain.totalUsd < 1 ? "<$1" : formatCompactUsd(chain.totalUsd)}
                {(chain.unavailableSupplyObservationCount ?? 0) > 0 ? (
                  <span className="block text-3xs text-muted-foreground">
                    Partial · {chain.unavailableSupplyObservationCount} unavailable
                  </span>
                ) : null}
              </TableCell>
              <TableCell>
                <HealthBadge flag={flags.get(chain.id)!} />
              </TableCell>
              <TableCell className={cn("text-right pharos-numeric", trendColor(chain.change7dPct))}>
                {chain.change7dPct == null ? "—" : formatSignedPercent(chain.change7dPct * 100, 2)}
              </TableCell>
              <TableCell className="text-right">
                <div className="flex items-center justify-end gap-2">
                  {/* geometry only (the printed share is unclamped); a nonzero share keeps a visible sliver */}
                  <div className="h-1.5 w-16 overflow-hidden rounded-full bg-foreground/10">
                    <div
                      className="h-full rounded-full bg-foreground/55"
                      style={{ width: chain.dominanceShare != null && chain.dominanceShare > 0 ? `max(2px, ${Math.min(100, chain.dominanceShare * 100)}%)` : 0 }}
                    />
                  </div>
                  <span className="text-xs pharos-numeric text-muted-foreground w-10 text-right">
                    {formatChainShare(chain.dominanceShare)}
                  </span>
                </div>
              </TableCell>
              <TableCell className="text-right pharos-numeric">{chain.stablecoinCount}</TableCell>
              <TableCell className="hidden lg:table-cell">
                <div className="flex items-center gap-2">
                  <StablecoinLogo
                    src={getLogoSrc(logosById, chain.dominantStablecoin.id)}
                    name={chain.dominantStablecoin.symbol}
                    size={18}
                  />
                  <span className="text-sm">{chain.dominantStablecoin.symbol}</span>
                  <span className="pharos-numeric text-xs text-muted-foreground">
                    ({(chain.dominantStablecoin.share * 100).toFixed(0)}%)
                  </span>
                </div>
              </TableCell>
            </InteractiveTableRow>
          );
        })}
      </DataTableShell>
    </div>
  );
}
