"use client";

import Link from "next/link";
import { useMemo } from "react";
import { CoinCell } from "@/components/home-alt-mini-cards/coin-cell";
import { PulseCard } from "@/components/home-alt-mini-cards/pulse-card-header";
import { UniverseChip } from "@/components/universe-chip";
import { RailHeroFigureTransition } from "@/components/view-transitions";
import { Skeleton } from "@/components/ui/skeleton";
import { holderExposureUsd, isResolverBookAvailable } from "@/components/depeg/depeg-resolver-book-summary";
import { getResolution, getTierMeta, getTierVocabulary, isCurrentForecast } from "@/components/depeg/depeg-resolver-row-card-model";
import { usePegSummary } from "@/hooks/api-hooks";
import { useActiveDepegEvents } from "@/hooks/use-depeg-events";
import { useDepegResolverSurfaces } from "@/hooks/use-depeg-resolver-surfaces";
import { useFlashOnChange } from "@/hooks/use-flash-on-change";
import { useMinuteClockSec } from "@/hooks/use-minute-clock-sec";
import { useStablecoins } from "@/hooks/use-stablecoins";
import { getLogoSrc, logosById } from "@/lib/logos";
import { buildStablecoinUrl } from "@shared/lib/urls";
import { formatCompactUsdShort, formatElapsedSeconds } from "@shared/lib/format";
import { getCirculatingRawOrNull } from "@shared/lib/supply";
import { WEEK_SECONDS } from "@shared/lib/time-constants";
import { ACTIVE_STABLECOIN_ID_SET } from "@/lib/stablecoin-static-data";
import { classifyOpenIncidentEvidence, selectActiveDepegCoins } from "@shared/lib/active-depegs";
import { resolveQueryViewState } from "@/lib/query-view-state";
import { readPublishedDeviation } from "@/lib/current-peg";
import type { PegSummaryCoin } from "@shared/types/peg";
import {
  DEPEG_DIRECTION_CLASSES,
  DEPEG_PENDING_STATE_LABELS,
  DIRECTION_TONE_CLASSES,
  OPEN_INCIDENT_EVIDENCE_LABELS,
  type OpenIncidentEvidence,
} from "@shared/lib/classification";
import { cn } from "@/lib/utils";

// Rows under the headline; the headline count is never this cap (R7).
const MAX_ROWS = 4;

