import { computePegScore } from "@shared/lib/peg-score";
import type { DepegEvent, PegSummaryCoin } from "@shared/types/market";

const ASSET_ID = "usdg-paxos";
type EventOverrides = Partial<DepegEvent> & Pick<DepegEvent, "id" | "startedAt" | "peakDeviationBps">;

export function event(overrides: EventOverrides): DepegEvent {
  const {
    id,
    startedAt,
    peakDeviationBps,
    direction: overrideDirection,
    ...optionalOverrides
  } = overrides;
  const direction = peakDeviationBps > 0 ? "above" : "below";
  const pegReference = optionalOverrides.pegReference ?? 1;
  const startPrice =
    optionalOverrides.startPrice ??
    pegReference * (1 + peakDeviationBps / 10_000);
  return {
    id,
    stablecoinId: ASSET_ID,
    symbol: "USDG",
    pegType: "peggedUSD",
    direction: overrideDirection ?? direction,
    peakDeviationBps,
    startedAt,
    endedAt: startedAt + 3_600,
    startPrice,
    peakPrice: startPrice,
    recoveryPrice: pegReference,
    pegReference,
    source: "backfill",
    constituentEventCount: 1,
    confirmationSources: null,
    pendingReason: null,
    closeReason: null,
    provenance: null,
    ...optionalOverrides,
  };
}
export function replayProvenance(
  clockSec: number,
  confidenceTier: "high" | "medium" | "low",
  providers: string[] = ["provider-a", "provider-b"],
): NonNullable<DepegEvent["provenance"]> {
  return {
    sourceKind: "market",
    replayRunId: "replay:1",
    replayVersion: "depeg-backfill-v6.0",
    sourcePriceProviders: providers,
    quoteMode: "native-peg",
    pegReferenceSource: "native-peg-history",
    supplySource: "defillama-history",
    confirmationPolicy: "two-point-36h-or-extreme",
    confirmationPointCount: 2,
    confidenceTier,
    auditVerdict: "confirmed",
    pegScoreEligible: true,
    updatedAt: clockSec - 86_400,
  };
}
export function pegSummary(events: readonly DepegEvent[], clockSec: number, trackingStartSec: number, methodologyVersion: string): PegSummaryCoin {
  const result = computePegScore([...events], trackingStartSec, clockSec);
  return {
    id: ASSET_ID,
    symbol: "USDG",
    name: "Global Dollar",
    pegType: "peggedUSD",
    pegCurrency: "USD",
    governance: "centralized",
    currentDeviationBps: 0,
    pegScore: result.pegScore,
    pegPct: result.pegPct,
    severityScore: result.severityScore,
    spreadPenalty: result.spreadPenalty,
    eventCount: result.eventCount,
    worstDeviationBps: result.worstDeviationBps,
    activeDepeg: result.activeDepeg,
    lastEventAt: result.lastEventAt,
    trackingSpanDays: result.trackingSpanDays,
    historyCoverage: {
      startedAt: trackingStartSec,
      source: "asset-age",
      status: "assumed",
    },
    methodologyVersion: methodologyVersion,
  };
}
const USDG_LEGACY_ROWS = [
  [26637, 153, 1731330362, 1731333917],
  [26638, 121, 1731348371, 1731351959],
  [26639, 165, 1731557457, 1731560995],
  [26640, -403, 1731902932, 1731906479],
  [26641, 538, 1732195745, 1732213901],
  [26642, 499, 1732705785, 1732709445],
  [26643, 434, 1734026615, 1734037416],
  [26644, 102, 1734609836, 1734613431],
  [26645, 6544, 1738195431, 1738199030],
  [26646, 2961, 1738263698, 1738267293],
  [26647, 480, 1738339433, 1738343312],
  [26648, 435, 1738454574, 1738458185],
  [26649, -680, 1740769483, 1740773147],
] as const;
export function legacyEvents(): DepegEvent[] {
  return USDG_LEGACY_ROWS.map(([id, peakDeviationBps, startedAt, endedAt]) =>
    event({ id, peakDeviationBps, startedAt, endedAt }),
  );
}
