/**
 * Incident grouping + quarantine for the Stage 2 corpus.
 *
 * The raw depeg_events corpus is flapping-dominated (spike: 34k events, 98%
 * shallow, top coins 1000s of fragments). Grouping collapses same-coin,
 * same-direction fragments separated by < 6h into one incident; quarantine
 * removes pathological high-frequency detectors so they cannot dominate a
 * stratum. Outcome labels come from `recovery_price` presence, NOT survival
 * (a dead coin can show "recovered" backfill fragments — handled in resolution).
 */

import { median } from "../stats";
import type { DdrHistoricalEvent } from "./inputs";
import {
  currencyClass,
  depthBucket,
  type DdrCurrencyClass,
  type DdrDepthBucket,
  type DdrStructuralClass,
} from "./strata";

const MERGE_GAP_SEC = 6 * 3600;
const QUARANTINE_MIN_INCIDENTS = 50;
const QUARANTINE_MEDIAN_DURATION_SEC = 30 * 60;

export interface DdrIncidentFragment {
  offsetSec: number;
  peakDeviationBps: number;
}

export interface DdrIncident {
  stablecoinId: string;
  direction: "above" | "below";
  /** worst (largest magnitude) peak deviation across merged fragments */
  peakDeviationBps: number;
  depth: DdrDepthBucket;
  currency: DdrCurrencyClass;
  /** assigned by the caller from registry structural class; defaults fragile */
  structural: DdrStructuralClass;
  startedAt: number;
  endedAt: number | null;
  durationSec: number | null;
  /** true when the final fragment closed in-band (recovery_price present) */
  recovered: boolean;
  /** Fragment peak severities relative to incident start; used to avoid depth leakage at landmark age. */
  fragments?: DdrIncidentFragment[];
}

/**
 * Group raw events into incidents. `currencyOf` resolves a coin's peg currency;
 * structural class is filled later (defaults "fragile") by the caller.
 */
export function groupIncidents(
  events: DdrHistoricalEvent[],
  currencyOf: (stablecoinId: string) => string,
): DdrIncident[] {
  const byKey = new Map<string, DdrHistoricalEvent[]>();
  for (const ev of events) {
    const key = `${ev.stablecoinId}|${ev.direction}`;
    const list = byKey.get(key);
    if (list) list.push(ev);
    else byKey.set(key, [ev]);
  }

  const incidents: DdrIncident[] = [];
  for (const [key, list] of byKey) {
    const [stablecoinId, direction] = key.split("|") as [string, "above" | "below"];
    list.sort((a, b) => a.startedAt - b.startedAt);

    let cur: {
      startedAt: number;
      endedAt: number | null;
      worstBps: number;
      lastRecovery: number | null;
      fragments: DdrIncidentFragment[];
    } | null = null;

    const flush = () => {
      if (!cur) return;
      const durationSec = cur.endedAt != null ? Math.max(0, cur.endedAt - cur.startedAt) : null;
      incidents.push({
        stablecoinId,
        direction,
        peakDeviationBps: cur.worstBps,
        depth: depthBucket(cur.worstBps),
        currency: currencyClass(currencyOf(stablecoinId)),
        structural: "fragile",
        startedAt: cur.startedAt,
        endedAt: cur.endedAt,
        durationSec,
        recovered: cur.endedAt != null && cur.lastRecovery != null,
        fragments: cur.fragments,
      });
      cur = null;
    };

    for (const ev of list) {
      if (!cur) {
        cur = {
          startedAt: ev.startedAt,
          endedAt: ev.endedAt,
          worstBps: ev.peakDeviationBps,
          lastRecovery: ev.recoveryPrice,
          fragments: [{ offsetSec: 0, peakDeviationBps: ev.peakDeviationBps }],
        };
        continue;
      }
      // An open fragment keeps the incident open; otherwise check the gap.
      const prevEnd = cur.endedAt;
      const contiguous = prevEnd == null || ev.startedAt - prevEnd < MERGE_GAP_SEC;
      if (contiguous) {
        if (Math.abs(ev.peakDeviationBps) > Math.abs(cur.worstBps)) cur.worstBps = ev.peakDeviationBps;
        cur.endedAt = ev.endedAt; // null if this fragment is open
        cur.lastRecovery = ev.recoveryPrice;
        cur.fragments.push({
          offsetSec: Math.max(0, ev.startedAt - cur.startedAt),
          peakDeviationBps: ev.peakDeviationBps,
        });
      } else {
        flush();
        cur = {
          startedAt: ev.startedAt,
          endedAt: ev.endedAt,
          worstBps: ev.peakDeviationBps,
          lastRecovery: ev.recoveryPrice,
          fragments: [{ offsetSec: 0, peakDeviationBps: ev.peakDeviationBps }],
        };
      }
    }
    flush();
  }

  return incidents;
}

/**
 * Coins whose history is too fragmented/noisy to inform duration. Excluded from
 * the Stage 2 training set (the >50-incidents, sub-30min-median detector rule).
 */
export function quarantinedCoins(incidents: DdrIncident[]): Set<string> {
  const byCoin = new Map<string, number[]>();
  for (const inc of incidents) {
    if (inc.durationSec == null) continue;
    const list = byCoin.get(inc.stablecoinId);
    if (list) list.push(inc.durationSec);
    else byCoin.set(inc.stablecoinId, [inc.durationSec]);
  }
  const out = new Set<string>();
  for (const [coin, durations] of byCoin) {
    // Quarantine uses the conventional average-of-middle median; Stage 2 p50
    // remains duration.ts's nearest-rank percentile for public estimates.
    if (durations.length > QUARANTINE_MIN_INCIDENTS && (median(durations) ?? 0) < QUARANTINE_MEDIAN_DURATION_SEC) {
      out.add(coin);
    }
  }
  return out;
}
