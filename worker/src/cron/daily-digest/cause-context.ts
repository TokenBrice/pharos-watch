import type { DigestInputData } from "@shared/types/digest";
import { CURATED_ANNOTATIONS } from "@shared/data/annotations/curated-annotations";

// The July 2026 corpus ran 17 USX-led editions without once saying WHY the
// coin broke. The curated annotation registry already stores cause-first,
// primary-sourced labels per coin; surface the relevant ones to the model.

const CAUSE_LOOKBACK_SEC = 90 * 86_400;
const MAX_CAUSE_ENTRIES = 6;
const MAX_ENTRIES_PER_COIN = 2;

export function collectCauseContext(
  topDepegs: DigestInputData["topDepegs"],
  nowSec: number,
): DigestInputData["causeContext"] {
  const out: NonNullable<DigestInputData["causeContext"]> = [];
  for (const depeg of topDepegs) {
    if (!depeg.stablecoinId) continue;
    const annotations = CURATED_ANNOTATIONS[depeg.stablecoinId] ?? [];
    const windowStartSec = (depeg.startedAt ?? nowSec) - CAUSE_LOOKBACK_SEC;
    const relevant = annotations
      .filter((annotation) => annotation.ts / 1000 >= windowStartSec && annotation.ts / 1000 <= nowSec)
      .slice(-MAX_ENTRIES_PER_COIN);
    for (const annotation of relevant) {
      out.push({
        stablecoinId: depeg.stablecoinId,
        symbol: depeg.symbol,
        kind: annotation.kind,
        label: annotation.label,
        date: new Date(annotation.ts).toISOString().slice(0, 10),
        ...(annotation.href ? { href: annotation.href } : {}),
      });
    }
  }
  return out.length > 0 ? out.slice(0, MAX_CAUSE_ENTRIES) : undefined;
}

/**
 * The chronic ledger: ongoing depegs older than 48h. Demoted stories stay
 * visible as a deterministic status strip (web + one Telegram line) instead
 * of being narrated into another day-count headline.
 */
export function buildStandingConditions(
  topDepegs: DigestInputData["topDepegs"],
): DigestInputData["standingConditions"] {
  const rows = topDepegs
    .filter((depeg) => (depeg.ageHours ?? 0) >= 48)
    .map((depeg) => ({
      ...(depeg.stablecoinId != null ? { stablecoinId: depeg.stablecoinId } : {}),
      symbol: depeg.symbol,
      ageDays: Math.floor((depeg.ageHours ?? 0) / 24),
      ...(depeg.currentBps != null ? { currentBps: depeg.currentBps } : {}),
      ...(depeg.peakBps != null ? { peakBps: depeg.peakBps } : {}),
      mcapUsd: depeg.mcapUsd,
    }))
    .sort((a, b) => Math.abs(b.currentBps ?? 0) * (b.mcapUsd ?? 0) - Math.abs(a.currentBps ?? 0) * (a.mcapUsd ?? 0));
  return rows.length > 0 ? rows : undefined;
}

export function formatStandingConditionsLine(
  standingConditions: DigestInputData["standingConditions"],
): string | null {
  if (!standingConditions || standingConditions.length === 0) return null;
  const parts = standingConditions
    .slice(0, 5)
    .map((row) => `${row.symbol} d${row.ageDays}${row.currentBps != null ? ` ${Math.abs(row.currentBps)}bps` : ""}`);
  return `Standing: ${parts.join(" · ")}`;
}
