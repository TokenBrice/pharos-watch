"use client";

import Link from "next/link";
import { useMemo, useState } from "react";
import { CoinCell } from "@/components/home-alt-mini-cards/coin-cell";
import { PulseCard } from "@/components/home-alt-mini-cards/pulse-card-header";
import { UniverseChip } from "@/components/universe-chip";
import { RailHeroFigureTransition } from "@/components/view-transitions";
import { Skeleton } from "@/components/ui/skeleton";
import { holderExposureUsd, isResolverBookAvailable } from "@/components/depeg/depeg-resolver-book-summary";
import { getResolution, getTierMeta, getTierVocabulary, isCurrentForecast } from "@/components/depeg/depeg-resolver-row-card-model";
import { usePegSummary } from "@/hooks/api-hooks";
import { useDepegResolverSurfaces } from "@/hooks/use-depeg-resolver-surfaces";
import { useFlashOnChange } from "@/hooks/use-flash-on-change";
import { useMinuteClockSec, useOpenIncidentHorizonClock } from "@/hooks/use-minute-clock-sec";
import { useStablecoins } from "@/hooks/use-stablecoins";
import { getLogoSrc, logosById } from "@/lib/logos";
import { buildStablecoinUrl } from "@shared/lib/urls";
import { formatCompactUsdShort, formatElapsedSeconds } from "@shared/lib/format";
import { getCirculatingRawOrNull } from "@shared/lib/supply";
import { WEEK_SECONDS } from "@shared/lib/time-constants";
import { ACTIVE_STABLECOIN_ID_SET } from "@/lib/stablecoin-static-data";
import {
  classifyOpenIncidentCoverage,
  classifyOpenIncidentTier,
  isNearParUnconfirmedOpenIncident,
  partitionActiveDepegRows,
  selectActiveDepegCoins,
} from "@shared/lib/active-depegs";
import { resolveQueryViewState } from "@/lib/query-view-state";
import { readUnroundedPublishedDeviation } from "@/lib/current-peg";
import type { PegSummaryCoin } from "@shared/types/peg";
import {
  DEPEG_DIRECTION_CLASSES,
  DEPEG_PENDING_STATE_LABELS,
  DIRECTION_TONE_CLASSES,
  OPEN_INCIDENT_EVIDENCE_LABELS,
  OPEN_INCIDENT_TIER_BADGES,
  type OpenIncidentEvidence,
  type OpenIncidentTier,
} from "@shared/lib/classification";
import { cn } from "@/lib/utils";

// Rows under the headline; the headline count is never this cap (R7).
const MAX_ROWS = 4;

type SegmentTab = "recent" | "long_running";

interface ActiveRow {
  id: string;
  symbol: string;
  pegCurrency: string;
  bps: number | null;
  referenceNote: string | null;
  ageSec: number | null;
  tier: OpenIncidentTier | null;
  evidence: OpenIncidentEvidence;
  /** Circulating USD; null when the supply read has no observation for the coin. */
  marketCapUsd: number | null;
  /** Holder exposure (USD off peg), the ranking key; null when either operand is unavailable. */
  exposureUsd: number | null;
  /** DDR call: the published tier (in the vocabulary it was locked under), or a forecast not locked yet. */
  verdict: DdrCall | null;
}

interface DdrCall {
  label: string;
  title: string;
  accent: string;
}

