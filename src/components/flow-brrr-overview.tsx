"use client";

import { useMemo } from "react";
import { FlowMachineScene } from "@/components/flow-machine-scene";
import { MintingPressureGauge } from "@/components/minting-pressure-gauge";
import { FlowReceiptBand } from "@/components/flow-receipt-band";
import { CardExpandButton } from "@/components/home-alt-mini-cards/pulse-card-header";
import { getNetPrefix } from "@shared/lib/format";
import type {
  MintBurnCoinFlow,
  MintBurnGauge,
  MintBurnHourlyBucket,
} from "@shared/types";
import {
  buildFlowOverviewDescription,
  buildFlowOverviewHeadline,
  getFlowDirectionUi,
  getFlowPressureUi,
  type FlowDirectionUi,
  type FlowPressureUi,
} from "@/lib/flow-signal-ui";
import { cn } from "@/lib/utils";
import { clamp } from "@shared/lib/math";
import {
  getNetFlowDirection24h,
  getPressureShiftState,
  type NetFlowDirection24h,
  type PressureShiftState,
} from "@shared/lib/mint-burn-signals";
import { getPressureShiftDisplay } from "@/lib/flow-intensity";
import { MethodologyLabel } from "@/components/methodology-hint";

interface FlowBrrrOverviewProps {
  gauge: MintBurnGauge | null;
  coins: MintBurnCoinFlow[];
  weeklyHourly?: MintBurnHourlyBucket[];
  isLoading?: boolean;
  className?: string;
  variant?: "default" | "compact";
  scopeLabel?: string;
  syncWarning?: string | null;
}

interface FlowSnapshot {
  mint24h: number;
  burn24h: number;
  net24h: number;
  score: number | null;
  trackedCoins: number;
  headline: string;
  description: string;
  leverPct: number | null;
  has24hActivity: boolean;
  netDirection: NetFlowDirection24h;
  pressureState: PressureShiftState;
  directionUi: FlowDirectionUi;
  pressureUi: FlowPressureUi;
}

function buildSnapshot(
  gauge: MintBurnGauge | null,
  coins: MintBurnCoinFlow[],
): FlowSnapshot {
  let mint24h = 0;
  let burn24h = 0;
  let net24h = 0;

  for (const coin of coins) {
    mint24h += coin.mintVolume24hUsd;
    burn24h += coin.burnVolume24hUsd;
    net24h += coin.netFlow24hUsd;
  }

  const score = gauge?.score ?? null;
  const has24hActivity = Boolean(mint24h || burn24h || net24h);
  const netDirection = getNetFlowDirection24h({
    netFlow24hUsd: net24h,
    has24hActivity,
  });
  const pressureState = getPressureShiftState(score);
  const leverPct = score === null ? null : clamp((score + 100) / 2, 0, 100);

  return {
    mint24h,
    burn24h,
    net24h,
    score,
    trackedCoins: gauge?.trackedCoins ?? coins.length,
    headline: buildFlowOverviewHeadline(netDirection, pressureState),
    description: buildFlowOverviewDescription(netDirection, pressureState),
    leverPct,
    has24hActivity,
    netDirection,
    pressureState,
    directionUi: getFlowDirectionUi(netDirection, "overview"),
    pressureUi: getFlowPressureUi(pressureState, "overview"),
  };
}

function LoadingState() {
  return (
    <div className="space-y-4">
      <div className="pharos-card-shell animate-pulse p-4 sm:p-6">
        <div className="h-4 w-44 rounded bg-muted/60" />
        <div className="mt-4 h-9 w-full max-w-[620px] rounded bg-muted/60" />
        <div className="mt-4 h-4 w-full max-w-[760px] rounded bg-muted/60" />
        <div className="mt-5 h-32 rounded-xl bg-muted/60" />
      </div>
    </div>
  );
}

