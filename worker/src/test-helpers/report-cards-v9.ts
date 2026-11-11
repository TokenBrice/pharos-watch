import { bytesToBase64 } from "@shared/lib/base64";
import { stableJsonStringifyChunksV1, stableJsonStringifyV1 } from "@shared/lib/stable-json";
import { SAFETY_SCORE_V9_PUBLICATION_MAX_WRITE_COMPRESSED_BYTES, SAFETY_SCORE_V9_PUBLICATION_MAX_WRITE_UNCOMPRESSED_BYTES, SAFETY_SCORE_V9_PUBLICATION_MAX_WRITE_STORED_BYTES } from "@shared/lib/safety-score-v9-publication-limits";
import { SafetyScoreV9CurrentResponseSchema } from "@shared/types/safety-score-v9-publication-response";
import { deepFreeze } from "@shared/types/safety-score-v9-immutable";
import { throwIfAborted } from "../lib/abort";
import { gzipCanonicalJson } from "../lib/canonical-json-gzip";
import { encodePublicationDictionary, PUBLICATION_DICTIONARY_MAX_WRITE_PACKED_BYTES } from "../lib/safety-score-v9/publication-dictionary";
import {
  makeReportCardsV9Card,
  makeReportCardsV9Pillars,
  makeReportCardsV9ArchivedResponse as makeSharedReportCardsV9ArchivedResponse,
  makeReportCardsV9Response as makeSharedReportCardsV9Response,
  type ReportCardsV9ArchivedResponse,
  type ReportCardsV9ResponseFixturePreset,
  type ReportCardsV9ResponseFixtureOverrides,
} from "@shared/test-utils/report-cards-v9";
import type { ReportCardsV9Response } from "@shared/types/report-cards-v9";
import type {
  SafetyScoreV9CurrentCard,
  SafetyScoreV9CurrentResponse,
  SafetyScoreV9ResolvedCurrentCard,
  V9OpenEvidence,
} from "@shared/types/safety-score-v9-public";

const digest = (character: string) => character.repeat(64);

const V9_RESPONSE_PRESET = {
  safetyScoreIdentity: {
    model: "v9",
    schemaVersion: 1,
    methodologyVersion: "9.0",
    policyId: "safety-score-v9",
    policyDigest: digest("a"),
    evaluationBuildDigest: digest("b"),
    baseInputGenerationId: `report-cards-input:v1:${digest("c")}`,
    publicationGenerationId: "report-cards:v9:1",
  },
  defaultUpdatedAt: 110,
  asOfSec: 100,
  source: {
    candidateId: "candidate-v9.0",
    factSetDigest: digest("d"),
    resultDigest: digest("e"),
    sourceGenerations: { registry: "registry-1" },
  },
} satisfies ReportCardsV9ResponseFixturePreset;

export function makeWorkerV9Card(
  overrides: Partial<SafetyScoreV9CurrentCard> = {},
): SafetyScoreV9ResolvedCurrentCard {
  return makeReportCardsV9Card(overrides);
}

export function makeWorkerReportCardsV9Response(
  overrides: ReportCardsV9ResponseFixtureOverrides = {},
): ReportCardsV9Response {
  return makeSharedReportCardsV9Response(V9_RESPONSE_PRESET, makeWorkerV9Card, overrides);
}

/** Archive-only report8 publication: the pre-cutover Worker bytes, block absent. */
export function makeWorkerReportCardsV9ArchivedResponse(
  overrides: ReportCardsV9ResponseFixtureOverrides = {},
): ReportCardsV9ArchivedResponse {
  return makeSharedReportCardsV9ArchivedResponse(V9_RESPONSE_PRESET, makeWorkerV9Card, overrides);
}

export const makeReportCardsV9Response = makeWorkerReportCardsV9Response;

/** Empty but schema-valid block: fixture cohorts publish no counted questions. */
export const emptyV9OpenEvidence: V9OpenEvidence = {
  semantics: "open-question-v1",
  totals: { questions: 0, open: 0, issuer: 0, documentation: 0, obligations: 0 },
  owners: [],
  reasons: [],
  documentation: { questions: 0, datums: 0, facts: 0, reasons: [] },
  issuer: { questions: 0, assets: 0, oldestReviewedAtSec: null, newestReviewedAtSec: null },
  byCard: [],
};

