"use client";

import type { HealthResponse } from "@shared/types";
import { RefreshCountdown } from "@/components/status/refresh-countdown";
import { formatTimestampMs, formatTimestampSeconds, getStatusTone } from "@/lib/status-dashboard-model";
import { getPublicMintBurnStatus } from "@/lib/status/public-status";
import { cn } from "@/lib/utils";

interface PublicProbeSummary {
  sampleCount: number;
  passCount: number;
  failCount: number;
  degradedCount: number;
  staleCount: number;
  p95LatencyMs: number | null;
  status: "healthy" | "degraded" | "stale";
  updatedAt: number | null;
}

interface PublicStatusHeroProps {
  healthData: HealthResponse;
  lastUpdated: number;
  probeSummary: PublicProbeSummary | null;
  worstCacheRatio: number | null;
  worstCacheStatus: "healthy" | "degraded" | "stale";
  impactedCacheLanes: number;
  openCircuits: number;
  halfOpenCircuits: number;
  lastSuccessfulMintBurnSyncAge: string;
  onRefresh: () => void;
}

const HERO_COPY = {
  healthy: {
    headline: "Public surface steady.",
    body: "Routes, freshness, and ingestion telemetry are holding inside public tolerance bands. Use this page as the public watch floor, not the intervention console.",
    panelTitle: "Nothing on the public edge is demanding intervention.",
    panelBody: "No active public warnings are attached to the health endpoint. Keep an eye on freshness drift and mint/burn cadence before pressure builds.",
    shell:
      "border-emerald-500/24 bg-[linear-gradient(140deg,oklch(0.985_0.02_150_/_0.98),oklch(0.975_0.012_248_/_0.99))] text-slate-950 dark:bg-[linear-gradient(140deg,rgba(3,30,22,0.96),rgba(5,15,23,0.99))] dark:text-emerald-50",
    glowA:
      "bg-[radial-gradient(circle_at_top_left,rgba(52,211,153,0.22),transparent_56%)]",
    glowB:
      "bg-[radial-gradient(circle_at_bottom_right,rgba(56,189,248,0.14),transparent_52%)]",
    kicker: "text-emerald-700 dark:text-emerald-200/88",
    panel:
      "border-emerald-500/20 bg-[linear-gradient(180deg,oklch(0.992_0.014_160_/_0.9),oklch(0.983_0.008_248_/_0.94))] dark:border-emerald-400/20 dark:bg-[linear-gradient(180deg,rgba(5,40,28,0.64),rgba(5,22,20,0.34))]",
    metaPanel:
      "border-emerald-500/18 bg-[linear-gradient(180deg,oklch(0.99_0.008_248_/_0.92),oklch(0.978_0.004_248_/_0.96))] dark:bg-[linear-gradient(180deg,rgba(7,19,17,0.78),rgba(4,11,18,0.88))]",
    accentDot: "bg-emerald-300",
  },
  degraded: {
    headline: "Public surface under pressure.",
    body: "The public edge is still serving, but one or more canary signals are slipping outside their comfort band. Treat this page as the fastest public triage readout.",
    panelTitle: "Promote the hottest public signal and work downward.",
    panelBody: "Start with the first warning or the worst freshness lane. The goal is to prevent a public reliability wobble from turning into stale data.",
    shell:
      "border-amber-500/24 bg-[linear-gradient(140deg,oklch(0.985_0.02_85_/_0.98),oklch(0.975_0.012_248_/_0.99))] text-slate-950 dark:bg-[linear-gradient(140deg,rgba(33,22,5,0.96),rgba(10,14,22,0.99))] dark:text-amber-50",
    glowA:
      "bg-[radial-gradient(circle_at_top_left,rgba(251,191,36,0.24),transparent_56%)]",
    glowB:
      "bg-[radial-gradient(circle_at_bottom_right,rgba(56,189,248,0.12),transparent_52%)]",
    kicker: "text-amber-800 dark:text-amber-200/88",
    panel:
      "border-amber-500/20 bg-[linear-gradient(180deg,oklch(0.992_0.016_85_/_0.9),oklch(0.984_0.008_248_/_0.94))] dark:border-amber-400/20 dark:bg-[linear-gradient(180deg,rgba(56,35,8,0.62),rgba(24,18,12,0.34))]",
    metaPanel:
      "border-amber-500/18 bg-[linear-gradient(180deg,oklch(0.991_0.009_85_/_0.92),oklch(0.978_0.004_248_/_0.96))] dark:bg-[linear-gradient(180deg,rgba(23,18,11,0.8),rgba(5,11,18,0.9))]",
    accentDot: "bg-amber-300",
  },
  stale: {
    headline: "Public surface compromised.",
    body: "Freshness or public-route integrity has crossed the stale threshold. Treat current public readings as suspect until the lead failure is contained.",
    panelTitle: "Investigate the public edge now.",
    panelBody: "Contain the first broken lane, then verify the browser canary, cache freshness, and mint/burn sync chain before trusting public output again.",
    shell:
      "border-red-500/24 bg-[linear-gradient(140deg,oklch(0.985_0.02_25_/_0.98),oklch(0.975_0.012_248_/_0.99))] text-slate-950 dark:bg-[linear-gradient(140deg,rgba(37,9,11,0.96),rgba(10,14,22,0.99))] dark:text-red-50",
    glowA:
      "bg-[radial-gradient(circle_at_top_left,rgba(248,113,113,0.24),transparent_56%)]",
    glowB:
      "bg-[radial-gradient(circle_at_bottom_right,rgba(56,189,248,0.12),transparent_52%)]",
    kicker: "text-red-700 dark:text-red-200/88",
    panel:
      "border-red-500/20 bg-[linear-gradient(180deg,oklch(0.992_0.015_25_/_0.9),oklch(0.984_0.008_248_/_0.94))] dark:border-red-400/20 dark:bg-[linear-gradient(180deg,rgba(62,15,16,0.62),rgba(26,12,13,0.34))]",
    metaPanel:
      "border-red-500/18 bg-[linear-gradient(180deg,oklch(0.991_0.008_25_/_0.92),oklch(0.978_0.004_248_/_0.96))] dark:bg-[linear-gradient(180deg,rgba(24,11,12,0.82),rgba(5,11,18,0.9))]",
    accentDot: "bg-red-300",
  },
} as const;

