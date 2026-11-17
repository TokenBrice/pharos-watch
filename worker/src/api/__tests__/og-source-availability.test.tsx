import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import * as ogRenderer from "../../lib/og-render";
import * as activeSafetyScoreSource from "../../lib/safety-score-index";
import { SAFETY_SCORE_V9_CONSUMER_MAX_AGE_SEC } from "../../lib/safety-score-v9/consumer-freshness";
import { makeScorecardImageFixture, makeScorecardMetadataFixture } from "@shared/test-utils/social-scorecard";
import { decodeSocialScorecardMetadata, SOCIAL_SCORECARD_METADATA_HEADER } from "@shared/lib/social-scorecard";
import { sha256HexFromBytes } from "@shared/lib/sha256";
import { makeWorkerReportCardsV9Response } from "../../test-helpers/report-cards-v9";
import { handleScorecardOg } from "../og-scorecard";

function scorecardMetadata(response: Response) {
  return decodeSocialScorecardMetadata(response.headers.get(SOCIAL_SCORECARD_METADATA_HEADER));
}

describe("admitted dated scorecard rendering", () => {
  const now = 1_795_000_000;
  const db = {} as D1Database;
  function snapshot(): activeSafetyScoreSource.SafetyScoreGradeSnapshot {
    const metadata = makeScorecardMetadataFixture(now);
    return {
      lifecycle: "active", safetyScoreIdentity: metadata.publication,
      methodology: { version: metadata.publication.methodologyVersion },
      asOfSec: metadata.asOfSec, updatedAt: metadata.publishedAtSec,
      publicationHealth: makeWorkerReportCardsV9Response({ updatedAt: metadata.publishedAtSec }).publicationHealth,
      completeness: { expectedCount: 1 },
      cards: [{ id: "usdc-circle", score: 82, grade: "A", ratingStatus: "rated", partialEvidence: null }],
    };
  }
  function mockIndex(source: activeSafetyScoreSource.ActiveSafetyScoreIndex = { kind: "v9", snapshot: snapshot() }) {
    return vi.spyOn(activeSafetyScoreSource, "loadActiveSafetyScoreIndex").mockResolvedValue(source);
  }
  beforeEach(() => {
    vi.useFakeTimers(); vi.setSystemTime(now * 1000);
    mockIndex();
    vi.spyOn(ogRenderer, "renderPng").mockResolvedValue(makeScorecardImageFixture());
  });
  afterEach(() => { vi.useRealTimers(); vi.restoreAllMocks(); });

  it("renders the published hysteresis grade and served methodology, date and full identity", async () => {
    const response = await handleScorecardOg(db, "usdc-circle");
    expect(response.status).toBe(200);
    const metadata = scorecardMetadata(response);
    expect(metadata.subject).toMatchObject({ score: 82, grade: "A" });
    expect(metadata.publication.methodologyVersion).toBe("10.37");
    expect(metadata.publication.publicationGenerationId).toBe(snapshot().safetyScoreIdentity.publicationGenerationId);
    expect(metadata.imageSha256).toBe(sha256HexFromBytes(new Uint8Array(await response.arrayBuffer())));
    const markup = renderToStaticMarkup(vi.mocked(ogRenderer.renderPng).mock.calls[0][0]);
    expect(markup).toContain("Published grade");
    expect(markup).toContain("Methodology v10.37");
    expect(markup).toContain(new Date(metadata.asOfSec * 1000).toISOString().slice(0, 10));
    expect(activeSafetyScoreSource.loadActiveSafetyScoreIndex).toHaveBeenCalledTimes(2);
  });

  it("renders a complete overview with unavailable members disclosed and no aggregate letter", async () => {
    const source = snapshot();
    source.cards.push({ id: "usdt-tether", score: null, grade: null, ratingStatus: "pipeline-gap", partialEvidence: null });
    source.completeness.expectedCount = 2;
    mockIndex({ kind: "v9", snapshot: source });
    const response = await handleScorecardOg(db, "safety-scores");
    expect(response.status).toBe(200);
    expect(scorecardMetadata(response).subject).toEqual({ kind: "overview", id: "safety-scores", ratedCount: 1, notRatedCount: 0, unavailableCount: 1, totalCount: 2, averageScore: 82 });
    const markup = renderToStaticMarkup(vi.mocked(ogRenderer.renderPng).mock.calls[0][0]);
    expect(markup).toContain("Mean rated score");
    expect(markup).not.toContain("Published grade");
  });

  it("preserves an admitted NR without inventing a score", async () => {
    const source = snapshot();
    source.cards[0] = { id: "usdc-circle", score: null, grade: "NR", ratingStatus: "not-rated", partialEvidence: null };
    mockIndex({ kind: "v9", snapshot: source });
    const response = await handleScorecardOg(db, "usdc-circle");
    expect(response.status).toBe(200);
    expect(scorecardMetadata(response).subject).toMatchObject({ score: null, grade: "NR" });
  });

  it.each(["error", "held", "stale", "future", "stale-observation", "future-observation", "quarantined", "missing"])("fails closed before render for %s evidence", async (fault) => {
    const source = snapshot();
    let active: activeSafetyScoreSource.ActiveSafetyScoreIndex = { kind: "v9", snapshot: source };
    if (fault === "error") active = { kind: "error", reason: "missing", detail: "missing", snapshot: null };
    if (fault === "held") active = { kind: "held", reason: "v9-publication-held", detail: "held", snapshot: source };
    if (fault === "stale") source.updatedAt = now - SAFETY_SCORE_V9_CONSUMER_MAX_AGE_SEC - 1;
    if (fault === "future") source.updatedAt = now + 1;
    if (fault === "stale-observation") source.asOfSec = now - SAFETY_SCORE_V9_CONSUMER_MAX_AGE_SEC;
    if (fault === "future-observation") source.asOfSec = now + 1;
    if (fault === "quarantined") source.cards[0] = { id: "usdc-circle", score: null, grade: null, ratingStatus: "pipeline-gap", partialEvidence: null };
    if (fault === "missing") source.cards = [];
    mockIndex(active);
    const response = await handleScorecardOg(db, "usdc-circle");
    expect(response.status).toBe(503);
    expect(response.headers.get("Cache-Control")).toBe("no-store");
    expect(response.headers.has(SOCIAL_SCORECARD_METADATA_HEADER)).toBe(false);
    expect(ogRenderer.renderPng).not.toHaveBeenCalled();
  });

  it.each(["expiry", "observation-expiry", "generation", "hold", "grade"])("re-admits after rendering and refuses %s changes", async (fault) => {
    const initial = snapshot();
    const next = snapshot();
    if (fault === "observation-expiry") initial.asOfSec = next.asOfSec = now - SAFETY_SCORE_V9_CONSUMER_MAX_AGE_SEC + 1;
    if (fault === "generation") next.safetyScoreIdentity = { ...next.safetyScoreIdentity, publicationGenerationId: "next-generation" };
    if (fault === "grade") next.cards[0].grade = "B+";
    mockIndex().mockResolvedValueOnce({ kind: "v9", snapshot: initial })
      .mockResolvedValueOnce(fault === "hold" ? { kind: "held", reason: "v9-publication-held", detail: "held", snapshot: next } : { kind: "v9", snapshot: next });
    vi.mocked(ogRenderer.renderPng).mockImplementation(async () => {
      if (fault === "expiry") vi.setSystemTime((initial.updatedAt + SAFETY_SCORE_V9_CONSUMER_MAX_AGE_SEC + 1) * 1000);
      if (fault === "observation-expiry") vi.setSystemTime((now + 2) * 1000);
      return makeScorecardImageFixture();
    });
    const response = await handleScorecardOg(db, "usdc-circle");
    expect(response.status).toBe(503);
    expect(response.headers.has(SOCIAL_SCORECARD_METADATA_HEADER)).toBe(false);
  });

  it.each(["publication", "observation"] as const)("bounds cache lifetime by the remaining %s budget", async (clock) => {
    const source = snapshot();
    if (clock === "publication") source.updatedAt = now - SAFETY_SCORE_V9_CONSUMER_MAX_AGE_SEC + 8;
    source.asOfSec = now - SAFETY_SCORE_V9_CONSUMER_MAX_AGE_SEC + 8;
    mockIndex({ kind: "v9", snapshot: source });
    const response = await handleScorecardOg(db, "usdc-circle");
    expect(response.status).toBe(200);
    expect(response.headers.get("Cache-Control")).toBe("public, max-age=7, s-maxage=7");
  });

  it("rejects unknown subjects and renderer failures without timeless fallback", async () => {
    expect((await handleScorecardOg(db, "not-a-stablecoin")).status).toBe(404);
    expect(activeSafetyScoreSource.loadActiveSafetyScoreIndex).not.toHaveBeenCalled();
    vi.mocked(ogRenderer.renderPng).mockRejectedValue(new Error("Renderer failed"));
    const response = await handleScorecardOg(db, "usdc-circle");
    expect(response.status).toBe(503);
    expect(response.headers.get("Cache-Control")).toBe("no-store");
  });
});