export function ActiveDepegsCard(): React.JSX.Element {
  const pegSummaryQuery = usePegSummary();
  const stablecoinsQuery = useStablecoins();
  const { resolver } = useDepegResolverSurfaces();
  const { data: pegSummaryData, isLoading: isPegSummaryLoading } = pegSummaryQuery;
  const resolverData = resolver.data;
  const logos = logosById;
  const logoMap = logos ?? {};
  const nowSec = useMinuteClockSec();
  const openIncidents = pegSummaryData?.openIncidents;
  const openIncidentsAsOfSec = pegSummaryData?.openIncidentsAsOfSec;
  // Single assessment clock per render (R3): prefer the live minute clock once
  // hydrated, else the server snapshot clock paired with `openIncidents`.
  const clockSec = nowSec > 0 ? nowSec : (openIncidentsAsOfSec ?? 0);
  const horizonClockSec = useOpenIncidentHorizonClock(
    openIncidents,
    openIncidentsAsOfSec,
    clockSec,
    pegSummaryQuery.refetch,
  );

  const activeCoins = useMemo(
    () => selectActiveDepegCoins(pegSummaryData?.coins ?? [], ACTIVE_STABLECOIN_ID_SET),
    [pegSummaryData?.coins],
  );
  const marketCaps = useMemo(
    () => new Map((stablecoinsQuery.data?.peggedAssets ?? []).map((coin) => [coin.id, getCirculatingRawOrNull(coin)])),
    [stablecoinsQuery.data?.peggedAssets],
  );
  // Only valid frozen predictions are verdicts, and only from a usable book (docs/homepage.md).
  // Index by both coin+eventId and coin so when `openIncidents` carries a specific eventId,
  // an older active DDR row never attaches to a newly opened incident (R5).
  const verdicts = useMemo(() => {
    const byCoinEvent = new Map<string, DdrCall>();
    const byCoin = new Map<string, DdrCall>();
    if (!isResolverBookAvailable(resolverData)) return { byCoinEvent, byCoin };
    for (const row of resolverData.rows) {
      if (row.live.eventState !== "active") continue;
      const eventKey = `${row.stablecoinId}:${row.live.currentEventId}`;
      if (isCurrentForecast(row)) {
        const meta = getTierMeta(getResolution(row).tier, getTierVocabulary(row));
        const call = { label: meta.short, title: meta.label, accent: meta.accent };
        byCoinEvent.set(eventKey, call);
        byCoin.set(row.stablecoinId, call);
      } else if (row.prediction.state === "pending_lock") {
        const label = DEPEG_PENDING_STATE_LABELS.ddrLock;
        const call = { label, title: label, accent: "" };
        if (!byCoinEvent.has(eventKey)) byCoinEvent.set(eventKey, call);
        if (!byCoin.has(row.stablecoinId)) byCoin.set(row.stablecoinId, call);
      }
    }
    return { byCoinEvent, byCoin };
  }, [resolverData]);

  // The complete summary owns the incident census; the sidecar supplies canonical onset,
  // re-escalation state, and live observation coverage without a separate event waterfall.
  const activeRows = useMemo<ActiveRow[]>(() => {
    const deviationClockSec = clockSec > 0 ? clockSec : undefined;
    return activeCoins.map((coin: PegSummaryCoin) => {
      const incident = openIncidents?.[coin.id];
      const { deviationBps: bps, referenceNote } = readUnroundedPublishedDeviation(
        coin.pegCurrency,
        coin,
        undefined,
        deviationClockSec,
      );
      const marketCapUsd = marketCaps.get(coin.id) ?? null;
      const ageSec =
        incident && clockSec > 0 && Number.isFinite(incident.startedAt) && incident.startedAt <= clockSec
          ? clockSec - incident.startedAt
          : null;
      const verdict = incident
        ? (verdicts.byCoinEvent.get(`${coin.id}:${incident.eventId}`) ?? null)
        : (verdicts.byCoin.get(coin.id) ?? null);
      return {
        id: coin.id,
        symbol: coin.symbol ?? coin.id,
        pegCurrency: coin.pegCurrency,
        bps,
        referenceNote,
        ageSec,
        tier: classifyOpenIncidentTier(incident, horizonClockSec),
        evidence: classifyOpenIncidentCoverage(incident?.coverage, clockSec),
        marketCapUsd,
        exposureUsd: holderExposureUsd(marketCapUsd, bps),
        verdict,
      };
    });
  }, [activeCoins, openIncidents, clockSec, horizonClockSec, marketCaps, verdicts]);

  const partitioned = useMemo(
    () => partitionActiveDepegRows(activeRows, openIncidents, horizonClockSec),
    [activeRows, openIncidents, horizonClockSec],
  );

  const activeCount = pegSummaryData?.summary?.activeDepegCount ?? null;
  const catalogCount = pegSummaryData?.coins.length ?? null;
  const recentCount = partitioned.recentCount;
  const longRunningCount = partitioned.longRunningCount;
  const splitConsistent =
    activeCount === null
    || (recentCount !== null && longRunningCount !== null && recentCount + longRunningCount === activeCount);
  const splitAvailable = partitioned.splitAvailable && recentCount !== null && longRunningCount !== null && splitConsistent;
  const hasLongRunning = splitAvailable && longRunningCount > 0;

  // Latch initial tab once split metadata first arrives, preserve manual toggles
  // across refreshes, and follow recent availability when the user has not overridden.
  const [selectedTab, setSelectedTab] = useState<SegmentTab | null>(null);
  const [manualOverride, setManualOverride] = useState(false);
  if (hasLongRunning) {
    if (selectedTab === null) {
      setSelectedTab(recentCount > 0 ? "recent" : "long_running");
    } else if (!manualOverride && selectedTab === "recent" && recentCount === 0) {
      setSelectedTab("long_running");
    } else if (!manualOverride && selectedTab === "long_running" && recentCount > 0) {
      setSelectedTab("recent");
    }
  } else if (selectedTab !== null || manualOverride) {
    setSelectedTab(null);
    setManualOverride(false);
  }
  const activeTab: SegmentTab = selectedTab ?? (recentCount && recentCount > 0 ? "recent" : "long_running");

  const visibleRows = hasLongRunning
    ? (activeTab === "recent" ? partitioned.recentRows : partitioned.longRunningRows)
    : partitioned.allRows;
  const rankKey = visibleRows.some((row) => row.exposureUsd != null) ? "holder exposure" : "deviation";
  const showManualEmptyRecent = hasLongRunning && activeTab === "recent" && visibleRows.length === 0;
  const showAutoFallbackMeta = hasLongRunning && activeTab === "long_running" && recentCount === 0;

  const listAriaLabel = hasLongRunning
    ? visibleRows.length > MAX_ROWS
      ? `Top ${MAX_ROWS} of ${visibleRows.length} ${activeTab === "recent" ? "recent" : "long-running"} active depegs by materiality, then ${rankKey}`
      : `${activeTab === "recent" ? "Recent" : "Long-running"} active depegs by materiality, then ${rankKey}`
    : visibleRows.length > MAX_ROWS
      ? `Top ${MAX_ROWS} of ${visibleRows.length} active depegs by materiality, then ${rankKey}`
      : `Active depegs by materiality, then ${rankKey}`;

  const flashClass = useFlashOnChange(activeCount);
  const state = resolveQueryViewState({
    hasData: pegSummaryData !== undefined,
    isLoading: isPegSummaryLoading,
    error: pegSummaryQuery.error,
    isEmpty: activeCount === 0,
  });

  return (
    <PulseCard
      className="pharos-card-shell flex h-full min-h-[322px] flex-col gap-2.5 p-4"
      href="/depeg/"
      expandLabel="Open Depeg monitor"
      label="Active depegs"
      aside={
        hasLongRunning ? (
          <div role="group" aria-label="Active depeg horizon" className="pharos-segmented">
            <button
              type="button"
              onClick={() => {
                setSelectedTab("recent");
                setManualOverride(true);
              }}
              aria-pressed={activeTab === "recent"}
              className="pharos-focus-ring pharos-segmented-item min-h-11 px-2 font-mono text-2xs leading-none md:min-h-7"
            >
              {`Recent (${recentCount})`}
            </button>
            <button
              type="button"
              onClick={() => {
                setSelectedTab("long_running");
                setManualOverride(true);
              }}
              aria-pressed={activeTab === "long_running"}
              className="pharos-focus-ring pharos-segmented-item min-h-11 px-2 font-mono text-2xs leading-none md:min-h-7"
            >
              {`>30d (${longRunningCount})`}
            </button>
          </div>
        ) : catalogCount != null ? (
          <UniverseChip
            universe="pegCatalog"
            value={`${catalogCount.toLocaleString()} coins`}
          />
        ) : null
      }
      state={state}
      loadingContent={
        <>
          <Skeleton className="h-12 w-28" />
          <Skeleton className="h-24 w-full" />
        </>
      }
      emptyContent={
        <div className="flex flex-1 items-center justify-center">
          <span className={cn("pharos-label text-sm", DIRECTION_TONE_CLASSES.up)}>
            No open confirmed incidents
          </span>
        </div>
      }
      hasRenderableData={pegSummaryData !== undefined}
    >
      <div className="flex flex-wrap items-center gap-x-2 gap-y-1">
        <div className="flex min-w-0 flex-wrap items-baseline gap-x-2 gap-y-0.5">
          <RailHeroFigureTransition rail="depeg">
            <span className={`rounded-md pharos-numeric text-3xl font-bold leading-none tracking-tight text-foreground sm:text-4xl ${flashClass}`}>
              {activeCount ?? "—"}
            </span>
          </RailHeroFigureTransition>
          {activeCount !== null ? (
            hasLongRunning ? (
              recentCount > 0 ? (
                <span className="min-w-0 text-xs text-muted-foreground">
                  open confirmed ·{" "}
                  <span className="pharos-numeric font-medium text-foreground">
                    {recentCount} recent · {longRunningCount} &gt;30d
                  </span>
                </span>
              ) : (
                <span className="min-w-0 text-xs text-muted-foreground">
                  open · <span className="pharos-numeric font-medium text-foreground">all &gt;30d</span>
                </span>
              )
            ) : (
              <span className="min-w-0 truncate text-xs text-muted-foreground">
                {activeCount === 1 ? "coin with an open confirmed incident" : "coins with open confirmed incidents"}
              </span>
            )
          ) : null}
        </div>
        {hasLongRunning && catalogCount != null ? (
          <UniverseChip
            universe="pegCatalog"
            value={`${catalogCount.toLocaleString()} coins`}
            className="sm:ml-auto"
          />
        ) : null}
      </div>
      {showAutoFallbackMeta ? (
        <p className="-mt-1 pharos-meta">
          {visibleRows.length > MAX_ROWS
            ? `No recent open incidents · Top ${MAX_ROWS} of ${visibleRows.length} >30d by materiality, then ${rankKey}`
            : `No recent open incidents · ${visibleRows.length} >30d by materiality, then ${rankKey}`}
        </p>
      ) : !showManualEmptyRecent && visibleRows.length > MAX_ROWS ? (
        <p className="-mt-1 pharos-meta">
          {hasLongRunning
            ? `Top ${MAX_ROWS} of ${visibleRows.length} ${activeTab === "recent" ? "recent" : ">30d"} by materiality, then ${rankKey}`
            : `Top ${MAX_ROWS} of ${visibleRows.length} by materiality, then ${rankKey}`}
        </p>
      ) : null}
      {showManualEmptyRecent ? (
        <div className="flex flex-1 flex-col items-center justify-center gap-2 border-t border-border/50 pt-3 text-center">
          <p className="text-xs text-muted-foreground">
            No open incidents started in the last 30d or re-escalated in the last 7d
          </p>
          <button
            type="button"
            onClick={() => {
              setSelectedTab("long_running");
              setManualOverride(true);
            }}
            className="pharos-focus-ring rounded-md border border-border/70 px-2.5 py-1 font-mono text-2xs font-medium text-foreground transition-colors hover:bg-muted/50"
          >
            {`View ${longRunningCount} long-running (>30d)`}
          </button>
        </div>
      ) : (
        <ul
          aria-label={listAriaLabel}
          className="flex flex-col gap-0.5 border-t border-border/50 pt-2 font-mono text-xs"
        >
          {visibleRows.slice(0, MAX_ROWS).map((row, index) => (
            <DepegRow
              key={row.id}
              row={row}
              logoSrc={getLogoSrc(logoMap, row.id)}
              isLead={index === 0}
              hasSidecar={openIncidents !== undefined}
            />
          ))}
        </ul>
      )}
    </PulseCard>
  );
}

