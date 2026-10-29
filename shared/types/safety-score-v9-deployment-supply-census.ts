import { z } from "zod";
import candidatePolicy from "../data/safety-score-v9/methodology-policy-candidate-v1.json";
import {
  CanonicalChainIdSchema,
  CanonicalTextSchema,
  NonNegativeFiniteSchema,
  Sha256Schema,
  UnixSecondsSchema,
} from "./safety-schema-primitives";

/**
 * v10.38 deployment supply census (`deployment-supply-census-v1`, WS6 / 4a).
 *
 * One pinned per-deployment `totalSupply` read per chain bounds a deployment's
 * share of the asset's supply from above. A row is only ever an upper bound:
 * `evidenceKind: "upper-bound"` must travel with it so no consumer can treat it
 * as an exact share. Admission gates (plan §4.6) live in policy
 * (`semantic.supplyAttribution.deploymentSupplyCensus`); this file is the wire
 * shape and re-checks the same bounds so a captured packet cannot widen them.
 */
export const SAFETY_SCORE_V9_DEPLOYMENT_SUPPLY_CENSUS_MODEL = "deployment-supply-census-v1" as const;
export const V9_DEPLOYMENT_SUPPLY_CENSUS_REJECTION_PREFIX = "census-rejected:" as const;

const censusPolicy = candidatePolicy.semantic.supplyAttribution.deploymentSupplyCensus;
// Tolerance is a policy constant, never the packet's own claim: a captured
// packet must restate the admitted values exactly.
const supplyPolicy = candidatePolicy.semantic.supplyAttribution;

/** Machine reason for one rejected deployment (or the whole asset when the key is null). */
export const V9DeploymentSupplyCensusRejectionReasonSchema = z.enum([
  // The reviewed roster is not fully measured; a partial partition is never evidence.
  "roster-incomplete",
  // SUM(shareUpper) exceeds 1 + conservation tolerance (e.g. a canonical over-count).
  "conservation-breach",
  // The route is not a reviewed bridge route with a token address.
  "route-unreviewed",
  // No admitted read kind exists for this chain family.
  "read-unavailable",
  // The pinned header/slot/ledger is absent.
  "missing-block-pin",
  // An EVM observation carries no runtime code hash.
  "missing-code-hash",
  // clockSec - pin time exceeds the census observation window.
  "observation-stale",
  // Cross-chain pin times exceed the census skew allowance.
  "cross-chain-skew",
  // A pin or reference price postdates the census clock.
  "future-dated-pin",
  // No current reference price for the deployment unit.
  "reference-price-unavailable",
  // The asset exceeds the per-asset deployment cap (the 65th deployment).
  "deployment-over-cap",
  // The route's amount basis is not a fixed-token-unit basis.
  "unresolved-amount-basis",
  // A measured share >= 1% needs a reviewed escrow rule or an exact read.
  "share-requires-reviewed-escrow",
]);
export type V9DeploymentSupplyCensusRejectionReason = z.infer<
  typeof V9DeploymentSupplyCensusRejectionReasonSchema
>;

/** `census-rejected:<reason>`: the one diagnostic code shape (plan §4.6 Interfaces). */
export const V9DeploymentSupplyCensusRejectionCodeSchema = z.templateLiteral([
  V9_DEPLOYMENT_SUPPLY_CENSUS_REJECTION_PREFIX,
  V9DeploymentSupplyCensusRejectionReasonSchema,
]);
export type V9DeploymentSupplyCensusRejectionCode = z.infer<
  typeof V9DeploymentSupplyCensusRejectionCodeSchema
>;

export function deploymentSupplyCensusRejectionCode(
  reason: V9DeploymentSupplyCensusRejectionReason,
): V9DeploymentSupplyCensusRejectionCode {
  return `${V9_DEPLOYMENT_SUPPLY_CENSUS_REJECTION_PREFIX}${reason}`;
}

