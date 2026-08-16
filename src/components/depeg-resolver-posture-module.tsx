"use client";

import { useMemo } from "react";
import Link from "next/link";
import { Info } from "lucide-react";
import { StablecoinLogo } from "@/components/stablecoin-logo";
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from "@/components/ui/tooltip";
import { cn } from "@/lib/utils";
import { buildStablecoinUrl } from "@shared/lib/urls";
import { isDepegResolverEnabled } from "@/lib/feature-flags";
import { DDR_RESOLUTION_TIER_VALUES, type DdrResolutionTier, type DdrResponse } from "@shared/types/depeg-resolver";
import {
  formatDurationSec,
  getCurrentDeviationBps,
  getDuration,
  getPeakDeviationBps,
  getPredictionState,
  getResolution,
  TIER_META,
  type DdrDisplayRow,
} from "@/components/depeg-resolver-row-card-model";

interface DepegResolverPostureModuleProps {
  data: DdrResponse | undefined;
  logos?: Record<string, string>;
}

/** Below this many open events the per-event cards already tell the whole story; the aggregate adds nothing. */
const MIN_AGGREGATE_ROWS = 3;

type Trajectory = "deepening" | "healing" | "steady";
type LaneState = "benchmarked" | "chronic" | "terminal" | "pending" | "unbenchmarked";

interface PostureItem {
  row: DdrDisplayRow;
  id: string;
  symbol: string;
  name: string;
  tier: DdrResolutionTier;
  nowBps: number | null;
  trajectory: Trajectory;
  laneState: LaneState;
  medianSec: number | null;
  severity: number;
}

/** Trajectory of the *gap to peg*: is the live deviation wider or tighter than this event's worst? */
function classifyTrajectory(nowBps: number | null, peakBps: number): Trajectory {
  if (nowBps == null) return "steady";
  const now = Math.abs(nowBps);
  const peak = Math.abs(peakBps);
  if (peak <= 0) return "steady";
  if (now > peak * 1.02) return "deepening";
  if (now <= peak * 0.85) return "healing";
  return "steady";
}

function toPostureItem(row: DdrDisplayRow): PostureItem {
  const resolution = getResolution(row);
  const duration = getDuration(row);
  const nowBps = getCurrentDeviationBps(row);
  const peakBps = getPeakDeviationBps(row);
  const tier = resolution.tier;
  const predictionState = getPredictionState(row);
  const pending = predictionState != null && predictionState !== "frozen" && predictionState !== "no_call";
  const benchmarked = !duration.suppressed && duration.medianSec != null;

  const laneState: LaneState =
    tier === "recovery_unlikely"
      ? "terminal"
      : benchmarked
        ? "benchmarked"
        : duration.ageStatus === "chronic_tail"
          ? "chronic"
          : pending
            ? "pending"
            : "unbenchmarked";

  return {
    row,
    id: row.stablecoinId,
    symbol: row.symbol,
    name: row.name,
    tier,
    nowBps,
    trajectory: classifyTrajectory(nowBps, peakBps),
    laneState,
    medianSec: benchmarked ? duration.medianSec : null,
    severity: nowBps != null ? Math.abs(nowBps) : 0,
  };
}

// --- pieces ----------------------------------------------------------------

function ChipForecast({ item }: { item: PostureItem }) {
  switch (item.laneState) {
    case "benchmarked":
      return (
        <span className="font-mono text-[10px] tabular-nums text-sky-700 dark:text-sky-400">
          ~{formatDurationSec(item.medianSec ?? 0)}
        </span>
      );
    case "chronic":
      return <span className="font-mono text-[10px] uppercase tracking-wide text-amber-700 dark:text-amber-400">past P99</span>;
    case "terminal":
      return <span className="font-mono text-[10px] text-red-700/80 dark:text-red-400/80">no return</span>;
    case "pending":
      return <span className="font-mono text-[10px] text-muted-foreground/70">awaiting lock</span>;
    default:
      return <span className="font-mono text-[10px] text-muted-foreground/70">not benchmarked</span>;
  }
}

function PostureChip({ item, logos }: { item: PostureItem; logos?: Record<string, string> }) {
  const deepening = item.trajectory === "deepening";
  return (
    <Link
      href={buildStablecoinUrl(item.id)}
      title={item.name}
      className="pharos-focus-ring group/chip flex min-w-0 items-center gap-2 rounded-md px-2 py-1.5 hover:bg-muted/50"
    >
      <StablecoinLogo src={logos?.[item.id]} name={item.symbol} size={22} />
      <span className="flex min-w-0 flex-col gap-0.5 leading-none">
        <span className="flex items-baseline gap-1.5">
          <span className="font-mono text-[13px] font-semibold text-foreground group-hover/chip:underline">{item.symbol}</span>
          {item.nowBps != null ? (
            <span className="font-mono text-[11px] tabular-nums">
              <span className={deepening ? "text-red-700 dark:text-red-400" : "text-foreground/80"}>
                {item.nowBps > 0 ? "+" : ""}
                {item.nowBps}
              </span>
              <span className="text-muted-foreground/70"> bps</span>
            </span>
          ) : null}
          {deepening ? (
            <span className="rounded-sm bg-red-500/12 px-1 font-mono text-[9px] font-semibold uppercase tracking-wide text-red-700 dark:text-red-400">
              deepening
            </span>
          ) : item.trajectory === "healing" ? (
            <span className="font-mono text-[10px] leading-none text-emerald-700/80 dark:text-emerald-400/80" aria-label="gap narrowing">
              ▴
            </span>
          ) : null}
        </span>
        <ChipForecast item={item} />
      </span>
    </Link>
  );
}

