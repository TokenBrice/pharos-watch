"use client";

import { useCallback, useRef, type FormEvent, type ReactNode } from "react";
import Link from "next/link";
import { QueryFreshnessNotices } from "@/components/query-freshness-notices";
import { FilterSearchInput } from "@/components/filter-search-input";
import { Input } from "@/components/ui/input";
import { Skeleton } from "@/components/ui/skeleton";
import { UsdsStatusCard } from "@/components/freezewatch/usds-status-card";
import { EurcBlacklistCard } from "@/components/freezewatch/eurc-blacklist-card";
import { BlacklistStats } from "@/components/freezewatch/blacklist-stats";
import { BlacklistChart } from "@/components/freezewatch/blacklist-chart";
import { BlacklistStatusDrilldown } from "@/components/freezewatch/blacklist-status-drilldown";
import { BlacklistFilters } from "@/components/freezewatch/blacklist-filters";
import { BlacklistTable } from "@/components/freezewatch/blacklist-table";
import { TablePagination } from "@/components/table-pagination";
import { CoinCrossTrackerHatnote } from "@/components/coin-cross-tracker-hatnote";
import { FeatureHeroSplit } from "@/components/feature-hero-split";
import { UniverseChip } from "@/components/universe-chip";
import { RailHeroFigureTransition } from "@/components/view-transitions";
import { FreezableSupplyMeter } from "@/components/freezewatch/freezable-supply-meter";
import { computeFreezableSummary, formatShare } from "@shared/lib/freezewatch/freezable-summary";
import { InterventionSeismograph } from "@/components/freezewatch/intervention-seismograph";
import { SovereigntyLattice } from "@/components/freezewatch/sovereignty-lattice";
import { getBlacklistStablecoinIdBySymbol } from "@shared/lib/blacklist-contract-specs";
import { coinIdBySymbol } from "@/lib/coin-id-by-symbol";
import { resolveQueryViewState } from "@/lib/query-view-state";
import { formatCurrency, formatEventDate } from "@shared/lib/format";
import type { BlacklistStablecoin } from "@shared/types/blacklist";
import { isCompleteAddress, resolveAddressCheck, useFreezeWatchPageController } from "./view-model";

function FreezeWatchSection({
  eyebrow,
  title,
  description,
  children,
}: {
  eyebrow: string;
  title: string;
  description?: string;
  children: ReactNode;
}) {
  return (
    <section className="space-y-3 animate-in fade-in duration-300">
      <div className="space-y-1">
        <p className="pharos-label">{eyebrow}</p>
        <h2 className="pharos-section-title">{title}</h2>
        {description ? <p className="pharos-meta max-w-3xl">{description}</p> : null}
      </div>
      {children}
    </section>
  );
}

function HeroStat({ label, value, loading }: { label: string; value: string; loading: boolean }) {
  return (
    <div className="space-y-1">
      <dt className="pharos-label">{label}</dt>
      {loading ? (
        <Skeleton className="h-7 w-24" />
      ) : (
        <dd className="pharos-numeric text-xl font-semibold text-foreground sm:text-2xl">{value}</dd>
      )}
    </div>
  );
}