const CensusTokenAddressSchema = z.string().min(1).max(128);
const EvmTokenAddressSchema = z.string().regex(/^0x[0-9a-f]{40}$/);
const EvmBlockHashSchema = z.string().regex(/^0x[0-9a-f]{64}$/);
const MoveAddressSchema = z.string().regex(/^0x[0-9a-f]{1,64}$/);
const IntegerStringSchema = z.string().max(128).regex(/^(0|[1-9][0-9]*)$/);

/**
 * One pinned header/slot/ledger per chain per run. A pin names exactly what was
 * read; a missing pin rejects the row (R3), never zero.
 */
export const V9DeploymentSupplyCensusPinSchema = z.discriminatedUnion("kind", [
  z.strictObject({
    kind: z.literal("evm-header"),
    blockNumber: z.number().int().positive(),
    blockHash: EvmBlockHashSchema,
    blockTimeSec: UnixSecondsSchema,
    // Required: an unverified runtime cannot bound a deployment.
    runtimeCodeSha256: Sha256Schema,
  }),
  z.strictObject({
    kind: z.literal("solana-finalized-slot"),
    slot: z.number().int().nonnegative(),
    blockHash: CanonicalTextSchema,
    blockTimeSec: UnixSecondsSchema,
    // Supply-only identity: mint owner plus decimals, never a holder scan.
    mintProgramOwner: CanonicalTextSchema,
  }),
  z.strictObject({
    kind: z.literal("move-ledger-version"),
    ledgerVersion: IntegerStringSchema,
    blockTimeSec: UnixSecondsSchema,
    packageAddress: MoveAddressSchema,
  }),
]);
export type V9DeploymentSupplyCensusPin = z.output<typeof V9DeploymentSupplyCensusPinSchema>;

const READ_KINDS = ["evm-total-supply", "solana-mint", "move-fa-supply"] as const;
const READ_KIND_PIN: Readonly<Record<(typeof READ_KINDS)[number], V9DeploymentSupplyCensusPin["kind"]>> = {
  "evm-total-supply": "evm-header",
  "solana-mint": "solana-finalized-slot",
  "move-fa-supply": "move-ledger-version",
};

/** One measured deployment. `shareUpper` is a proof of immateriality below the bar, never an exact share. */
export const V9DeploymentSupplyCensusRowSchema = z
  .strictObject({
    deploymentRouteKey: CanonicalTextSchema,
    chainId: CanonicalChainIdSchema,
    tokenAddress: CensusTokenAddressSchema,
    readKind: z.enum(READ_KINDS),
    pin: V9DeploymentSupplyCensusPinSchema,
    decimals: z.number().int().min(0).max(36),
    totalSupplyRaw: IntegerStringSchema,
    referencePriceUsd: z.number().finite().positive(),
    referencePriceObservedAtSec: UnixSecondsSchema,
    supplyUsdUpper: NonNegativeFiniteSchema,
    shareUpper: NonNegativeFiniteSchema,
    evidenceKind: z.literal("upper-bound"),
  })
  .superRefine((row, ctx) => {
    if (row.pin.kind !== READ_KIND_PIN[row.readKind]) {
      ctx.addIssue({ code: "custom", path: ["pin"], message: "Read kind and pin kind must agree" });
    }
    if (row.readKind === "evm-total-supply" && !EvmTokenAddressSchema.safeParse(row.tokenAddress).success) {
      ctx.addIssue({ code: "custom", path: ["tokenAddress"], message: "EVM deployments need a 0x token address" });
    }
  });
export type V9DeploymentSupplyCensusRow = z.output<typeof V9DeploymentSupplyCensusRowSchema>;

