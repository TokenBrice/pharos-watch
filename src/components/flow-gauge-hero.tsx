"use client";

import { useMemo } from "react";
import { FeatureHeroSplit, HeroMetricRow } from "@/components/feature-hero-split";
import { FlowRunLine } from "@/components/flow-run-line";
import { FlowSignedNetValue, FlowVolumeValue } from "@/components/flow-valuation-value";
import { MethodologyLabel } from "@/components/methodology-hint";
import { OpsStatusChip } from "@/components/ops-status-chip";
import { UniverseChip } from "@/components/universe-chip";
import { Skeleton } from "@/components/ui/skeleton";
import { buildRunLineModel, selectRunLineDrivers, type RunLineModel } from "@/lib/flow-run-line-model";
import { formatDataHealthWarning, type DataHealthInfo } from "@/lib/data-health";
import { buildGaugeVerdict } from "@/lib/flow-signal-ui";
import { cn } from "@/lib/utils";
import { API_FRESHNESS_MAX_AGE_SEC } from "@shared/lib/api-freshness";
import { GAUGE_BAND_LABELS, GAUGE_BAND_TONE_CLASSES } from "@shared/lib/classification";
import { formatCurrency, formatElapsedSeconds, formatSignedCurrency, getNetColor } from "@shared/lib/format";
import { aggregateCoinFlows24h } from "@shared/lib/mint-burn-coin-helpers";
import { formatBankRunGaugeScore } from "@shared/lib/mint-burn-signals";
import type { MintBurnCoinFlow, MintBurnFlowsResponse, MintBurnGauge } from "@shared/types";
import { MINT_BURN_FTQ_DEPENDENCY_KEY } from "@shared/types/mint-burn";

const SYNC_TIME_FORMAT = new Intl.DateTimeFormat("en-GB", {
  day: "numeric",
  month: "short",
  hour: "2-digit",
  minute: "2-digit",
  hourCycle: "h23",
  timeZone: "UTC",
});

interface FlowGaugeHeroProps {
  gauge: MintBurnGauge | null;
  coins: MintBurnCoinFlow[];
  sync: MintBurnFlowsResponse["sync"] | null;
  /** The worst degraded or stale read behind the page (`deriveDataHealth`); a chip, never a banner. */
  dataHealth?: DataHealthInfo | null;
  isLoading?: boolean;
}

const DATA_HEALTH_CHIP_LABELS = {
  age: "Data delayed",
  source: "Source warning",
  refresh: "Refresh failed",
  "catch-up": "Sources catching up",
} as const;

/** The data-health finding as a chip: label, machine reasons, and the budget and generation it was judged against (R3/R4). */
function DataHealthChip({ health }: { health: DataHealthInfo }) {
  const label = health.state === "stale"
    ? "Older snapshot"
    : DATA_HEALTH_CHIP_LABELS[health.degradationReason ?? "age"];
  const reason = health.meta && "reason" in health.meta ? health.meta.reason : undefined;
  const budgetSec = health.meta && "freshBudgetSec" in health.meta && typeof health.meta.freshBudgetSec === "number"
    ? health.meta.freshBudgetSec
    : API_FRESHNESS_MAX_AGE_SEC.mintBurnFlows;
  const codes = [`data-health-${health.state}`, health.degradationReason, typeof reason === "string" ? reason : undefined]
    .filter((code): code is string => Boolean(code));
  return (
    <OpsStatusChip label={label} reasonCodes={codes}>
      <p>{health.message}</p>
      {health.meta?.warning ? <p>{formatDataHealthWarning(health.meta.warning)}</p> : null}
      <p className="text-muted-foreground">
        Flow observation budget: fresh within {formatElapsedSeconds(budgetSec)}
        {health.ageMs != null ? ` · generation ${formatElapsedSeconds(health.ageMs / 1000)} old` : " · generation time unknown"}.
      </p>
    </OpsStatusChip>
  );
}

function HeroLoading() {
  return (
    <div className="pharos-card-shell grid gap-6 p-5 sm:p-6 lg:grid-cols-[minmax(0,4fr)_minmax(0,8fr)] lg:p-7">
      <div className="space-y-3">
        <Skeleton className="h-4 w-56" />
        <Skeleton className="h-10 w-32" />
        <Skeleton className="h-6 w-48" />
        <Skeleton className="mt-6 h-24 w-full" />
      </div>
      <Skeleton className="h-56 w-full" />
    </div>
  );
}

/**
 * Ops and partial-input state for the beam, each an amber chip with its
 * machine-readable reason (R4) and the budget or counts behind it (R3). Codes
 * name the published field that set them; none is inferred from figures.
 */
