import { createElement } from "react";
import { ACTIVE_IDS, TRACKED_META_BY_ID } from "@shared/lib/stablecoins/registry";
import { sha256HexFromBytes } from "@shared/lib/sha256";
import { stableJsonStringifyV1 } from "@shared/lib/stable-json";
import {
  SOCIAL_SCORECARD_METADATA_HEADER,
  SOCIAL_SCORECARD_OVERVIEW_ID,
  SOCIAL_SCORECARD_RENDERER_REVISION,
  encodeSocialScorecardMetadata,
  validateSocialScorecardPng,
} from "@shared/lib/social-scorecard";
import { SocialScorecardMetadataSchema, type SocialScorecardMetadata } from "@shared/types/social-scorecard";
import { renderPng } from "../lib/og-render";
import { Scorecard } from "../lib/og-templates/scorecard";
import { loadActiveSafetyScoreIndex, type SafetyScoreGradeSnapshot } from "../lib/safety-score-index";
import { isSafetyScoreV9SnapshotFresh, SAFETY_SCORE_V9_CONSUMER_MAX_AGE_SEC } from "../lib/safety-score-v9/consumer-freshness";

function unavailable(reason: string, status = 503): Response {
  return new Response("Dated scorecard unavailable", {
    status,
    headers: { "Content-Type": "text/plain", "Cache-Control": "no-store", "X-Scorecard-Reason": reason, ...(status === 503 ? { "Retry-After": "60" } : {}) },
  });
}

function admitSubject(snapshot: SafetyScoreGradeSnapshot, id: string): SocialScorecardMetadata["subject"] | null {
  if (id === SOCIAL_SCORECARD_OVERVIEW_ID) {
    let ratedCount = 0;
    let notRatedCount = 0;
    let unavailableCount = 0;
    let totalScore = 0;
    for (const card of snapshot.cards) {
      if (card.ratingStatus === "pipeline-gap") unavailableCount++;
      else if (card.ratingStatus === "not-rated") notRatedCount++;
      else if (card.score !== null && card.grade !== null) { ratedCount++; totalScore += card.score; }
      else return null;
    }
    if (snapshot.cards.length !== snapshot.completeness.expectedCount || snapshot.cards.length === 0) return null;
    return {
      kind: "overview", id: SOCIAL_SCORECARD_OVERVIEW_ID,
      ratedCount, notRatedCount, unavailableCount, totalCount: snapshot.cards.length,
      averageScore: ratedCount === 0 ? null : totalScore / ratedCount,
    };
  }
  const coin = TRACKED_META_BY_ID.get(id);
  const card = snapshot.cards.find((candidate) => candidate.id === id);
  if (!coin || !card || card.ratingStatus === "pipeline-gap" || card.grade === null) return null;
  return { kind: "stablecoin", id, name: coin.name, symbol: coin.symbol, score: card.score, grade: card.grade, ratingStatus: card.ratingStatus };
}

/** No live fallback: only the admitted accepted index can produce a retained edition. */
export async function handleScorecardOg(db: D1Database, id: string): Promise<Response> {
  if (id !== SOCIAL_SCORECARD_OVERVIEW_ID && !ACTIVE_IDS.has(id)) return unavailable("unknown-subject", 404);
  try {
    const active = await loadActiveSafetyScoreIndex(db);
    const now = Math.floor(Date.now() / 1000);
    if (active.kind !== "v9" || !isSafetyScoreV9SnapshotFresh(active.snapshot, now)) return unavailable("publication-unavailable");
    const snapshot = active.snapshot;
    if (snapshot.asOfSec <= 0 || snapshot.asOfSec > now
      || Math.min(snapshot.asOfSec, snapshot.updatedAt) + SAFETY_SCORE_V9_CONSUMER_MAX_AGE_SEC <= now) {
      return unavailable("observation-clock-invalid");
    }
    const subject = admitSubject(snapshot, id);
    if (!subject) return unavailable("subject-unavailable");
    const metadata = SocialScorecardMetadataSchema.parse({
      schemaVersion: 1, rendererRevision: SOCIAL_SCORECARD_RENDERER_REVISION,
      publication: snapshot.safetyScoreIdentity, asOfSec: snapshot.asOfSec,
      publishedAtSec: snapshot.updatedAt, subject, imageSha256: "0".repeat(64),
      freshnessBudgetSec: SAFETY_SCORE_V9_CONSUMER_MAX_AGE_SEC,
    });
    const image = await renderPng(createElement(Scorecard, { metadata }));
    validateSocialScorecardPng(image);
    // Rendering can cross an expiry, hold or publication change. Re-admit the
    // exact source, never relabel the old pixels as the newest generation.
    const afterRender = await loadActiveSafetyScoreIndex(db);
    const assessedAt = Math.floor(Date.now() / 1000);
    if (afterRender.kind !== "v9" || !isSafetyScoreV9SnapshotFresh(afterRender.snapshot, assessedAt)
      || stableJsonStringifyV1(afterRender.snapshot.safetyScoreIdentity) !== stableJsonStringifyV1(metadata.publication)
      || afterRender.snapshot.updatedAt !== metadata.publishedAtSec || afterRender.snapshot.asOfSec !== metadata.asOfSec
      || stableJsonStringifyV1(admitSubject(afterRender.snapshot, id)) !== stableJsonStringifyV1(subject)
      || Math.min(metadata.asOfSec, metadata.publishedAtSec) + SAFETY_SCORE_V9_CONSUMER_MAX_AGE_SEC <= Date.now() / 1000) {
      return unavailable("publication-changed-during-render");
    }
    metadata.imageSha256 = sha256HexFromBytes(image);
    const remaining = Math.min(metadata.asOfSec, metadata.publishedAtSec) + SAFETY_SCORE_V9_CONSUMER_MAX_AGE_SEC - assessedAt;
    const maxAge = Math.max(0, Math.min(60, remaining - 1));
    return new Response(image as Uint8Array<ArrayBuffer>, { headers: {
      "Content-Type": "image/png", "Cache-Control": `public, max-age=${maxAge}, s-maxage=${maxAge}`,
      "X-Content-Type-Options": "nosniff",
      [SOCIAL_SCORECARD_METADATA_HEADER]: encodeSocialScorecardMetadata(metadata),
    } });
  } catch (error) {
    console.error("[og-scorecard] Render or source failed", error);
    return unavailable("render-or-source-failed");
  }
}