/** Conservation of the admitted partition. A breach is representable so the diagnostic can name it. */
export const V9DeploymentSupplyCensusConservationSchema = z
  .strictObject({
    aggregateSupplyUsd: NonNegativeFiniteSchema,
    measuredSupplyUsd: NonNegativeFiniteSchema,
    measuredShareSum: NonNegativeFiniteSchema,
    relativeTolerance: z.number().finite().nonnegative(),
    absoluteToleranceUsd: z.number().finite().nonnegative(),
    rosterComplete: z.boolean(),
    conserved: z.boolean(),
  })
  .superRefine((conservation, ctx) => {
    if (conservation.relativeTolerance !== supplyPolicy.conservationRelativeTolerance ||
        conservation.absoluteToleranceUsd !== supplyPolicy.conservationAbsoluteToleranceUsd) {
      ctx.addIssue({
        code: "custom",
        path: ["relativeTolerance"],
        message: "Conservation tolerance is the policy value, not the packet's own claim",
      });
    }
    const allowedUsd = conservation.aggregateSupplyUsd * (1 + conservation.relativeTolerance) +
      conservation.absoluteToleranceUsd;
    if (conservation.conserved && conservation.measuredSupplyUsd > allowedUsd) {
      ctx.addIssue({
        code: "custom",
        path: ["conserved"],
        message: "A packet above the conservation ceiling cannot claim conservation",
      });
    }
    if (conservation.conserved && !conservation.rosterComplete) {
      ctx.addIssue({
        code: "custom",
        path: ["conserved"],
        message: "Conservation requires the whole reviewed roster",
      });
    }
  });
export type V9DeploymentSupplyCensusConservation = z.output<
  typeof V9DeploymentSupplyCensusConservationSchema
>;

/** One rejected deployment (or `null` for an asset-level rejection), always machine-reasoned. */
export const V9DeploymentSupplyCensusRejectionSchema = z.strictObject({
  deploymentRouteKey: CanonicalTextSchema.nullable(),
  code: V9DeploymentSupplyCensusRejectionCodeSchema,
});
export type V9DeploymentSupplyCensusRejection = z.output<
  typeof V9DeploymentSupplyCensusRejectionSchema
>;

function pinIdentity(pin: V9DeploymentSupplyCensusPin): string {
  switch (pin.kind) {
    case "evm-header":
      // The header pins the chain, not the token: two deployments on one chain
      // share blockNumber/blockHash/blockTimeSec and may carry different
      // runtime code hashes (each row still requires its own).
      return `${pin.kind}:${pin.blockNumber}:${pin.blockHash}:${pin.blockTimeSec}`;
    case "solana-finalized-slot":
      return `${pin.kind}:${pin.slot}:${pin.blockHash}:${pin.blockTimeSec}`;
    case "move-ledger-version":
      return `${pin.kind}:${pin.ledgerVersion}:${pin.blockTimeSec}`;
  }
}