function GaugeStatusChips({
  gauge,
  sync,
  model,
  dataHealth,
}: {
  gauge: MintBurnGauge | null;
  sync: MintBurnFlowsResponse["sync"] | null;
  model: RunLineModel;
  dataHealth: DataHealthInfo | null;
}) {
  const scoredCoins = model.ticks.length;
  const withheld = gauge?.partialValuationInputs ?? 0;
  const weightsMissing = gauge?.mcapUnavailableCoins ?? 0;
  const budgetMin = Math.round(API_FRESHNESS_MAX_AGE_SEC.mintBurnFlows / 60);
  const ftqDependency = dataHealth?.meta?.dependencies?.[MINT_BURN_FTQ_DEPENDENCY_KEY];
  const classificationReason = gauge?.classificationReason ?? ftqDependency?.reason ?? "classification-unavailable";
  return (
    <>
      {gauge && gauge.score == null ? (
        <OpsStatusChip label="Not rated" reasonCodes={["gauge-score-null"]}>
          <p>
            No weighted coin has a pressure shift this window. A coin scores with 7 days of baseline history, at
            least $50K of 24h flow and a fully valued window.
          </p>
        </OpsStatusChip>
      ) : null}
      {model.bandUnsettled ? (
        <OpsStatusChip label="Band unsettled" reasonCodes={["band-not-robust-to-withheld-weight"]}>
          <p>
            Weight withheld for valuation could carry the full-cohort score across a band edge, so no band is
            claimed.
          </p>
          <p className="text-muted-foreground">
            {model.scoreInterval
              ? `Full-cohort score could be ${formatBankRunGaugeScore(model.scoreInterval[0])} to ${formatBankRunGaugeScore(model.scoreInterval[1])}.`
              : "The withheld weight is not published, so the score is unbounded."}
          </p>
        </OpsStatusChip>
      ) : null}
      {withheld > 0 ? (
        <OpsStatusChip label="Partial valuation" reasonCodes={["partial-valuation-inputs"]}>
          <p>
            {withheld} weighted {withheld === 1 ? "coin has" : "coins have"} unpriced events in the 24h window or
            baseline, so {withheld === 1 ? "its pressure is" : "their pressure is"} withheld and the gauge re-weights
            over the {scoredCoins} scored {scoredCoins === 1 ? "coin" : "coins"}.
          </p>
          {gauge?.scoredMcapUsd != null && gauge.partialValuationMcapUsd != null ? (
            <p className="text-muted-foreground">
              Scored weight {formatCurrency(gauge.scoredMcapUsd, 1)} · withheld weight{" "}
              {formatCurrency(gauge.partialValuationMcapUsd, 1)}.
            </p>
          ) : null}
        </OpsStatusChip>
      ) : null}
      {weightsMissing > 0 ? (
        <OpsStatusChip label="Weights missing" reasonCodes={["mcap-unavailable-coins"]}>
          <p>
            {weightsMissing} tracked {weightsMissing === 1 ? "coin has" : "coins have"} no observed supply weight, so
            the gauge excludes {weightsMissing === 1 ? "it" : "them"} rather than weighting them at zero.
          </p>
        </OpsStatusChip>
      ) : null}
      {gauge?.classificationSource === "unavailable" ? (
        <OpsStatusChip label="FTQ unavailable" reasonCodes={["classification-unavailable", classificationReason]}>
          <p>{sync?.classificationWarning
            ? formatDataHealthWarning(sync.classificationWarning)
            : `Flight-to-quality classification is unavailable because the Safety Score source could not be admitted (${classificationReason}).`}</p>
          {ftqDependency ? (
            <p className="text-muted-foreground">
              Safety Score dependency budget: {ftqDependency.freshBudgetSec != null
                ? formatElapsedSeconds(ftqDependency.freshBudgetSec) : "unknown"}
              {ftqDependency.updatedAt != null
                ? ` · accepted publication ${SYNC_TIME_FORMAT.format(new Date(ftqDependency.updatedAt * 1000))} UTC`
                : " · source generation unknown"}
              {ftqDependency.ageSeconds != null ? ` · source ${formatElapsedSeconds(ftqDependency.ageSeconds)} old` : ""}.
            </p>
          ) : null}
        </OpsStatusChip>
      ) : gauge?.flightToQuality === null ? (
        <OpsStatusChip label="FTQ unavailable" reasonCodes={["valuation-incomplete"]}>
          <p>Missing valuation could change the flight-to-quality verdict, so none is published.</p>
        </OpsStatusChip>
      ) : null}
      {dataHealth && !sync?.warning ? <DataHealthChip health={dataHealth} /> : null}
      {sync?.warning ? (
        <OpsStatusChip label="Sync delayed" reasonCodes={[`freshness-${sync.freshnessStatus}`]}>
          <p>{formatDataHealthWarning(sync.warning)}</p>
          <p className="text-muted-foreground">
            Budget: {budgetMin} min from the last critical-lane sync
            {sync.lastSuccessfulSyncAt != null
              ? ` · last sync ${SYNC_TIME_FORMAT.format(new Date(sync.lastSuccessfulSyncAt * 1000))} UTC`
              : " · no successful sync recorded"}
            .
          </p>
        </OpsStatusChip>
      ) : null}
    </>
  );
}

