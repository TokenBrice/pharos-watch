"use client";

import Link from "next/link";
import { Fragment, useCallback, useEffect, useMemo, useState } from "react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { LazySection } from "@/components/lazy-section";
import { QueryFreshnessNotices } from "@/components/query-freshness-notices";
import { ReportCardMiniV9 } from "@/components/report-card-mini-v9";
import { useReportCardsV9 } from "@/hooks/api-hooks";
import { useLogos } from "@/hooks/use-logos";
import { useStablecoins } from "@/hooks/use-stablecoins";
import { refetchQueryGroup } from "@/lib/query-refetch-group";
import { getSafetyGradeMetadata } from "@/lib/report-card-ui";
import { cn } from "@/lib/utils";
import type { V9ConsumerCard } from "@/lib/safety-score-v9-consumers";
import { buildStablecoinUrl } from "@shared/lib/urls";
import { CLIENT_TRACKED_META_BY_ID } from "@shared/lib/stablecoins/client-registry";
import { formatCurrency } from "@shared/lib/format";
import { SafetyScoresContentLoadingState } from "./loading";
import {
  SafetyEmptyState,
  SafetyResultsSummary,
  SafetyScoresHero,
} from "./presentational";
import { SafetyPillarExplainer } from "./pillar-explainer";
import {
  GRADE_RANGES,
  buildSafetyMcapMap,
  buildSafetyPegTypeMap,
  buildV9GradeCounts,
  buildV9HeadlineStats,
  buildSafetyScoreCoinCardId,
  filterAndSortV9Cards,
  groupV9CardsByGrade,
  parseSafetyScoreCoinQuery,
  searchV9CardsByCoin,
  type SafetyScoreCoinQueryState,
  type GradeFilter,
  type PegFilter,
  type V9SortKey,
} from "./v9-view-model";

const SORT_OPTIONS: ReadonlyArray<{ key: V9SortKey; label: string }> = [
  { key: "overall", label: "Overall" },
  { key: "backing", label: "Backing" },
  { key: "exit", label: "Exit" },
  { key: "control", label: "Econ. Control" },
  { key: "mcap", label: "MCap" },
];

const PEG_OPTIONS: ReadonlyArray<{ key: Exclude<PegFilter, "all">; label: string }> = [
  { key: "usd", label: "USD" },
  { key: "fiat-non-usd", label: "Fiat non USD" },
  { key: "commodities", label: "Commodities" },
];

const lazyCardSkeleton = (
  <div
    className="flex h-[250px] flex-col items-center justify-center gap-2 rounded-xl border bg-muted/20 animate-pulse"
    role="status"
    aria-busy="true"
    aria-label="Loading score card"
  >
    <div className="h-8 w-8 rounded-full bg-muted/40" />
    <div className="h-4 w-20 rounded bg-muted/40" />
    <div className="h-6 w-12 rounded bg-muted/40" />
  </div>
);

const EMPTY_COIN_QUERY: SafetyScoreCoinQueryState = { raw: null, id: null, status: "empty" };
const SAFETY_SCORE_DATE_FORMATTER = new Intl.DateTimeFormat("en-US", {
  dateStyle: "medium",
  timeZone: "UTC",
});

function formatSafetyScoreAsOf(asOfSec: number): string {
  return `${SAFETY_SCORE_DATE_FORMATTER.format(new Date(asOfSec * 1_000))} UTC`;
}

