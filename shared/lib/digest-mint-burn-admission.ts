import { sumPegBucketsOrNull } from "./supply";
import { DAY_SECONDS, HOUR_SECONDS } from "./time-constants";

// Editorial circuit breaker: a quarter of tracked supply needs independent
// confirmation; half the net allows daily snapshot timing/chain-coverage skew.
const LARGE_NET_SUPPLY_RATIO = 0.25;
const MIN_SUPPLY_CONFIRMATION_RATIO = 0.5;
const DIGEST_SUPPLY_WINDOW_TOLERANCE_SEC = 12 * HOUR_SECONDS;
export const MATERIAL_DIGEST_GAUGE_SHARE = 0.01;

export interface DigestFlowSupplySnapshot {
  snapshotDate: number;
  circulatingUsd: number | null;
}

/** Null means admitted; unavailable evidence never confirms a large flow. */
export function getMintBurnPressureRejection(input: {
  net24hUsd: number;
  gaugeWeightUsd: number | null;
  window: { start: number; end: number } | null;
  previous?: DigestFlowSupplySnapshot;
  current?: DigestFlowSupplySnapshot;
}): "supply-weight-unavailable" | "supply-unavailable" | "supply-window-mismatch" | "supply-unconfirmed" | null {
  const { net24hUsd, gaugeWeightUsd, window, previous, current } = input;
  if (gaugeWeightUsd == null || !Number.isFinite(gaugeWeightUsd) || gaugeWeightUsd < 0) {
    return "supply-weight-unavailable";
  }
  if (Number.isFinite(net24hUsd) && Math.abs(net24hUsd) < gaugeWeightUsd * LARGE_NET_SUPPLY_RATIO) return null;
  if (!window || window.end - window.start !== DAY_SECONDS || !previous || !current) return "supply-unavailable";
  // Daily history has UTC-day labels, not exact observation clocks. Only an
  // adjacent pair no more than half a day behind the closed-hour window counts.
  if (current.snapshotDate - previous.snapshotDate !== DAY_SECONDS
    || ![window.start - previous.snapshotDate, window.end - current.snapshotDate]
      .every((lag) => Number.isFinite(lag) && lag >= 0 && lag <= DIGEST_SUPPLY_WINDOW_TOLERANCE_SEC)) {
    return "supply-window-mismatch";
  }
  const before = previous.circulatingUsd == null ? null : sumPegBucketsOrNull({ usd: previous.circulatingUsd });
  const after = current.circulatingUsd == null ? null : sumPegBucketsOrNull({ usd: current.circulatingUsd });
  if (before == null || after == null) return "supply-unavailable";
  const change = after - before;
  return Number.isFinite(net24hUsd) && change * Math.sign(net24hUsd) >= Math.abs(net24hUsd) * MIN_SUPPLY_CONFIRMATION_RATIO
    && change !== 0 ? null : "supply-unconfirmed";
}

export function isMaterialDigestGaugeShare(share: number | null | undefined): share is number {
  return share != null && Number.isFinite(share) && share >= MATERIAL_DIGEST_GAUGE_SHARE && share <= 1;
}

export function digestGaugeWeightFact(share: number | null | undefined): string {
  if (share == null || !Number.isFinite(share) || share < 0 || share > 1) {
    return "Scored gauge weight share unavailable; no aggregate gauge attribution";
  }
  return `Scored gauge weight share ${(share * 100).toFixed(3)}%`
    + (isMaterialDigestGaugeShare(share) ? "" : " (negligible; cannot explain aggregate gauge movement)");
}
