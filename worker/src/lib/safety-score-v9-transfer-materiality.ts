import { resolveChainId } from "@shared/lib/chains";
import { compareText } from "@shared/lib/safety-score-v9/primitives";
import { sha256Hex } from "@shared/lib/sha256";
import { stableJsonStringifyV1 } from "@shared/lib/stable-json";
import type { ContractDeployment } from "@shared/types/core";
import { z } from "zod";
import type { V9ExtensionRegistryMeta } from "./safety-score-v9-extension-shared";
import { safetyScoreV9TransferDeploymentKey, type SafetyScoreV9TransferMaterialScope } from "./safety-score-v9-extension-transfer";
import { reviewedDeploymentObservationTimingIssue } from "./safety-score-v9-supply-attribution-contract";

export const SAFETY_SCORE_V9_TRANSFER_MATERIALITY_CACHE_KEY =
  "safety-score-v9:transfer-materiality-generation:v1";
const SAFETY_SCORE_V9_TRANSFER_MATERIALITY_MAX_AGE_SEC = 1_800;

export const SAFETY_SCORE_V9_TRANSFER_MATERIALITY_ASSET_IDS = Object.freeze([
  "aa-falconx-mev-capital", "asusdf-astherus", "bbqusdc-steakhouse", "dusd-dialectic",
  "eearn-ember", "fusd-freedom-dollar", "fxsave-f-x-protocol", "gldt-gold-dao",
  "gtusdc-gauntlet", "gtusdcp-gauntlet", "jpyt-dephaser", "jusd-juicedollar",
  "kgst-kyrgyz-som", "luausd-lumi-finance", "sbold-k3-capital", "scrvusd-curve",
  "sdai-sky", "sdola-inverse-finance", "sdusd-dtrinity", "sgho-aave", "srusd-reservoir",
  "srusde-strata", "stcusd-cap", "stkgho-umbrella-aave", "stusd-stoneyield", "stusds-sky",
  "susdd-tron-dao-reserve", "susds-sky", "susn-noon", "syzusd-yuzu", "usdcx-movement",
  "vcred-vcred", "vusd-virtue", "wsrusd-reservoir", "xdai-gnosis", "ybold-yearn",
  "yusd-yieldfi", "zsd-zephyr-protocol", "zys-zephyr-protocol",
].sort(compareText));

const TRANSFER_MATERIALITY_ASSET_ID_SET = new Set(SAFETY_SCORE_V9_TRANSFER_MATERIALITY_ASSET_IDS);
const DeploymentObservationSchema = z.object({
  deploymentKey: z.string().min(1),
  rawTokenUnits: z.string().regex(/^(0|[1-9][0-9]*)$/).nullable(),
  decimals: z.number().int().min(0).max(255).nullable(),
  blockNumber: z.string().regex(/^(0|[1-9][0-9]*)$/).nullable(),
  observedAtSec: z.number().int().nonnegative().nullable(),
  status: z.enum(["accepted", "rejected"]),
}).strict().superRefine((row, ctx) => {
  const complete = row.rawTokenUnits !== null && row.decimals !== null && row.blockNumber !== null && row.observedAtSec !== null;
  if ((row.status === "accepted") !== complete) ctx.addIssue({ code: "custom", message: "Accepted observations require a complete raw-unit packet" });
});

/** Raw token-unit evidence only. It is deliberately incapable of carrying USD or price data. */
export type SafetyScoreV9TransferMaterialityObservation = z.infer<typeof DeploymentObservationSchema>;

const GenerationPayloadSchema = z.object({
  schemaVersion: z.literal(1),
  kind: z.literal("safety-score-v9-transfer-materiality-generation"),
  sourceBaseInputGenerationId: z.string().regex(/^report-cards-input:v1:[a-f0-9]{64}$/),
  registryFingerprint: z.string().regex(/^[a-f0-9]{64}$/),
  capturedAtSec: z.number().int().nonnegative(),
  observationsByAssetId: z.record(z.string(), z.array(DeploymentObservationSchema)),
}).strict();

const GenerationSchema = GenerationPayloadSchema.extend({
  generationId: z.string().regex(/^safety-score-v9-transfer-materiality:v1:[a-f0-9]{64}$/),
}).strict().superRefine((generation, ctx) => {
  const { generationId, ...payload } = generation;
  if (generationId !== computeGenerationId(payload)) ctx.addIssue({ code: "custom", path: ["generationId"], message: "Transfer materiality generation ID mismatch" });
});

