import { bytesToBase64 } from "@shared/lib/base64";
import { SITE_ORIGIN } from "@shared/lib/runtime-origins";
import { ACTIVE_IDS, TRACKED_META_BY_ID } from "@shared/lib/stablecoins/registry";
import { sha256HexFromBytes } from "@shared/lib/sha256";
import { stableJsonStringifyV1 } from "@shared/lib/stable-json";
import type { SocialCardElement, SocialCardLogo } from "@shared/lib/social-card/parts";
import { socialScorecardCard } from "@shared/lib/social-card/scorecard";
import { buildSocialScorecardElement, buildSocialScorecardOverviewElement } from "@shared/lib/social-card/templates";
import { isTrustedLogoSvg } from "@shared/lib/social-card/tokens";
import {
  SOCIAL_SCORECARD_METADATA_HEADER,
  SOCIAL_SCORECARD_NOT_RATED_REASON,
  SOCIAL_SCORECARD_OVERVIEW_ID,
  SOCIAL_SCORECARD_REASON_HEADER,
  SOCIAL_SCORECARD_RENDERER_REVISION,
  encodeSocialScorecardMetadata,
  validateSocialScorecardPng,
} from "@shared/lib/social-scorecard";
import { SocialScorecardMetadataSchema, type SocialScorecardMetadata } from "@shared/types/social-scorecard";
import { V9_QUALITY_PILLARS } from "@shared/types/safety-score-v9-quality-pillars";
import { renderPng, socialCardMeasurer } from "../lib/og-render";
import { cancelResponseBodyQuietly, readResponseBytesWithinLimitWithSignal } from "../lib/response-body";
import { loadActiveSafetyScoreIndex, type SafetyScoreGradeSnapshot } from "../lib/safety-score-index";
import { isSafetyScoreV9SnapshotFresh, SAFETY_SCORE_V9_CONSUMER_MAX_AGE_SEC } from "../lib/safety-score-v9/consumer-freshness";

function unavailable(reason: string, status = 503): Response {
  return new Response("Dated scorecard unavailable", {
    status,
    headers: { "Content-Type": "text/plain", "Cache-Control": "no-store", [SOCIAL_SCORECARD_REASON_HEADER]: reason, ...(status === 503 ? { "Retry-After": "60" } : {}) },
  });
}

const LOGO_TIMEOUT_MS = 2_500;
const LOGO_MAX_BYTES = 512 * 1024;
const LOGO_SIGNATURES: Readonly<Record<string, (bytes: Uint8Array) => boolean>> = {
  "image/png": (bytes) => bytes[0] === 0x89 && bytes[1] === 0x50 && bytes[2] === 0x4e && bytes[3] === 0x47,
  "image/jpeg": (bytes) => bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff,
  "image/svg+xml": (bytes) => isTrustedLogoSvg(new TextDecoder().decode(bytes)),
};

/**
 * The one outbound request of a render: the coin's registered logo from the
 * site, its body read before anything else. Satori and resvg draw PNG, JPEG
 * and SVG; WebP, a timeout or anything unexpected falls back to the monogram.
 * The Worker cannot inspect pixels, so every logo sits on the light plate the
 * site uses for logos in dark mode.
 */
async function fetchScorecardLogo(logoPath: string): Promise<SocialCardLogo | null> {
  // One budget for the request and its body read.
  const signal = AbortSignal.timeout(LOGO_TIMEOUT_MS);
  try {
    const response = await fetch(`${SITE_ORIGIN}${logoPath}`, { signal });
    const type = response.headers.get("Content-Type")?.split(";")[0].trim().toLowerCase() ?? "";
    const admits = LOGO_SIGNATURES[type];
    if (!response.ok || !admits) {
      await cancelResponseBodyQuietly(response);
      return null;
    }
    const bytes = await readResponseBytesWithinLimitWithSignal(response, LOGO_MAX_BYTES, signal);
    return bytes.byteLength > 0 && admits(bytes) ? { color: `data:${type};base64,${bytesToBase64(bytes)}`, lightPlate: true } : null;
  } catch {
    return null;
  }
}

