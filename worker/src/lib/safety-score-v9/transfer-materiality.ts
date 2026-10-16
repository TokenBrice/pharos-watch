import { resolveChainId } from "@shared/types/chain-identity";
import { compareText } from "@shared/lib/safety-score-v9/primitives";
import { V9_REVIEW_EVIDENCE_MAX_AGE_SEC } from "@shared/lib/safety-score-v9/evidence";
import type { ContractDeployment } from "@shared/types/core";
import { safetyScoreV9TransferDeploymentKey, type SafetyScoreV9ReviewedTransferFact } from "@shared/types/safety-score-v9-transfer-overlays";
import { getCirculatingRawOrNull } from "@shared/lib/supply";
import { BaseInputGenerationIdSchema, Sha256Schema, UnixSecondsSchema } from "@shared/types/safety-schema-primitives";
import { z } from "zod";
import { createCanonicalGenerationCodec } from "../canonical-generation-codec";
import type { V9ExtensionRegistryMeta } from "./extension-shared";
import type { SafetyScoreV9TransferMaterialScope } from "./extension-transfer";
import { reviewedDeploymentObservationTimingIssue } from "./supply-attribution-contract";
import { V9_CANDIDATE_POLICY_V1 } from "@shared/lib/safety-score-v9/policy";
import { REVIEWED_ECONOMIC_SUPPLY_PLANS, REVIEWED_SUPPLY_ATTRIBUTION_ENVELOPE, reviewedEconomicDeploymentAttributionValidationError } from "./supply-attribution-contract";
import type { SafetyScoreV9CompilerInput } from "./native-input";
import { isFixedDecimalDeployment } from "@shared/lib/deployment-amounts";

export const SAFETY_SCORE_V9_TRANSFER_MATERIALITY_CACHE_KEY =
  "safety-score-v9:transfer-materiality-generation:v1";
const SAFETY_SCORE_V9_TRANSFER_MATERIALITY_MAX_AGE_SEC = V9_CANDIDATE_POLICY_V1.policy.semantic.supplyAttribution.observationMaxAgeSec;

export const SAFETY_SCORE_V9_TRANSFER_MATERIALITY_ASSET_IDS = Object.freeze([...new Set([
  "aa-falconx-mev-capital", "asusdf-astherus", "bbqusdc-steakhouse", "bd-basedollar", "dusd-dialectic",
  "eearn-ember", "fusd-freedom-dollar", "fxsave-f-x-protocol", "gldt-gold-dao",
  "gtusdc-gauntlet", "gtusdcp-gauntlet", "jpyt-dephaser", "jusd-juicedollar",
  "kgst-kyrgyz-som", "luausd-lumi-finance", "sbold-k3-capital", "scrvusd-curve",
  "sdai-sky", "sdola-inverse-finance", "sdusd-dtrinity", "sfrxusd-frax", "sgho-aave",
  "srusd-reservoir", "srusde-strata", "stcusd-cap", "stkgho-umbrella-aave", "stusd-stoneyield", "stusds-sky",
  "susdd-tron-dao-reserve", "susds-sky", "susn-noon", "syzusd-yuzu", "usdcx-movement",
  "vcred-vcred", "vusd-virtue", "wsrusd-reservoir", "xdai-gnosis", "ybold-yearn",
  "yusd-yieldfi", "zsd-zephyr-protocol", "zys-zephyr-protocol",
  ...REVIEWED_ECONOMIC_SUPPLY_PLANS.keys(),
  ...REVIEWED_SUPPLY_ATTRIBUTION_ENVELOPE.independentLiabilityAssetIds,
  ...(REVIEWED_SUPPLY_ATTRIBUTION_ENVELOPE.providerChainPartitionReviews ?? []).map(row => row.assetId),
])].sort(compareText));