function GroupRow({
  tier,
  items,
  logos,
}: {
  tier: DdrResolutionTier;
  items: PostureItem[];
  logos?: Record<string, string>;
}) {
  const meta = TIER_META[tier];
  return (
    <div className="grid grid-cols-1 gap-x-4 gap-y-1.5 py-3 first:pt-0 last:pb-0 sm:grid-cols-[11rem_1fr] sm:items-start">
      <div className="flex items-baseline gap-1.5 sm:pt-1.5">
        <span className={cn("min-w-[1ch] font-mono text-sm font-semibold tabular-nums", meta.accent)}>{items.length}</span>
        <span className={cn("whitespace-nowrap text-xs font-semibold uppercase tracking-wide", meta.accent)}>{meta.label}</span>
      </div>
      <div className="-mx-2 flex flex-wrap items-center gap-x-1 gap-y-0.5">
        {items.map((item) => (
          <PostureChip key={item.id} item={item} logos={logos} />
        ))}
      </div>
    </div>
  );
}

// --- public component -------------------------------------------------------

export function DepegResolverPostureModule({ data, logos }: DepegResolverPostureModuleProps) {
  const items = useMemo(() => (data?.rows ?? []).map(toPostureItem), [data]);

  const grouped = useMemo(() => {
    const byTier = new Map<DdrResolutionTier, PostureItem[]>();
    for (const item of items) {
      const bucket = byTier.get(item.tier) ?? [];
      bucket.push(item);
      byTier.set(item.tier, bucket);
    }
    for (const bucket of byTier.values()) bucket.sort((a, b) => b.severity - a.severity);
    return DDR_RESOLUTION_TIER_VALUES.map((tier) => ({ tier, items: byTier.get(tier) ?? [] })).filter(
      (group) => group.items.length > 0,
    );
  }, [items]);

  if (!isDepegResolverEnabled()) return null;

  const degraded = data?._meta.degraded === true;
  const usableDegraded = degraded && data?._meta.degradedReason === "stale-cache";
  if (!data || (degraded && !usableDegraded) || items.length < MIN_AGGREGATE_ROWS) return null;

  const counts = {
    likely: grouped.find((g) => g.tier === "recovery_likely")?.items.length ?? 0,
    atRisk: grouped.find((g) => g.tier === "at_risk")?.items.length ?? 0,
    unlikely: grouped.find((g) => g.tier === "recovery_unlikely")?.items.length ?? 0,
  };
  const deepening = items.filter((i) => i.trajectory === "deepening");

  const clauses: string[] = [];
  if (counts.likely) clauses.push(`${counts.likely} likely to recover`);
  if (counts.atRisk) clauses.push(`${counts.atRisk} at risk`);
  if (counts.unlikely) clauses.push(`${counts.unlikely} unlikely to return`);

  return (
    <section aria-label="Depeg outlook posture" className="pharos-card-shell space-y-4 p-4 sm:p-5">
      <div className="flex flex-wrap items-center gap-x-3 gap-y-1.5">
        <div className="flex items-center gap-2.5">
          <span className="rounded-md bg-foreground px-1.5 py-0.5 font-mono text-[11px] font-bold tracking-[0.08em] text-background">
            DDR
          </span>
          <h2 className="pharos-section-title">Outlook Posture</h2>
          <TooltipProvider>
            <Tooltip>
              <TooltipTrigger
                aria-label="About the outlook posture board"
                className="pharos-focus-ring inline-flex h-11 min-w-11 shrink-0 items-center justify-center rounded-full text-muted-foreground hover:text-foreground"
              >
                <Info className="h-3.5 w-3.5" aria-hidden="true" />
              </TooltipTrigger>
              <TooltipContent className="max-w-[280px]">
                The whole live book at a glance: every open depeg sorted by the resolver&apos;s recovery verdict, with its
                current gap to peg and — where benchmarked — its expected time to clear. Each event&apos;s full forecast is
                below.
              </TooltipContent>
            </Tooltip>
          </TooltipProvider>
        </div>
        <p className="min-w-0 flex-1 text-pretty text-sm text-muted-foreground">
          <span className="font-mono tabular-nums text-foreground">{items.length}</span> open depegs
          {clauses.length ? <> — {clauses.join(", ")}</> : null}.
          {deepening.length ? (
            <>
              {" "}
              <span className="text-amber-700 dark:text-amber-400">
                {deepening.length === 1
                  ? `${deepening[0].symbol} is deepening past its worst.`
                  : `${deepening.length} are deepening past their worst.`}
              </span>
            </>
          ) : null}
        </p>
      </div>

      <div className="divide-y divide-border/50 border-t border-border/50 pt-1">
        {grouped.map((group) => (
          <GroupRow key={group.tier} tier={group.tier} items={group.items} logos={logos} />
        ))}
      </div>
    </section>
  );
}
