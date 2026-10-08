import type { SafetyScoreV9CurrentResponse } from "@shared/types/safety-score-v9-public";
import type { V9PublicationHoldReason } from "@shared/types/report-cards-v9";
import { stableJsonStringifyV1 } from "@shared/lib/stable-json";
import { sha256Hex } from "@shared/lib/sha256";
import { executeAtomicBatch, prepareMultiRowInsertStatements } from "../db";
import { logWorkerEvent } from "../structured-log";
import type { SafetyScoreV9CompilerInput } from "./native-input";

export const SAFETY_SCORE_PUBLICATION_JOURNAL_RETENTION_SEC = 120 * 86_400;
type Card = SafetyScoreV9CurrentResponse["cards"][number];
type Pillar = keyof Card["pillars"];
type PrimaryRoute = NonNullable<NonNullable<Card["breakdowns"]>["exit"]["primaryRoute"]>;
export interface SafetyScoreCompactCard extends Pick<Card, "score" | "grade" | "ratingStatus" | "reasonCodes" | "pegMultiplier"> {
  nrReasons: { code: Card["nrReasons"][number]["code"]; causes: string[] }[];
  partialEvidence: Pick<NonNullable<Card["partialEvidence"]>, "reasonCode" | "excludedPillars" | "causes"> | null;
  pillars: Record<Pillar, { score: number | null; inclusion: string; causes: readonly string[] }>;
  bindingCap: Pick<NonNullable<Card["bindingCap"]>, "kind" | "reason" | "limit"> | null;
  primaryExitRoute: (Pick<PrimaryRoute, "routeId" | "lane" | "capacityEvidenceTier" | "confidenceFactor"> & {
    executableUsd: number | null;
    evidenceKind: string | null;
    confidenceDimensions: Record<keyof PrimaryRoute["confidenceDimensions"], { factor: number; cause: string | null }>;
  }) | null;
}

/** Clocks and generation-addressed route keys are lineage, not score movement. */
export function buildSafetyScoreCompactCard(card: Card): SafetyScoreCompactCard {
  const primary = card.breakdowns?.exit.primaryRoute;
  return {
    score: card.score, grade: card.grade, ratingStatus: card.ratingStatus,
    reasonCodes: [...card.reasonCodes].sort(),
    nrReasons: card.nrReasons.map(({ code, causes }) => ({ code, causes: [...(causes ?? [])].sort() }))
      .sort((a, b) => a.code < b.code ? -1 : a.code > b.code ? 1 : 0),
    partialEvidence: card.partialEvidence === null ? null : {
      reasonCode: card.partialEvidence.reasonCode, excludedPillars: card.partialEvidence.excludedPillars,
      causes: card.partialEvidence.causes,
    },
    pillars: {
      backing: {
        score: card.pillars.backing.score,
        inclusion: card.pillars.backing.aggregationDisposition ?? "included",
        causes: card.pillars.backing.limitedEvidenceCauses ?? [],
      },
      exit: {
        score: card.pillars.exit.score,
        inclusion: card.pillars.exit.aggregationDisposition ?? "included",
        causes: card.pillars.exit.limitedEvidenceCauses ?? [],
      },
      control: {
        score: card.pillars.control.score,
        inclusion: card.pillars.control.aggregationDisposition ?? "included",
        causes: card.pillars.control.limitedEvidenceCauses ?? [],
      },
    },
    pegMultiplier: card.pegMultiplier,
    bindingCap: card.bindingCap === null ? null : {
      kind: card.bindingCap.kind, reason: card.bindingCap.reason, limit: card.bindingCap.limit,
    },
    primaryExitRoute: primary == null ? null : {
      routeId: primary.routeId, lane: primary.lane,
      executableUsd: primary.capacity?.executableUsd ?? null,
      evidenceKind: primary.capacity?.evidenceKind ?? null,
      capacityEvidenceTier: primary.capacityEvidenceTier,
      confidenceFactor: primary.confidenceFactor,
      confidenceDimensions: {
        observation: { factor: primary.confidenceDimensions.observation.factor, cause: primary.confidenceDimensions.observation.cause ?? null },
        model: { factor: primary.confidenceDimensions.model.factor, cause: primary.confidenceDimensions.model.cause ?? null },
        capacityMethod: { factor: primary.confidenceDimensions.capacityMethod.factor, cause: primary.confidenceDimensions.capacityMethod.cause ?? null },
      },
    },
  };
}
export interface SafetyScoreJournalIdentity {
  methodologyVersion: string;
  policyDigest: string;
  evaluationBuildDigest: string;
}
export function safetyScoreCompactDigest(card: SafetyScoreCompactCard, identity: SafetyScoreJournalIdentity): string {
  return sha256Hex(stableJsonStringifyV1({ domain: "safety-score-publication-journal.v1", identity, card }));
}
export function safetyScoreJournalCardChanged(previousDigest: string | null | undefined, digest: string): boolean {
  return previousDigest !== digest;
}
export type SafetyScoreJournalResult = {
  status: "written" | "failed" | "skipped";
  reason?: string;
  rows: number;
};
interface JournalInput {
  db: D1Database;
  publication: SafetyScoreV9CurrentResponse;
  fixedInput: Readonly<SafetyScoreV9CompilerInput>;
  attemptId: string;
  attemptedAtSec: number;
  outcome: "accepted" | "held";
  holdReasons?: readonly V9PublicationHoldReason[];
  transferMaterialityGenerationId?: string | null;
  signal?: AbortSignal;
}

