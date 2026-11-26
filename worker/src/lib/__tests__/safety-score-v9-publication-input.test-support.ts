import { Buffer as NodeBuffer } from "node:buffer";
import { computeRedemptionPayloadFingerprint } from "@shared/lib/report-cards-fixed-input-identity";
import { V9_CANDIDATE_POLICY_V1 } from "@shared/lib/safety-score-v9/policy";
import { buildSafetyScoreV9InputIdentity } from "@shared/lib/safety-score-v9-input-identity";
import {
  SAFETY_SCORE_V9_CACHE_KEYS,
  SAFETY_SCORE_V9_PUBLICATION_REPLAY_BASE_CACHE_KEY,
  SAFETY_SCORE_V9_PUBLICATION_REPLAY_CACHE_KEY,
} from "@shared/types/safety-score-cache-keys";
import { SafetyScoreV9ResponseSchema } from "@shared/types/safety-score-v9-publication-response";
import type { SafetyScoreV9CurrentResponse } from "@shared/types/safety-score-v9-public";
import type { ReportCardsFixedInputDraft } from "../../test-helpers/report-cards-fixed-input";
import { v9TestClockSec } from "../../test-helpers/v9-fixed-input";
import { buildNativeSafetyScoreV9Capture } from "./safety-score-v9-capture.test-support";
import { G5_SUBSET_IDS, makeG5CaptureSources } from "./fixtures/safety-score-v9-g5-fixtures";
import { buildSafetyScoreV9Candidate } from "../safety-score-v9/candidate";
import { archiveSafetyScoreCapture } from "../safety-score-v9/capture-archive";
import {
  buildNativeV9InputCacheEntry,
  computeNativeDexLiquidityPayloadFingerprint,
  normalizeNativeV9Input,
  type NativeSafetyScoreV9Input,
} from "../safety-score-v9/native-input";
import {
  buildSafetyScoreV9PegProvenanceSeedCacheEntry,
  captureSafetyScoreV9PegProvenanceById,
  parseSafetyScoreV9PegProvenanceSeed,
} from "../safety-score-v9/peg-provenance";
import { serializeSafetyScoreV9Publication } from "../safety-score-v9/publication-codec";
import { buildSafetyScoreV9PublicationReplayCapture } from "../safety-score-v9/publication-replay-capture";

const Buffer = NodeBuffer as BufferConstructor;

/** Synthetic input rows only; each suite owns its capture identity and reserve evidence. */
export function makePublicationPegRow(
  asset: { id: string; symbol: string; name: string },
  observedAtSec: number,
): ReportCardsFixedInputDraft["pegDataById"][string] {
  return {
    ...asset,
    pegType: "peggedUSD",
    pegCurrency: "USD",
    governance: "centralized",
    currentDeviationBps: 1,
    pegScore: 99,
    priceSource: "fixture-price",
    priceObservedAt: observedAtSec,
    pegPct: 99,
    severityScore: 0,
    spreadPenalty: 0,
    eventCount: 0,
    worstDeviationBps: 1,
    activeDepeg: false,
    lastEventAt: null,
    trackingSpanDays: 365,
    methodologyVersion: "peg:fixture-v1",
  };
}

export function makePublicationDexRow(
  observedAtSec: number,
): ReportCardsFixedInputDraft["dexLiqMap"][string] {
  return {
    liquidityScore: 12,
    concentrationHhi: 0.5,
    poolCount: 1,
    chainCount: 1,
    coverageClass: "primary",
    coverageConfidence: 1,
    liquidityEvidenceClass: "measured",
    hasMeasuredLiquidityEvidence: true,
    effectiveTvlUsd: 1_000_000,
    balanceMeasuredTvlUsd: 1_000_000,
    organicMeasuredTvlUsd: 1_000_000,
    exitRouteObservations: [],
    methodologyVersion: "dex:fixture-v1",
    updatedAt: observedAtSec,
  };
}

function sliceNormalizedV9InputForSubsetCompile(fullNormalized: NativeSafetyScoreV9Input, subsetIds: readonly string[]): NativeSafetyScoreV9Input {
  const pick = <T,>(rec: Record<string, T> | undefined): Record<string, T> =>
    Object.fromEntries(subsetIds.flatMap((id) => (rec && id in rec ? [[id, rec[id]]] : [])));
  const { baseInputGenerationId: _base, ...rest } = fullNormalized;
  const subDex = pick(rest.dexLiqMap), subRed = pick(rest.redemptionBackstopMap);
  return normalizeNativeV9Input({
    ...rest, activeAssetIds: [...subsetIds], dexLiqMap: subDex, redemptionBackstopMap: subRed,
    pegDataById: pick(rest.pegDataById), pegProvenanceById: pick(rest.pegProvenanceById),
    ...(rest.pegEvidenceById ? { pegEvidenceById: pick(rest.pegEvidenceById) } : {}),
    navPriceById: pick(rest.navPriceById), exitOutputPriceById: pick(rest.exitOutputPriceById),
    activeDepegPeakBpsById: pick(rest.activeDepegPeakBpsById),
    safetyScoreV9DirectionalPeg: rest.safetyScoreV9DirectionalPeg
      ? { ...rest.safetyScoreV9DirectionalPeg, pegScoreById: pick(rest.safetyScoreV9DirectionalPeg.pegScoreById), activeDiscountPeakBpsById: pick(rest.safetyScoreV9DirectionalPeg.activeDiscountPeakBpsById) }
      : undefined,
    liveReserveMap: pick(rest.liveReserveMap), liveReserveProvenanceMap: pick(rest.liveReserveProvenanceMap),
    pipelineGapByAssetId: pick(rest.pipelineGapByAssetId), chainCirculatingById: pick(rest.chainCirculatingById),
    aggregateCirculatingById: pick(rest.aggregateCirculatingById), dexDeploymentSupplyCoverageById: pick(rest.dexDeploymentSupplyCoverageById),
    liveToFallbackCoins: rest.liveToFallbackCoins.filter((id) => subsetIds.includes(id)),
    dexPayloadFingerprint: computeNativeDexLiquidityPayloadFingerprint(subDex, rest.dexGenerationId),
    redemptionPayloadFingerprint: computeRedemptionPayloadFingerprint(subRed, rest.redemptionGenerationId),
  });
}

