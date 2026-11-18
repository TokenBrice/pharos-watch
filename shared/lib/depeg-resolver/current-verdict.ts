import type { DdrResolutionTier, DdrV2ResponseRow } from "../../types/depeg-resolver";

/**
 * The resolver book is usable for headline claims: not degraded, or a stale
 * cache that still carries rows. Anything else fails closed (no verdicts).
 */
export function isDdrBookUsable(data: {
  _meta?: { degraded: boolean; degradedReason?: string | null };
  rows: readonly unknown[];
} | null | undefined): boolean {
  return data != null && (!data._meta?.degraded
    || (data._meta.degradedReason === "stale-cache" && data.rows.length > 0));
}

export interface CurrentDdrVerdict {
  tier: DdrResolutionTier;
  /** The forecast's methodology version, so the tier keeps the label it was published with. */
  methodologyVersion: string | null;
}

/**
 * Each coin's published DDR verdict: the frozen forecast of its active event,
 * else its first frozen forecast. One row choice for every surface that names
 * a verdict (dossier, coin-state chips), so a chip never disagrees with the page.
 */
export function selectCurrentDdrVerdicts(rows: readonly DdrV2ResponseRow[]): Map<string, CurrentDdrVerdict> {
  const chosen = new Map<string, { verdict: CurrentDdrVerdict; active: boolean }>();
  for (const row of rows) {
    if (row.kind !== "prediction" || row.prediction.state !== "frozen") continue;
    const active = row.live.eventState === "active";
    const previous = chosen.get(row.stablecoinId);
    if (previous && (previous.active || !active)) continue;
    chosen.set(row.stablecoinId, {
      verdict: { tier: row.frozen.resolution.tier, methodologyVersion: row.prediction.predictionMethodologyVersion },
      active,
    });
  }
  return new Map([...chosen].map(([id, { verdict }]) => [id, verdict]));
}