export function FlowBrrrOverview({
  gauge,
  coins,
  weeklyHourly,
  isLoading,
  className,
  variant = "default",
  scopeLabel = "Configured issuance chains",
  syncWarning = null,
}: FlowBrrrOverviewProps) {
  const snapshot = useMemo(
    () => buildSnapshot(gauge, coins),
    [gauge, coins],
  );

  if (isLoading) {
    return <LoadingState />;
  }

  const isCompact = variant === "compact";
  const totalFlow24h = snapshot.mint24h + snapshot.burn24h;
  const netDominance = snapshot.has24hActivity
    ? Math.abs(snapshot.net24h) / Math.max(totalFlow24h, 1)
    : 0.08;
  const pressurePower = snapshot.score === null
    ? 0.18
    : Math.abs(snapshot.score) / 100;
  const sceneIntensity = snapshot.netDirection === "flat"
    ? 0.12
    : clamp(Math.max(netDominance, pressurePower * 0.6), 0.12, 1);
  const sceneStress = snapshot.score === null || snapshot.score >= -10
    ? 0
    : clamp((-10 - snapshot.score) / 90, 0, 1);
  const gaugeDisplay = snapshot.score == null
    ? null
    : getPressureShiftDisplay(snapshot.score);
  const receiptBand = (
    <FlowReceiptBand
      gauge={gauge}
      coins={coins}
      weeklyHourly={weeklyHourly}
      scopeLabel={scopeLabel}
      syncWarning={syncWarning}
      variant={isCompact ? "compact" : "default"}
      className={isCompact ? "border-t border-dashed border-border/70 pt-4" : undefined}
    />
  );

  return (
    <div className={cn("h-full space-y-5", className)}>
      <article
        className={cn(
          "pharos-card-shell",
          isCompact ? "p-4 sm:p-5" : "p-4 sm:p-6",
        )}
      >
        <div className="space-y-5">
          <header className="flex items-start justify-between gap-2">
            <div className="flex flex-wrap items-center gap-2">
              <span
                className={cn(
                  "inline-flex rounded-full border px-2 py-0.5 text-[11px] font-semibold",
                  snapshot.directionUi.badgeClass,
                )}
              >
                {snapshot.directionUi.label}
              </span>
              <span
                className={cn(
                  "inline-flex rounded-full border px-2 py-0.5 text-[11px] font-semibold",
                  snapshot.pressureUi.badgeClass,
                )}
              >
                {snapshot.pressureUi.label}
              </span>
              {gauge?.flightToQuality && (
                <span className="inline-flex rounded-full border border-amber-600/35 bg-amber-500/15 px-2 py-0.5 text-[11px] font-semibold text-amber-700 dark:border-amber-500/40 dark:text-amber-300">
                  FTQ {Math.round(gauge.flightIntensity)}%
                </span>
              )}
            </div>
            <CardExpandButton
              href="/timeline/?type=mint_burn.*"
              expandLabel="See all mint/burn events on the Timeline"
            />
          </header>

          <div
            className={cn(
              "grid",
              isCompact
                ? "gap-4 2xl:grid-cols-[minmax(0,1.12fr)_minmax(15rem,0.88fr)]"
                : "gap-5 lg:grid-cols-[1.2fr_1fr]",
            )}
          >
            <div className="flex flex-col gap-4">
              <h3
                className={cn(
                  isCompact
                    ? "text-3xl font-black leading-[0.94] tracking-tight md:text-4xl 2xl:text-5xl"
                    : "text-3xl font-black tracking-tight sm:text-5xl",
                  snapshot.pressureUi.headlineClass,
                )}
              >
                {snapshot.headline}
              </h3>
              <p
                className={cn(
                  "text-sm text-muted-foreground",
                  isCompact ? "max-w-[34rem]" : undefined,
                )}
              >
                {snapshot.description}
              </p>
            </div>

            <div className="flex flex-col">
              <FlowMachineScene
                size={isCompact ? "mini" : "full"}
                mode={snapshot.directionUi.sceneMode}
                intensity={sceneIntensity}
                statusText={snapshot.directionUi.label}
                title={isCompact ? undefined : snapshot.directionUi.sceneTitle}
                subText={isCompact ? undefined : `Tracking ${snapshot.trackedCoins} stablecoins`}
                accentHex={snapshot.directionUi.accentHex}
                stress={sceneStress}
              />
            </div>
          </div>

          {isCompact ? (
            receiptBand
          ) : (
            <div className="border-t border-dashed border-border/70 pt-5">
              {receiptBand}
            </div>
          )}
        </div>
      </article>

      <section
        className="grid gap-3 sm:grid-cols-2"
        aria-label="Mint and burn pressure gauges"
      >
        <div
          className={cn(
            "space-y-2 rounded-xl border p-3",
            snapshot.pressureUi.panelClass,
          )}
        >
          <div className="flex items-center justify-between text-xs text-muted-foreground">
            <MethodologyLabel topic="bankRunGauge">
              Bank Run Gauge (pressure vs 30D)
            </MethodologyLabel>
            <span className="pharos-numeric">
              {gaugeDisplay == null
                ? "NR"
                : `${getNetPrefix(gaugeDisplay)}${gaugeDisplay} / 100`}
            </span>
          </div>
          <div className="relative h-3 rounded-full border border-border/60 bg-muted/25">
            <div
              className="h-full rounded-full"
              style={{
                background:
                  "linear-gradient(90deg, var(--severity-severe-hex) 0%, var(--severity-moderate-hex) 35%, var(--severity-mild-hex) 55%, var(--severity-healthy-hex) 100%)",
              }}
            />
            {snapshot.leverPct !== null && (
              <div
                className="absolute top-1/2 h-5 w-5 -translate-y-1/2 rounded-full border-2 border-background bg-foreground ring-2 ring-foreground/30 transition-all"
                style={{ left: `calc(${snapshot.leverPct}% - 10px)` }}
                role="img"
                aria-label={`Bank Run Gauge at ${Math.round(snapshot.leverPct)}%`}
              />
            )}
          </div>
          <p className="text-xs text-muted-foreground">
            The gauge is a market-cap-weighted pressure-shift signal, not a literal mint-vs-burn direction meter.
          </p>
        </div>

        <MintingPressureGauge
          mintVolume24hUsd={snapshot.mint24h}
          burnVolume24hUsd={snapshot.burn24h}
        />
      </section>
    </div>
  );
}
