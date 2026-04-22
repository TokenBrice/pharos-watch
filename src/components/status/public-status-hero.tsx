"use client";

import type { HealthResponse } from "@shared/types";
import { RefreshCountdown } from "@/components/status/refresh-countdown";
import { FreshnessIndicator } from "@/components/status/freshness-indicator";
import type { BrowserProbeSummary } from "@/lib/status-dashboard-model";
import { formatTimestampMs, formatTimestampSeconds, getStatusTone } from "@/lib/status-dashboard-model";
import { getPublicMintBurnStatus } from "@/lib/status/public-status";
import { cn } from "@/lib/utils";

/** Mark data stale when older than 3 min (>3x our 60s refresh cadence). */
const PUBLIC_HERO_STALE_AFTER_MS = 180_000;

interface PublicStatusHeroProps {
  healthData: HealthResponse;
  lastUpdated: number;
  probeSummary: BrowserProbeSummary | null;
  worstCacheRatio: number | null;
  worstCacheStatus: HealthResponse["status"];
  impactedCacheLanes: number;
  openCircuits: number;
  halfOpenCircuits: number;
  onRefresh: () => void;
}

const HERO_COPY = {
  healthy: {
    headline: "Public surface steady.",
    shell:
      "border-emerald-500/24 bg-[linear-gradient(140deg,oklch(0.985_0.02_150_/_0.98),oklch(0.975_0.012_248_/_0.99))] text-slate-950 dark:bg-[linear-gradient(140deg,rgba(3,30,22,0.96),rgba(5,15,23,0.99))] dark:text-emerald-50",
    glowA:
      "bg-[radial-gradient(circle_at_top_left,rgba(52,211,153,0.22),transparent_56%)]",
    glowB:
      "bg-[radial-gradient(circle_at_bottom_right,rgba(56,189,248,0.14),transparent_52%)]",

    accentDot: "bg-emerald-300",
  },
  degraded: {
    headline: "Public surface under pressure.",
    shell:
      "border-amber-500/24 bg-[linear-gradient(140deg,oklch(0.985_0.02_85_/_0.98),oklch(0.975_0.012_248_/_0.99))] text-slate-950 dark:bg-[linear-gradient(140deg,rgba(33,22,5,0.96),rgba(10,14,22,0.99))] dark:text-amber-50",
    glowA:
      "bg-[radial-gradient(circle_at_top_left,rgba(251,191,36,0.24),transparent_56%)]",
    glowB:
      "bg-[radial-gradient(circle_at_bottom_right,rgba(56,189,248,0.12),transparent_52%)]",

    accentDot: "bg-amber-300",
  },
  stale: {
    headline: "Public surface compromised.",
    shell:
      "border-red-500/24 bg-[linear-gradient(140deg,oklch(0.985_0.02_25_/_0.98),oklch(0.975_0.012_248_/_0.99))] text-slate-950 dark:bg-[linear-gradient(140deg,rgba(37,9,11,0.96),rgba(10,14,22,0.99))] dark:text-red-50",
    glowA:
      "bg-[radial-gradient(circle_at_top_left,rgba(248,113,113,0.24),transparent_56%)]",
    glowB:
      "bg-[radial-gradient(circle_at_bottom_right,rgba(56,189,248,0.12),transparent_52%)]",

    accentDot: "bg-red-300",
  },
} as const;

function SignalTile({
  label,
  value,
  tone,
}: {
  label: string;
  value: string;
  tone: HealthResponse["status"];
}) {
  const toneClassName = getStatusTone(tone).badgeClassName;

  return (
    <div className="rounded-lg border border-black/8 bg-white/45 px-3.5 py-3 dark:border-white/10 dark:bg-black/15">
      <p className="text-[11px] uppercase tracking-[0.18em] text-slate-500 dark:text-white/55">{label}</p>
      <div className="mt-1.5 flex items-baseline justify-between gap-2">
        <span className="font-mono text-lg font-semibold tracking-tight text-slate-950 dark:text-white">{value}</span>
        <span className={cn("rounded-full border px-2 py-0.5 text-[11px] font-medium", toneClassName)}>
          {getStatusTone(tone).label}
        </span>
      </div>
    </div>
  );
}

function MetaRow({
  label,
  value,
}: {
  label: string;
  value: string;
}) {
  return (
    <div className="flex items-baseline gap-1.5">
      <span className="text-[11px] uppercase tracking-[0.18em] text-slate-500 dark:text-white/48">{label}</span>
      <span className="font-mono text-xs text-slate-950 dark:text-white">{value}</span>
    </div>
  );
}

