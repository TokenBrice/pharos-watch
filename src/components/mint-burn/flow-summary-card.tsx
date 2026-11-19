"use client";

import Link from "next/link";
import type { ReactNode } from "react";
import { ArrowRight } from "lucide-react";
import { Card, CardContent, CardHeader } from "@/components/ui/card";
import { StablecoinModuleTitle } from "@/components/stablecoin-detail/module-title";
import {
  DETAIL_MODULE_SHELL_CLASS,
  DETAIL_MODULE_TITLE_CLASS,
} from "@/components/stablecoin-detail/section-title-class";
import { Skeleton } from "@/components/ui/skeleton";
import {
  formatBankRunGaugeScore,
  getLiteralMintingPressureReading,
  PRESSURE_SHIFT_MIN_BASELINE_DAYS,
  type LiteralMintingPressureUnavailableReason,
  type NetFlowDirection24h,
  type PressureShiftState,
} from "@shared/lib/mint-burn-signals";
import { useMintBurnFlows } from "@/hooks/use-mint-burn-flows";
import { formatCurrency, formatEventDate, formatProseList, formatSignedCurrency, formatSignedPercent } from "@shared/lib/format";
import { clamp } from "@shared/lib/math";
import { resolveMintBurnValuation } from "@shared/lib/mint-burn-valuation";
import { getFlowDirectionUi } from "@/lib/flow-signal-ui";
import { getNetColor } from "@shared/lib/classification/flows";
import { SEVERITY_TONE_CLASS } from "@/lib/severity-tone";
import { cn } from "@/lib/utils";
import {
  hasCompleteCoinScan,
  resolveBaselineDailyNetUsd,
  resolveCoinNetFlow,
  resolveNetDirection,
  resolvePressureScore,
  resolvePressureState,
  resolvePressureUnavailableNote,
  type MintBurnNetWindow,
} from "@shared/lib/mint-burn-coin-helpers";
import { describeUnpricedEvents, type MintBurnSignedNetView } from "@shared/lib/mint-burn-valuation-display";
import { FlowSignedNetValue, FlowVolumeValue } from "@/components/mint-burn/flow-valuation-value";
import { MethodologyHint, MethodologyLabel } from "@/components/methodology-hint";
import { EvidenceFooter } from "@/components/stablecoin-detail/evidence-footer";
import { QueryStateNotice } from "@/components/query-state-notice";
import { FreshnessIndicator } from "@/components/status/freshness-indicator";
import { API_FRESHNESS_MAX_AGE_SEC } from "@shared/lib/api-freshness";
import { StaleDataBanner } from "@/components/stale-data-banner";
import { deriveDataHealth } from "@/lib/data-health";
import { DATA_HEALTH_PRESETS } from "@/lib/data-health-config";
import { resolveDetailFlowMeta } from "@/lib/stablecoin-detail-query-view-model";
import type { MintBurnCoinFlow } from "@shared/types/mint-burn";

interface FlowSummaryCardProps {
  stablecoinId: string;
}

/** Signed figures carry a typographic minus. */
function formatSignedUsd(valueUsd: number): string {
  return formatSignedCurrency(valueUsd).replace("-", "−");
}

