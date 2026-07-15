import { canonicalizeForDatasetHash } from "./canonicalize";
import { sha256Hex } from "../sha256";
import { ReportCardsV9ResponseSchema } from "../../types/report-cards-v9";
import type { SafetyScoreV9PublicationIdentity } from "../../types/safety-score-publication";
import { V9SelectorSnapshotSchema, type V9SelectorSnapshot } from "../../types/selector-v9";

export class V9SelectorSnapshotUnavailableError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "V9SelectorSnapshotUnavailableError";
  }
}

function canonicalIdentity(identity: SafetyScoreV9PublicationIdentity): string {
  return [
    identity.model,
    identity.schemaVersion,
    identity.methodologyVersion,
    identity.policyId,
    identity.policyDigest,
    identity.evaluationBuildDigest,
    identity.baseInputGenerationId,
    identity.publicationGenerationId,
  ].join("\u0000");
}

export function buildV9SelectorSnapshot(
  source: unknown,
  expectedIdentity: SafetyScoreV9PublicationIdentity,
  createdAt: number,
): V9SelectorSnapshot {
  const parsed = ReportCardsV9ResponseSchema.safeParse(source);
  if (!parsed.success) {
    throw new V9SelectorSnapshotUnavailableError("V9 selector source contract failed");
  }
  if (canonicalIdentity(parsed.data.safetyScoreIdentity) !== canonicalIdentity(expectedIdentity)) {
    throw new V9SelectorSnapshotUnavailableError("V9 selector source identity mismatch");
  }

  const rows = parsed.data.cards.map((card) => ({
    id: card.id,
    safetyScore: card.score,
    safetyGrade: card.grade,
    pillars: card.pillars,
    accessPosture: card.accessPosture,
    dependencies: card.dependencies,
  }));
  const hashContent = {
    model: "v9",
    schemaVersion: 1,
    safetyScoreIdentity: parsed.data.safetyScoreIdentity,
    rows,
    recommendation: {
      status: "deferred",
      reason: "v9-selector-thresholds-unreviewed",
    },
  } as const;

  return V9SelectorSnapshotSchema.parse({
    ...hashContent,
    sourceUpdatedAt: parsed.data.updatedAt,
    createdAt,
    datasetHash: sha256Hex(canonicalizeForDatasetHash(hashContent)),
  });
}