function getHeroLeadWarning(status: HealthResponse["status"], warnings: string[]): string {
  const firstWarning = warnings[0];
  if (firstWarning) return firstWarning;
  if (status === "healthy") return "No public warnings are active right now.";
  if (status === "degraded") return "Some data pipelines are experiencing delays. Check the sections below for details.";
  return "System health data is outdated. Check the sections below for current status.";
}

export function PublicStatusHero({
  healthData,
  lastUpdated,
  probeSummary,
  worstCacheRatio,
  worstCacheStatus,
  impactedCacheLanes,
  openCircuits,
  halfOpenCircuits,
  onRefresh,
}: PublicStatusHeroProps) {
  const hero = HERO_COPY[healthData.status];
  const statusTone = getStatusTone(healthData.status);
  const warningLine = getHeroLeadWarning(healthData.status, healthData.warnings);
  const probeValue = probeSummary ? `${probeSummary.passCount}/${probeSummary.sampleCount}` : "—";
  const circuitValue =
    openCircuits > 0 ? `${openCircuits} open` : halfOpenCircuits > 0 ? `${halfOpenCircuits} half-open` : "All closed";
  const mintBurnTone = getPublicMintBurnStatus(healthData.mintBurn.sync);

  return (
    <section className={cn("relative overflow-hidden rounded-[1.75rem] border px-4 py-5 shadow-[0_24px_60px_oklch(0_0_0_/0.18)] sm:px-5 lg:px-6", hero.shell)}>
      <div className={cn("pointer-events-none absolute inset-0 opacity-100", hero.glowA)} />
      <div className={cn("pointer-events-none absolute inset-0 opacity-100", hero.glowB)} />

      <div className="relative space-y-4">
        {/* ── Headline row ── */}
        <div className="flex flex-wrap items-start justify-between gap-4">
          <div className="space-y-2">
            <div className="flex flex-wrap items-center gap-2.5">
              <span className={cn("rounded-full border px-3 py-1 text-[11px] font-medium", statusTone.badgeClassName)}>
                {statusTone.label}
              </span>
              <FreshnessIndicator
                updatedAtMs={lastUpdated}
                staleAfterMs={PUBLIC_HERO_STALE_AFTER_MS}
                labelPrefix="Dashboard fetch"
              />
              {healthData.warnings.length > 0 && (
                <span className="flex items-center gap-1.5 text-[11px] text-slate-500 dark:text-white/60">
                  <span className={cn("h-2 w-2 rounded-full", hero.accentDot)} />
                  {healthData.warnings.length} warning{healthData.warnings.length !== 1 ? "s" : ""}
                </span>
              )}
            </div>
            <h2 className="max-w-3xl text-balance text-[clamp(2rem,4.5vw,3.5rem)] font-semibold leading-[0.92] tracking-[-0.05em] text-slate-950 dark:text-white">
              {hero.headline}
            </h2>
          </div>
          <RefreshCountdown key={lastUpdated} onRefresh={onRefresh} />
        </div>

        {/* ── Watch note (only when warnings or non-healthy) ── */}
        {(healthData.status !== "healthy" || healthData.warnings.length > 0) && (
          <p className="max-w-3xl text-sm leading-relaxed text-slate-700 dark:text-white/70">{warningLine}</p>
        )}

        {/* ── 4-metric strip ── */}
        <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
          <SignalTile
            label="Cache Pressure"
            value={worstCacheRatio != null ? `${worstCacheRatio.toFixed(2)}x` : worstCacheStatus === "healthy" ? "—" : "missing"}
            tone={worstCacheStatus}
          />
          <SignalTile
            label="Browser Probes"
            value={probeValue}
            tone={probeSummary?.status ?? "healthy"}
          />
          <SignalTile
            label="Circuit Breakers"
            value={circuitValue}
            tone={openCircuits > 0 ? "stale" : halfOpenCircuits > 0 ? "degraded" : "healthy"}
          />
          <SignalTile
            label="Mint/Burn Writer"
            value={mintBurnTone}
            tone={mintBurnTone}
          />
        </div>

        {/* ── Compact metadata footer ── */}
        <div className="flex flex-wrap items-center gap-x-6 gap-y-1 border-t border-black/8 pt-3 dark:border-white/10">
          <MetaRow label="Health sample" value={formatTimestampSeconds(healthData.timestamp)} />
          <MetaRow label="Client sync" value={formatTimestampMs(lastUpdated)} />
          {impactedCacheLanes > 0 && (
            <MetaRow label="Impacted lanes" value={String(impactedCacheLanes)} />
          )}
        </div>
      </div>
    </section>
  );
}
