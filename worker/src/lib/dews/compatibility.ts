/**
 * DEWS compatibility & band-gate utilities.
 *
 * These helpers are version-aware load-bearing pieces of the DEWS public API:
 *   - `piecewiseLinear` powers every signal-family scoring curve.
 *   - `getThreatBand` maps a final score (0-100) to a band string used across
 *     tests, alerts, and downstream consumers.
 *
 * Both are exported from the dews barrel for back-compat.
 */

import type { ThreatBand } from "@shared/lib/classification";
import { DEWS_THREAT_BANDS } from "@shared/lib/dews-config";

/**
 * Generic piecewise linear interpolation.
 * Anchors must be sorted by x ascending. Values below first anchor return
 * first y; values above last anchor return last y.
 */
export function piecewiseLinear(x: number, anchors: [number, number][]): number {
  if (anchors.length === 0) return 0;
  if (!Number.isFinite(x)) return x !== x ? 0 : x > 0 ? anchors[anchors.length - 1][1] : anchors[0][1];
  if (x <= anchors[0][0]) return anchors[0][1];
  if (x >= anchors[anchors.length - 1][0]) return anchors[anchors.length - 1][1];

  for (let i = 1; i < anchors.length; i++) {
    if (x <= anchors[i][0]) {
      const [x0, y0] = anchors[i - 1];
      const [x1, y1] = anchors[i];
      const t = (x - x0) / (x1 - x0);
      return y0 + t * (y1 - y0);
    }
  }
  return anchors[anchors.length - 1][1];
}

export function getThreatBand(score: number): ThreatBand {
  for (const threshold of DEWS_THREAT_BANDS) {
    if (score <= threshold.upper) return threshold.band;
  }
  return "DANGER";
}