export function makeWorkerSafetyScoreV9Publication(
  overrides: Partial<SafetyScoreV9CurrentResponse> = {},
): SafetyScoreV9CurrentResponse {
  const projected = makeWorkerReportCardsV9Response(
    overrides.cards === undefined ? {} : { cards: overrides.cards },
  );
  return {
    model: "v9-critical-path",
    schemaVersion: 8,
    openEvidence: emptyV9OpenEvidence,
    lifecycle: "active",
    candidateId: projected.source.candidateId,
    policyVersion: projected.methodology.version,
    publicationGenerationId:
      projected.safetyScoreIdentity.publicationGenerationId,
    baseInputGenerationId:
      projected.safetyScoreIdentity.baseInputGenerationId,
    factSetDigest: projected.source.factSetDigest,
    resultDigest: projected.source.resultDigest,
    policy: projected.methodology.policy,
    evaluationBuildDigest:
      projected.safetyScoreIdentity.evaluationBuildDigest,
    sourceGenerations: projected.source.sourceGenerations,
    asOfSec: projected.asOfSec,
    publishedAtSec: projected.updatedAt,
    completeness: projected.completeness,
    cards: projected.cards,
    foreignCauseGaps: projected.foreignCauseGaps,
    ...overrides,
  };
}

export const makeWorkerV9Pillars = makeReportCardsV9Pillars;

/** Historical storage fixtures; the production writer only emits the current dictionary envelope. */
export async function serializeSafetyScoreV9PublicationWithEncoding(
  value: SafetyScoreV9CurrentResponse,
  encoding: "legacy" | "dictionary",
  signal?: AbortSignal,
): Promise<string> {
  throwIfAborted(signal);
  const publication = deepFreeze(SafetyScoreV9CurrentResponseSchema.parse(value));
  const dictionary = encoding === "dictionary" ? encodePublicationDictionary(publication, signal) : undefined;
  const compressed = await gzipCanonicalJson(dictionary?.chunks ?? stableJsonStringifyChunksV1(publication), {
    label: "Safety Score v9 publication",
    maximumCompressedBytes: SAFETY_SCORE_V9_PUBLICATION_MAX_WRITE_COMPRESSED_BYTES,
    maximumUncompressedBytes: dictionary ? PUBLICATION_DICTIONARY_MAX_WRITE_PACKED_BYTES : SAFETY_SCORE_V9_PUBLICATION_MAX_WRITE_UNCOMPRESSED_BYTES,
    signal,
  });
  const stored = stableJsonStringifyV1({
    storageSchemaVersion: dictionary ? 2 : 1,
    kind: "safety-score-v9-publication",
    encoding: dictionary ? "gzip-json-dictionary-base64-v1" : "gzip-base64",
    ...(dictionary ? { packedBytes: compressed.uncompressedBytes } : {}),
    identity: {
      candidateId: publication.candidateId,
      policyVersion: publication.policyVersion,
      publicationGenerationId: publication.publicationGenerationId,
      baseInputGenerationId: publication.baseInputGenerationId,
      factSetDigest: publication.factSetDigest,
      policyId: publication.policy.id,
      policyDigest: publication.policy.semanticDigest,
      evaluationBuildDigest: publication.evaluationBuildDigest,
      resultDigest: publication.resultDigest,
    },
    payloadSha256: dictionary?.contentSha256 ?? compressed.contentSha256,
    uncompressedBytes: dictionary?.uncompressedBytes ?? compressed.uncompressedBytes,
    compressedBytes: compressed.compressed.byteLength,
    payload: bytesToBase64(compressed.compressed),
  });
  const storedBytes = new TextEncoder().encode(stored).byteLength;
  if (storedBytes > SAFETY_SCORE_V9_PUBLICATION_MAX_WRITE_STORED_BYTES) {
    throw new Error(
      `Safety Score v9 publication is ${storedBytes} stored bytes; maximum is ${SAFETY_SCORE_V9_PUBLICATION_MAX_WRITE_STORED_BYTES}`,
    );
  }
  throwIfAborted(signal);
  return stored;
}