function CoinFinder({
  cards,
  mcapMap,
  apiAvailable,
  asOfSec,
  methodologyVersion,
  selectedCoinId,
  queryState,
  searchQuery,
  onSearchQueryChange,
  onSelectCoin,
}: {
  cards: readonly V9ConsumerCard[];
  mcapMap: ReadonlyMap<string, number>;
  apiAvailable: boolean;
  asOfSec?: number;
  methodologyVersion?: string;
  selectedCoinId: string | null;
  queryState: SafetyScoreCoinQueryState;
  searchQuery: string;
  onSearchQueryChange: (value: string) => void;
  onSelectCoin: (id: string) => void;
}) {
  const matches = useMemo(
    () => searchV9CardsByCoin(cards, searchQuery).slice(0, 8),
    [cards, searchQuery],
  );
  const selectedCard = selectedCoinId
    ? cards.find((card) => card.id === selectedCoinId)
    : undefined;
  const selectedMeta = selectedCoinId ? CLIENT_TRACKED_META_BY_ID.get(selectedCoinId) : undefined;

  return (
    <section aria-labelledby="find-your-coin" className="pharos-card-shell space-y-4 p-4 sm:p-5">
      <div className="space-y-1">
        <p className="pharos-kicker">Stable-ID lookup</p>
        <h2 id="find-your-coin" className="pharos-section-title">Find your coin</h2>
        <p className="pharos-meta">
          Search the current Safety Score cards by symbol or name. Selecting a result writes its stable
          asset ID to the <code>coin</code> query parameter.
        </p>
      </div>

      <div className="space-y-2">
        <label htmlFor="safety-score-coin-search" className="text-sm font-medium text-foreground">
          Search by symbol or name
        </label>
        <Input
          id="safety-score-coin-search"
          value={searchQuery}
          onChange={(event) => onSearchQueryChange(event.target.value)}
          onKeyDown={(event) => {
            if (event.key === "Enter" && matches[0]) {
              event.preventDefault();
              onSelectCoin(matches[0].id);
            }
          }}
          placeholder="Try USDT or Tether"
          autoComplete="off"
          aria-describedby="safety-score-coin-search-help"
        />
        <p id="safety-score-coin-search-help" className="pharos-meta">
          The URL uses a stable ID, never a ticker by itself.
        </p>
        {searchQuery.trim() && matches.length > 0 ? (
          <div className="divide-y divide-border/60 overflow-hidden rounded-md border border-border/60" role="listbox" aria-label="Matching stablecoins">
            {matches.map((card) => {
              const meta = CLIENT_TRACKED_META_BY_ID.get(card.id);
              return (
                <button
                  key={card.id}
                  type="button"
                  role="option"
                  aria-selected={card.id === selectedCoinId}
                  onClick={() => onSelectCoin(card.id)}
                  className="pharos-focus-ring flex min-h-11 w-full items-center justify-between gap-3 px-3 py-2 text-left text-sm hover:bg-muted/50"
                >
                  <span className="min-w-0 truncate font-medium">{meta?.name ?? card.id}</span>
                  <span className="shrink-0 text-xs text-muted-foreground">{meta?.symbol ?? card.id}</span>
                </button>
              );
            })}
          </div>
        ) : null}
      </div>

      {queryState.status === "malformed" ? (
        <p className="pharos-empty-note text-sm" role="alert">
          The <code>coin</code> parameter must be a canonical stablecoin ID, such as <code>usdt-tether</code>.
        </p>
      ) : null}
      {queryState.status === "unknown" ? (
        <p className="pharos-empty-note text-sm" role="alert">
          No tracked stablecoin uses the ID <code>{queryState.raw}</code>. Search by symbol or name to find
          a current card.
        </p>
      ) : null}

      {!apiAvailable ? (
        <p className="pharos-empty-note text-sm" role="status">
          The live Safety Score lookup is temporarily unavailable. The current API publication could not
          be loaded, so grade, score, supply, and report-card links will return when it is available.
        </p>
      ) : selectedCoinId && selectedCard ? (
        <div className="space-y-4 border-t border-border/60 pt-4">
          <div className="flex flex-wrap items-baseline justify-between gap-x-3 gap-y-1">
            <div className="min-w-0">
              <p className="text-base font-semibold text-foreground">{selectedMeta?.name ?? selectedCard.id}</p>
              <p className="pharos-meta">{selectedMeta?.symbol ?? selectedCard.id} · live report card</p>
            </div>
            <Link href={buildStablecoinUrl(selectedCard.id)} className="pharos-prose-link text-sm">
              Open report card &rarr;
            </Link>
          </div>
          <dl className="grid grid-cols-2 gap-3 sm:grid-cols-4">
            <div>
              <dt className="pharos-kicker">Grade</dt>
              <dd className="pharos-numeric text-lg font-semibold">{selectedCard.grade}</dd>
            </div>
            <div>
              <dt className="pharos-kicker">Score</dt>
              <dd className="pharos-numeric text-lg font-semibold">
                {selectedCard.score === null ? "Not rated" : selectedCard.score}
              </dd>
            </div>
            <div>
              <dt className="pharos-kicker">Supply</dt>
              <dd className="pharos-numeric text-lg font-semibold">
                {mcapMap.has(selectedCard.id) ? formatCurrency(mcapMap.get(selectedCard.id)!) : "Unavailable"}
              </dd>
            </div>
            <div>
              <dt className="pharos-kicker">As of</dt>
              <dd className="text-sm font-medium text-foreground">
                {asOfSec == null ? "Unavailable" : formatSafetyScoreAsOf(asOfSec)}
              </dd>
            </div>
          </dl>
          <p className="pharos-meta">
            This is the current live V9 publication{asOfSec == null ? "" : ` as of ${formatSafetyScoreAsOf(asOfSec)}`}.
            Its methodology is{" "}
            <Link href="/methodology/#safety-scores-methodology" className="pharos-prose-link">
              {methodologyVersion ?? "the current Safety Score methodology"}
            </Link>
            . The poster is a separate dated capture; use its footer date for the image, and expect the
            two views to legitimately disagree when the live publication changes.
          </p>
        </div>
      ) : selectedCoinId ? (
        <p className="pharos-empty-note text-sm" role="status">
          No current V9 report card matches <code>{selectedCoinId}</code>. The stable ID is valid, but it
          is not present in this live publication.
        </p>
      ) : null}
    </section>
  );
}