const WINDOW_DAYS: Record<MintBurnNetWindow, number> = { "24h": 1, "7d": 7, "30d": 30, "90d": 90 };
const WINDOW_LONG_LABEL: Record<MintBurnNetWindow, string> = {
  "24h": "24 hours",
  "7d": "7 days",
  "30d": "30 days",
  "90d": "90 days",
};
const WINDOW_ADJECTIVE: Record<MintBurnNetWindow, string> = { "24h": "24-hour", "7d": "7-day", "30d": "30-day", "90d": "90-day" };
/** Direction chip shape; its tone comes from `getFlowDirectionUi` (green minting, red burning, neutral otherwise). */
const DIRECTION_CHIP_CLASS = "inline-flex items-center gap-1 rounded-full border px-2 py-0.5 text-2xs font-semibold";
/** Hairlines for the full 2×2 (phone) / 1×4 (sm+) net strip, by cell index. */
const STRIP_CELL_BORDER_CLASS = [
  "",
  "border-l border-border/60",
  "border-t border-border/60 sm:border-t-0 sm:border-l",
  "border-l border-t border-border/60 sm:border-t-0",
] as const;
/** Strip columns by how many windows have a figure: the available nets take the whole row. */
const STRIP_GRID_CLASS = ["", "grid-cols-1", "grid-cols-2", "grid-cols-3", "grid-cols-2 sm:grid-cols-4"] as const;
/** U+2011 keeps "30-day" from breaking at its hyphen. */
const BASELINE_30D = "30\u2011day baseline";

function SummarySkeleton() {
  return (
    <Card className={DETAIL_MODULE_SHELL_CLASS}>
      <CardHeader className="border-b border-border/40 px-4 py-4 sm:px-5">
        <Skeleton className="h-4 w-40" />
      </CardHeader>
      <CardContent className="space-y-5 px-4 py-5 sm:px-5">
        <div className="grid gap-4 lg:grid-cols-2">
          <Skeleton className="h-16 w-full rounded-lg" />
          <Skeleton className="h-16 w-full rounded-lg" />
        </div>
        <Skeleton className="h-20 w-full rounded-lg" />
      </CardContent>
    </Card>
  );
}

/** Plain-language reason the 24h balance bar is withheld; `data-reason-codes` keeps the machine code. */
function describeBalanceUnavailable(
  reason: LiteralMintingPressureUnavailableReason | "window-unavailable" | "classification-unresolved" | "classification-unknown",
  window24h: ReturnType<typeof resolveMintBurnValuation>,
): string {
  switch (reason) {
    case "classification-unresolved":
      return "Some 24h events are awaiting classification review.";
    case "classification-unknown":
      return "Older hours in the 24h window have no classification record.";
    case "window-unavailable":
      return "The 24h scan is incomplete.";
    case "valuation-partial":
      return `${describeUnpricedEvents(window24h)} in the last 24h, so the volumes are lower bounds.`;
    case "valuation-unknown":
      return "Pricing coverage of the last 24h is unknown.";
    case "no-24h-volume":
      return "No priced mint or burn volume in the last 24h.";
  }
}

/** How the 24h net compares with the coin's own 30-day baseline (the pressure-shift band). */
function describeBaselineComparison(direction: NetFlowDirection24h, state: PressureShiftState): string {
  if (state === "nr") return "";
  if (state === "stable") return `, close to its ${BASELINE_30D}`;
  const worse = state === "worsening";
  if (direction === "burning") return worse ? `, more burning than its ${BASELINE_30D}` : `, less burning than its ${BASELINE_30D}`;
  if (direction === "minting") return worse ? `, less minting than its ${BASELINE_30D}` : `, more minting than its ${BASELINE_30D}`;
  return worse ? `, below its ${BASELINE_30D}` : `, above its ${BASELINE_30D}`;
}

/** What a pressure-shift figure means, in words; the scale is the coin's own 30-day band. */
const PRESSURE_STATE_MEANING: Record<PressureShiftState, string> = {
  worsening: "More outflow than usual",
  improving: "More inflow than usual",
  stable: "Within its usual range",
  nr: "",
};

function describePressureGap(coin: MintBurnCoinFlow): string {
  const note = resolvePressureUnavailableNote(coin);
  if (note) return note;
  if (coin.coverage?.isPartial) return "Not rated while tracked history is incomplete";
  if (coin.baselineDataDays == null) return "Not rated: no 30-day baseline yet";
  if (coin.baselineDataDays < PRESSURE_SHIFT_MIN_BASELINE_DAYS) {
    return `Not rated until ${PRESSURE_SHIFT_MIN_BASELINE_DAYS} days of history`;
  }
  return "Not rated: 24h volume too small to compare";
}