const TRANSFER_MATERIALITY_ASSET_ID_SET = new Set(SAFETY_SCORE_V9_TRANSFER_MATERIALITY_ASSET_IDS);
const HaltedChainHeadSchema = z.object({
  endpointOrigin: z.string().url().refine(value => new URL(value).origin === value),
  blockNumber: z.string().regex(/^(0|[1-9][0-9]*)$/),
  blockHash: z.string().regex(/^0x[a-f0-9]{64}$/),
  timestampSec: UnixSecondsSchema,
}).strict();
const HaltedChainProvenanceSchema = z.object({
  kind: z.literal("halted-chain"),
  checkedAtSec: UnixSecondsSchema,
  heads: z.tuple([HaltedChainHeadSchema, HaltedChainHeadSchema]),
}).strict();
const DeploymentObservationSchema = z.object({
  deploymentKey: z.string().min(1),
  rawTokenUnits: z.string().regex(/^(0|[1-9][0-9]*)$/).nullable(),
  decimals: z.number().int().min(0).max(255).nullable(),
  blockNumber: z.string().regex(/^(0|[1-9][0-9]*)$/).nullable(),
  blockHash: z.string().regex(/^0x[0-9a-f]{64}$/).optional(),
  observedAtSec: UnixSecondsSchema.nullable(),
  status: z.enum(["accepted", "rejected"]),
  provenance: HaltedChainProvenanceSchema.optional(),
}).strict().superRefine((row, ctx) => {
  const complete = row.rawTokenUnits !== null && row.decimals !== null && row.blockNumber !== null && row.observedAtSec !== null;
  if ((row.status === "accepted") !== complete) ctx.addIssue({ code: "custom", message: "Accepted observations require a complete raw-unit packet" });
  if (row.provenance && (row.status !== "accepted" ||
      row.provenance.heads[0].endpointOrigin === row.provenance.heads[1].endpointOrigin ||
      row.provenance.heads.some(head => head.blockNumber !== row.blockNumber ||
        head.timestampSec !== row.observedAtSec || head.blockHash !== row.provenance!.heads[0].blockHash ||
        row.provenance!.checkedAtSec - head.timestampSec < V9_CANDIDATE_POLICY_V1.policy.semantic.materiality.haltedChainMinStallSec))) {
    ctx.addIssue({ code: "custom", message: "Frozen liabilities require agreeing independent stalled heads" });
  }
});

/** Raw token-unit evidence only. It is deliberately incapable of carrying USD or price data. */
export type SafetyScoreV9TransferMaterialityObservation = z.infer<typeof DeploymentObservationSchema>;

const GenerationPayloadSchema = z.object({
  schemaVersion: z.literal(1),
  kind: z.literal("safety-score-v9-transfer-materiality-generation"),
  sourceBaseInputGenerationId: BaseInputGenerationIdSchema,
  registryFingerprint: Sha256Schema,
  capturedAtSec: UnixSecondsSchema,
  observationsByAssetId: z.record(z.string(), z.array(DeploymentObservationSchema)),
}).strict();

const generationCodec = createCanonicalGenerationCodec({
  payloadSchema: GenerationPayloadSchema,
  generationIdSchema: z.string().regex(/^safety-score-v9-transfer-materiality:v1:[a-f0-9]{64}$/),
  generationIdPrefix: "safety-score-v9-transfer-materiality:v1:",
  digestPayload: (payload) => payload,
  mismatchMessage: "Transfer materiality generation ID mismatch",
});

export type SafetyScoreV9TransferMaterialityGeneration = z.infer<typeof generationCodec.schema>;

export const createSafetyScoreV9TransferMaterialityGeneration = generationCodec.create;
export const parseSafetyScoreV9TransferMaterialityGeneration = generationCodec.parse;
export const serializeSafetyScoreV9TransferMaterialityGeneration = generationCodec.serialize;

function authoritativeDeployments(meta: V9ExtensionRegistryMeta): Array<{ deployment: ContractDeployment; key: string }> | null {
  const rows = (meta.contracts ?? []).map((deployment) => {
    const chainId = resolveChainId(deployment.chain);
    return chainId === null ? null : { deployment, key: safetyScoreV9TransferDeploymentKey(chainId, deployment.address) };
  });
  return rows.some((row) => row === null) ? null : rows as Array<{ deployment: ContractDeployment; key: string }>;
}

export type SafetyScoreV9ExactTransferMaterialityObservation = SafetyScoreV9TransferMaterialityObservation & {
  rawTokenUnits: string;
  decimals: number;
  blockNumber: string;
  observedAtSec: number;
  status: "accepted";
};

export interface SafetyScoreV9ExactTransferMaterialityPacket {
  authoritativeDeploymentKeys: readonly string[];
  observations: readonly SafetyScoreV9ExactTransferMaterialityObservation[];
}

/**
 * Admits a complete raw-unit packet only when it is bound to the exact fixed
 * input and registry inventory consumed by the compiler. This is shared by
 * transfer-scope review and the narrowly allowlisted independent-liability
 * supply partition so neither path can loosen identity, freshness, or timing.
 */