function GradeFilterButtons({
  gradeFilter,
  totalCards,
  gradeCounts,
  onChange,
}: {
  gradeFilter: GradeFilter;
  totalCards: number;
  gradeCounts: Record<string, number>;
  onChange: (grade: GradeFilter) => void;
}) {
  return (
    <>
      <Button
        variant="ghost"
        size="sm"
        onClick={() => onChange("all")}
        className={cn(
          "pharos-focus-ring pharos-control-pill min-h-[44px] text-xs md:min-h-0",
          gradeFilter === "all" && "pharos-control-pill-active",
        )}
      >
        All ({totalCards})
      </Button>
      {GRADE_RANGES.map((grade) => {
        const count = gradeCounts[grade] ?? 0;
        if (count === 0) return null;
        return (
          <Button
            key={grade}
            variant="ghost"
            size="sm"
            onClick={() => onChange(gradeFilter === grade ? "all" : grade)}
            className={cn(
              "pharos-focus-ring pharos-control-pill min-h-[44px] text-xs md:min-h-0",
              gradeFilter === grade && "pharos-control-pill-active",
            )}
          >
            {grade} ({count})
          </Button>
        );
      })}
    </>
  );
}

function SortButtons({
  sortKey,
  onChange,
}: {
  sortKey: V9SortKey;
  onChange: (key: V9SortKey) => void;
}) {
  return SORT_OPTIONS.map((option) => (
    <Button
      key={option.key}
      variant="ghost"
      size="sm"
      onClick={() => onChange(option.key)}
      className={cn(
        "pharos-focus-ring pharos-control-pill min-h-[44px] text-xs md:min-h-0",
        sortKey === option.key && "pharos-control-pill-active",
      )}
    >
      {option.label}
    </Button>
  ));
}

function PegFilterButtons({
  pegFilter,
  onChange,
}: {
  pegFilter: PegFilter;
  onChange: (peg: PegFilter) => void;
}) {
  return PEG_OPTIONS.map((option) => (
    <Button
      key={option.key}
      variant="ghost"
      size="sm"
      aria-pressed={pegFilter === option.key}
      onClick={() => onChange(pegFilter === option.key ? "all" : option.key)}
      className={cn(
        "pharos-focus-ring pharos-control-pill min-h-[44px] text-xs md:min-h-0",
        pegFilter === option.key && "pharos-control-pill-active",
      )}
    >
      {option.label}
    </Button>
  ));
}

function V9Controls({
  gradeFilter,
  totalCards,
  gradeCounts,
  pegFilter,
  sortKey,
  onGradeFilterChange,
  onPegFilterChange,
  onSortChange,
}: {
  gradeFilter: GradeFilter;
  totalCards: number;
  gradeCounts: Record<string, number>;
  pegFilter: PegFilter;
  sortKey: V9SortKey;
  onGradeFilterChange: (grade: GradeFilter) => void;
  onPegFilterChange: (peg: PegFilter) => void;
  onSortChange: (key: V9SortKey) => void;
}) {
  const gradeButtons = (
    <GradeFilterButtons
      gradeFilter={gradeFilter}
      totalCards={totalCards}
      gradeCounts={gradeCounts}
      onChange={onGradeFilterChange}
    />
  );

  return (
    <div className="space-y-3 border-t border-border/30 pt-6">
      <details className="pharos-card-shell px-4 py-3 md:hidden">
        <summary className="pharos-focus-ring cursor-pointer rounded-lg text-sm font-medium text-foreground">
          Sort and filter score cards
        </summary>
        <div className="space-y-4 pt-4">
          <div className="space-y-2">
            <span className="pharos-kicker">Filter by Grade</span>
            <div className="flex flex-wrap gap-1">{gradeButtons}</div>
          </div>
          <div className="space-y-2">
            <span className="pharos-kicker">Peg</span>
            <div className="flex flex-wrap gap-1">
              <PegFilterButtons pegFilter={pegFilter} onChange={onPegFilterChange} />
            </div>
          </div>
          <div className="space-y-2">
            <span className="pharos-kicker">Sort by</span>
            <div className="flex flex-wrap gap-1">
              <SortButtons sortKey={sortKey} onChange={onSortChange} />
            </div>
          </div>
        </div>
      </details>

      <div className="hidden md:flex md:flex-wrap md:items-center md:gap-4">
        <div className="flex items-center gap-1">
          <span className="pharos-kicker mr-2">Filter:</span>
          {gradeButtons}
          <span className="pharos-kicker ml-3 mr-2">Peg:</span>
          <PegFilterButtons pegFilter={pegFilter} onChange={onPegFilterChange} />
        </div>
        <div className="h-5 w-px bg-border" />
        <div className="flex items-center gap-1">
          <span className="pharos-kicker mr-2">Sort:</span>
          <SortButtons sortKey={sortKey} onChange={onSortChange} />
        </div>
      </div>
    </div>
  );
}

