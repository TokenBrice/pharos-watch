import type { DdrV2ResponseRow } from "../../../types/depeg-resolver";
import { attachDdrPublicRowHash, computeDdrPublicRowHash, type validateDdrPublicCacheContract } from "../public-contract";

export function basePublicRow(incidentKey = "ddr2:test", prediction: Partial<DdrV2ResponseRow["prediction"]> = {}) {
  return {
    stablecoinId: "lusd-liquity",
    symbol: "LUSD",
    name: "Liquity USD",
    pegCurrency: "USD",
    governance: "decentralized",
    status: null,
    eventId: 1,
    incidentKey,
    startedAt: 100,
    direction: "below",
    kind: "prediction",
    prediction: {
      incidentKey,
      eligibleAt: 200,
      lockedAt: 200,
      eventAgeAtLockSec: 100,
      lockTiming: "on_time",
      policyDelaySec: 100,
      predictionPolicyVersion: "sticky-24h-v1",
      predictionMethodologyVersion: "2.0",
      predictionMethodologyVersionLabel: "v2.0",
      resolutionRubricVersion: "resolution-v1",
      durationModelVersion: "duration-v1",
      incidentGroupingVersion: "incident-v1",
      supportRulesVersion: "support-v1",
      ...prediction,
    },
    frozen: { resolution: { tier: "at_risk", factors: [] } },
  };
}

export function validPublicPredictionResponse() {
  const baseRow = {
    ...basePublicRow("ddr2:validator", { state: "frozen", publicPredictionId: 7, rowHash: null }),
    live: {
      currentEventId: 1,
      ageSec: 100,
      peakDeviationBps: -200,
      currentDeviationBps: -150,
      eventState: "active",
      updatedAt: 250,
      stale: false,
      degradedReason: null,
    },
  };
  const rowHash = computeDdrPublicRowHash(baseRow);
  const row = attachDdrPublicRowHash(baseRow, rowHash);
  return {
    _meta: {
      schemaVersion: 2,
      snapshotGeneration: 2,
      publicPredictionIds: [7],
      publicPredictionRowHashes: { "7": rowHash },
      basePayloadHash: null,
      publicWarning: "warning",
      resolutionRubricVersion: "resolution-v1",
      durationModelVersion: "duration-v1",
      incidentGroupingVersion: "incident-v1",
      supportRulesVersion: "support-v1",
      lineage: null,
    },
    rows: [row],
    methodology: { version: "2.0" },
  } as unknown as Parameters<typeof validateDdrPublicCacheContract>[0];
}