/** Why the 30-day average is withheld, as the tail of "30-day average daily net …". */
function describeBaselineGap(coin: MintBurnCoinFlow): string {
  if (coin.coverage?.isPartial || coin.coverage?.windows?.window30d.complete === false) {
    return "withheld until 30 days are fully tracked";
  }
  if (coin.classification?.baseline && coin.classification.baseline.completeness !== "complete") {
    return "withheld: events awaiting review";
  }
  if (coin.valuation?.baseline !== "complete") return "withheld: pricing coverage incomplete";
  return "not available until a 30-day baseline exists";
}

/** The pressure-shift gap as a sentence; resolver notes already name the pressure shift. */
function describePressureGapSentence(coin: MintBurnCoinFlow): string {
  const gap = describePressureGap(coin);
  return gap.startsWith("Not rated") ? `Pressure shift ${lowerFirst(gap)}.` : `${gap}.`;
}

function lowerFirst(text: string): string {
  return text.charAt(0).toLowerCase() + text.slice(1);
}

/** One quiet sentence for the windows withheld from the strip, grouped by reason. */
function describeHiddenWindows(coin: MintBurnCoinFlow, cells: readonly NetCell[]): string[] {
  const byReason = new Map<string, MintBurnNetWindow[]>();
  for (const cell of cells) {
    const reason = describeWindowGap(coin, cell.window, cell.net) ?? "Unavailable";
    byReason.set(reason, [...(byReason.get(reason) ?? []), cell.window]);
  }
  return [...byReason].map(([reason, windows]) =>
    `${formatProseList(windows)} ${windows.length === 1 ? "net" : "nets"} ${reason === "Unavailable" ? "unavailable" : `withheld: ${lowerFirst(reason)}`}.`,
  );
}

const CLASSIFICATION_KEY = { "24h": "window24h", "7d": "netFlow7d", "30d": "netFlow30d", "90d": "netFlow90d" } as const;
const SCAN_KEY = { "24h": "window24h", "7d": "window7d", "30d": "window30d", "90d": "window90d" } as const;

/** One short visible reason for a withheld window net (the full note stays in the value's sr-only text). */
function describeWindowGap(coin: MintBurnCoinFlow, window: MintBurnNetWindow, net: MintBurnSignedNetView): string | null {
  if (net.valueUsd != null) return null;
  const classification = coin.classification?.[CLASSIFICATION_KEY[window]];
  if (classification && classification.completeness !== "complete") {
    return classification.unavailableReason === "classification-unresolved" ? "Events awaiting review" : "Older events unclassified";
  }
  if (net.bound || net.completeness === "partial") return "Some events unpriced";
  if (coin.coverage?.windows?.[SCAN_KEY[window]].complete === false) {
    const startedAt = coin.coverage.historyStartAt;
    return startedAt != null && startedAt > Date.now() / 1000 - WINDOW_DAYS[window] * 86_400
      ? `Tracked since ${formatEventDate(startedAt)}`
      : "Scan incomplete";
  }
  return "Unavailable";
}

interface NetCell {
  window: MintBurnNetWindow;
  net: MintBurnSignedNetView;
  /** Covered-portion subtotal of an incomplete window. */
  isPartial: boolean;
}

function supplyShare(cell: NetCell, supplyUsd: number | null): string | null {
  if (cell.net.valueUsd == null || cell.isPartial || supplyUsd == null) return null;
  const pct = (cell.net.valueUsd / supplyUsd) * 100;
  if (pct !== 0 && Math.abs(pct) < 0.005) return "<0.01% of supply";
  return `${formatSignedPercent(pct, 2).replace("-", "−")} of supply`;
}