/** The element an admitted edition draws; null when the subject has nothing rated to show. */
async function scorecardElement(metadata: SocialScorecardMetadata): Promise<SocialCardElement | null> {
  const drawn = socialScorecardCard(metadata);
  if (!drawn) return null;
  const measure = await socialCardMeasurer();
  if (drawn.kind === "overview") return buildSocialScorecardOverviewElement(drawn.card, { measure, logos: new Map() });
  const { logoPath, ...identity } = drawn.card.identity;
  const logo = logoPath ? await fetchScorecardLogo(logoPath) : null;
  return logo && logoPath
    ? buildSocialScorecardElement(drawn.card, { measure, logos: new Map([[logoPath, logo]]) })
    : buildSocialScorecardElement({ ...drawn.card, identity }, { measure, logos: new Map() });
}

import { isTokenizedFundId } from "@shared/lib/stablecoins/listing-governance";

function admitSubject(snapshot: SafetyScoreGradeSnapshot, id: string): SocialScorecardMetadata["subject"] | null {
  if (id === SOCIAL_SCORECARD_OVERVIEW_ID) {
    let ratedCount = 0;
    let notRatedCount = 0;
    let unavailableCount = 0;
    let totalScore = 0;
    for (const card of snapshot.cards) {
      if (card.ratingStatus === "pipeline-gap") unavailableCount++;
      else if (card.ratingStatus === "not-rated" || isTokenizedFundId(card.id)) notRatedCount++;
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
  if (isTokenizedFundId(id)) {
    return {
      kind: "stablecoin", id, name: coin.name, symbol: coin.symbol, score: null, grade: "NR",
      ratingStatus: "not-rated",
    };
  }
  const ratings = snapshot.scorecardPillars?.id === id ? snapshot.scorecardPillars.ratings : undefined;
  const pillars = V9_QUALITY_PILLARS.flatMap(pillar => {
    const rating = ratings?.[pillar];
    return rating ? [{ id: pillar, ...rating }] : [];
  });
  return {
    kind: "stablecoin", id, name: coin.name, symbol: coin.symbol, score: card.score, grade: card.grade,
    ratingStatus: card.ratingStatus, ...(pillars.length ? { pillars } : {}),
  };
}

/** No live fallback: only the admitted accepted index can produce a retained edition. */
export async function handleScorecardOg(db: D1Database, id: string): Promise<Response> {
  if (id !== SOCIAL_SCORECARD_OVERVIEW_ID && !ACTIVE_IDS.has(id)) return unavailable("unknown-subject", 404);
  try {
    const pillarSubjectId = id === SOCIAL_SCORECARD_OVERVIEW_ID ? undefined : id;
    const active = await loadActiveSafetyScoreIndex(db, undefined, pillarSubjectId);
    const now = Math.floor(Date.now() / 1000);
    if (active.kind !== "v9" || !isSafetyScoreV9SnapshotFresh(active.snapshot, now)) return unavailable("publication-unavailable");
    const snapshot = active.snapshot;
    if (snapshot.asOfSec <= 0 || snapshot.asOfSec > now
      || Math.min(snapshot.asOfSec, snapshot.updatedAt) + SAFETY_SCORE_V9_CONSUMER_MAX_AGE_SEC <= now) {
      return unavailable("observation-clock-invalid");
    }
    const subject = admitSubject(snapshot, id);
    if (!subject) return unavailable("subject-unavailable");
    // A dated scorecard shows a published grade; a not-rated coin has none to date.
    if (subject.kind === "stablecoin" && subject.ratingStatus !== "rated") return unavailable(SOCIAL_SCORECARD_NOT_RATED_REASON, 404);
    if (subject.kind === "overview" && subject.ratedCount === 0) return unavailable("no-rated-subjects");
    const metadata = SocialScorecardMetadataSchema.parse({
      schemaVersion: 1, rendererRevision: SOCIAL_SCORECARD_RENDERER_REVISION,
      publication: snapshot.safetyScoreIdentity, asOfSec: snapshot.asOfSec,
      publishedAtSec: snapshot.updatedAt, subject, imageSha256: "0".repeat(64),
      freshnessBudgetSec: SAFETY_SCORE_V9_CONSUMER_MAX_AGE_SEC,
    });
    const element = await scorecardElement(metadata);
    if (!element) return unavailable("subject-unavailable");
    const image = await renderPng(element);
    validateSocialScorecardPng(image);
    // Rendering can cross an expiry, hold or publication change. Re-admit the
    // exact source, never relabel the old pixels as the newest generation.
    const afterRender = await loadActiveSafetyScoreIndex(db, undefined, pillarSubjectId);
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