async function archiveG5AcceptedCapture(compiledInput: NativeSafetyScoreV9Input, publication: SafetyScoreV9CurrentResponse) {
  const identity = buildSafetyScoreV9InputIdentity({
    methodologyVersion: compiledInput.methodologyVersion, baseInputGenerationId: compiledInput.baseInputGenerationId, publicationGenerationId: compiledInput.sourceGeneration,
  });
  const baseEntry = await buildNativeV9InputCacheEntry(compiledInput, identity);
  const deltaEntry = await buildSafetyScoreV9PublicationReplayCapture(publication, compiledInput, null, null);
  const cardsValue = await serializeSafetyScoreV9Publication(publication);
  let capturedKey = "";
  let capturedBytes: Uint8Array = new Uint8Array();
  let capturedBinds: unknown[] = [];
  const bucket = {
    put: async (key: string, value: string | ArrayBuffer | ArrayBufferView) => {
      capturedKey = key;
      capturedBytes = typeof value === "string"
        ? Uint8Array.from(Buffer.from(value, "utf8"))
        : value instanceof ArrayBuffer ? new Uint8Array(value) : new Uint8Array(value.buffer, value.byteOffset, value.byteLength);
      return { key };
    },
  } as unknown as R2Bucket;
  const db = {
    prepare: () => ({ bind: (...args: unknown[]) => ({ args }) }),
    batch: async (stmts: Array<{ args?: unknown[] }>) => { capturedBinds = stmts[0]?.args ?? []; return stmts.map(() => ({ success: true, results: [], meta: { changes: 1 } })); },
  } as unknown as D1Database;
  const archiveResult = await archiveSafetyScoreCapture({
    db, bucket, publication,
    cacheRows: {
      base: { key: SAFETY_SCORE_V9_PUBLICATION_REPLAY_BASE_CACHE_KEY, value: baseEntry.value, updatedAt: publication.publishedAtSec },
      delta: { key: SAFETY_SCORE_V9_PUBLICATION_REPLAY_CACHE_KEY, value: deltaEntry.value, updatedAt: publication.publishedAtSec },
      cards: { key: SAFETY_SCORE_V9_CACHE_KEYS.publication, value: cardsValue, updatedAt: publication.publishedAtSec },
    },
  });
  return {
    archiveResult, key: capturedKey, bytes: capturedBytes,
    index: {
      generation_id: String(capturedBinds[0] ?? ""), published_at: Number(capturedBinds[1] ?? 0),
      methodology_version: String(capturedBinds[2] ?? ""), policy_digest: String(capturedBinds[3] ?? ""),
      evaluation_build_digest: String(capturedBinds[4] ?? ""), r2_key: String(capturedBinds[5] ?? ""),
      object_sha256: String(capturedBinds[6] ?? ""), object_bytes: Number(capturedBinds[7] ?? 0),
    },
  };
}

export async function runG5PipelineHarness(deps: {
  db: D1Database;
  setSources: (sources: ReturnType<typeof makeG5CaptureSources>, dexAt: number) => void;
}) {
  const clockSec = v9TestClockSec(), dexAt = clockSec - 60;
  deps.setSources(makeG5CaptureSources(clockSec, dexAt), dexAt);
  const captureOut = await buildNativeSafetyScoreV9Capture(deps.db);
  const pegProv = captureSafetyScoreV9PegProvenanceById(captureOut.input, captureOut.v9PegProvenanceSource);
  const seedEntry = buildSafetyScoreV9PegProvenanceSeedCacheEntry({
    sourceGeneration: captureOut.input.sourceGeneration, clockSec: captureOut.input.clockSec,
    safetyScoreIdentity: buildSafetyScoreV9InputIdentity({
      methodologyVersion: captureOut.input.methodologyVersion, baseInputGenerationId: captureOut.input.baseInputGenerationId, publicationGenerationId: captureOut.input.sourceGeneration,
    }),
    pegProvenanceById: pegProv,
  });
  const parsedSeed = parseSafetyScoreV9PegProvenanceSeed(seedEntry.value);
  // Normalize the full active cohort with enriched pegProvenanceById before compiling the 5-asset subset.
  const fullNormalized = normalizeNativeV9Input({ ...captureOut.input, pegProvenanceById: parsedSeed.pegProvenanceById });
  const compiledInput = sliceNormalizedV9InputForSubsetCompile(fullNormalized, G5_SUBSET_IDS);
  const pipeline = buildSafetyScoreV9Candidate({ fixedInput: compiledInput, publishedAtSec: clockSec, policy: V9_CANDIDATE_POLICY_V1 });
  const parsedPub = SafetyScoreV9ResponseSchema.parse(pipeline.candidate);
  const archive = await archiveG5AcceptedCapture(compiledInput, parsedPub);
  return { clockSec, dexAt, captureOut, fullNormalized, compiledInput, pipeline, parsedPub, archive };
}
