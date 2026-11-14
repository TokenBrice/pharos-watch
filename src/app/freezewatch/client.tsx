"use client";

import { useRef, type FormEvent, type ReactNode } from "react";
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
import { AlertsHeaderLink } from "@/components/alerts-header-link";
import { FeaturePageShell } from "@/components/feature-page-shell";
import { ShareButton } from "@/components/share-button";
import { HERO_KPI_VALUE_CLASS } from "@/components/feature-hero-split";
import { UniverseChip } from "@/components/universe-chip";
import { RailHeroFigureTransition } from "@/components/view-transitions";
import { FreezableSupplyMeter } from "@/components/freezewatch/freezable-supply-meter";
import { computeFreezableSummary, formatShare } from "@shared/lib/freezewatch/freezable-summary";
import { InterventionSeismograph } from "@/components/freezewatch/intervention-seismograph";
import { SovereigntyLattice } from "@/components/freezewatch/sovereignty-lattice";
import { coinIdBySymbol } from "@/lib/coin-id-by-symbol";
import { resolveQueryViewState } from "@/lib/query-view-state";
import { formatCurrency, formatEventDate } from "@shared/lib/format";
import { API_PATHS } from "@shared/lib/api-endpoints/paths";
import {
  BLACKLIST_TRACKER_METHODOLOGY_CHANGELOG_PATH,
  BLACKLIST_TRACKER_METHODOLOGY_VERSION_LABEL,
} from "@shared/lib/methodology-versions/constants";
import { resolveAddressCheck, useFreezeWatchPageController } from "./view-model";

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
    handleStablecoinChange,
    handleChainChange,
    handleLatticeSelection,
    handleEventTypeChange,
    handleSearchChange,
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

  const focusedCoin =
    stablecoinFilter !== "all"
      ? stablecoins?.find((coin) => coin.symbol === stablecoinFilter)
      : null;
  const focusedCoinId =
    focusedCoin?.id ??
    (stablecoinFilter !== "all" ? coinIdBySymbol(stablecoinFilter) : null);

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
  const ledgerUnfiltered =
    stablecoinFilter === "all" && chainFilter === "all" && eventTypeFilter === "all" &&
    sortKey === "date" && sortDirection === "desc" && clampedPage === 1;
  // Only a settled read for exactly the typed address may produce a sentence.
  const addressCheck =
    ledgerUnfiltered && searchInput.trim() === searchQuery.trim()
      ? resolveAddressCheck({ query: searchQuery, settled: pageSettled, events, total })
      : null;
  const handleAddressSubmit = (event: FormEvent) => {
    event.preventDefault();
    ledgerRef.current?.scrollIntoView({ behavior: "smooth", block: "start" });
  };

  return (
    <FeaturePageShell
      breadcrumbName="FreezeWatch"
      path="/freezewatch/"
      title="FreezeWatch"
      methodology={{
        version: BLACKLIST_TRACKER_METHODOLOGY_VERSION_LABEL,
        changelogPath: BLACKLIST_TRACKER_METHODOLOGY_CHANGELOG_PATH,
        docsPath: "/docs/blacklist-tracker/",
      }}
      header="instrument"
      headerActions={
        <>
          <AlertsHeaderLink
            href="/pharoswatchbot/#getting-started"
            description="Get Telegram alerts when an issuer freezes, releases, or wipes a tracked stablecoin"
          />
          <ShareButton ogPath={API_PATHS.ogPage("freezewatch")} />
        </>
      }
      leadParagraphs={[
        "Live issuer freezes, releases, and wipes, with frozen value and direct vs. upstream exposure per asset.",
      ]}
    >
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

      <section
        aria-label="Freeze exposure overview"
        className="pharos-card-shell overflow-hidden animate-in fade-in duration-300"
      >
        <div className="flex flex-wrap items-end justify-between gap-x-6 gap-y-4 border-b border-border/50 p-5 sm:p-6">
          <div className="min-w-0 space-y-1.5">
            <p className="text-sm font-medium text-muted-foreground">Freeze-exposed share of tracked supply</p>
            {heroLoading && !heroUnavailable ? (
              <Skeleton className="h-10 w-32" />
            ) : (
              <RailHeroFigureTransition rail="freezewatch">
                <p className={HERO_KPI_VALUE_CLASS}>
                  {heroUnavailable || freezableShare === null || freezableSummary.coverage === "unavailable"
                    ? "—"
                    : formatShare(freezableShare)}
                </p>
              </RailHeroFigureTransition>
            )}
            {heroUnavailable || heroLoading ? null : (
              <UniverseChip universe="active" value={`${classifiedCount} coins classified`} />
            )}
          </div>
          <dl className="flex flex-wrap items-end gap-x-8 gap-y-3">
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
        </div>
        <FreezableSupplyMeter
          buckets={blacklistStatusBuckets}
          isLoading={heroLoading}
          isUnavailable={heroUnavailable}
          onRetry={refetchSupport}
          selectedBucket={statusBucket}
          onBucketSelect={handleStatusBucketChange}
        />
        <form
          onSubmit={handleAddressSubmit}
          className="space-y-2 border-t border-border/50 p-5 sm:p-6"
        >
          <label htmlFor="freezewatch-address-check" className="pharos-label">Check an address</label>
          <div className="flex flex-wrap gap-2">
            <Input
              id="freezewatch-address-check"
              value={searchInput}
              onChange={(event) => handleSearchChange(event.target.value)}
              placeholder="0x… or T… address"
              autoComplete="off"
              spellCheck={false}
              className="h-11 w-full sm:h-9 sm:w-96"
            />
            <button type="submit" className="pharos-focus-ring h-11 rounded-md border border-border/60 px-4 text-sm sm:h-9">
              Show in ledger
            </button>
          </div>
          <p className="pharos-meta max-w-3xl">
            Pharos freeze checker: look up a full address in the recorded freeze, release and wipe events.
            Coverage is limited to the contracts Pharos scans.
          </p>
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
      </section>

      <BlacklistStats
        summary={summary}
        isLoading={summaryLoading}
        error={summaryError}
        blacklistStatusBuckets={blacklistStatusBuckets}
        supportDataLoading={supportDataLoading}
        supportError={stablecoinsError}
        onRetry={() => void refetchSummary()}
        onUnfreezableSelect={() => handleStatusBucketChange("no")}
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
              onStablecoinChange={handleStablecoinChange}
              onChainChange={handleChainChange}
              onEventTypeChange={handleEventTypeChange}
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

        <section id="data" ref={ledgerRef} aria-label="Data table" tabIndex={-1}>
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
          onCellSelect={handleLatticeSelection}
        />
      </FreezeWatchSection>

      <FreezeWatchSection
        eyebrow="Timeline"
        title="Quarterly freeze, release, and wipe events"
        description="Historical event volume by quarter. Use the ledger above for address-level rows."
      >
        <InterventionSeismograph
          stats={summary?.stats}
          chart={summary?.chart}
          totalEvents={summary?.totalEvents}
          isLoading={summaryLoading}
          error={summaryError}
          onRetry={() => void refetchSummary()}
        />
      </FreezeWatchSection>

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
    </FeaturePageShell>
  );
}