function NetValue({ cell, className }: { cell: NetCell; className?: string }) {
  return (
    <FlowSignedNetValue
      net={cell.net}
      format={formatSignedUsd}
      colorClassName={getNetColor}
      className={cn(cell.net.valueUsd === 0 && "text-muted-foreground", className)}
    />
  );
}

/** A window renders a figure: a value, a proven bound or a labelled subset, never the bare placeholder. */
function hasNetFigure(net: MintBurnSignedNetView): boolean {
  return net.valueUsd != null || net.bound != null || net.subtotal != null;
}

/** Only windows with a figure get a cell; the card's note names the withheld ones. */
function NetStrip({ cells, coin, supplyUsd }: { cells: readonly NetCell[]; coin: MintBurnCoinFlow; supplyUsd: number | null }) {
  return (
    <dl
      className={cn("grid overflow-hidden rounded-lg border border-border/60", STRIP_GRID_CLASS[cells.length])}
      aria-label="Net mint minus burn by window"
    >
      {cells.map((cell, index) => {
        const subline = supplyShare(cell, supplyUsd) ?? describeWindowGap(coin, cell.window, cell.net);
        return (
          <div
            key={cell.window}
            className={cn(
              "min-w-0 px-3 py-2.5 sm:px-4",
              cells.length === 4 ? STRIP_CELL_BORDER_CLASS[index] : index > 0 && "border-l border-border/60",
            )}
            title={cell.isPartial ? `${WINDOW_ADJECTIVE[cell.window]} window is incomplete; value reflects the covered portion only.` : undefined}
          >
            <dt className="pharos-label">
              {cell.window} net
              {cell.isPartial ? <span className="ml-1">partial</span> : null}
            </dt>
            <dd className={cn("mt-1 pharos-numeric text-lg font-semibold leading-tight text-foreground", cell.isPartial && "opacity-70")}>
              <NetValue cell={cell} />
            </dd>
            {subline ? <dd className="mt-0.5 text-xs text-muted-foreground">{subline}</dd> : null}
          </div>
        );
      })}
    </dl>
  );
}

/**
 * Signed 24h balance on a centred track: −100 all burned, 0 balanced, +100 all
 * minted. Spans with inline offsets, like the other detail primitives. The fill
 * is neutral; amber only when the pressure shift is outside the coin's own
 * 30-day band in the outflow direction (`worsening`).
 */
function MintBurnBalanceBar({ score, alert, burned, minted }: { score: number; alert: boolean; burned: ReactNode; minted: ReactNode }) {
  const pos = (clamp(score, -100, 100) + 100) / 2;
  const mintedShare = Math.round(pos);
  return (
    <div>
      <div
        role="img"
        aria-label={`24h mint and burn balance: ${100 - mintedShare}% of volume burned, ${mintedShare}% minted`}
        className="relative mx-1 h-2 rounded-full bg-muted"
      >
        <span
          className={cn("absolute inset-y-0", alert ? SEVERITY_TONE_CLASS.caution.bar : "bg-muted-foreground/45")}
          style={{ left: `${Math.min(pos, 50)}%`, width: `${Math.abs(pos - 50)}%` }}
        />
        <span className="absolute left-1/2 top-1/2 h-4 w-px -translate-x-1/2 -translate-y-1/2 bg-muted-foreground" />
        <span
          className="absolute top-1/2 h-5 w-1.5 -translate-x-1/2 -translate-y-1/2 rounded-full bg-foreground ring-2 ring-card"
          style={{ left: `${pos}%` }}
        />
      </div>
      <div className="mt-2.5 flex gap-x-3 text-xs text-muted-foreground">
        <span className="flex-1">Burned <span className="pharos-numeric text-foreground">{burned}</span></span>
        <span className="shrink-0" aria-hidden="true">Balanced</span>
        <span className="flex-1 text-right">Minted <span className="pharos-numeric text-foreground">{minted}</span></span>
      </div>
    </div>
  );
}