function SignalTile({
  label,
  value,
  detail,
  tone,
}: {
  label: string;
  value: string;
  detail: string;
  tone: HealthResponse["status"];
}) {
  const toneClassName = getStatusTone(tone).badgeClassName;

  return (
    <div className="rounded-[1.2rem] border border-black/8 bg-white/52 p-4 dark:border-white/10 dark:bg-black/15">
      <div className="flex items-start justify-between gap-3">
        <p className="text-[11px] uppercase tracking-[0.22em] text-slate-500 dark:text-white/55">{label}</p>
        <span className={cn("rounded-full border px-2.5 py-1 text-[11px] font-medium", toneClassName)}>
          {getStatusTone(tone).label}
        </span>
      </div>
      <div className="mt-3 font-mono text-[1.65rem] font-semibold tracking-tight text-slate-950 dark:text-white">{value}</div>
      <p className="mt-2 text-sm leading-relaxed text-slate-600 dark:text-white/68">{detail}</p>
    </div>
  );
}

function MetaRow({
  label,
  value,
  detail,
}: {
  label: string;
  value: string;
  detail: string;
}) {
  return (
    <div className="border-t border-black/8 py-3 first:border-t-0 first:pt-0 last:pb-0 dark:border-white/10">
      <div className="flex items-baseline justify-between gap-3">
        <p className="text-[11px] uppercase tracking-[0.22em] text-slate-500 dark:text-white/48">{label}</p>
        <p className="font-mono text-sm text-slate-950 dark:text-white">{value}</p>
      </div>
      <p className="mt-2 text-sm leading-relaxed text-slate-600 dark:text-white/62">{detail}</p>
    </div>
  );
}