interface ActiveRow {
  id: string;
  symbol: string;
  bps: number | null;
  referenceNote: string | null;
  ageSec: number | null;
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

// Larger first; an unavailable value sorts after every observed one (R1).
const rankValue = (value: number | null) => value ?? -1;

export function ActiveDepegsCard(): React.JSX.Element {
  const activeQuery = useActiveDepegEvents();
  const pegSummaryQuery = usePegSummary();
  const stablecoinsQuery = useStablecoins();
  const { resolver } = useDepegResolverSurfaces();
  const { data } = activeQuery;
  const { data: pegSummaryData, isLoading: isPegSummaryLoading } = pegSummaryQuery;
  const resolverData = resolver.data;
  const logos = logosById;
  const logoMap = logos ?? {};
  const nowSec = useMinuteClockSec();

  const activeCoins = useMemo(
    () => selectActiveDepegCoins(pegSummaryData?.coins ?? [], ACTIVE_STABLECOIN_ID_SET),
    [pegSummaryData?.coins],
  );
  const marketCaps = useMemo(
    () => new Map((stablecoinsQuery.data?.peggedAssets ?? []).map((coin) => [coin.id, getCirculatingRawOrNull(coin)])),
    [stablecoinsQuery.data?.peggedAssets],
  );
  // Only valid frozen predictions are verdicts, and only from a usable book (docs/homepage.md).
  const verdicts = useMemo(() => {
    const byId = new Map<string, DdrCall>();
    if (!isResolverBookAvailable(resolverData)) return byId;
    for (const row of resolverData.rows) {
      if (row.live.eventState !== "active") continue;
      if (isCurrentForecast(row)) {
        const meta = getTierMeta(getResolution(row).tier, getTierVocabulary(row));
        byId.set(row.stablecoinId, { label: meta.short, title: meta.label, accent: meta.accent });
      } else if (row.prediction.state === "pending_lock" && !byId.has(row.stablecoinId)) {
        const label = DEPEG_PENDING_STATE_LABELS.ddrLock;
        byId.set(row.stablecoinId, { label, title: label, accent: "" });
      }
    }
    return byId;
  }, [resolverData]);

  // The complete summary owns the incident census; the event page supplies detail only.
  const activeRows = useMemo<ActiveRow[]>(() => {
    const eventsById = new Map((data?.events ?? []).map((event) => [event.stablecoinId, event]));
    return activeCoins.map((coin: PegSummaryCoin) => {
      const event = eventsById.get(coin.id);
      const { deviationBps: bps, referenceNote } = readPublishedDeviation(coin.pegCurrency, coin);
      const marketCapUsd = marketCaps.get(coin.id) ?? null;
      return {
        id: coin.id,
        symbol: coin.symbol ?? event?.symbol ?? coin.id,
        bps,
        referenceNote,
        ageSec: event && nowSec > 0 ? Math.max(0, nowSec - event.startedAt) : null,
        evidence: classifyOpenIncidentEvidence(data?.events, coin.id, nowSec),
        marketCapUsd,
        exposureUsd: holderExposureUsd(marketCapUsd, bps),
        verdict: verdicts.get(coin.id) ?? null,
      };
    }).sort((a, b) =>
      rankValue(b.exposureUsd) - rankValue(a.exposureUsd)
      || rankValue(b.bps == null ? null : Math.abs(b.bps)) - rankValue(a.bps == null ? null : Math.abs(a.bps)));
  }, [activeCoins, data?.events, nowSec, marketCaps, verdicts]);

  const rankKey = activeRows.some((row) => row.exposureUsd != null) ? "USD off peg" : "deviation";

  const activeCount = pegSummaryData?.summary?.activeDepegCount ?? null;
  const catalogCount = pegSummaryData?.coins.length ?? null;
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
        catalogCount != null ? (
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
      <div className="flex items-baseline gap-2">
        <RailHeroFigureTransition rail="depeg">
          <span className={`rounded-md pharos-numeric text-3xl font-bold leading-none tracking-tight text-foreground sm:text-4xl ${flashClass}`}>
            {activeCount ?? "—"}
          </span>
        </RailHeroFigureTransition>
        {activeCount !== null ? (
          <span className="min-w-0 truncate text-xs text-muted-foreground">
            {activeCount === 1 ? "coin with an open confirmed incident" : "coins with open confirmed incidents"}
          </span>
        ) : null}
      </div>
      {activeRows.length > MAX_ROWS ? (
        <p className="-mt-1 pharos-meta">Top {MAX_ROWS} of {activeRows.length} by {rankKey}</p>
      ) : null}
      <ul
        aria-label={
          activeRows.length > MAX_ROWS
            ? `Top ${MAX_ROWS} of ${activeRows.length} active depegs by ${rankKey}`
            : `Active depegs by ${rankKey}`
        }
        className="flex flex-col gap-0.5 border-t border-border/50 pt-2 font-mono text-xs"
      >
        {activeRows.slice(0, MAX_ROWS).map((row, index) => (
          <DepegRow key={row.id} row={row} logoSrc={getLogoSrc(logoMap, row.id)} isLead={index === 0} />
        ))}
      </ul>
    </PulseCard>
  );
}

function DepegRow({
  row,
  logoSrc,
  isLead,
}: {
  row: ActiveRow;
  logoSrc: string | undefined;
  isLead: boolean;
}): React.JSX.Element {
  const below = row.bps != null && row.bps < 0;
  const colorClass =
    row.bps == null ? "text-muted-foreground" : below
      ? DEPEG_DIRECTION_CLASSES.below.text : DEPEG_DIRECTION_CLASSES.above.text;
  const isNew = row.ageSec != null && row.ageSec <= WEEK_SECONDS;
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
          <span className="sr-only">{`, ${OPEN_INCIDENT_EVIDENCE_LABELS[row.evidence]}`}</span>
        </span>
        <span
          className={`shrink-0 font-semibold pharos-numeric ${colorClass}`}
          title={row.exposureUsd != null ? `${formatCompactUsdShort(row.exposureUsd)} ${below ? "below" : "above"} peg` : undefined}
        >
          {row.referenceNote ? row.referenceNote : row.bps == null ? "Observation unavailable" : (
            <><span aria-hidden="true" className="mr-0.5">{below ? "↓" : "↑"}</span>{Math.abs(row.bps).toFixed(0)} bps</>
          )}
        </span>
        {/* Second line: DDR verdict, market cap and incident age; unavailable stays named. */}
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
        </span>
      </Link>
    </li>
  );
}