/**
 * /flows/ One Beam hero: the Bank Run Gauge in neutral ink with its published
 * band chip, a structured verdict, the 24h receipt as three facts, and the run
 * line showing why the gauge sits where it does. Degraded states are chips and
 * the beam label, never a headline.
 */
export function FlowGaugeHero({ gauge, coins, sync, dataHealth = null, isLoading }: FlowGaugeHeroProps) {
  const model = useMemo(() => buildRunLineModel(gauge, coins), [gauge, coins]);
  const aggregate = useMemo(() => aggregateCoinFlows24h(coins), [coins]);

  if (isLoading) return <HeroLoading />;

  const { score, band } = model;
  const scoredCoins = model.ticks.length;
  const withheld = model.withheldForValuation;
  const verdict = buildGaugeVerdict(model.bandUnsettled ? "unsettled" : band, selectRunLineDrivers(model));
  const trackedCoins = gauge?.trackedCoins ?? coins.length;

  return (
    <FeatureHeroSplit
      ariaLabel="Bank Run Gauge overview"
      mobileSubBeforeVisual
      beamLabel={
        <>
          <MethodologyLabel topic="bankRunGauge">Bank Run Gauge</MethodologyLabel>
          <span> · </span>
          <span className="hidden sm:inline">pressure </span>
          <span>vs 30-day norm</span>
          {withheld > 0 ? (
            <>
              {" "}
              <span className="whitespace-nowrap text-state-warn-strong">
                · partial: {withheld} weighted {withheld === 1 ? "coin" : "coins"} withheld
              </span>
            </>
          ) : null}
        </>
      }
      status={<GaugeStatusChips gauge={gauge} sync={sync} model={model} dataHealth={dataHealth} />}
      beamValue={
        score != null ? (
          <span className="inline-flex items-baseline gap-3">
            {formatBankRunGaugeScore(score)}
            {/* The band is a semantic scale, so it alone carries colour; an unsettled band is not printed. */}
            {band != null ? (
              <span
                className={cn(
                  "rounded-md border px-2 py-0.5 font-sans text-base font-semibold tracking-normal",
                  GAUGE_BAND_TONE_CLASSES[band],
                )}
              >
                {GAUGE_BAND_LABELS[band]}
              </span>
            ) : null}
          </span>
        ) : (
          <span className="text-muted-foreground">
            <span aria-hidden="true">—</span>
            <span className="sr-only">Not rated</span>
          </span>
        )
      }
      universe={
        <UniverseChip universe="active" value={`${scoredCoins} of ${trackedCoins} flow-tracked scored`} />
      }
      subKicker="Last 24 hours"
      sub={
        <div className="space-y-3">
          <p className="text-pretty text-sm leading-relaxed text-foreground/85">{verdict}</p>
          <div className="divide-y divide-border/50">
            <HeroMetricRow
              label="Printed 24h"
              value={
                <FlowVolumeValue
                  valueUsd={aggregate.mintVolumeUsd}
                  completeness={aggregate.mintCompleteness}
                  unpricedEventCount={aggregate.unpricedMintEventCount}
                  scanComplete={aggregate.scanComplete}
                  format={formatCurrency}
                />
              }
            />
            <HeroMetricRow
              label="Shredded 24h"
              value={
                <FlowVolumeValue
                  valueUsd={aggregate.burnVolumeUsd}
                  completeness={aggregate.burnCompleteness}
                  unpricedEventCount={aggregate.unpricedBurnEventCount}
                  scanComplete={aggregate.scanComplete}
                  format={formatCurrency}
                />
              }
            />
            <HeroMetricRow
              label="Net 24h"
              value={
                <FlowSignedNetValue
                  net={aggregate.net}
                  format={formatSignedCurrency}
                  colorClassName={getNetColor}
                  placeholder="NR"
                />
              }
              detail={aggregate.net.bound ? "proven bound" : undefined}
            />
            {gauge?.flightToQuality === true ? (
              <HeroMetricRow
                label="Flight to quality"
                value={<span className="text-state-warn-strong">Active</span>}
                detail={gauge.flightIntensity != null ? `${Math.round(gauge.flightIntensity)}% intensity` : undefined}
              />
            ) : null}
          </div>
        </div>
      }
    >
      <div className="flex h-full flex-col justify-center p-5 sm:p-6 lg:p-7">
        <FlowRunLine model={model} />
      </div>
    </FeatureHeroSplit>
  );
}