export type SafetyScoreV9TransferMaterialityGeneration = z.infer<typeof GenerationSchema>;

function computeGenerationId(payload: z.infer<typeof GenerationPayloadSchema>): string {
  return `safety-score-v9-transfer-materiality:v1:${sha256Hex(stableJsonStringifyV1(payload))}`;
}

export function createSafetyScoreV9TransferMaterialityGeneration(
  payload: z.infer<typeof GenerationPayloadSchema>,
): SafetyScoreV9TransferMaterialityGeneration {
  return GenerationSchema.parse({ ...payload, generationId: computeGenerationId(payload) });
}

export function parseSafetyScoreV9TransferMaterialityGeneration(value: unknown): SafetyScoreV9TransferMaterialityGeneration {
  const parsed = typeof value === "string" ? JSON.parse(value) : value;
  return GenerationSchema.parse(parsed);
}

export function serializeSafetyScoreV9TransferMaterialityGeneration(generation: SafetyScoreV9TransferMaterialityGeneration): string {
  return stableJsonStringifyV1(generation);
}

function authoritativeDeployments(meta: V9ExtensionRegistryMeta): Array<{ deployment: ContractDeployment; key: string }> | null {
  const rows = (meta.contracts ?? []).map((deployment) => {
    const chainId = resolveChainId(deployment.chain);
    return chainId === null ? null : { deployment, key: safetyScoreV9TransferDeploymentKey(chainId, deployment.address) };
  });
  return rows.some((row) => row === null) ? null : rows as Array<{ deployment: ContractDeployment; key: string }>;
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
  const deployments = authoritativeDeployments(input.meta);
  const observations = input.generation?.observationsByAssetId[input.assetId];
  if (
    deployments === null || deployments.length === 0 || !input.generation || !observations ||
    input.generation.registryFingerprint !== input.registryFingerprint ||
    input.generation.sourceBaseInputGenerationId !== input.baseInputGenerationId ||
    input.generation.capturedAtSec > input.clockSec ||
    input.clockSec - input.generation.capturedAtSec > SAFETY_SCORE_V9_TRANSFER_MATERIALITY_MAX_AGE_SEC
  ) return input.baseScope;

  const expectedKeys = deployments.map(({ key }) => key).sort(compareText);
  const observedKeys = observations.map((row) => row.deploymentKey).sort(compareText);
  if (
    new Set(expectedKeys).size !== expectedKeys.length || new Set(observedKeys).size !== observedKeys.length ||
    expectedKeys.length !== observedKeys.length || expectedKeys.some((key, index) => key !== observedKeys[index])
  ) return input.baseScope;

  const deploymentByKey = new Map(deployments.map((row) => [row.key, row.deployment]));
  if (observations.some((row) => {
    const deployment = deploymentByKey.get(row.deploymentKey);
    return row.status !== "accepted" || !deployment || row.decimals !== deployment.decimals || row.observedAtSec === null ||
      row.observedAtSec > input.clockSec || input.clockSec - row.observedAtSec > SAFETY_SCORE_V9_TRANSFER_MATERIALITY_MAX_AGE_SEC;
  })) return input.baseScope;
  const observedAt = observations.map((row) => row.observedAtSec!);
  if (reviewedDeploymentObservationTimingIssue({
    clockSec: input.clockSec,
    captureStartedAtSec: Math.min(...observedAt),
    captureEndedAtSec: Math.max(...observedAt),
    observedAtSec: Math.max(...observedAt),
    deployments: observations.map((row) => ({ routeId: row.deploymentKey, blockTimeSec: row.observedAtSec! })),
  }) !== null) return input.baseScope;

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
  const materialDeploymentKeys = observations
    .filter((row) => BigInt(row.rawTokenUnits!) > 0n)
    .map((row) => row.deploymentKey)
    .sort(compareText);
  return {
    authoritativeDeploymentKeys: expectedKeys,
    materialDeploymentKeys,
    materialDeploymentScopeComplete: materialDeploymentKeys.length > 0,
    deploymentModel: "contract-addressable",
  };
}
