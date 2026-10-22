import type { V9MechanismFactV1, V9MechanismRiskReview } from "../../types/safety-score-v9-backing";

export type V9SimpleArchetype =
  | "fiat-cash" | "commodity-claim" | "tbill"
  | "ucits-trs-fund" | "shared-reserve" | "protocol-position";
export type V9SimpleReview = Extract<V9MechanismRiskReview, { archetype: V9SimpleArchetype }>;
type Review<A extends V9MechanismRiskReview["archetype"]> = Extract<V9MechanismRiskReview, { archetype: A }>;
type Field<T, Value> = { [K in keyof T]-?: T[K] extends Value ? K : never }[keyof T];
type MechanismFields<A extends V9MechanismRiskReview["archetype"]> = {
  readonly components: readonly (readonly [componentKey: string, field: Field<Review<A>, V9MechanismFactV1>])[];
  readonly metrics: readonly Field<Review<A>, number | null>[];
};

/** Field identity only: no evaluator implementations or reviewed registry graphs. */
export const V9_MECHANISM_FIELDS = {
  "fiat-cash": {
    components: [["claim-and-segregation", "claimAndSegregation"], ["custody-continuity", "custodyContinuity"],
      ["assurance-and-reconciliation", "assuranceAndReconciliation"]], metrics: [],
  },
  "commodity-claim": {
    components: [["title-and-allocation", "titleAndAllocation"], ["custody-continuity", "custodyContinuity"],
      ["assurance-and-reconciliation", "assuranceAndReconciliation"], ["physical-redemption", "physicalRedemption"]], metrics: [],
  },
  tbill: {
    components: [["fund-claim-and-seniority", "fundClaimAndSeniority"], ["nav-valuation", "navValuation"],
      ["duration-and-liquidity", "durationAndLiquidity"], ["loss-recovery-design", "lossRecoveryDesign"]], metrics: [],
  },
  "ucits-trs-fund": {
    components: [["fund-claim-and-segregation", "fundClaimAndSegregation"], ["nav-and-reconciliation", "navAndReconciliation"],
      ["portfolio-hedge", "portfolioHedge"], ["counterparty-and-collateral", "counterpartyAndCollateral"],
      ["custody-continuity", "custodyContinuity"], ["default-recovery", "defaultRecovery"]], metrics: [],
  },
  "shared-reserve": {
    components: [["holder-claim", "holderClaim"], ["liability-conservation", "liabilityConservation"],
      ["reserve-custody", "reserveCustody"], ["encumbrance-and-allocation", "encumbranceAndAllocation"],
      ["default-recovery", "defaultRecovery"]], metrics: [],
  },
  "protocol-position": {
    components: [["holder-claim", "holderClaim"], ["liability-conservation", "liabilityConservation"],
      ["reserve-custody", "positionCustody"], ["encumbrance-and-allocation", "encumbranceAndAllocation"],
      ["default-recovery", "defaultRecovery"]], metrics: [],
  },
  cdp: {
    components: [["collateralization-parameters", "collateralizationParameters"], ["liquidation-mechanics", "liquidationMechanics"],
      ["backstop", "backstop"], ["branch-isolation", "branchIsolation"], ["shutdown-and-bad-debt", "shutdownAndBadDebt"],
      ["structural-redemption", "structuralRedemption"]], metrics: ["collateralizationRatio", "liquidationCapacityRatio"],
  },
  "synthetic-delta-neutral": {
    components: [["venue-and-custody", "venueAndCustody"], ["hedge-reconciliation", "hedgeReconciliation"],
      ["funding-basis-stress", "fundingBasisStress"], ["margin-and-liquidation", "marginAndLiquidation"],
      ["unwind-capacity", "unwindCapacity"], ["loss-absorption", "lossAbsorption"]],
    metrics: ["hedgeCoverageRatio", "marginBufferPct", "lossAbsorptionShare"],
  },
  algorithmic: {
    components: [["contraction-capacity", "contractionCapacity"], ["confidence-and-incentives", "confidenceAndIncentives"],
      ["oracle-and-control-assumptions", "oracleAndControlAssumptions"], ["emergency-recovery", "emergencyRecovery"],
      ["loss-recovery", "lossRecovery"]], metrics: ["exogenousBackingShare", "reflexiveBackingShare", "contractionCapacityRatio"],
  },
  "rwa-credit-fund": {
    components: [["credit-quality", "creditQuality"], ["seniority", "seniority"], ["legal-enforceability", "legalEnforceability"],
      ["valuation-cadence", "valuationCadence"], ["maturity-and-liquidity", "maturityAndLiquidity"],
      ["custody", "custody"], ["recovery", "recovery"]], metrics: ["weightedAverageMaturityDays", "valuationCadenceDays"],
  },
} as const satisfies { readonly [A in V9MechanismRiskReview["archetype"]]: MechanismFields<A> };