export default function FreezeWatchClient({ children }: { children?: ReactNode }) {
  const {
    summary,
    summaryLoading,
    summaryError,
    error,
    pageError,
    freshnessQueries,
    sourceGenerations,
    stablecoins,
    stablecoinFxFallbackRates,
    reportCardMap,
    reportCardsMethodologyVersion,
    blacklistStatusBuckets,
    supportDataLoading,
    stablecoinsError,
    refetchSummary,
    refetchPage,
    refetchSupport,
    statusBucket,
    stablecoinFilter,
    chainFilter,
    eventTypeFilter,
    sortKey,
    sortDirection,
    searchInput,
    hasActiveLedgerFilters,
    hasConflictingAddressFilters,
    filtersClearedForAddressCheck,
    handleStablecoinChange,
    handleChainChange,
    handleLatticeSelection,
    handleEventTypeChange,
    handleSearchChange,
    handleHeroAddressChange,
    handleHeroAddressSubmit,
    handleResetFilters,
    handleSortChange,
    handleStatusBucketChange,
    handleStatusBucketClear,
    handlePreviousPage,
    handleNextPage,
    drilldownRef,
    clampedPage,
    total,
    totalPages,
    canPreviousPage,
    canNextPage,
    rangeStart,
    rangeEnd,
    pageLoading,
    pageSettled,
    searchQuery,
    events,
    pageSize,
  } = useFreezeWatchPageController();

  const focusedCoinId =
    stablecoinFilter !== "all"
      ? (getBlacklistStablecoinIdBySymbol(stablecoinFilter) ?? coinIdBySymbol(stablecoinFilter))
      : null;

  const heroState = resolveQueryViewState({
    hasData: blacklistStatusBuckets !== null,
    isLoading: supportDataLoading,
    error: stablecoinsError,
  });
  const heroUnavailable = heroState === "unavailable";
  const heroLoading = summaryLoading || supportDataLoading;
  const freezableSummary = computeFreezableSummary(blacklistStatusBuckets);
  const { freezableMarketCap, freezableCount, freezableShare } = freezableSummary;
  const supplyAvailable = freezableSummary.coverage !== "unavailable";
  // Every active coin with a freeze-control bucket: the hero's coin denominator.
  const classifiedCount = freezableSummary.registryCount;

  const ledgerRef = useRef<HTMLElement>(null);
  const ledgerUnfiltered = !hasConflictingAddressFilters;
  const hasCompleteAddressQuery = isCompleteAddress(searchInput);
  // Only a settled read for exactly the typed address on the unfiltered ledger may produce a verdict sentence.
  const addressCheck =
    ledgerUnfiltered && searchInput.trim() === searchQuery.trim()
      ? resolveAddressCheck({ query: searchQuery, settled: pageSettled, events, total })
      : null;

  const handleAddressSubmit = (event: FormEvent) => {
    event.preventDefault();
    handleHeroAddressSubmit();
    ledgerRef.current?.scrollIntoView?.({ behavior: "smooth", block: "start" });
  };

  const handleLatticeCellSelect = useCallback(
    (selection: { stablecoin: BlacklistStablecoin; chainId: string }) => {
      handleLatticeSelection(selection);
      ledgerRef.current?.scrollIntoView?.({ behavior: "smooth", block: "start" });
    },
    [handleLatticeSelection],
  );

  return (
    <div className="space-y-6">
      {focusedCoinId ? (
        <CoinCrossTrackerHatnote
          coinId={focusedCoinId}
          coinSymbol={stablecoinFilter}
          currentTracker="freezewatch"
        />
      ) : null}
      <QueryFreshnessNotices
        error={error}
        hasData={freshnessQueries.some((query) => query.hasData)}
        onRetry={() => {
          void refetchSummary();
          void refetchPage();
          refetchSupport();
        }}
        queries={freshnessQueries}
      />

      <FeatureHeroSplit
        layout="stacked"
        ariaLabel="Freeze exposure overview"
        beamLabel="Freeze-exposed share of tracked supply"
        beamValueClassName="pharos-hero-kpi"
        beamValue={
          heroLoading && !heroUnavailable ? (
            <span className="skeleton-shimmer inline-block h-10 w-32 rounded-md align-middle" aria-hidden="true" />
          ) : (
            <RailHeroFigureTransition rail="freezewatch">
              <span>
                {heroUnavailable || freezableShare === null || freezableSummary.coverage === "unavailable"
                  ? "—"
                  : formatShare(freezableShare)}
              </span>
            </RailHeroFigureTransition>
          )
        }
        universe={
          heroUnavailable || heroLoading ? null : (
            <UniverseChip universe="active" value={`${classifiedCount} coins classified`} />
          )
        }
        sub={
          <dl className="flex flex-wrap items-end gap-x-8 gap-y-3 lg:justify-end">
            <HeroStat
              label="Freeze-exposed value"
              value={heroUnavailable || !supplyAvailable || freezableMarketCap === null ? "—" : formatCurrency(freezableMarketCap, 0)}
              loading={heroLoading && !heroUnavailable}
            />
            <HeroStat
              label="Freeze-exposed coins"
              value={heroUnavailable ? "—" : `${freezableCount} / ${classifiedCount}`}
              loading={heroLoading && !heroUnavailable}
            />
          </dl>
        }
        footer={
          <form onSubmit={handleAddressSubmit} className="space-y-2">
            <label htmlFor="freezewatch-address-check" className="pharos-label">Check an address</label>
            <div className="flex flex-wrap gap-2">
              <Input
                id="freezewatch-address-check"
                value={searchInput}
                onChange={(event) => handleHeroAddressChange(event.target.value)}
                placeholder="0x… or T… address"
                autoComplete="off"
                spellCheck={false}
                className="h-11 w-full sm:h-9 sm:w-96"
              />
              <button
                type="submit"
                className="pharos-focus-ring h-11 rounded-md border border-border/60 px-4 text-sm transition-colors hover:bg-muted/50 sm:h-9"
              >
                Show in ledger
              </button>
            </div>
            <p className="pharos-meta max-w-3xl">
              Pharos freeze checker: look up a full address in the recorded freeze, release and wipe events.
              Coverage is limited to the contracts Pharos scans.
            </p>
            {filtersClearedForAddressCheck ? (
              <p className="text-xs text-muted-foreground" role="status">
                Cleared active ledger filters to check this address across all scanned contracts.
              </p>
            ) : null}
            {!ledgerUnfiltered && hasCompleteAddressQuery ? (
              <p className="text-xs text-muted-foreground" role="status">
                Active ledger filters narrow this lookup.{" "}
                <button
                  type="button"
                  onClick={handleHeroAddressSubmit}
                  className="pharos-focus-ring rounded-sm font-medium text-brand-accent-text underline underline-offset-4"
                >
                  Clear filters to check all scanned contracts
                </button>
              </p>
            ) : null}
            <p className="pharos-meta max-w-3xl" aria-live="polite">
              {addressCheck?.kind === "found"
                ? `Pharos records ${addressCheck.count} freeze, release or wipe ${addressCheck.count === 1 ? "event" : "events"} for this address. Latest: ${addressCheck.stablecoin}, ${formatEventDate(addressCheck.timestamp)}.`
                : null}
              {addressCheck?.kind === "none" ? (
                <>
                  No freeze, release or wipe event is recorded for this address on the contracts Pharos scans.{" "}
                  <Link href="/docs/blacklist-tracker/" className="underline">
                    Coverage limits
                  </Link>
                </>
              ) : null}
            </p>
          </form>
        }
      >
        <FreezableSupplyMeter
          buckets={blacklistStatusBuckets}
          isLoading={heroLoading}
          isUnavailable={heroUnavailable}
          onRetry={refetchSupport}
          selectedBucket={statusBucket}
          onBucketSelect={handleStatusBucketChange}
        />
      </FeatureHeroSplit>

      <BlacklistStats
        summary={summary}
        isLoading={summaryLoading}
        error={summaryError}
        onRetry={() => void refetchSummary()}
      />

      {statusBucket ? (
        <div ref={drilldownRef}>
          <BlacklistStatusDrilldown
            status={statusBucket}
            stablecoins={stablecoins}
            sourceGenerations={sourceGenerations}
            fxFallbackRates={stablecoinFxFallbackRates}
            reportCards={reportCardMap}
            reportCardsMethodologyVersion={reportCardsMethodologyVersion}
            error={stablecoinsError}
            isLoading={supportDataLoading}
            onRetry={refetchSupport}
            onClear={handleStatusBucketClear}
          />
        </div>
      ) : null}

      <BlacklistChart
        chart={summary?.chart}
        isLoading={summaryLoading}
        error={summaryError}
        onRetry={() => void refetchSummary()}
      />

      <FreezeWatchSection
        eyebrow="Event ledger"
        title="Affected addresses and transactions"
        description="Filter by asset, chain, event type, or address to isolate the rows that matter."
      >
        <div className="pharos-table-toolbar rounded-xl border border-border/60">
          <div className="flex flex-wrap items-end justify-between gap-4">
            <BlacklistFilters
              chains={summary?.chains ?? []}
              stablecoinFilter={stablecoinFilter}
              chainFilter={chainFilter}
              eventTypeFilter={eventTypeFilter}
              perCoinTotalEvents={summary?.stats.perCoinTotalEvents}
              hasActiveFilters={hasActiveLedgerFilters}
              onStablecoinChange={handleStablecoinChange}
              onChainChange={handleChainChange}
              onEventTypeChange={handleEventTypeChange}
              onResetFilters={handleResetFilters}
            />
            <FilterSearchInput
              value={searchInput}
              onValueChange={handleSearchChange}
              placeholder="Search address..."
              className="relative w-full sm:w-56"
              inputClassName="pl-8 h-11 sm:h-8 text-sm sm:text-xs"
              ariaLabel="Search events by address"
            />
          </div>
        </div>

        <section id="data" ref={ledgerRef} aria-label="Data table" tabIndex={-1} className="scroll-mt-24">
          <BlacklistTable
            events={events}
            isLoading={pageLoading}
            error={pageError}
            page={clampedPage}
            pageSize={pageSize}
            sortKey={sortKey}
            sortDirection={sortDirection}
            onSortChange={handleSortChange}
          />
        </section>

        {total > 0 && (
          <TablePagination
            page={clampedPage - 1} /* TablePagination expects 0-indexed page */
            totalPages={totalPages}
            rangeStart={rangeStart}
            rangeEnd={rangeEnd}
            total={total}
            onPrevious={handlePreviousPage}
            onNext={handleNextPage}
            previousDisabled={!canPreviousPage}
            nextDisabled={!canNextPage}
            noun="events"
          />
        )}

        <div className="flex justify-end">
          <Link
            href="/timeline/?type=freeze.*"
            className="pharos-focus-ring text-xs text-muted-foreground hover:text-foreground"
          >
            See all freeze events on the Timeline →
          </Link>
        </div>
      </FreezeWatchSection>

      <FreezeWatchSection
        eyebrow="Coverage"
        title="Watched contracts by chain"
        description="Coverage cells show where Pharos watches issuer intervention events. Empty cells mean no tracker coverage, not no freeze risk."
      >
        <SovereigntyLattice
          coverage={summary?.coverage}
          stats={summary?.stats}
          chains={summary?.chains ?? []}
          isLoading={summaryLoading}
          error={summaryError}
          onRetry={() => void refetchSummary()}
          onCellSelect={handleLatticeCellSelect}
        />
      </FreezeWatchSection>

      <InterventionSeismograph
        stats={summary?.stats}
        chart={summary?.chart}
        totalEvents={summary?.totalEvents}
        isLoading={summaryLoading}
        error={summaryError}
        onRetry={() => void refetchSummary()}
      />

      <FreezeWatchSection
        eyebrow="Monitors"
        title="Special-case issuer controls"
        description="Known edge cases that need separate status context."
      >
        <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 sm:gap-5">
          <UsdsStatusCard />
          <EurcBlacklistCard />
        </div>
      </FreezeWatchSection>

      {children}
    </div>
  );
}
