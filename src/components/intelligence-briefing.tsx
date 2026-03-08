"use client";

import { useMemo } from "react";
import { Skeleton } from "@/components/ui/skeleton";
import { useStabilityIndex } from "@/hooks/use-stability-index";
import { usePegSummary } from "@/hooks/use-peg-summary";
import { useStressSignals } from "@/hooks/use-stress-signals";
import { useMintBurnFlows } from "@/hooks/use-mint-burn-flows";
import { useEntranceSequence } from "@/hooks/use-entrance-sequence";
import {
  buildBriefing,
  type BriefingInput,
  type BriefingOutput,
} from "@/lib/build-briefing";
import { PSI_BAND_CLASSES, type ConditionBand } from "@shared/lib/psi-colors";

// ---------------------------------------------------------------------------
// Static Tailwind classes for subtle band-tinted backgrounds (5-10% opacity)
// These must be static strings for Tailwind purge to detect them.
// ---------------------------------------------------------------------------

const PSI_BG_CLASSES: Record<ConditionBand, string> = {
  BEDROCK: "bg-green-500/[0.06] dark:bg-green-500/[0.08]",
  STEADY: "bg-teal-500/[0.06] dark:bg-teal-500/[0.08]",
  TREMOR: "bg-yellow-500/[0.06] dark:bg-yellow-500/[0.08]",
  FRACTURE: "bg-orange-500/[0.06] dark:bg-orange-500/[0.08]",
  CRISIS: "bg-red-500/[0.06] dark:bg-red-500/[0.08]",
  MELTDOWN: "bg-red-800/[0.08] dark:bg-red-800/[0.10]",
};

const PSI_BORDER_TINT_CLASSES: Record<ConditionBand, string> = {
  BEDROCK: "border-green-500/20 dark:border-green-500/15",
  STEADY: "border-teal-500/20 dark:border-teal-500/15",
  TREMOR: "border-yellow-500/20 dark:border-yellow-500/15",
  FRACTURE: "border-orange-500/20 dark:border-orange-500/15",
  CRISIS: "border-red-500/20 dark:border-red-500/15",
  MELTDOWN: "border-red-800/20 dark:border-red-800/15",
};

// ---------------------------------------------------------------------------
// Data transformation helpers
// ---------------------------------------------------------------------------