function getHeroLeadWarning(status: HealthResponse["status"], warnings: string[]): string {
  const firstWarning = warnings[0];
  if (firstWarning) return firstWarning;
  if (status === "healthy") return "No public warnings are active right now.";
  if (status === "degraded") return "Public health is degraded even though no human-readable warning string was attached.";
  return "Public health is stale even though no human-readable warning string was attached.";
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
  lastSuccessfulMintBurnSyncAge,
  onRefresh,
}: PublicStatusHeroProps) {
  const hero = HERO_COPY[healthData.status];
  const statusTone = getStatusTone(healthData.status);
  const warningLine = getHeroLeadWarning(healthData.status, healthData.warnings);
  const probeValue = probeSummary ? `${probeSummary.passCount}/${probeSummary.sampleCount}` : "—";
  const probeDetail = probeSummary
    ? probeSummary.failCount > 0
      ? `${probeSummary.degradedCount} degraded and ${probeSummary.staleCount} stale or unreachable public canary route(s).`
      : probeSummary.p95LatencyMs != null
        ? `All sampled public routes passed. P95 latency ${probeSummary.p95LatencyMs}ms.`
        : "All sampled public routes passed."
    : "Awaiting public canary samples from this browser session.";
  const circuitValue =
    openCircuits > 0 ? `${openCircuits} open` : halfOpenCircuits > 0 ? `${halfOpenCircuits} half-open` : "All closed";
  const circuitDetail =
    openCircuits > 0
      ? `${openCircuits} breaker(s) are open and blocking upstream calls.`
      : halfOpenCircuits > 0
        ? `${halfOpenCircuits} breaker(s) are probing recovery.`
        : "All registered public-source breakers are closed.";
  const mintBurnTone = getPublicMintBurnStatus(healthData.mintBurn.sync);
  const mintBurnDetail = healthData.mintBurn.sync.warning
    ? `${healthData.mintBurn.sync.warning}${
      healthData.mintBurn.sync.lastSuccessfulSyncAt != null
        ? ` Last successful sync ${lastSuccessfulMintBurnSyncAge} ago.`
        : ""
    }`
    : healthData.mintBurn.sync.lastSuccessfulSyncAt != null
      ? `Last successful sync ${lastSuccessfulMintBurnSyncAge} ago.`
      : "No successful mint/burn sync has been recorded yet.";

  return (
    <section className={cn("relative overflow-hidden rounded-[2rem] border px-4 py-5 shadow-[0_34px_90px_oklch(0_0_0_/0.24)] sm:px-5 lg:px-6", hero.shell)}>
      <div className={cn("pointer-events-none absolute inset-0 opacity-100", hero.glowA)} />
      <div className={cn("pointer-events-none absolute inset-0 opacity-100", hero.glowB)} />
      <div className="pointer-events-none absolute inset-0 opacity-[0.11] [background-image:linear-gradient(to_right,rgba(148,163,184,0.18)_1px,transparent_1px),linear-gradient(to_bottom,rgba(148,163,184,0.14)_1px,transparent_1px)] [background-size:4.5rem_4.5rem]" />

      <div className="relative grid gap-5 xl:grid-cols-[minmax(0,1.22fr)_minmax(18rem,0.78fr)]">
        <div className="space-y-5">
          <div className="flex flex-wrap items-center gap-2.5">
            <span className={cn("pharos-kicker", hero.kicker)}>Public Monitor</span>
            <span className="rounded-full border border-black/8 bg-black/[0.03] px-3 py-1 text-[11px] uppercase tracking-[0.18em] text-slate-600 dark:border-white/12 dark:bg-white/6 dark:text-white/70">
              Read only
            </span>
            <span className={cn("rounded-full border px-3 py-1 text-[11px] font-medium", statusTone.badgeClassName)}>
              {statusTone.label}
            </span>
          </div>

          <div className="max-w-4xl space-y-4">
            <div className="space-y-3">
              <h2 className="max-w-3xl text-balance text-[clamp(2.8rem,6vw,5.5rem)] font-semibold leading-[0.9] tracking-[-0.07em] text-slate-950 dark:text-white">
                {hero.headline}
              </h2>
              <p className="max-w-2xl text-sm leading-relaxed text-slate-700 sm:text-base dark:text-white/70">{hero.body}</p>
            </div>

            <div className="grid gap-3 lg:grid-cols-[minmax(0,1.12fr)_minmax(0,0.88fr)]">
              <article className={cn("rounded-[1.35rem] border p-5 shadow-[0_12px_40px_rgba(0,0,0,0.18)]", hero.panel)}>
                <div className="flex flex-wrap items-start justify-between gap-3">
                  <div className="space-y-2">
                    <p className="text-[11px] uppercase tracking-[0.22em] text-slate-500 dark:text-white/52">Lead signal</p>
                    <h3 className="max-w-2xl text-2xl font-semibold tracking-tight text-slate-950 dark:text-white">{hero.panelTitle}</h3>
                  </div>
                  <div className="flex items-center gap-2 rounded-full border border-black/8 bg-black/[0.03] px-3 py-1.5 dark:border-white/10 dark:bg-black/20">
                    <span className={cn("h-2.5 w-2.5 rounded-full", hero.accentDot)} />
                    <span className="text-[11px] uppercase tracking-[0.18em] text-slate-600 dark:text-white/68">
                      {healthData.warnings.length} active warning(s)
                    </span>
                  </div>
                </div>
                <p className="mt-4 max-w-2xl text-sm leading-relaxed text-slate-700 dark:text-white/74">{hero.panelBody}</p>
                <div className="mt-5 rounded-[1.15rem] border border-black/8 bg-white/55 p-4 dark:border-white/10 dark:bg-black/20">
                  <div className="text-[11px] uppercase tracking-[0.22em] text-slate-500 dark:text-white/52">Watch note</div>
                  <p className="mt-2 text-sm leading-relaxed text-slate-700 dark:text-white/74">{warningLine}</p>
                </div>
              </article>

              <div className="grid gap-3">
                <SignalTile
                  label="Worst Cache Lane"
                  value={worstCacheRatio != null ? `${worstCacheRatio.toFixed(2)}x` : worstCacheStatus === "healthy" ? "—" : "missing"}
                  detail={`${impactedCacheLanes} cache lane(s) are outside their public reliability floor.`}
                  tone={worstCacheStatus}
                />
                <SignalTile
                  label="Mint/Burn Writer"
                  value={mintBurnTone}
                  detail={mintBurnDetail}
                  tone={mintBurnTone}
                />
              </div>
            </div>
          </div>
        </div>

        <aside className={cn("rounded-[1.45rem] border p-5 shadow-[0_18px_48px_rgba(0,0,0,0.18)]", hero.metaPanel)}>
          <div className="flex flex-wrap items-center justify-between gap-3 border-b border-black/8 pb-4 dark:border-white/10">
            <div>
              <p className="pharos-kicker text-slate-500 dark:text-white/62">Live watch</p>
              <p className="mt-2 max-w-xs text-sm leading-relaxed text-slate-600 dark:text-white/68">
                Timeboxed public telemetry, sampled from the current browser session.
              </p>
            </div>
            <RefreshCountdown key={lastUpdated} onRefresh={onRefresh} />
          </div>

          <div className="mt-4 space-y-1">
            <MetaRow
              label="Health Sample"
              value={formatTimestampSeconds(healthData.timestamp)}
              detail="Timestamp emitted by the public health endpoint."
            />
            <MetaRow
              label="Client Sync"
              value={formatTimestampMs(lastUpdated)}
              detail="Oldest current refresh across the public health payload and browser probe loop."
            />
            <MetaRow label="Browser Probes" value={probeValue} detail={probeDetail} />
            <MetaRow label="Circuit Breakers" value={circuitValue} detail={circuitDetail} />
          </div>

          <div className="mt-5 rounded-[1.15rem] border border-black/8 bg-white/55 p-4 dark:border-white/10 dark:bg-black/18">
            <div className="text-[11px] uppercase tracking-[0.22em] text-slate-500 dark:text-white/50">Operator handoff</div>
            <p className="mt-2 text-sm leading-relaxed text-slate-700 dark:text-white/70">
              Pipeline recovery controls are available to Pharos operators on the access-protected ops console.
            </p>
          </div>
        </aside>
      </div>
    </section>
  );
}
