"use client";

import type { HealthResponse } from "@shared/types";
import { RefreshControl } from "@/components/status/refresh-countdown";
import { FreshnessIndicator } from "@/components/status/freshness-indicator";
import type { BrowserProbeSummary } from "@/lib/status-dashboard-model";
import { formatTimestampMs, formatTimestampSeconds, getStatusTone } from "@/lib/status-dashboard-model";
import { getPublicHealthWarningPresentation, getPublicMintBurnStatus } from "@/lib/status/public-status";
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
    /* Flat card; no accent stripe when healthy. */
    shell: "",
    accentDot: "bg-emerald-500",
  },
  degraded: {
    headline: "Public surface under pressure.",
    /* Data-driven severity accent for a real degraded state. */
    shell: "border-l-[3px] border-l-amber-500",
    accentDot: "bg-amber-500",
  },
  stale: {
    headline: "Public surface compromised.",
    shell: "border-l-[3px] border-l-red-500",
    accentDot: "bg-red-500",
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
    <div>
      <p className="pharos-kicker">{label}</p>
      <div className="mt-1.5 flex items-baseline justify-between gap-2">
        <span className="pharos-numeric text-lg font-semibold tracking-tight text-foreground">{value}</span>
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
      <span className="pharos-kicker">{label}</span>
      <span className="pharos-numeric text-xs text-foreground">{value}</span>
    </div>
  );
}

function getHeroLeadWarning(healthData: HealthResponse): string {
  const { status, warnings } = healthData;
  const firstWarning = warnings[0];
  if (firstWarning) return getPublicHealthWarningPresentation(firstWarning, healthData).detail;
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
  const warningLine = getHeroLeadWarning(healthData);
  const probeValue = probeSummary ? `${probeSummary.passCount}/${probeSummary.sampleCount}` : "—";
  const circuitValue =
    openCircuits > 0 ? `${openCircuits} open` : halfOpenCircuits > 0 ? `${halfOpenCircuits} half-open` : "All closed";
  const mintBurnTone = getPublicMintBurnStatus(healthData.mintBurn.sync);

  return (
    <section className={cn("pharos-card-shell px-4 py-5 sm:px-5 lg:px-6", hero.shell)}>
      <div className="space-y-4">
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
                <span className="flex items-center gap-1.5 text-[11px] text-muted-foreground">
                  <span className={cn("h-2 w-2 rounded-full", hero.accentDot)} />
                  {healthData.warnings.length} warning{healthData.warnings.length !== 1 ? "s" : ""}
                </span>
              )}
            </div>
            <h2 className="pharos-page-title max-w-3xl text-balance text-foreground">
              {hero.headline}
            </h2>
          </div>
          <RefreshControl key={lastUpdated} onRefresh={onRefresh} />
        </div>

        {/* ── Watch note (only when warnings or non-healthy) ── */}
        {(healthData.status !== "healthy" || healthData.warnings.length > 0) && (
          <p className="max-w-3xl text-sm leading-relaxed text-muted-foreground">{warningLine}</p>
        )}

        {/* ── 4-metric strip ── */}
        <div className="grid gap-x-6 gap-y-3 border-t border-border/60 pt-4 sm:grid-cols-2 lg:grid-cols-4">
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
        <div className="flex flex-wrap items-center gap-x-6 gap-y-1 border-t border-border/60 pt-3">
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