export function FlowSummaryCard({ stablecoinId }: FlowSummaryCardProps) {
  const query = useMintBurnFlows();
  const { data, isLoading } = query;
  const coin = data?.coins?.find((entry) => entry.stablecoinId === stablecoinId);
  const healthInput = {
    ...DATA_HEALTH_PRESETS.mintBurnFlows,
    label: "Mint and burn flow data",
    dataUpdatedAt: query.dataUpdatedAt,
    meta: resolveDetailFlowMeta(query),
    error: query.error,
    hasData: !!coin,
  };
  const health = deriveDataHealth(healthInput, query.dataUpdatedAt);

  if (isLoading && !data) {
    return <SummarySkeleton />;
  }

  if (query.error && !data) {
    return (
      <Card className={DETAIL_MODULE_SHELL_CLASS}>
        <CardHeader>
          <StablecoinModuleTitle as="h3" className={DETAIL_MODULE_TITLE_CLASS}>
            Mint &amp; Burn Flows
          </StablecoinModuleTitle>
        </CardHeader>
        <CardContent>
          <QueryStateNotice state="unavailable" label="Mint and burn flow data" onRetry={() => void query.refetch()} />
        </CardContent>
      </Card>
    );
  }

  if (!coin) return null;

  const netDirection = resolveNetDirection(coin);
  const pressureScore = resolvePressureScore(coin);
  const pressureState = resolvePressureState(coin);
  const netSignal = getFlowDirectionUi(netDirection);
  const baselineDailyNetUsd = resolveBaselineDailyNetUsd(coin);
  const window24h = resolveMintBurnValuation(coin.valuation?.window24h);
  const supplyUsd = coin.gaugeWeightUsd != null && coin.gaugeWeightUsd > 0 ? coin.gaugeWeightUsd : null;
  // A balance of lower-bound volumes bounds nothing (v6.27): the bar is drawn
  // only from a fully scanned, classified and valued 24h window.
  const balance = coin.classification?.window24h.unavailableReason
    ? { score: null, unavailableReason: coin.classification.window24h.unavailableReason }
    : coin.has24hActivity === null
    || coin.coverage?.windows?.window24h.complete === false
    || (coin.netFlow24hUsd === null && window24h.completeness === "complete")
    ? { score: null, unavailableReason: "window-unavailable" as const }
    : getLiteralMintingPressureReading({
        mintVolume24hUsd: coin.mintVolume24hUsd,
        burnVolume24hUsd: coin.burnVolume24hUsd,
        mintCompleteness: window24h.mintCompleteness,
        burnCompleteness: window24h.burnCompleteness,
      });

  const netCells: NetCell[] = (["24h", "7d", "30d", "90d"] as const).map((window) => {
    const net = resolveCoinNetFlow(coin, window, true);
    const hasWindow = { "24h": coin.coverage?.has24hWindow, "7d": coin.coverage?.has7dWindow, "30d": coin.coverage?.has30dWindow, "90d": coin.coverage?.has90dWindow }[window];
    return { window, net, isPartial: hasWindow === false && net.valueUsd != null };
  });
  const hasCoverageUnknown = netCells.some((cell) => cell.net.valueUsd != null && cell.net.completeness === "unknown");
  const figureCells = netCells.filter((cell) => hasNetFigure(cell.net));

  // Quiet coin: no 24h activity. Collapse to plain lines instead of a bar, a
  // verdict and a strip of zeros; a window is quiet only on an exact, fully
  // evidenced zero net.
  const isQuiet = netDirection === "inactive";
  let quietRun = 0;
  if (isQuiet) {
    while (
      quietRun + 1 < netCells.length
      && netCells[quietRun + 1].net.valueUsd === 0
      && netCells[quietRun + 1].net.completeness === "complete"
      && !netCells[quietRun + 1].isPartial
    ) quietRun++;
  }
  const activeCells = netCells.slice(quietRun + 1);
  // The quiet sentence already states the zero windows, so the strip holds only the rest.
  const stripCells = isQuiet ? activeCells.filter((cell) => hasNetFigure(cell.net)) : figureCells;
  // Withheld figures get no tile and no placeholder: one quiet line names them.
  const gapNotes = [
    ...describeHiddenWindows(coin, (isQuiet ? activeCells : netCells).filter((cell) => !hasNetFigure(cell.net))),
    ...(isQuiet || pressureScore != null ? [] : [describePressureGapSentence(coin)]),
    ...(isQuiet || baselineDailyNetUsd != null ? [] : [`30-day average daily net ${describeBaselineGap(coin)}.`]),
  ];

  const burned = (
    <FlowVolumeValue
      valueUsd={coin.burnVolume24hUsd}
      completeness={window24h.burnCompleteness}
      unpricedEventCount={window24h.unpricedBurnEventCount}
      scanComplete={hasCompleteCoinScan(coin, "24h")}
      format={formatCurrency}
    />
  );
  const minted = (
    <FlowVolumeValue
      valueUsd={coin.mintVolume24hUsd}
      completeness={window24h.mintCompleteness}
      unpricedEventCount={window24h.unpricedMintEventCount}
      scanComplete={hasCompleteCoinScan(coin, "24h")}
      format={formatCurrency}
    />
  );

  // The 24h figure lives in the strip's first tile; the sentence names only the direction.
  const verdict = netDirection === null || netDirection === "inactive"
    ? "Net direction over 24h is unavailable."
    : netDirection === "flat"
      ? `Mints and burns offset over 24h${describeBaselineComparison(netDirection, pressureState)}.`
      : `Net ${netDirection} over 24h${describeBaselineComparison(netDirection, pressureState)}.`;

  return (
    <Card className={DETAIL_MODULE_SHELL_CLASS}>
      <div className="flex flex-wrap items-center justify-between gap-3 border-b border-border/40 px-4 py-4 sm:px-5">
        <StablecoinModuleTitle as="h3" className={DETAIL_MODULE_TITLE_CLASS}>
          Mint &amp; Burn Flows
        </StablecoinModuleTitle>
        <div className="flex items-center gap-2">
          {/* A quiet coin's one sentence already says there was no activity. */}
          {isQuiet ? null : (
            <span className={cn(DIRECTION_CHIP_CLASS, netSignal.badgeClass)}>
              {netDirection === "burning" ? <span aria-hidden="true">▼</span> : null}
              {netDirection === "minting" ? <span aria-hidden="true">▲</span> : null}
              {netSignal.label}
            </span>
          )}
          <FreshnessIndicator
            compact
            updatedAtMs={health.dataUpdatedAt}
            staleAfterMs={API_FRESHNESS_MAX_AGE_SEC.mintBurnFlows * 1000}
            labelPrefix="Updated"
          />
          <MethodologyHint
            topic="mintBurnFlows"
            buttonClassName="!h-5 !min-h-0 !w-5 rounded-md !border-border/60 !bg-muted/50 !text-muted-foreground hover:!border-border hover:!bg-muted hover:!text-foreground dark:!border-border/60 dark:!bg-muted/50 dark:!text-muted-foreground md:!h-5 md:!w-5 md:!min-h-0"
          />
        </div>
      </div>

      <div className="empty:hidden border-b border-border/40 px-4 py-3 sm:px-5">
        <StaleDataBanner queries={[healthInput]} />
      </div>

      <div className="space-y-5 px-4 py-5 sm:px-5">
        {isQuiet ? (
          <div className="space-y-1.5 text-sm">
            <p className="text-muted-foreground">
              No mints or burns in the last 24 hours
              {quietRun > 0 ? `, and no net supply change over ${WINDOW_LONG_LABEL[netCells[quietRun].window]}` : ""}.
            </p>
            {activeCells.length === 1 ? (
              <p className="text-foreground">
                {WINDOW_ADJECTIVE[activeCells[0].window]} net:{" "}
                <NetValue cell={activeCells[0]} className="pharos-numeric font-semibold" />
                {supplyShare(activeCells[0], supplyUsd) ? (
                  <span className="text-muted-foreground"> ({supplyShare(activeCells[0], supplyUsd)})</span>
                ) : null}
              </p>
            ) : null}
          </div>
        ) : (
          <div className="grid gap-x-10 gap-y-5 lg:grid-cols-2 lg:items-center">
            <div>
              <p className="pharos-label mb-3">24h mint / burn balance</p>
              {balance.score != null ? (
                <MintBurnBalanceBar score={balance.score} alert={pressureState === "worsening"} burned={burned} minted={minted} />
              ) : (
                <p className="text-sm text-muted-foreground" data-reason-codes={balance.unavailableReason}>
                  Balance not shown. {describeBalanceUnavailable(balance.unavailableReason, window24h)}
                </p>
              )}
            </div>
            <div className="space-y-3">
              <p className="text-pretty text-sm font-medium leading-relaxed text-foreground">{verdict}</p>
              {pressureScore != null || baselineDailyNetUsd != null ? (
                <dl className="flex flex-wrap gap-x-10 gap-y-2">
                  {pressureScore != null ? (
                    <div className="min-w-0">
                      <dt className="pharos-label">
                        <MethodologyLabel topic="pressureShift">Pressure shift</MethodologyLabel>
                      </dt>
                      <dd
                        className={cn(
                          "mt-0.5 pharos-numeric text-sm font-semibold",
                          pressureState === "worsening" ? SEVERITY_TONE_CLASS.caution.text : "text-foreground",
                        )}
                      >
                        {formatBankRunGaugeScore(pressureScore)}
                      </dd>
                      {PRESSURE_STATE_MEANING[pressureState] ? (
                        <dd className="text-xs text-muted-foreground">{PRESSURE_STATE_MEANING[pressureState]} · ±100 scale</dd>
                      ) : null}
                    </div>
                  ) : null}
                  {baselineDailyNetUsd != null ? (
                    <div className="min-w-0">
                      <dt className="pharos-label">Avg daily net · 30d</dt>
                      <dd className={cn("mt-0.5 pharos-numeric text-sm font-semibold", getNetColor(baselineDailyNetUsd))}>
                        {formatSignedUsd(baselineDailyNetUsd)}
                      </dd>
                    </div>
                  ) : null}
                </dl>
              ) : null}
            </div>
          </div>
        )}

        {(!isQuiet || activeCells.length > 1) && stripCells.length > 0 ? (
          <NetStrip cells={stripCells} coin={coin} supplyUsd={supplyUsd} />
        ) : null}

        <p className="text-xs leading-relaxed text-muted-foreground">
          Tracked chains only; excludes bridge transfers.{supplyUsd != null ? " Supply shares use current tracked-chain supply." : ""}
          {hasCoverageUnknown ? " * Includes hours recorded before pricing checks began, so the total may miss unpriced events." : ""}
          {gapNotes.length > 0 ? <span data-flow-gap-note=""> {gapNotes.join(" ")}</span> : null}
        </p>
      </div>

      <div className="flex flex-wrap items-center justify-between gap-2 border-t border-border/40 px-4 py-2 sm:px-5">
        <EvidenceFooter topic="mintBurnFlows" className="border-t-0 pt-0" />
        {/* A quiet card is one sentence; the flows leaderboard link stays with the active ones. */}
        {isQuiet ? null : (
          <Link
            href="/flows/"
            className="pharos-focus-ring inline-flex min-h-6 items-center gap-1 text-xs text-muted-foreground transition-colors hover:text-foreground"
          >
            View all flows
            <ArrowRight className="h-3 w-3" aria-hidden="true" />
          </Link>
        )}
      </div>
    </Card>
  );
}
