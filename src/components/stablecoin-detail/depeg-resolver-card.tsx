"use client";

import { useId } from "react";
import { ArrowDown } from "lucide-react";
import { ActiveDepegAlert } from "@/components/coin-notice";
import { DDR_VERDICT_CLASSES, DEPEG_LIVE_PING_CLASS } from "@shared/lib/classification";
import { formatDeviationBps } from "@shared/lib/format";
import { isResolverBookAvailable } from "@/components/depeg/depeg-resolver-book-summary";
import {
  SEVERITY_WEIGHT,
  SUPPRESSED_REASON_LABELS,
  formatCoarseDurationSec,
  formatDurationSec,
  getAgeSec,
  getDisplayedLivePeakDeviationBps,
  getDuration,
  getLiveCurrentDeviationBps,
  getLockMetadata,
  getResolution,
  getTierMeta,
  getTierVocabulary,
  isCumulativeIncidence,
  isCurrentForecast,
} from "@/components/depeg/depeg-resolver-row-card-model";
import { StablecoinDepegResolverRows } from "@/components/depeg/depeg-resolver-row-card-parts";
import { describeDdrVerdict } from "@/components/depeg/depeg-resolver-row-card-state";
import { QueryStateNotice } from "@/components/query-state-notice";
import { StaleDataBanner } from "@/components/stale-data-banner";
import { useDepegResolver } from "@/hooks/api-hooks";
import { isDepegResolverEnabled } from "@/lib/feature-flags";
import { SEVERITY_TONE_CLASS } from "@/lib/severity-tone";
import { cn } from "@/lib/utils";

/** In-page target of the outlook's link: the full resolver card in the Risk zone. */
export const DEPEG_RESOLVER_ANCHOR_ID = "depeg-resolver";

export interface ActiveDepegOutlookProps {
  stablecoinId: string;
  symbol: string;
  /** The dossier's live deviation, known before the book loads. */
  deviationBps: number | null;
}

function formatUtcDate(sec: number): string {
  return new Date(sec * 1000).toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric", timeZone: "UTC" });
}

/**
 * A live depeg's Depeg Duration Resolver forecast, lifted to the top of the
 * dossier: while a coin is off its peg, whether it is expected to recover is
 * the first thing a holder needs. It reads the same resolver query as the full
 * card (`#depeg-resolver`) and states the published frozen forecast only: the
 * verdict in its tier tone, the live and peak deviation, the event's age, its
 * leading break signals and the duration line (or why none is shown). Until
 * the book loads, and without a published forecast, it renders the plain
 * active-depeg alert (the live deviation and what the resolver has published),
 * never an empty or placeholder panel.
 */