export function exactInputBoundTransferMaterialityPacket(input: {
  assetId: string;
  meta: V9ExtensionRegistryMeta;
  generation: SafetyScoreV9TransferMaterialityGeneration | null;
  registryFingerprint: string;
  baseInputGenerationId: string;
  clockSec: number;
}): SafetyScoreV9ExactTransferMaterialityPacket | null {
  if (!TRANSFER_MATERIALITY_ASSET_ID_SET.has(input.assetId)) return null;
  const deployments = authoritativeDeployments(input.meta);
  const observations = input.generation?.observationsByAssetId[input.assetId];
  if (
    deployments === null || deployments.length === 0 || !input.generation || !observations ||
    input.generation.registryFingerprint !== input.registryFingerprint ||
    input.generation.sourceBaseInputGenerationId !== input.baseInputGenerationId ||
    input.generation.capturedAtSec > input.clockSec ||
    input.clockSec - input.generation.capturedAtSec > SAFETY_SCORE_V9_TRANSFER_MATERIALITY_MAX_AGE_SEC
  ) return null;

  const expectedKeys = deployments.map(({ key }) => key).sort(compareText);
  const observedKeys = observations.map((row) => row.deploymentKey).sort(compareText);
  if (
    new Set(expectedKeys).size !== expectedKeys.length || new Set(observedKeys).size !== observedKeys.length ||
    expectedKeys.length !== observedKeys.length || expectedKeys.some((key, index) => key !== observedKeys[index])
  ) return null;

  const deploymentByKey = new Map(deployments.map((row) => [row.key, row.deployment]));
  if (observations.some((row) => {
    const deployment = deploymentByKey.get(row.deploymentKey);
    return row.status !== "accepted" || row.rawTokenUnits === null || row.decimals === null ||
      row.blockNumber === null || row.observedAtSec === null || !deployment || !isFixedDecimalDeployment(deployment) ||
      row.decimals !== deployment.decimals || row.observedAtSec > input.clockSec ||
      (row.provenance
        ? row.provenance.checkedAtSec > input.clockSec ||
          input.clockSec - row.provenance.checkedAtSec > SAFETY_SCORE_V9_TRANSFER_MATERIALITY_MAX_AGE_SEC ||
          !DeploymentObservationSchema.safeParse(row).success
        : input.clockSec - row.observedAtSec > SAFETY_SCORE_V9_TRANSFER_MATERIALITY_MAX_AGE_SEC);
  })) return null;

  const accepted = observations as SafetyScoreV9ExactTransferMaterialityObservation[];
  // Frozen ledger time is retained; only the independent head check has a
  // current clock. It never makes the halted leg healthy-live or native.
  const observedAt = accepted.map((row) => row.provenance?.checkedAtSec ?? row.observedAtSec);
  if (reviewedDeploymentObservationTimingIssue({
    clockSec: input.clockSec,
    captureStartedAtSec: Math.min(...observedAt),
    captureEndedAtSec: Math.max(...observedAt),
    observedAtSec: Math.max(...observedAt),
    deployments: accepted.map((row) => ({ routeId: row.deploymentKey, blockTimeSec: row.provenance?.checkedAtSec ?? row.observedAtSec })),
  }) !== null) return null;

  return {
    authoritativeDeploymentKeys: expectedKeys,
    observations: [...accepted].sort((left, right) => compareText(left.deploymentKey, right.deploymentKey)),
  };
}

export function transferMaterialScopeFromOnchainGeneration(input: {
  assetId: string;
  meta: V9ExtensionRegistryMeta;
  baseScope: SafetyScoreV9TransferMaterialScope;
  generation: SafetyScoreV9TransferMaterialityGeneration | null;
  registryFingerprint: string;
  baseInputGenerationId: string;
  clockSec: number;
}): SafetyScoreV9TransferMaterialScope {
  if (!TRANSFER_MATERIALITY_ASSET_ID_SET.has(input.assetId)) return input.baseScope;
  const packet = exactInputBoundTransferMaterialityPacket(input);
  if (packet === null) return input.baseScope;

  // Materiality here is "carries supply at all", deliberately not a share of a
  // summed total. Raw totalSupply() must not be summed across chains: for
  // lock-mint and bridged representations the same liability is reported by
  // several deployments, so a summed denominator overstates the total, understates
  // every share, and could drop a genuinely material deployment out of review
  // while still reporting scope complete. Counting any non-zero deployment as
  // material needs no denominator, so it is double-count safe by construction and
  // errs toward demanding more review coverage rather than less. The share-based
  // DEPLOYMENT_MATERIAL_SHARE_THRESHOLD stays with the DefiLlama path, whose
  // per-chain USD rows already resolve bridged representation.
  const materialDeploymentKeys = packet.observations
    .filter((row) => BigInt(row.rawTokenUnits) > 0n)
    .map((row) => row.deploymentKey)
    .sort(compareText);
  return {
    authoritativeDeploymentKeys: packet.authoritativeDeploymentKeys,
    materialDeploymentKeys,
    materialDeploymentScopeComplete: materialDeploymentKeys.length > 0,
    deploymentModel: "contract-addressable",
  };
}