function useBriefingInput(): {
  input: BriefingInput | null;
  isLoading: boolean;
  allErrored: boolean;
} {
  const psiQuery = useStabilityIndex();
  const pegQuery = usePegSummary();
  const stressQuery = useStressSignals();
  const flowQuery = useMintBurnFlows(24);

  const isLoading =
    psiQuery.isLoading ||
    pegQuery.isLoading ||
    stressQuery.isLoading ||
    flowQuery.isLoading;

  const allErrored =
    !!psiQuery.error &&
    !!pegQuery.error &&
    !!stressQuery.error &&
    !!flowQuery.error;

  const input = useMemo<BriefingInput | null>(() => {
    const psiData = psiQuery.data;
    const pegData = pegQuery.data;
    const stressData = stressQuery.data;
    const flowData = flowQuery.data;

    // Need at least PSI to generate a meaningful briefing
    const psiCurrent = psiData?.current;
    if (!psiCurrent) return null;

    // --- PSI ---
    const psiScore = psiCurrent.avg24h ?? psiCurrent.score;
    const psiBand = psiCurrent.avg24hBand ?? psiCurrent.band;
    const history = psiData?.history ?? [];

    let daysInBand = 1;
    for (const point of history) {
      if (point.band === psiBand) daysInBand++;
      else break;
    }

    const delta24h =
      history.length > 0 ? psiScore - history[0].score : 0;
    const delta7d =
      history.length >= 7 ? psiScore - history[6].score : 0;

    // --- Depegs ---
    const coins = pegData?.coins ?? [];
    const activeCoins = coins
      .filter((c) => c.activeDepeg && c.currentDeviationBps !== null)
      .map((c) => ({ symbol: c.symbol, bps: Math.abs(c.currentDeviationBps!) }));

    // Find last closed event (most recent non-active coin with lastEventAt)
    let lastClosedCoin: string | null = null;
    let lastClosedDaysAgo: number | null = null;
    let lastClosedBps: number | null = null;

    if (activeCoins.length === 0) {
      const nowSec = Date.now() / 1000;
      let recentTs = 0;
      for (const c of coins) {
        if (!c.activeDepeg && c.lastEventAt && c.lastEventAt > recentTs) {
          recentTs = c.lastEventAt;
          lastClosedCoin = c.symbol;
          lastClosedDaysAgo = Math.round((nowSec - c.lastEventAt) / 86400);
          lastClosedBps =
            c.worstDeviationBps !== null
              ? Math.abs(c.worstDeviationBps)
              : null;
        }
      }
    }

    // --- DEWS ---
    let dangerCount = 0;
    let alertCount = 0;
    let warningCount = 0;
    const topStressed: Array<{ symbol: string; band: string }> = [];

    if (stressData?.signals) {
      const dangerEntries: Array<{ id: string; score: number }> = [];
      for (const [id, entry] of Object.entries(stressData.signals)) {
        if (entry.band === "DANGER") {
          dangerCount++;
          dangerEntries.push({ id, score: entry.score });
        } else if (entry.band === "ALERT") {
          alertCount++;
        } else if (entry.band === "WARNING") {
          warningCount++;
        }
      }
      // Top stressed: up to 3 danger coins by score desc
      dangerEntries
        .sort((a, b) => b.score - a.score)
        .slice(0, 3)
        .forEach((e) => {
          // Extract symbol from the stablecoin ID (e.g. "tether" -> find in peg data)
          const pegCoin = coins.find((c) => c.id === e.id);
          topStressed.push({
            symbol: pegCoin?.symbol ?? e.id,
            band: "DANGER",
          });
        });
    }

    // --- Flows ---
    const flowCoins = flowData?.coins ?? [];
    let net24h = 0;
    let net7d = 0;
    for (const coin of flowCoins) {
      net24h += coin.netFlow24hUsd;
      net7d += coin.netFlow7dUsd;
    }

    const direction: "minting" | "burning" | "neutral" =
      net24h > 1_000_000
        ? "minting"
        : net24h < -1_000_000
          ? "burning"
          : "neutral";

    // isStrongestIn7d: today's absolute net > each of the past days' absolute net
    // Approximation: compare 24h abs to (7d abs / 7)
    const avg7dAbs = net7d !== 0 ? Math.abs(net7d) / 7 : 0;
    const isStrongestIn7d =
      avg7dAbs > 0 && Math.abs(net24h) > avg7dAbs * 1.5;

    const ftqTriggered = flowData?.gauge.flightToQuality ?? false;

    // Bank run elevated: gauge band is CRISIS or STRESS
    const gaugeBand = flowData?.gauge.band ?? null;
    const bankRunElevated =
      gaugeBand === "CRISIS" || gaugeBand === "STRESS";

    return {
      psi: {
        score: Math.round(psiScore * 10) / 10,
        band: psiBand,
        delta24h: Math.round(delta24h * 10) / 10,
        delta7d: Math.round(delta7d * 10) / 10,
        daysInBand,
      },
      depegs: {
        activeCount: activeCoins.length,
        activeCoins,
        lastClosedCoin,
        lastClosedDaysAgo,
        lastClosedBps,
      },
      dews: {
        dangerCount,
        alertCount,
        warningCount,
        topStressed,
      },
      flows: {
        net24hUsd: net24h,
        direction,
        isStrongestIn7d,
        ftqTriggered,
        bankRunElevated,
      },
    };
  }, [psiQuery.data, pegQuery.data, stressQuery.data, flowQuery.data]);

  return { input, isLoading, allErrored };
}

// ---------------------------------------------------------------------------
// Highlight the band keyword in the headline with its semantic color
// ---------------------------------------------------------------------------

function renderHeadline(headline: string, bandKeyword: string) {
  const colorClass = PSI_BAND_CLASSES[bandKeyword as ConditionBand] ?? "";

  // The band keyword appears in the headline as part of "(BAND)".
  // Split on the band keyword and wrap it in a styled <strong>.
  const idx = headline.indexOf(bandKeyword);
  if (idx === -1) {
    return <span>{headline}</span>;
  }

  const before = headline.slice(0, idx);
  const after = headline.slice(idx + bandKeyword.length);

  return (
    <span>
      {before}
      <strong className={colorClass}>{bandKeyword}</strong>
      {after}
    </span>
  );
}

