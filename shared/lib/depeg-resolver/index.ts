/**
 * Depeg Duration Resolver engine (runtime-neutral).
 *
 * `resolveDepeg` turns one active confirmed depeg event + its context + the
 * grouped historical incident corpus into a single DDR row (Stage 1 verdict +
 * Stage 2 duration). The worker precompute layer groups/quarantines the corpus
 * once, then calls this per active event.
 */

import type { DdrDuration, DdrRow } from "../../types/depeg-resolver";
import { computeDuration } from "./duration";
import type { DdrIncident } from "./incident-groups";
import type { DdrActiveEventInput, DdrCoinStructural, DdrLiveContext, DdrSupplyContext } from "./inputs";
import { resolveOutlook } from "./resolution";
import { currencyClass, depthBucket, structuralClass, type DdrStratumKey } from "./strata";

export interface DdrResolveInput {
  active: DdrActiveEventInput;
  coin: DdrCoinStructural;
  supply: DdrSupplyContext;
  live: DdrLiveContext;
  nowSec: number;
  /** Grouped, structural-annotated historical incidents (shared across all active events). */
  incidents: DdrIncident[];
  quarantined: Set<string>;
}

function suppressDuration(duration: DdrDuration, reason: string): DdrDuration {
  // Suppressed public rows intentionally drop stratum/horizon details so
  // terminal and insufficient-signal outcomes cannot look like duration calls.
  return {
    ...duration,
    suppressed: true,
    suppressedReason: reason,
    stratum: null,
    medianSec: null,
    iqrSec: null,
    ageStatus: null,
    horizons: [],
  };
}

export function resolveDepeg(input: DdrResolveInput): DdrRow {
  const { active, coin, supply, live, nowSec, incidents, quarantined } = input;
  const ageSec = Math.max(0, nowSec - active.startedAt);

  const resolution = resolveOutlook(active, coin, supply, live, nowSec);

  const activeKey: DdrStratumKey = {
    direction: active.direction,
    depth: depthBucket(active.peakDeviationBps),
    structural: structuralClass(coin),
    currency: currencyClass(coin.pegCurrency),
  };

  let duration = computeDuration(activeKey, ageSec, incidents, quarantined);
  if (resolution.tier === "recovery_unlikely") {
    duration = suppressDuration(duration, "verdict_terminal");
  } else if (resolution.tier === "insufficient_signal") {
    duration = suppressDuration(duration, "insufficient_signal");
  }

  return {
    stablecoinId: active.stablecoinId,
    symbol: active.symbol,
    name: coin.name,
    pegCurrency: coin.pegCurrency,
    governance: coin.governance,
    status: coin.status ?? null,
    eventId: active.id,
    startedAt: active.startedAt,
    ageSec,
    direction: active.direction,
    peakDeviationBps: active.peakDeviationBps,
    currentDeviationBps: active.currentDeviationBps ?? null,
    resolution,
    duration,
    relatedContext: {
      dewsBand: live.dewsBand ?? null,
      dewsScore: live.dewsScore ?? null,
      liquidityScore: live.liquidityScore ?? null,
      safetyGrade: live.safetyGrade ?? null,
      safetyScore: live.safetyScore ?? null,
      safetyContext: live.safetyContext ?? { status: "identity-missing", reason: "safety-context-not-provided", identity: null },
      supplyChange7dPct: supply.change7dPct,
      supplyChange30dPct: supply.change30dPct,
      mintSurge: supply.mintSurge,
    },
  };
}

export * from "./inputs";
export * from "./strata";
export * from "./incident-groups";
export * from "./resolution";
export * from "./duration";
export * from "./hash";
export * from "./public-contract";
export * from "./forecast-readiness";