export function ActiveDepegOutlook({ stablecoinId, symbol, deviationBps }: ActiveDepegOutlookProps) {
  const enabled = isDepegResolverEnabled();
  const resolver = useDepegResolver({ enabled });
  const headingId = useId();

  if (!enabled) return <ActiveDepegAlert symbol={symbol} deviationBps={deviationBps} forecast={null} />;
  // First read in flight: the alert holds the panel's footprint so the first fold does not jump.
  if (resolver.data == null && resolver.error == null) {
    return <ActiveDepegAlert symbol={symbol} deviationBps={deviationBps} forecast={{ read: "pending" }} />;
  }
  if (!isResolverBookAvailable(resolver.data)) {
    return <ActiveDepegAlert symbol={symbol} deviationBps={deviationBps} forecast={{ read: "unavailable" }} />;
  }
  const rows = (resolver.data?.rows ?? []).filter((candidate) => candidate.stablecoinId === stablecoinId);
  const forecasts = rows.filter(isCurrentForecast);
  const row = forecasts.find((candidate) => candidate.live.eventState === "active") ?? forecasts[0];
  if (!row) {
    // No locked forecast: name the resolver's state for this break (the full card shows its row).
    const incident = rows.find((candidate) => candidate.live.eventState === "active") ?? rows[0];
    return (
      <ActiveDepegAlert
        symbol={symbol}
        deviationBps={deviationBps}
        forecast={incident ? { read: "state", label: describeDdrVerdict(incident).label } : null}
      />
    );
  }

  const resolution = getResolution(row);
  const meta = getTierMeta(resolution.tier, getTierVocabulary(row));
  const current = getLiveCurrentDeviationBps(row);
  const peak = getDisplayedLivePeakDeviationBps(row);
  const ageSec = getAgeSec(row);
  const duration = getDuration(row);
  const side = row.direction === "below" ? "below" : "above";
  // The duration line in the full card's own words (see the forecast timeline).
  const durationLine = duration.suppressed
    ? (duration.suppressedReason ? SUPPRESSED_REASON_LABELS[duration.suppressedReason] : null) ?? null
    : resolution.tier === "recovery_unlikely" || resolution.tier === "insufficient_signal" || duration.medianSec == null
      ? null
      : isCumulativeIncidence(duration)
        ? `Half of comparable incidents recovered within about ${formatCoarseDurationSec(duration.medianSec)}.`
        : `Expected to resolve in about ${formatDurationSec(duration.medianSec)} after the forecast lock.`;
  // A frozen estimate the live break has already outrun says so, never reads as still ahead.
  const ageAtLockSec = getLockMetadata(row).predictedAgeSec;
  const outrun = durationLine != null && duration.medianSec != null && ageSec != null && ageAtLockSec != null
    && ageSec > ageAtLockSec + duration.medianSec;
  // The break (kill) signals explain the verdict, strongest first; without
  // any, the leading counter-signals do. At most three.
  const bySeverity = (a: (typeof resolution.factors)[number], b: (typeof resolution.factors)[number]) =>
    (SEVERITY_WEIGHT[b.severity as keyof typeof SEVERITY_WEIGHT] ?? 0) - (SEVERITY_WEIGHT[a.severity as keyof typeof SEVERITY_WEIGHT] ?? 0);
  const kills = resolution.factors.filter((factor) => factor.kind === "kill");
  // A "no break signal" class blurb would be false for an above-peg break or one with kill signals.
  const blurb = resolution.tier === "recovery_likely" && (row.direction === "above" || kills.length > 0) ? null : meta.blurb;
  const factors = (kills.length > 0 ? kills : resolution.factors).slice().sort(bySeverity).slice(0, 3);
  const ageLabel = ageSec == null ? null : ageSec >= 2 * 86_400 ? `${Math.round(ageSec / 86_400)} days` : formatDurationSec(ageSec);

  // Severity follows the verdict: a break the resolver expects to heal is a watch, not an alarm.
  const severe = resolution.tier === "recovery_unlikely" || resolution.tier === "at_risk";

  return (
    <section
      aria-labelledby={headingId}
      data-active-depeg-outlook
      className={cn("overflow-hidden rounded-xl border", severe ? SEVERITY_TONE_CLASS.danger.banner : SEVERITY_TONE_CLASS.caution.banner)}
    >
      <div className="flex flex-col gap-4 p-4 sm:flex-row sm:items-stretch sm:gap-5 sm:p-5">
        <div className="min-w-0 flex-1">
          <p className={cn("pharos-label flex flex-wrap items-center gap-x-2 gap-y-0.5", severe ? "text-state-danger" : "text-state-warn")}>
            <span aria-hidden="true" className="relative flex h-2 w-2">
              <span
                className={cn(
                  "absolute inline-flex h-full w-full animate-ping rounded-full opacity-75 motion-reduce:hidden",
                  severe ? DEPEG_LIVE_PING_CLASS : DDR_VERDICT_CLASSES.at_risk.dot,
                )}
              />
              <span className={cn("relative inline-flex h-2 w-2 rounded-full", severe ? DDR_VERDICT_CLASSES.recovery_unlikely.dot : DDR_VERDICT_CLASSES.at_risk.dot)} />
            </span>
            Active depeg
            {ageLabel ? (
              <span className="font-medium text-foreground/70">· {ageLabel} so far</span>
            ) : null}
          </p>
          <h2 id={headingId} className="mt-1.5 text-pretty text-lg font-semibold leading-snug text-foreground sm:text-xl">
            {current != null
              ? <>{symbol} is trading <span className="tabular-nums">{formatDeviationBps(current)}</span> {side} its peg</>
              : <>{symbol} is off its peg</>}
          </h2>
          <p className="mt-1 text-sm text-foreground/75">
            {peak != null ? <>Peak <span className="tabular-nums">{formatDeviationBps(peak)}</span> {side} · </> : null}
            since {formatUtcDate(row.startedAt)}
          </p>
          {factors.length > 0 ? (
            <ul aria-label="Leading resolver signals" className="mt-3 flex flex-wrap gap-1.5">
              {factors.map((factor) => (
                <li
                  key={factor.code}
                  className="inline-flex items-center gap-1.5 rounded-full border border-border/60 bg-background/70 px-2.5 py-1 text-xs text-foreground"
                >
                  <span
                    aria-hidden="true"
                    className={cn(
                      "h-1.5 w-1.5 shrink-0 rounded-full",
                      factor.kind === "kill" ? DDR_VERDICT_CLASSES.recovery_unlikely.dot : DDR_VERDICT_CLASSES.recovery_likely.dot,
                    )}
                  />
                  {factor.label}
                </li>
              ))}
            </ul>
          ) : null}
        </div>
        <div className={cn("flex shrink-0 flex-col justify-between rounded-lg border px-4 py-3 sm:w-72", meta.band)}>
          <div>
            <p className="pharos-label text-foreground/70">Depeg Duration Resolver</p>
            <p className={cn("mt-1 text-2xl font-semibold leading-tight", meta.accent)}>{meta.label}</p>
            {durationLine ?? blurb ? (
              <p className="mt-1.5 text-pretty text-xs leading-relaxed text-foreground/80">
                {durationLine ?? blurb}
                {outrun ? <span className="font-medium text-foreground"> This break has already run longer.</span> : null}
              </p>
            ) : null}
          </div>
          <a
            href={`#${DEPEG_RESOLVER_ANCHOR_ID}`}
            className="pharos-focus-ring mt-3 inline-flex items-center gap-1 self-start rounded-sm text-sm font-medium text-foreground underline-offset-2 hover:underline"
          >
            Full forecast and evidence
            <ArrowDown aria-hidden="true" className="h-3.5 w-3.5" />
          </a>
        </div>
      </div>
    </section>
  );
}