/** Transfer-only reviewed attribution; never produces chain supply numbers. */
export function transferMaterialScopeFromSingleDeploymentAttribution(input: {
  meta: V9ExtensionRegistryMeta;
  review: SafetyScoreV9ReviewedTransferFact | undefined;
  aggregateCirculating: Parameters<typeof getCirculatingRawOrNull>[0];
  baseScope: SafetyScoreV9TransferMaterialScope;
  clockSec: number;
}): SafetyScoreV9TransferMaterialScope {
  const attestation = input.review?.transferScopeAttestation;
  if (input.baseScope.materialDeploymentScopeComplete || !attestation ||
    input.review?.assetId !== input.meta.id ||
    (input.meta.status !== undefined && input.meta.status !== "active") ||
    input.meta.variantKind === "pure-wrapper" ||
    (input.meta.bridgeRouteRisk !== undefined && input.meta.bridgeRouteRisk.tier !== "single-chain-or-native" &&
      !input.meta.bridgeRouteRisk.routes?.length) ||
    (input.meta.variantOf != null && input.meta.variantKind !== "savings-passthrough" &&
      input.meta.variantKind !== "risk-absorption" && input.meta.variantKind !== "strategy-vault") ||
    input.meta.bridgeRouteRisk?.routes?.some((route) =>
      route.routeClass !== "native" && route.issuanceModel !== "native-issuance")) return input.baseScope;
  const deployments = authoritativeDeployments(input.meta);
  if (deployments?.length !== 1 || deployments[0]!.key !== attestation.deploymentKey) return input.baseScope;
  const reviewedAtSec = Date.parse(`${attestation.reviewedAt}T00:00:00Z`) / 1_000;
  const expiresAtSec = Date.parse(`${attestation.expiresAt}T00:00:00Z`) / 1_000;
  const aggregate = getCirculatingRawOrNull(input.aggregateCirculating);
  if (aggregate === null || aggregate <= 0 ||
    reviewedAtSec > input.clockSec || input.clockSec >= expiresAtSec ||
    input.clockSec - reviewedAtSec > V9_REVIEW_EVIDENCE_MAX_AGE_SEC) return input.baseScope;
  return {
    authoritativeDeploymentKeys: [attestation.deploymentKey],
    materialDeploymentKeys: [attestation.deploymentKey],
    materialDeploymentScopeComplete: true,
    deploymentModel: "contract-addressable",
    scopeBasis: "attributed",
    scopeAttestation: attestation,
  };
}

/** Economic percentages only after the exhaustive, source-bound packet is admitted. */
export function transferMaterialScopeFromEconomicDeploymentPartition(input: {
  assetId: string; fixedInput: Readonly<SafetyScoreV9CompilerInput>; baseScope: SafetyScoreV9TransferMaterialScope;
}): SafetyScoreV9TransferMaterialScope {
  const packet = input.fixedInput.safetyScoreV9SupplyAttributionById?.[input.assetId];
  if (packet?.model !== "reviewed-economic-deployment-partition-v1") return input.baseScope;
  const rejected = { ...input.baseScope, materialDeploymentScopeComplete: false };
  const aggregate = input.fixedInput.aggregateCirculatingById[input.assetId];
  const aggregateSupplyUsd = getCirculatingRawOrNull(aggregate);
  if (aggregateSupplyUsd === null) return rejected;
  if (!packet.quantitativeCompleteness || packet.aggregate.supplyUsd <= 0 ||
    packet.unattributedSupplyUsd > 0 || reviewedEconomicDeploymentAttributionValidationError({
      assetId: input.assetId, attribution: packet, aggregateSupplyUsd,
      clockSec: input.fixedInput.clockSec, registryFingerprint: input.fixedInput.registryFingerprint,
      baseInputGenerationId: input.fixedInput.baseInputGenerationId, sourceGeneration: input.fixedInput.sourceGeneration,
      aggregateObservedAtSec: aggregate?.observedAtSec ?? null, referencePrice: input.fixedInput.navPriceById?.[input.assetId] ?? null,
      chainRows: input.fixedInput.chainCirculatingById[input.assetId],
    }) !== null) return rejected;
  const threshold = V9_CANDIDATE_POLICY_V1.policy.semantic.materiality.deploymentMaterialSharePct / 100;
  const nativeKeys = packet.deployments.filter(row => row.holdingKind === "native-gas").map(row => row.deploymentKey);
  return {
    authoritativeDeploymentKeys: packet.deployments.map(row => row.deploymentKey).sort(compareText),
    materialDeploymentKeys: packet.deployments.filter(row => row.currentSupplyUsd / packet.aggregate.supplyUsd >= threshold).map(row => row.deploymentKey).sort(compareText),
    materialDeploymentScopeComplete: true, deploymentModel: nativeKeys.length > 0 ? "mixed-economic" : "contract-addressable",
    reviewedNativeDeploymentKeys: nativeKeys, scopeBasis: "attributed",
  };
}