/** Best effort AFTER the canonical commit. Never decode or serialize a full card set. */
export async function journalSafetyScorePublication(input: JournalInput): Promise<SafetyScoreJournalResult> {
  try {
    const { db, publication, fixedInput } = input;
    const identity = {
      methodologyVersion: publication.policyVersion,
      policyDigest: publication.policy.semanticDigest,
      evaluationBuildDigest: publication.evaluationBuildDigest,
    };
    const lineage = {
      baseInputGenerationId: publication.baseInputGenerationId,
      sourceGeneration: fixedInput.sourceGeneration,
      sourceGenerations: publication.sourceGenerations,
      dexGenerationId: fixedInput.dexGenerationId,
      redemptionGenerationId: fixedInput.redemptionGenerationId,
      transferMaterialityGenerationId: input.transferMaterialityGenerationId ?? null,
      inputFreshness: fixedInput.inputFreshness,
      registryFingerprint: fixedInput.registryFingerprint,
    };
    const rows: unknown[][] = [];
    let unchanged = 0;
    if (input.outcome === "accepted") {
      const previous = await db.prepare(`SELECT c.value AS stablecoin_id,
        (SELECT j.compact_digest FROM safety_score_publication_journal j
         WHERE j.stablecoin_id = c.value AND j.published_at < ?
         ORDER BY j.published_at DESC, j.generation_id DESC LIMIT 1) AS compact_digest
        FROM json_each(?) c`).bind(
        publication.publishedAtSec, JSON.stringify(publication.cards.map((card) => card.id)),
      ).all<{ stablecoin_id: string; compact_digest: string | null }>();
      if (!previous.success) throw new Error("journal-baseline-read-failed");
      const digests = new Map(previous.results.map((row) => [row.stablecoin_id, row.compact_digest]));
      for (const card of publication.cards) {
        const compact = buildSafetyScoreCompactCard(card);
        const digest = safetyScoreCompactDigest(compact, identity);
        if (!safetyScoreJournalCardChanged(digests.get(card.id), digest)) { unchanged++; continue; }
        rows.push([publication.publicationGenerationId, card.id, publication.publishedAtSec,
          identity.methodologyVersion, identity.policyDigest, identity.evaluationBuildDigest,
          card.score, card.grade, digest, stableJsonStringifyV1(compact), stableJsonStringifyV1({
            ...lineage,
            supply: card.supply ?? null,
            primaryExitRoute: card.breakdowns?.exit.primaryRoute == null ? null : {
              key: card.breakdowns.exit.primaryRoute.key,
              observedAtSec: card.breakdowns.exit.primaryRoute.capacity?.observedAtSec ?? null,
            },
          })]);
      }
    }
    const statements = prepareMultiRowInsertStatements(db,
      `INSERT OR IGNORE INTO safety_score_publication_journal
       (generation_id, stablecoin_id, published_at, methodology_version, policy_digest, evaluation_build_digest,
        score, grade, compact_digest, compact_json, input_lineage_json)`, rows);
    statements.push(db.prepare(`INSERT OR IGNORE INTO safety_score_publication_attempts
      (attempt_id, generation_id, attempted_at, published_at, outcome, hold_reason_codes_json,
       methodology_version, policy_digest, evaluation_build_digest, input_lineage_json, changed_cards, unchanged_cards)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`).bind(
      input.attemptId, publication.publicationGenerationId, input.attemptedAtSec, publication.publishedAtSec,
      input.outcome, JSON.stringify([...new Set((input.holdReasons ?? []).map((reason) => reason.code))].sort()),
      identity.methodologyVersion, identity.policyDigest, identity.evaluationBuildDigest, stableJsonStringifyV1(lineage),
      input.outcome === "held" ? null : rows.length, input.outcome === "held" ? null : unchanged,
    ));
    const written = await executeAtomicBatch(db, statements, { signal: input.signal });
    return { status: "written", rows: written };
  } catch (error) {
    logWorkerEvent({ scope: "lib", level: "warn", event: "safety_score_publication_journal_failed",
      job: "compute-safety-score-v9", message: "Safety journal write failed after publication settled",
      metadata: { reason: "journal-write-failed", error: String(error).slice(0, 200) } });
    return { status: "failed", reason: "journal-write-failed", rows: 0 };
  }
}