/** One asset's admitted census partition; the fixed-input projection carries only this packet. */
export const SafetyScoreV9DeploymentSupplyCensusSchema = z
  .strictObject({
    model: z.literal(SAFETY_SCORE_V9_DEPLOYMENT_SUPPLY_CENSUS_MODEL),
    observedAtSec: UnixSecondsSchema,
    deployments: z
      .array(V9DeploymentSupplyCensusRowSchema)
      .max(censusPolicy.maxDeploymentsPerAsset),
    conservation: V9DeploymentSupplyCensusConservationSchema,
    rejected: z
      .array(V9DeploymentSupplyCensusRejectionSchema)
      .max(censusPolicy.maxDeploymentsPerAsset),
  })
  .superRefine((packet, ctx) => {
    const routeKeys = new Set<string>();
    const pinByChain = new Map<string, string>();
    const pinTimes: number[] = [];
    packet.deployments.forEach((row, index) => {
      if (routeKeys.has(row.deploymentRouteKey)) {
        ctx.addIssue({ code: "custom", path: ["deployments", index, "deploymentRouteKey"], message: "Duplicate deployment row" });
      }
      routeKeys.add(row.deploymentRouteKey);
      const identity = pinIdentity(row.pin);
      const chainPin = pinByChain.get(row.chainId);
      if (chainPin !== undefined && chainPin !== identity) {
        ctx.addIssue({ code: "custom", path: ["deployments", index, "pin"], message: "One pinned header per chain" });
      }
      pinByChain.set(row.chainId, identity);
      pinTimes.push(row.pin.blockTimeSec);
      const pinAgeSec = packet.observedAtSec - row.pin.blockTimeSec;
      if (pinAgeSec < 0) {
        ctx.addIssue({ code: "custom", path: ["deployments", index, "pin", "blockTimeSec"], message: "Pin cannot postdate the census clock" });
      } else if (pinAgeSec > censusPolicy.observationMaxAgeSec) {
        ctx.addIssue({ code: "custom", path: ["deployments", index, "pin", "blockTimeSec"], message: "Pin is older than the census observation window" });
      }
      const priceAgeSec = packet.observedAtSec - row.referencePriceObservedAtSec;
      if (priceAgeSec < 0) {
        ctx.addIssue({ code: "custom", path: ["deployments", index, "referencePriceObservedAtSec"], message: "Reference price cannot postdate the census clock" });
      } else if (priceAgeSec > censusPolicy.observationMaxAgeSec) {
        ctx.addIssue({ code: "custom", path: ["deployments", index, "referencePriceObservedAtSec"], message: "Reference price is older than the census observation window" });
      }
    });
    if (pinTimes.length > 1) {
      const skewSec = Math.max(...pinTimes) - Math.min(...pinTimes);
      if (skewSec > censusPolicy.observationMaxSkewSec) {
        ctx.addIssue({ code: "custom", path: ["deployments"], message: "Cross-chain pin skew exceeds the census allowance" });
      }
    }
    packet.rejected.forEach((rejection, index) => {
      if (rejection.deploymentRouteKey !== null && routeKeys.has(rejection.deploymentRouteKey)) {
        ctx.addIssue({
          code: "custom",
          path: ["rejected", index, "deploymentRouteKey"],
          message: "A rejected deployment cannot also be admitted",
        });
      }
    });
  });
export type SafetyScoreV9DeploymentSupplyCensus = z.output<
  typeof SafetyScoreV9DeploymentSupplyCensusSchema
>;

/** `safetyScoreV9DeploymentSupplyCensusById[assetId]`: the fixed-input projection. */
export const SafetyScoreV9DeploymentSupplyCensusByIdSchema = z.record(
  CanonicalTextSchema,
  SafetyScoreV9DeploymentSupplyCensusSchema,
);
export type SafetyScoreV9DeploymentSupplyCensusById = z.output<
  typeof SafetyScoreV9DeploymentSupplyCensusByIdSchema
>;

/**
 * Policy block at `semantic.supplyAttribution.deploymentSupplyCensus`. The
 * age/skew gates restate the supply-attribution authorities; the policy schema
 * rejects any drift between the two copies.
 */
export const V9DeploymentSupplyCensusPolicySchema = z
  .strictObject({
    model: z.literal(SAFETY_SCORE_V9_DEPLOYMENT_SUPPLY_CENSUS_MODEL),
    // Tier 0: the provider chain total is already an upper bound, no read needed.
    tier0ChainBound: z.literal(true),
    // Tier 1: one pinned totalSupply read per deployment.
    tier1Read: z.literal("total-supply"),
    pinnedHeaderPerChain: z.literal(true),
    requireRuntimeCodeHash: z.literal(true),
    evmMulticallMaxBatchSize: z.number().int().positive().max(64),
    solanaCommitment: z.literal("finalized"),
    solanaMaxAccountsPerRequest: z.number().int().positive().max(100),
    movePin: z.literal("ledger-version"),
    maxDeploymentsPerAsset: z.number().int().positive().max(64),
    observationMaxAgeSec: z.number().int().positive(),
    observationMaxSkewSec: z.number().int().nonnegative(),
  })
  .strict();
export type V9DeploymentSupplyCensusPolicy = z.output<
  typeof V9DeploymentSupplyCensusPolicySchema
>;
