export const ACTIVE_DEPEG_SEVERITY_SOURCE = "open-event-peak";

/** Overall score cap when an active depeg exceeds these thresholds (absolute bps). */
export const ACTIVE_DEPEG_CAP_F_BPS = 2500;
export const ACTIVE_DEPEG_CAP_D_BPS = 1000;
export const ACTIVE_DEPEG_CAP_F_SCORE = 39;
export const ACTIVE_DEPEG_CAP_D_SCORE = 49;

export const REDEMPTION_SEVERE_ACTIVE_DEPEG_BPS = ACTIVE_DEPEG_CAP_F_BPS;

export function activeDepegCapScore(activeDepegBps: number | null | undefined): number | null {
  if (activeDepegBps == null) return null;
  if (activeDepegBps >= ACTIVE_DEPEG_CAP_F_BPS) return ACTIVE_DEPEG_CAP_F_SCORE;
  if (activeDepegBps >= ACTIVE_DEPEG_CAP_D_BPS) return ACTIVE_DEPEG_CAP_D_SCORE;
  return null;
}