// ---------------------------------------------------------------------------
// Wrap numbers in supporting lines with font-mono
// ---------------------------------------------------------------------------

function renderLineText(text: string) {
  // Match numbers like $1.2B, $340M, 42, 3.5, 150 bps, percentages, etc.
  const parts = text.split(/(\$[\d,.]+[BMK]?|\d+(?:\.\d+)?(?:\s*bps)?)/g);
  return (
    <>
      {parts.map((part, i) =>
        /^\$[\d,.]+[BMK]?$|^\d+(?:\.\d+)?(?:\s*bps)?$/.test(part) ? (
          <span key={i} className="font-mono tabular-nums">
            {part}
          </span>
        ) : (
          <span key={i}>{part}</span>
        ),
      )}
    </>
  );
}

// ---------------------------------------------------------------------------
// Skeleton for loading state
// ---------------------------------------------------------------------------

function BriefingSkeleton() {
  return (
    <div className="rounded-xl border border-border/70 bg-card/78 px-4 py-3.5 space-y-2.5">
      <Skeleton className="h-4 w-3/4" />
      <div className="space-y-1.5">
        <Skeleton className="h-3.5 w-5/6" />
        <Skeleton className="h-3.5 w-2/3" />
        <Skeleton className="h-3.5 w-3/5" />
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Line type icon hints (subtle visual differentiation)
// ---------------------------------------------------------------------------

const LINE_BULLETS: Record<string, string> = {
  depegs: "\u25CF", // filled circle
  stress: "\u25B2", // triangle
  flows: "\u25C6",  // diamond
  "calm-summary": "\u2713", // checkmark
  extra: "\u26A0",  // warning sign
};

// ---------------------------------------------------------------------------
// Main component
// ---------------------------------------------------------------------------

export function IntelligenceBriefing() {
  const { input, isLoading, allErrored } = useBriefingInput();
  const { delayFor } = useEntranceSequence();

  const briefing = useMemo<BriefingOutput | null>(
    () => (input ? buildBriefing(input) : null),
    [input],
  );

  if (isLoading) return <BriefingSkeleton />;
  if (allErrored || !briefing) return null;

  const band = briefing.bandKeyword as ConditionBand;
  const bgClass = PSI_BG_CLASSES[band] ?? "";
  const borderClass = PSI_BORDER_TINT_CLASSES[band] ?? "border-border/70";

  return (
    <div
      className={`rounded-xl border px-4 py-3.5 ${bgClass} ${borderClass}`}
      style={{
        transition:
          "background-color var(--motion-duration-base) var(--motion-ease-standard), border-color var(--motion-duration-base) var(--motion-ease-standard)",
      }}
      role="region"
      aria-label="Intelligence Briefing"
    >
      {/* Headline */}
      <p
        className="text-sm font-semibold leading-snug text-foreground"
        style={{
          animation: "pharos-fade-in-up var(--motion-duration-entrance) var(--motion-ease-standard) both",
          animationDelay: `${delayFor("briefing", 0)}ms`,
        }}
      >
        {renderHeadline(briefing.headline, briefing.bandKeyword)}
      </p>

      {/* Supporting lines */}
      {briefing.lines.length > 0 && (
        <ul className="mt-2 space-y-1">
          {briefing.lines.map((line, i) => (
            <li
              key={i}
              className="flex items-start gap-1.5 text-xs leading-relaxed text-muted-foreground"
              style={{
                animation: "pharos-fade-in-up var(--motion-duration-entrance) var(--motion-ease-standard) both",
                animationDelay: `${delayFor("briefing-lines", i)}ms`,
              }}
            >
              <span
                className="mt-px shrink-0 text-[9px] opacity-50"
                aria-hidden
              >
                {LINE_BULLETS[line.type] ?? "\u2022"}
              </span>
              <span>{renderLineText(line.text)}</span>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
