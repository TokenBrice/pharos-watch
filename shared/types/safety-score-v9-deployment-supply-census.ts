import { z } from "zod";
import candidatePolicy from "../data/safety-score-v9/methodology-policy-candidate-v1.json";
import {
  BaseInputGenerationIdSchema,
  CanonicalChainIdSchema,
  CanonicalTextSchema,
  NonNegativeFiniteSchema,
  Sha256Schema,
  UnixSecondsSchema,
} from "./safety-schema-primitives";
import { DeploymentIdSchema } from "./stablecoin-meta-primitives";

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
// Float-conversion floor for the raw-units x reference-price identity; the
// policy relative tolerance still governs conservation sums.
const CENSUS_ARITHMETIC_RELATIVE_TOLERANCE = 1e-9;

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
  // The served census map carries no generation binding to the compute input.
  "generation-unbound",
  // The served census was built for another registry or base input generation.
  "generation-mismatch",
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

/**
 * The one census serving/evaluation window (v10.38): the declared per-source
 * chain-supply ceiling for `deployment-supply-census-v1`. Capture freshness
 * (`observationMaxAgeSec`, 1,800 s) governs a packet's own pin and price age;
 * this ceiling governs how long a captured packet may be served and admitted,
 * and the store and the consumer both read it here instead of restating it.
 */
export function deploymentSupplyCensusMaxAgeSec(): number {
  return supplyPolicy.chainSupplyMaxAgeBySource.maxAgeSecBySource[
    SAFETY_SCORE_V9_DEPLOYMENT_SUPPLY_CENSUS_MODEL];
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
    routeId: DeploymentIdSchema,
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
  routeId: DeploymentIdSchema.nullable(),
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

/**
 * One asset's admitted census partition; the fixed-input projection carries only this packet.
 * Conservation is recomputed from this packet's own rows (M-9): declared totals or a
 * `conserved` flag can never outweigh an over-counting row set.
 */
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
    const routeIds = new Set<string>();
    const pinByChain = new Map<string, string>();
    const pinTimes: number[] = [];
    const conservation = packet.conservation;
    const rowsSupplyUsd = packet.deployments.reduce((sum, row) => sum + row.supplyUsdUpper, 0);
    const rowsShare = packet.deployments.reduce((sum, row) => sum + row.shareUpper, 0);
    const usdTolerance = conservation.absoluteToleranceUsd +
      conservation.relativeTolerance * Math.max(rowsSupplyUsd, conservation.measuredSupplyUsd);
    const shareTolerance = conservation.relativeTolerance * Math.max(1, Math.abs(rowsShare));
    if (Math.abs(conservation.measuredSupplyUsd - rowsSupplyUsd) > usdTolerance) {
      ctx.addIssue({
        code: "custom",
        path: ["conservation", "measuredSupplyUsd"],
        message: "Declared measured supply must equal the deployment rows",
      });
    }
    if (Math.abs(conservation.measuredShareSum - rowsShare) > shareTolerance) {
      ctx.addIssue({
        code: "custom",
        path: ["conservation", "measuredShareSum"],
        message: "Declared measured share must equal the deployment rows",
      });
    }
    packet.deployments.forEach((row, index) => {
      if (routeIds.has(row.routeId)) {
        ctx.addIssue({ code: "custom", path: ["deployments", index, "routeId"], message: "Duplicate deployment row" });
      }
      routeIds.add(row.routeId);
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
      } else if (pinAgeSec > supplyPolicy.observationMaxAgeSec) {
        ctx.addIssue({ code: "custom", path: ["deployments", index, "pin", "blockTimeSec"], message: "Pin is older than the census observation window" });
      }
      const priceAgeSec = packet.observedAtSec - row.referencePriceObservedAtSec;
      if (priceAgeSec < 0) {
        ctx.addIssue({ code: "custom", path: ["deployments", index, "referencePriceObservedAtSec"], message: "Reference price cannot postdate the census clock" });
      } else if (priceAgeSec > supplyPolicy.observationMaxAgeSec) {
        ctx.addIssue({ code: "custom", path: ["deployments", index, "referencePriceObservedAtSec"], message: "Reference price is older than the census observation window" });
      }
      if (conservation.aggregateSupplyUsd > 0 &&
          row.shareUpper + shareTolerance < row.supplyUsdUpper / conservation.aggregateSupplyUsd) {
        ctx.addIssue({
          code: "custom",
          path: ["deployments", index, "shareUpper"],
          message: "shareUpper must bound the row's share of aggregate supply",
        });
      }
      const expectedSupplyUsd = Number(row.totalSupplyRaw) / 10 ** row.decimals * row.referencePriceUsd;
      const productTolerance = Math.max(
        conservation.absoluteToleranceUsd,
        expectedSupplyUsd * Math.max(conservation.relativeTolerance, CENSUS_ARITHMETIC_RELATIVE_TOLERANCE),
      );
      if (Math.abs(row.supplyUsdUpper - expectedSupplyUsd) > productTolerance) {
        ctx.addIssue({
          code: "custom",
          path: ["deployments", index, "supplyUsdUpper"],
          message: "supplyUsdUpper must equal raw units times the reference price",
        });
      }
    });
    if (pinTimes.length > 1) {
      const skewSec = Math.max(...pinTimes) - Math.min(...pinTimes);
      if (skewSec > supplyPolicy.observationMaxSkewSec) {
        ctx.addIssue({ code: "custom", path: ["deployments"], message: "Cross-chain pin skew exceeds the census allowance" });
      }
    }
    if (conservation.conserved && packet.rejected.some((rejection) => rejection.routeId === null)) {
      ctx.addIssue({
        code: "custom",
        path: ["conservation", "conserved"],
        message: "An asset-level rejection cannot claim conservation",
      });
    }
    packet.rejected.forEach((rejection, index) => {
      if (rejection.routeId !== null && routeIds.has(rejection.routeId)) {
        ctx.addIssue({
          code: "custom",
          path: ["rejected", index, "routeId"],
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
 * The generation identity that must travel beside the fixed-input projection.
 * A packet map without it is unbound (`census-rejected:generation-unbound`);
 * one whose binding names another registry or compiler base generation is
 * `census-rejected:generation-mismatch`. Neither ever becomes an empty census.
 */
export const SafetyScoreV9DeploymentSupplyCensusBindingSchema = z.strictObject({
  generationId: z.string().min(1).max(256),
  registryFingerprint: Sha256Schema,
  sourceBaseInputGenerationId: BaseInputGenerationIdSchema,
});
export type SafetyScoreV9DeploymentSupplyCensusBinding = z.output<
  typeof SafetyScoreV9DeploymentSupplyCensusBindingSchema
>;

/**
 * Policy block at `semantic.supplyAttribution.deploymentSupplyCensus`. Pin age
 * and cross-chain skew are the supply-attribution authorities
 * (`observationMaxAgeSec` / `observationMaxSkewSec`), read directly by the wire
 * schema instead of restated here (S-12).
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
  })
  .strict();
export type V9DeploymentSupplyCensusPolicy = z.output<
  typeof V9DeploymentSupplyCensusPolicySchema
>;
