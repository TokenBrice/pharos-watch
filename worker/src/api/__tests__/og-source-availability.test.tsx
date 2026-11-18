import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import * as ogRenderer from "../../lib/og-render";
import * as activeSafetyScoreSource from "../../lib/safety-score-index";
import { SAFETY_SCORE_V9_CONSUMER_MAX_AGE_SEC } from "../../lib/safety-score-v9/consumer-freshness";
import { makeScorecardImageFixture, makeScorecardMetadataFixture } from "@shared/test-utils/social-scorecard";
import { decodeSocialScorecardMetadata, SOCIAL_SCORECARD_METADATA_HEADER, SOCIAL_SCORECARD_REASON_HEADER } from "@shared/lib/social-scorecard";
import { SITE_ORIGIN } from "@shared/lib/runtime-origins";
import { sha256HexFromBytes } from "@shared/lib/sha256";
import { mockFetch, type MockFetchOutcome } from "@shared/test-utils/mock-fetch";
import { makeWorkerReportCardsV9Response } from "../../test-helpers/report-cards-v9";
import { handleScorecardOg } from "../og-scorecard";

// Node's harfbuzzjs is a promise that vitest's module interop cannot await; the measurer is stubbed below.
vi.mock("harfbuzzjs", () => ({ default: {} }));

function scorecardMetadata(response: Response) {
  return decodeSocialScorecardMetadata(response.headers.get(SOCIAL_SCORECARD_METADATA_HEADER));
}

const logoUrl = `${SITE_ORIGIN}/logos/2-usdc.svg`;
const logoSvg = '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 2 2"><circle cx="1" cy="1" r="1"/></svg>';
const mockLogo = (respond: () => MockFetchOutcome | Response) => mockFetch([{ match: logoUrl, respond }], { requireMatch: true, strictUrl: true });
/** The element handed to the renderer, as searchable JSON (no-break spaces read as spaces). */
const drawn = () => JSON.stringify(vi.mocked(ogRenderer.renderPng).mock.calls[0][0]).replace(/\u00a0/g, " ");

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
    vi.spyOn(ogRenderer, "socialCardMeasurer").mockResolvedValue({ width: (text, _face, size) => text.length * size * 0.3 });
    mockLogo(() => new Response(logoSvg, { headers: { "Content-Type": "image/svg+xml" } }));
  });
  afterEach(() => { vi.useRealTimers(); vi.restoreAllMocks(); vi.unstubAllGlobals(); });

  it("renders the published hysteresis grade, its date and the registered logo", async () => {
    const response = await handleScorecardOg(db, "usdc-circle");
    expect(response.status).toBe(200);
    const metadata = scorecardMetadata(response);
    expect(metadata.subject).toMatchObject({ score: 82, grade: "A" });
    expect(metadata.publication.methodologyVersion).toBe("10.37");
    expect(metadata.publication.publicationGenerationId).toBe(snapshot().safetyScoreIdentity.publicationGenerationId);
    expect(metadata.imageSha256).toBe(sha256HexFromBytes(new Uint8Array(await response.arrayBuffer())));
    const card = drawn();
    for (const shown of ["A", "82", "USDC", "USD Coin", "As of 18 Nov 2026"]) expect(card).toContain(`"${shown}"`);
    expect(card).toContain(`data:image/svg+xml;base64,${btoa(logoSvg)}`);
    expect(card).not.toMatch(/methodology|not live/i);
    expect(fetch).toHaveBeenCalledOnce();
    expect(activeSafetyScoreSource.loadActiveSafetyScoreIndex).toHaveBeenCalledTimes(2);
  });

  it.each<[string, () => MockFetchOutcome | Response]>([
    ["WebP", () => new Response(new Uint8Array([0x52, 0x49, 0x46, 0x46]), { headers: { "Content-Type": "image/webp" } })],
    ["mislabelled", () => new Response(logoSvg, { headers: { "Content-Type": "image/png" } })],
    ["missing", () => new Response("missing", { status: 404 })],
    ["unreachable", () => new Error("network down")],
  ])("draws the monogram when the logo is %s", async (_case, respond) => {
    mockLogo(respond);
    expect((await handleScorecardOg(db, "usdc-circle")).status).toBe(200);
    expect(drawn()).toContain("3px dashed");
    expect(drawn()).not.toMatch(/data:image\/(?:webp|png|svg\+xml;base64)/);
  });

  it("renders a complete overview with unavailable members disclosed and no aggregate letter", async () => {
    const source = snapshot();
    source.cards.push({ id: "usdt-tether", score: null, grade: null, ratingStatus: "pipeline-gap", partialEvidence: null });
    source.completeness.expectedCount = 2;
    mockIndex({ kind: "v9", snapshot: source });
    const response = await handleScorecardOg(db, "safety-scores");
    expect(response.status).toBe(200);
    expect(scorecardMetadata(response).subject).toEqual({ kind: "overview", id: "safety-scores", ratedCount: 1, notRatedCount: 0, unavailableCount: 1, totalCount: 2, averageScore: 82 });
    const card = drawn();
    for (const shown of ["Safety Scores", "82.0", "Mean rated score", "1 rated · 1 unavailable", "As of 18 Nov 2026"]) expect(card).toContain(`"${shown}"`);
    expect(card).not.toMatch(/"children":"[A-F][+-]?"|not rated/);
    expect(fetch).not.toHaveBeenCalled();
  });

  it("answers a not-rated coin with a machine-readable reason instead of dating a grade it lacks", async () => {
    const source = snapshot();
    source.cards[0] = { id: "usdc-circle", score: null, grade: "NR", ratingStatus: "not-rated", partialEvidence: null };
    mockIndex({ kind: "v9", snapshot: source });
    const response = await handleScorecardOg(db, "usdc-circle");
    expect(response.status).toBe(404);
    expect(response.headers.get(SOCIAL_SCORECARD_REASON_HEADER)).toBe("not-rated");
    expect(response.headers.has("Retry-After") || response.headers.has(SOCIAL_SCORECARD_METADATA_HEADER)).toBe(false);
    expect(ogRenderer.renderPng).not.toHaveBeenCalled();
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