function DepegRow({
  row,
  logoSrc,
  isLead,
  hasSidecar,
}: {
  row: ActiveRow;
  logoSrc: string | undefined;
  isLead: boolean;
  hasSidecar: boolean;
}): React.JSX.Element {
  const below = row.bps != null && row.bps < 0;
  const colorClass =
    row.bps == null ? "text-muted-foreground" : below
      ? DEPEG_DIRECTION_CLASSES.below.text : DEPEG_DIRECTION_CLASSES.above.text;
  const isNew = row.ageSec != null && row.ageSec <= WEEK_SECONDS;
  const isNearParUnconfirmed = hasSidecar && isNearParUnconfirmedOpenIncident(row.evidence, row.bps, row.pegCurrency);
  const evidenceQualifier = !hasSidecar
    ? null
    : isNearParUnconfirmed
      ? "Near par"
      : row.evidence === "unconfirmed" && row.bps != null
        ? "Unconfirmed"
        : null;
  return (
    <li>
      <Link
        prefetch={false}
        href={buildStablecoinUrl(row.id)}
        title={OPEN_INCIDENT_EVIDENCE_LABELS[row.evidence]}
        className={`pharos-focus-ring -mx-1 grid grid-cols-[1.25rem_minmax(0,1fr)_auto] items-center gap-x-2 rounded-sm px-1 py-1 pharos-numeric transition-colors hover:bg-muted/50 ${isLead ? "bg-muted/55" : ""}`}
      >
        <CoinCell logoSrc={logoSrc} />
        <span className="flex min-w-0 items-baseline gap-1.5">
          <span className="truncate tracking-tight text-foreground">{row.symbol}</span>{" "}
          {isNew ? (
            <span className="shrink-0 rounded-sm border border-border/70 px-1 font-sans text-3xs font-semibold text-foreground/80">
              New
            </span>
          ) : null}
          {row.tier === "escalating" ? (
            <span
              title="Re-escalated >30d incident (confirmed within 7d)"
              className={cn(
                "shrink-0 rounded-sm border px-1 font-sans text-3xs font-semibold",
                OPEN_INCIDENT_TIER_BADGES.escalating.className,
              )}
            >
              {OPEN_INCIDENT_TIER_BADGES.escalating.short}
            </span>
          ) : null}
          <span className="sr-only">{`, ${OPEN_INCIDENT_EVIDENCE_LABELS[row.evidence]}`}</span>
        </span>
        <span
          className={`shrink-0 font-semibold pharos-numeric ${colorClass}`}
          title={row.exposureUsd != null ? `${formatCompactUsdShort(row.exposureUsd)} ${below ? "below" : "above"} peg` : undefined}
        >
          {row.referenceNote ? row.referenceNote : row.bps == null ? "Observation unavailable" : (
            <><span aria-hidden="true" className="mr-0.5">{below ? "↓" : "↑"}</span>{Math.abs(Math.round(row.bps))} bps</>
          )}
        </span>
        {/* Second line: DDR verdict, market cap, incident age, and unconfirmed qualifier; unavailable stays named. */}
        <span className="col-span-2 col-start-2 truncate text-2xs text-muted-foreground">
          {row.verdict ? (
            <>
              <span className={cn("font-sans font-semibold", row.verdict.accent)} title={row.verdict.title}>
                <span className="sr-only">DDR: </span>
                {row.verdict.label}
              </span>
              {" · "}
            </>
          ) : null}
          <span>{row.marketCapUsd != null ? `${formatCompactUsdShort(row.marketCapUsd)} mkt cap` : "Market cap unavailable"}</span>
          {" · "}
          <span>{row.ageSec != null ? formatElapsedSeconds(row.ageSec) : "Age unavailable"}</span>
          {evidenceQualifier ? (
            <>
              {" · "}
              <span>{evidenceQualifier}</span>
            </>
          ) : null}
        </span>
      </Link>
    </li>
  );
}
