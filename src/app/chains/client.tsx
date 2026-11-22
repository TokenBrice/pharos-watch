"use client";

import { useEffect, useMemo, useState } from "react";
import Image from "next/image";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { useChains } from "@/hooks/use-chains";
import { useSort } from "@/hooks/use-sort";
import { TableCell } from "@/components/table";
import { DataTableEmptyRow, DataTableShell, type DataTableColumn, type DataTableSortControls } from "@/components/data-table-shell";
import { ControlPillToggle } from "@/components/control-pill-toggle";
import { FilterSearchInput } from "@/components/filter-search-input";
import { InteractiveTableRow } from "@/components/interactive-table-row";
import { SectionErrorBoundary } from "@/components/section-error-boundary";
import { QueryFreshnessNotices } from "@/components/query-freshness-notices";
import { QueryErrorNotice } from "@/components/query-error-notice";
import { ChartSkeleton } from "@/components/chart-skeleton";
import { Skeleton } from "@/components/ui/skeleton";
import { cn } from "@/lib/utils";
import { formatChainShare, trendColor } from "@/lib/chain-ui";
import { formatEventTimestamp } from "@/lib/depeg-event-display";
import { formatCompactUsd, formatSignedPercent } from "@shared/lib/format";
import { harborFlag, isSupplyRetained, type HarborSceneInput } from "@shared/lib/harbor-scene";
import type { ApiMeta } from "@/lib/api";
import { CardExpandButton } from "@/components/home-alt-mini-cards/pulse-card-header";
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
      <div className="space-y-4">
        <div className="pharos-card-shell space-y-3 p-4 sm:p-5 lg:px-6 lg:py-4">
          <div className="flex flex-wrap items-end justify-between gap-4">
            <div>
              <Skeleton className="h-4 w-56" />
              <Skeleton className="mt-2 h-9 w-32" />
              <Skeleton className="mt-2 h-6 w-48 rounded-full" />
            </div>
            <div className="grid w-full max-w-xl grid-cols-3 gap-4">
              {Array.from({ length: 3 }).map((_, i) => (
                <Skeleton key={i} className="h-10 w-full" />
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
        <ChartSkeleton variant="bars" className="aspect-[1/2.1] min-[761px]:aspect-[2.6/1]" aria-hidden />
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
  // the stamp dates the supply generation: it takes the full source date on the same rule as Harbor's retained scene, not on Chain Health lag
  const retained = isError || isSupplyRetained(harborInput._meta);

  return (
    <SectionErrorBoundary name="Chains">
      <HarborSelectionProvider chainIds={chainIds}>
        <div className="space-y-4">
          <QueryFreshnessNotices
            error={error}
            hasData={!!data?.chains?.length}
            onRetry={() => {
              void refetch();
            }}
            queries={[{ preset: "chains", dataUpdatedAt, error, hasData: !!data?.chains?.length, meta }]}
            // Materially stale data is the hero's status chip; the body only reports a hard error.
            showFreshnessBanner={false}
          />

          <ChainsHero data={data} meta={meta} dataUpdatedAt={dataUpdatedAt} retained={retained} />

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
function ChainsHero({ data, meta, dataUpdatedAt, retained }: { data: ChainsResponse; meta: ApiMeta | null | undefined; dataUpdatedAt: number; retained: boolean }) {
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
  const stamp = `as of ${retained ? formatEventTimestamp(data.updatedAt, true) : utcStamp(data.updatedAt)}`;

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
  const freshnessChip = <ChainsFreshnessChip meta={meta} dataUpdatedAt={dataUpdatedAt} />;
  const status = coverageChip || freshnessChip ? (
    <>
      {coverageChip}
      {freshnessChip}
    </>
  ) : null;

  const beamLabel = first
    ? `Largest chain's share · ${first.name}${partial ? " · partial" : ""}`
    : `Largest chain's share${partial ? " · partial" : ""}`;

  return (
    <div className="pharos-card-shell relative overflow-hidden" role="group" aria-label="Chain concentration">
      <div className="grid grid-cols-1 gap-4 border-b border-border/50 px-4 py-3.5 sm:px-5 lg:grid-cols-[minmax(0,5fr)_minmax(0,7fr)] lg:items-center lg:gap-6 lg:px-6 lg:py-4">
        <div className="space-y-1.5">
          <div className="flex items-start justify-between gap-2">
            <div className="flex min-w-0 flex-wrap items-center gap-x-2 gap-y-1">
              <p className="text-sm font-medium text-muted-foreground" title="Share of observed global stablecoin supply held on the largest chain">
                {beamLabel}
              </p>
              {status}
            </div>
            <CardExpandButton href="#chains-leaderboard" expandLabel="Jump to the chain leaderboard" className="-mr-2" />
          </div>
          <div className="flex flex-wrap items-baseline gap-x-3 gap-y-1.5">
            <p className="pharos-hero-kpi">{first ? formatChainShare(first.dominanceShare) : "Unavailable"}</p>
            <UniverseChip universe="core" value={`${data.chains.length} of ${REGISTERED_CHAIN_COUNT} chains with supply`} />
          </div>
        </div>
        <dl className="grid grid-cols-1 divide-y divide-border/50 sm:grid-cols-3 sm:divide-x sm:divide-y-0">
          <div className="py-1.5 sm:px-4 sm:py-0 sm:first:pl-0">
            <dt className="text-xs text-muted-foreground">{excludedAssets > 0 ? "Known supply subtotal" : "Observed stablecoin supply"}</dt>
            <dd className="pharos-numeric mt-0.5 text-base font-semibold text-foreground">
              {data.globalTotalUsd == null ? "Unavailable" : formatCompactUsd(data.globalTotalUsd)}
            </dd>
          </div>
          <div className="py-1.5 sm:px-4 sm:py-0">
            <dt className="text-xs text-muted-foreground">7d change</dt>
            <dd className="pharos-numeric mt-0.5 text-base font-semibold text-foreground">
              {change7dPct == null ? (
                <span className="text-muted-foreground">—</span>
              ) : (
                <span className={trendColor(change7dPct)}>{formatSignedPercent(change7dPct * 100, 1)}</span>
              )}
            </dd>
          </div>
          {first && second ? (
            <div className="py-1.5 sm:px-4 sm:py-0">
              <dt className="text-xs text-muted-foreground">Top two chains</dt>
              <dd className="pharos-numeric mt-0.5 text-base font-semibold text-foreground">
                {formatChainShare(first.dominanceShare! + second.dominanceShare!)}
              </dd>
              <dd className="text-2xs text-muted-foreground">{first.name} + {second.name}</dd>
            </div>
          ) : null}
        </dl>
      </div>
      <div className="space-y-2 px-4 py-3 sm:px-5 lg:px-6 lg:py-3.5">
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
    </div>
  );
}

type ChainTriageFilter = "all" | "top" | "concentrated" | "growing";

const CHAIN_TRIAGE_OPTIONS: readonly { value: ChainTriageFilter; label: string }[] = [
  { value: "all", label: "All chains" },
  { value: "top", label: "Top chains ($1B+)" },
  { value: "concentrated", label: "High concentration" },
  { value: "growing", label: "Growing 7d" },
];

const TOP_CHAIN_MIN_USD = 1_000_000_000;
const HIGH_CONCENTRATION_SHARE = 0.7;

function matchesChainTriage(chain: ChainSummary, triage: ChainTriageFilter): boolean {
  if (triage === "all") return true;
  if (triage === "top") return chain.totalUsd >= TOP_CHAIN_MIN_USD;
  if (triage === "concentrated") return chain.dominantStablecoin.share >= HIGH_CONCENTRATION_SHARE;
  return chain.change7dPct != null && chain.change7dPct > 0.01;
}

/**
 * The leaderboard: the harbor's equivalent data surface. Row hover/focus lights the matching berth; the harbor's
 * "Show in table" scrolls to the row (smoothly only when motion is allowed), focuses its link and highlights it.
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
  const [searchQuery, setSearchQuery] = useState("");
  const [triageFilter, setTriageFilter] = useState<ChainTriageFilter>("all");
  const normalizedQuery = searchQuery.trim().toLowerCase();
  const hasFilters = normalizedQuery.length > 0 || triageFilter !== "all";
  const visibleRows = useMemo(
    () =>
      sorted.filter((chain) => {
        if (!matchesChainTriage(chain, triageFilter)) return false;
        if (!normalizedQuery) return true;
        return (
          chain.name.toLowerCase().includes(normalizedQuery) ||
          chain.id.toLowerCase().includes(normalizedQuery) ||
          chain.dominantStablecoin.symbol.toLowerCase().includes(normalizedQuery)
        );
      }),
    [normalizedQuery, sorted, triageFilter],
  );
  // One Harbor flag per row; an NR reason is shown once above the table, since a title tooltip never reaches touch.
  const flags = new Map(visibleRows.map((chain) => [chain.id, harborFlag(chain, data)]));
  const nrReasons = new Map<string, number>();
  for (const flag of flags.values()) if (flag.kind === "unrated") nrReasons.set(flag.reason, (nrReasons.get(flag.reason) ?? 0) + 1);
  const router = useRouter();
  const reducedMotion = usePrefersReducedMotion();
  const { revealedChainId, setHoverChainId, registerRevealRow } = useHarborSelection();

  useEffect(
    () =>
      registerRevealRow((chainId) => {
        const scrollToRow = () => {
          const row = document.getElementById(`chain-row-${chainId}`);
          if (!row) return false;
          row.scrollIntoView({ block: "center", behavior: reducedMotion ? "auto" : "smooth" });
          row.querySelector<HTMLAnchorElement>("[data-chain-identity-link]")?.focus({ preventScroll: true });
          return true;
        };
        if (!scrollToRow()) {
          setSearchQuery("");
          setTriageFilter("all");
          window.requestAnimationFrame(() => {
            scrollToRow();
          });
        }
      }),
    [registerRevealRow, reducedMotion],
  );

  const clearFilters = () => {
    setSearchQuery("");
    setTriageFilter("all");
  };

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
        // TableViewport automatically keeps horizontal scroll on narrow
        // viewports (with `--table-header-top: 0px` so thead never covers row 1)
        // and switches to `overflow-visible` once the 760px table fits so thead
        // sticks cleanly beneath the desktop navbar (`--sticky-header-bottom`).
        viewportClassName="pb-[calc(var(--mobile-utility-safe-offset,4.5rem)-1rem)] sm:pb-0"
        viewportProps={{ compactBottomPadding: false }}
        tableClassName="min-w-[760px] w-full"
        stickyHeader
        topSlot={
          <>
            <div className="pharos-table-toolbar">
              <div className="flex flex-col gap-2.5 sm:flex-row sm:flex-wrap sm:items-center sm:justify-between">
                <ControlPillToggle
                  ariaLabel="Filter chains"
                  options={CHAIN_TRIAGE_OPTIONS}
                  value={triageFilter}
                  onChange={setTriageFilter}
                  className="flex flex-wrap gap-1.5"
                  buttonClassName="min-h-11 md:min-h-8"
                />
                <div className="flex items-center gap-2">
                  <FilterSearchInput
                    value={searchQuery}
                    onValueChange={setSearchQuery}
                    placeholder="Search chains..."
                    ariaLabel="Search chains by name or dominant stablecoin"
                    className="relative w-full sm:w-48"
                    inputClassName="h-11 pl-8 text-xs md:h-8"
                  />
                  {hasFilters ? (
                    <button
                      type="button"
                      onClick={clearFilters}
                      className="pharos-focus-ring shrink-0 min-h-11 rounded-sm text-xs text-muted-foreground underline-offset-4 hover:text-foreground hover:underline md:min-h-8"
                    >
                      Clear
                    </button>
                  ) : null}
                </div>
              </div>
            </div>
            {nrReasons.size > 0 ? (
              <ul className="border-b border-border/50 px-3 py-2 text-2xs text-muted-foreground" aria-label="Chain Health not rated">
                {[...nrReasons].map(([reason, count]) => (
                  <li key={reason}>
                    <span className="font-medium text-foreground">Health NR</span> · {count} {count === 1 ? "chain" : "chains"} · {reason}
                  </li>
                ))}
              </ul>
            ) : null}
          </>
        }
      >
        {visibleRows.map((chain, i) => {
          const rank = i + 1;
          return (
            <InteractiveTableRow
              key={chain.id}
              id={`chain-row-${chain.id}`}
              className={cn(
                "group h-11 border-l-2 border-l-transparent transition-colors duration-150 hover:border-l-frost-blue hover:bg-muted/30 data-[state=selected]:border-l-frost-blue sm:h-auto",
                revealedChainId === chain.id ? "border-l-frost-blue bg-muted/40" : "",
              )}
              onHover={() => setHoverChainId(chain.id)}
              onActivate={() => router.push(`/chains/${chain.id}/`)}
            >
              <TableCell className="pharos-numeric text-right text-muted-foreground">{rank}</TableCell>
              <TableCell>
                <Link
                  href={`/chains/${chain.id}/`}
                  prefetch={false}
                  aria-label={`${chain.name} — ${formatCompactUsd(chain.totalUsd)} supply`}
                  data-chain-identity-link
                  className="pharos-focus-ring flex items-center gap-2 rounded-md"
                >
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
                </Link>
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
        {visibleRows.length === 0 ? (
          <DataTableEmptyRow colSpan={CHAIN_COLUMNS.length}>
            <span className="flex flex-col items-center gap-3">
              <span>No chains match the current filter.</span>
              <button
                type="button"
                onClick={clearFilters}
                className="pharos-focus-ring rounded-full border border-border/60 px-3 py-1.5 text-xs text-muted-foreground hover:text-foreground"
              >
                Clear filters
              </button>
            </span>
          </DataTableEmptyRow>
        ) : null}
      </DataTableShell>
    </div>
  );
}
