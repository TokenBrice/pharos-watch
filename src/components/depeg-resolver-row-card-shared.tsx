"use client";

import type { ReactNode } from "react";
import Link from "next/link";
import { StablecoinLogo } from "@/components/stablecoin-logo";
import { buildStablecoinUrl } from "@/lib/urls";
import { formatBps, formatElapsedSeconds } from "@shared/lib/format";
import {
  compactLockTiming,
  formatDurationSec,
  formatUtcTimestamp,
  getAgeSec,
  getCurrentDeviationBps,
  getDuration,
  getLockMetadata,
  getPeakDeviationBps,
  type DdrCompatRow,
  type DdrDisplayRow,
} from "@/components/depeg-resolver-row-card-model";

export function StageLabel({ children }: { children: ReactNode }) {
  return <p className="text-[10px] font-semibold uppercase tracking-[0.14em] text-muted-foreground">{children}</p>;
}

function MetadataPill({ label, value }: { label: string; value: ReactNode }) {
  if (value == null || value === "") return null;
  return (
    <span className="inline-flex items-center gap-1 rounded-full border border-border/60 bg-background/60 px-2 py-0.5 text-[10px] text-muted-foreground">
      <span>{label}</span>
      <span className="font-mono tabular-nums text-foreground">{value}</span>
    </span>
  );
}

function formatLockTrigger(value: string | null | undefined, lockedAt: number | null): string | null {
  switch (value) {
    case "forecast_readiness":
      return "readiness";
    case "readiness_backstop":
      return "72h backstop";
    case "scheduled_24h":
      return lockedAt != null ? "legacy 24h" : null;
    default:
      return null;
  }
}

function formatReadinessScore(score: number | null, threshold: number | null): string | null {
  if (score == null || !Number.isFinite(score)) return null;
  const scoreText = `${Math.round(score * 100)}%`;
  if (threshold == null || !Number.isFinite(threshold)) return scoreText;
  return `${scoreText}/${Math.round(threshold * 100)}%`;
}

export function CoinLockup({
  row,
  logos,
  logoSize = 26,
}: {
  row: Pick<DdrDisplayRow, "stablecoinId" | "symbol" | "name">;
  logos?: Record<string, string>;
  logoSize?: number;
}) {
  return (
    <Link
      href={buildStablecoinUrl(row.stablecoinId)}
      className="pharos-focus-ring group/lockup flex min-w-0 items-center gap-2.5 rounded-sm"
    >
      <StablecoinLogo src={logos?.[row.stablecoinId]} name={row.symbol} size={logoSize} />
      <span className="min-w-0">
        <span className="block truncate text-sm font-semibold text-foreground group-hover/lockup:underline">
          {row.symbol}
        </span>
        <span className="block truncate text-[11px] text-muted-foreground">{row.name}</span>
      </span>
    </Link>
  );
}

export function LiveFacts({ row }: { row: DdrDisplayRow }) {
  const compat = row as DdrCompatRow;
  const live = compat.live ?? {};
  const ageSec = live.ageSec ?? getAgeSec(row);
  const peakDeviationBps = live.peakDeviationBps ?? getPeakDeviationBps(row);
  const currentDeviationBps =
    compat.live && "currentDeviationBps" in compat.live
      ? (compat.live.currentDeviationBps ?? null)
      : getCurrentDeviationBps(row);
  const status =
    live.status ??
    ("eventState" in live ? live.eventState : live.active === false ? "closed" : live.stale ? "stale" : "active");

  return (
    <div className="flex flex-wrap items-baseline gap-x-3 gap-y-1 font-mono text-xs tabular-nums text-muted-foreground">
      <span className="font-sans text-[10px] font-semibold uppercase tracking-[0.14em] text-muted-foreground/75">
        Live incident
      </span>
      <span>
        age <span className="text-foreground">{formatElapsedSeconds(ageSec)}</span>
      </span>
      <span>
        peak <span className="text-foreground">{formatBps(peakDeviationBps)}</span>
      </span>
      {currentDeviationBps != null ? (
        <span>
          now <span className="text-foreground">{formatBps(currentDeviationBps)}</span>
        </span>
      ) : null}
      {status ? <span className="uppercase tracking-wide text-foreground/70">{status}</span> : null}
      {live.degradedReason ? (
        <span className="w-full text-muted-foreground">Live overlay degraded: {live.degradedReason}.</span>
      ) : null}
    </div>
  );
}

export function LockMetadataStrip({
  row,
  showAnchoredDuration = false,
}: {
  row: DdrDisplayRow;
  showAnchoredDuration?: boolean;
}) {
  const metadata = getLockMetadata(row);
  const duration = getDuration(row);
  const lockedAt = formatUtcTimestamp(metadata.lockedAt);
  const eligibleAt = formatUtcTimestamp(metadata.eligibleAt);
  const predictedAt = formatUtcTimestamp(metadata.predictedAt);
  const trigger = formatLockTrigger(metadata.lockTrigger, metadata.lockedAt);
  const readiness = formatReadinessScore(metadata.readinessScore, metadata.readinessThreshold);
  const backstop =
    metadata.backstopAt != null
      ? `${formatDurationSec(metadata.backstopDelaySec ?? 72 * 3600)} · ${formatUtcTimestamp(metadata.backstopAt)}`
      : null;
  const anchoredDuration =
    showAnchoredDuration && duration.medianSec != null && !duration.suppressed
      ? `~${formatDurationSec(duration.medianSec)}${
          duration.iqrSec ? ` (${formatDurationSec(duration.iqrSec[0])}-${formatDurationSec(duration.iqrSec[1])})` : ""
        }`
      : null;

  return (
    <div className="flex flex-wrap gap-1.5">
      <MetadataPill label="eligible" value={eligibleAt} />
      <MetadataPill label="locked" value={lockedAt} />
      <MetadataPill
        label="predicted at"
        value={metadata.predictedAgeSec != null ? formatElapsedSeconds(metadata.predictedAgeSec) : null}
      />
      <MetadataPill label="trigger" value={trigger} />
      <MetadataPill label="readiness" value={readiness} />
      <MetadataPill label="backstop" value={backstop} />
      <MetadataPill label="lock timing" value={compactLockTiming(metadata.lockTiming)} />
      <MetadataPill label="anchored duration" value={anchoredDuration} />
      <MetadataPill label="manifest" value={predictedAt && !lockedAt ? predictedAt : null} />
    </div>
  );
}