interface StablecoinDepegResolverCardProps {
  stablecoinId: string;
  logoSrc?: string;
}

export function StablecoinDepegResolverCard({ stablecoinId, logoSrc }: StablecoinDepegResolverCardProps) {
  const enabled = isDepegResolverEnabled();
  const resolver = useDepegResolver({ enabled });

  if (!enabled) return null;
  const rows = resolver.data?.rows.filter((row) => row.stablecoinId === stablecoinId) ?? [];
  const degraded = resolver.data?._meta?.degraded === true;
  const bookAvailable = isResolverBookAvailable(resolver.data);
  const usableRows = bookAvailable && rows.length > 0;
  // A failed refresh over a retained book is aged by the shared banner, not reported as missing.
  const unavailable = !usableRows && (resolver.data == null ? resolver.error != null : !bookAvailable);

  if (!unavailable && !usableRows) return null;
  return (
    <div className="space-y-3">
      {unavailable ? (
        <section aria-label="Depeg Duration Resolver availability" className="space-y-2">
          <QueryStateNotice
            state="unavailable"
            label="Depeg Duration Resolver"
            onRetry={() => void resolver.refetch()}
          />
          {degraded ? (
            <p className="text-xs text-muted-foreground">
              Snapshot reason: {resolver.data?._meta?.degradedReason ?? "unavailable"}
            </p>
          ) : null}
        </section>
      ) : (
        <StaleDataBanner
          queries={[{
            preset: "depegResolver",
            // The producer clock, never receipt time; header metadata takes precedence when present.
            dataUpdatedAt: (resolver.data?._meta.computedAt ?? 0) * 1000,
            hasData: true,
            error: resolver.error,
            meta: resolver.meta,
          }]}
          onRetry={() => void resolver.refetch()}
        />
      )}
      <StablecoinDepegResolverRows stablecoinId={stablecoinId} data={resolver.data} logoSrc={logoSrc} />
    </div>
  );
}