function GradeSectionHeader({ grade, count }: { grade: string; count: number }) {
  const metadata = getSafetyGradeMetadata(grade as V9ConsumerCard["grade"]);
  return (
    <div className="pharos-section-enter col-span-full flex items-center gap-3 pt-4 first:pt-0">
      <span
        className={cn(
          "flex h-8 w-8 items-center justify-center rounded-lg font-mono text-sm font-bold text-white",
          metadata.sectionSwatchClassName,
        )}
      >
        {grade}
      </span>
      <div className="min-w-0">
        <span className="text-sm font-medium">{count} {count === 1 ? "coin" : "coins"}</span>
        <span className="ml-2 text-xs text-muted-foreground">{metadata.sectionDescription}</span>
      </div>
      <div className="flex-1 border-t border-border/40" />
    </div>
  );
}

export function ReportCardsV9Client() {
  const reportCardsQuery = useReportCardsV9();
  const stablecoinsQuery = useStablecoins();
  const { data: logos } = useLogos();
  const [gradeFilter, setGradeFilter] = useState<GradeFilter>("all");
  const [pegFilter, setPegFilter] = useState<PegFilter>("all");
  const [sortKey, setSortKey] = useState<V9SortKey>("overall");
  const [coinQueryState, setCoinQueryState] = useState<SafetyScoreCoinQueryState>(() =>
    typeof window === "undefined"
      ? EMPTY_COIN_QUERY
      : parseSafetyScoreCoinQuery(window.location.search),
  );
  const selectedCoinId = coinQueryState.status === "valid" ? coinQueryState.id : null;
  const [coinSearch, setCoinSearch] = useState("");

  const cards = useMemo(
    () => reportCardsQuery.data?.cards ?? [],
    [reportCardsQuery.data?.cards],
  );
  const mcapMap = useMemo(
    () => buildSafetyMcapMap(stablecoinsQuery.data?.peggedAssets),
    [stablecoinsQuery.data?.peggedAssets],
  );
  const pegTypeMap = useMemo(
    () => buildSafetyPegTypeMap(stablecoinsQuery.data?.peggedAssets),
    [stablecoinsQuery.data?.peggedAssets],
  );
  const gradeCounts = useMemo(() => buildV9GradeCounts(cards), [cards]);
  const totalCards = cards.length;
  const headlineStats = useMemo(() => buildV9HeadlineStats(cards, mcapMap), [cards, mcapMap]);
  const filteredCards = useMemo(
    () => filterAndSortV9Cards(cards, { gradeFilter, pegFilter, pegTypeMap, sortKey, mcapMap }),
    [cards, gradeFilter, mcapMap, pegFilter, pegTypeMap, sortKey],
  );
  const groupedCards = useMemo(() => groupV9CardsByGrade(filteredCards), [filteredCards]);
  const showGroupedCards = gradeFilter === "all" && sortKey === "overall";
  useEffect(() => {
    if (!selectedCoinId) return;
    const target = document.getElementById(buildSafetyScoreCoinCardId(selectedCoinId));
    if (!target) return;
    target.focus({ preventScroll: true });
    target.scrollIntoView?.({ behavior: "smooth", block: "center" });
  }, [cards, selectedCoinId]);
  const handleSelectCoin = useCallback((id: string) => {
    const nextQueryState: SafetyScoreCoinQueryState = { raw: id, id, status: "valid" };
    setCoinQueryState(nextQueryState);
    setCoinSearch("");
    if (typeof window === "undefined") return;
    const params = new URLSearchParams(window.location.search);
    params.set("coin", id);
    const nextSearch = params.toString();
    window.history.replaceState(
      null,
      "",
      `${window.location.pathname}${nextSearch ? `?${nextSearch}` : ""}${window.location.hash}`,
    );
  }, []);
  const handleRetry = useCallback(
    () => refetchQueryGroup([reportCardsQuery.refetch, stablecoinsQuery.refetch]),
    [reportCardsQuery.refetch, stablecoinsQuery.refetch],
  );

  if (reportCardsQuery.isLoading) return <SafetyScoresContentLoadingState />;

  const renderCard = (card: V9ConsumerCard, index: number) => (
    <div
      key={card.id}
      id={buildSafetyScoreCoinCardId(card.id)}
      tabIndex={-1}
      className={cn(
        "min-w-0 rounded-xl",
        selectedCoinId === card.id && "ring-2 ring-primary ring-offset-2 ring-offset-background",
      )}
      aria-current={selectedCoinId === card.id ? "true" : undefined}
    >
      <LazySection rootMargin="100px" placeholder={lazyCardSkeleton}>
        <div className="pharos-card-enter">
          <ReportCardMiniV9
            card={card}
            identity={reportCardsQuery.data!.safetyScoreIdentity}
            logo={logos?.[card.id]}
            animIndex={index % 5}
          />
        </div>
      </LazySection>
    </div>
  );

  return (
    <div className="space-y-6">
      <QueryFreshnessNotices
        error={reportCardsQuery.error ?? stablecoinsQuery.error}
        hasData={cards.length > 0 || !!stablecoinsQuery.data?.peggedAssets?.length}
        onRetry={handleRetry}
        queries={[
          {
            preset: "reportCards",
            dataUpdatedAt: reportCardsQuery.dataUpdatedAt,
            error: reportCardsQuery.error,
            hasData: cards.length > 0,
            meta: reportCardsQuery.meta,
          },
          {
            preset: "stablecoins",
            dataUpdatedAt: stablecoinsQuery.dataUpdatedAt,
            error: stablecoinsQuery.error,
            hasData: !!stablecoinsQuery.data?.peggedAssets?.length,
            meta: stablecoinsQuery.meta,
          },
        ]}
      />
      <CoinFinder
        cards={cards}
        mcapMap={mcapMap}
        apiAvailable={!!reportCardsQuery.data}
        asOfSec={reportCardsQuery.data?.asOfSec}
        methodologyVersion={reportCardsQuery.data?.methodology.version}
        selectedCoinId={selectedCoinId}
        queryState={coinQueryState}
        searchQuery={coinSearch}
        onSearchQueryChange={setCoinSearch}
        onSelectCoin={handleSelectCoin}
      />
      <SafetyScoresHero
        stats={headlineStats}
        gradeCounts={gradeCounts}
        totalCards={totalCards}
      />

      <SafetyPillarExplainer />

      <V9Controls
        gradeFilter={gradeFilter}
        totalCards={totalCards}
        gradeCounts={gradeCounts}
        pegFilter={pegFilter}
        sortKey={sortKey}
        onGradeFilterChange={setGradeFilter}
        onPegFilterChange={setPegFilter}
        onSortChange={setSortKey}
      />

      <SafetyResultsSummary count={filteredCards.length} gradeFilter={gradeFilter} pegFilter={pegFilter} />

      <section id="data" aria-label="Safety score cards" tabIndex={-1}>
        {!reportCardsQuery.data ? (
          <p className="pharos-empty-note text-sm text-muted-foreground" role="alert">
            Safety Score V9 ratings are temporarily unavailable. V8 ratings are not used as a fallback.
          </p>
        ) : filteredCards.length === 0 ? (
          <SafetyEmptyState
            gradeFilter={gradeFilter}
            pegFilter={pegFilter}
            onClearFilter={() => {
              setGradeFilter("all");
              setPegFilter("all");
            }}
          />
        ) : (
          <div className="grid grid-cols-1 gap-3 min-[360px]:grid-cols-2 sm:grid-cols-3 md:grid-cols-4 lg:grid-cols-5 xl:grid-cols-6">
            {showGroupedCards
              ? groupedCards.map((group) => (
                  <Fragment key={group.grade}>
                    <GradeSectionHeader grade={group.grade} count={group.cards.length} />
                    {group.cards.map(renderCard)}
                  </Fragment>
                ))
              : filteredCards.map(renderCard)}
          </div>
        )}
      </section>
    </div>
  );
}
