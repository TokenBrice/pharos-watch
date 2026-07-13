import { describe, it, expect } from "vitest";
import { mockD1, type MockD1Database } from "../../test-helpers/__shared/mock-d1";
import { makeAsset, makeReportCardsDb } from "../../test-helpers/__shared/fixtures";
import { handleReportCards } from "../report-cards";
import { REPORT_CARDS_SNAPSHOT_CACHE_GENERATION } from "../../lib/report-cards-snapshot-cache";
import { SAFETY_SCORE_METHODOLOGY_VERSION as METHODOLOGY_VERSION } from "@shared/lib/safety-score-version";
import { ACTIVE_STABLECOINS } from "@shared/lib/stablecoins/registry";
import { buildReportCardsSnapshot } from "../../lib/report-cards-snapshot";
import { buildReportCardPublicationPlan } from "../../lib/report-card-publication";
import { buildSafetyScoreV8PublicationIdentity } from "@shared/lib/safety-score-v8-publication";

function makeCachedSnapshot(updatedAt = Math.floor(Date.now() / 1000)) {
  return {
    cards: [],
    methodology: {
      version: METHODOLOGY_VERSION,
      weights: {
        pegStability: 0.3,
        liquidity: 0.25,
        resilience: 0.2,
        decentralization: 0.15,
        dependencyRisk: 0.1,
      },
      pegMultiplierExponent: 1.15,
      thresholds: [{ grade: "A", min: 85 }],
    },
    dependencyGraph: { edges: [] },
    updatedAt,
    liquidityStale: false,
    redemptionStale: false,
    inputFreshness: {
      dexLiquidity: { updatedAt, ageSeconds: 0, stale: false },
      redemptionBackstops: { updatedAt, ageSeconds: 0, stale: false },
    },
  };
}

function makeCachedSnapshotEnvelope(snapshot: unknown) {
  return {
    generation: REPORT_CARDS_SNAPSHOT_CACHE_GENERATION,
    methodologyVersion: METHODOLOGY_VERSION,
    payload: snapshot,
  };
}

async function makeExactCachedSnapshot(updatedAt: number) {
  const assets = ACTIVE_STABLECOINS.map((meta) =>
    makeAsset({
      id: meta.id,
      name: meta.name,
      symbol: meta.symbol,
    }),
  );
  const snapshot = await buildReportCardsSnapshot(makeReportCardsDb(assets, updatedAt));
  const publication = buildReportCardPublicationPlan(
    snapshot.cards,
    snapshot.methodology.version,
    snapshot.updatedAt,
  ).completeness;
  return {
    ...snapshot,
    safetyScoreIdentity: buildSafetyScoreV8PublicationIdentity({
      methodologyVersion: snapshot.methodology.version,
      baseInputGenerationId: `report-cards-input:v1:${"a".repeat(64)}`,
      publicationGenerationId: publication.generationId,
    }),
    publication,
  };
}

describe("handleReportCards", () => {
  it("returns 503 when stablecoins cache is missing", async () => {
    const db = mockD1();
    const res = await handleReportCards(db);
    expect(res.status).toBe(503);
  });

  it("returns 200 with cards, methodology, and dependencyGraph", async () => {
    const asset = makeAsset({ id: "usdt-tether", symbol: "USDT" });
    const db = makeReportCardsDb([asset]);
    const res = await handleReportCards(db);
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      cards: unknown[];
      methodology: Record<string, unknown>;
      dependencyGraph: { edges: unknown[] };
      updatedAt: number;
    };
    expect(body).toHaveProperty("cards");
    expect(body).toHaveProperty("methodology");
    expect(body).toHaveProperty("dependencyGraph");
    expect(body).toHaveProperty("updatedAt");
    expect(body.methodology).toHaveProperty("version");
    expect(body.methodology).toHaveProperty("weights");
    expect(body.methodology).toHaveProperty("thresholds");
    expect(Array.isArray(body.cards)).toBe(true);
    expect(Array.isArray(body.dependencyGraph.edges)).toBe(true);
  });

  it("serves the published snapshot without recomputing the report cards", async () => {
    const updatedAt = Math.floor(Date.now() / 1000) - 30;
    const snapshot = await makeExactCachedSnapshot(updatedAt);
    const db = mockD1([
      {
        match: "cache",
        rows: [
          {
            key: "report-cards:snapshot",
            value: JSON.stringify(makeCachedSnapshotEnvelope(snapshot)),
            updated_at: updatedAt,
          },
        ],
      },
    ]) as MockD1Database;

    const res = await handleReportCards(db);

    expect(res.status).toBe(200);
    const body = (await res.json()) as { cards: unknown[]; updatedAt: number };
    expect(body.cards).toHaveLength(snapshot.cards.length);
    expect(body.updatedAt).toBe(updatedAt);
    expect(db.getHistory().some((entry) => entry.sql.includes("dex_liquidity"))).toBe(false);
    expect(db.getHistory().some((entry) => entry.sql.includes("depeg_events"))).toBe(false);
  });

  it("rejects a published snapshot from an old cache generation and computes on read", async () => {
    const updatedAt = Math.floor(Date.now() / 1000) - 30;
    const staleSnapshot = makeCachedSnapshot(updatedAt);
    const asset = makeAsset({ id: "usdt-tether", symbol: "USDT" });
    const stablecoinsValue = JSON.stringify({ peggedAssets: [asset] });
    const db = mockD1([
      {
        match: "cache",
        rows: [
          {
            key: "report-cards:snapshot",
            value: JSON.stringify({
              generation: 1,
              methodologyVersion: staleSnapshot.methodology.version,
              payload: staleSnapshot,
            }),
            updated_at: updatedAt,
          },
          { key: "stablecoins", value: stablecoinsValue, updated_at: updatedAt },
          { key: "bluechip-ratings", value: "{}", updated_at: updatedAt },
        ],
      },
      { match: "dex_liquidity", rows: [] },
      { match: "depeg_events", rows: [] },
      { match: "supply_history", rows: [] },
    ]) as MockD1Database;

    const res = await handleReportCards(db);

    expect(res.status).toBe(200);
    const body = (await res.json()) as { cards: unknown[]; updatedAt: number };
    expect(body.cards.length).toBeGreaterThan(0);
    expect(db.getHistory().some((entry) => entry.sql.includes("dex_liquidity"))).toBe(true);
  });

  it("rejects a published snapshot from an old methodology and computes on read", async () => {
    const updatedAt = Math.floor(Date.now() / 1000) - 30;
    const staleSnapshot = makeCachedSnapshot(updatedAt);
    const asset = makeAsset({ id: "usdt-tether", symbol: "USDT" });
    const stablecoinsValue = JSON.stringify({ peggedAssets: [asset] });
    const db = mockD1([
      {
        match: "cache",
        rows: [
          {
            key: "report-cards:snapshot",
            value: JSON.stringify({
              generation: 2,
              methodologyVersion: "old-version",
              payload: staleSnapshot,
            }),
            updated_at: updatedAt,
          },
          { key: "stablecoins", value: stablecoinsValue, updated_at: updatedAt },
          { key: "bluechip-ratings", value: "{}", updated_at: updatedAt },
        ],
      },
      { match: "dex_liquidity", rows: [] },
      { match: "depeg_events", rows: [] },
      { match: "supply_history", rows: [] },
    ]) as MockD1Database;

    const res = await handleReportCards(db);

    expect(res.status).toBe(200);
    const body = (await res.json()) as { cards: unknown[]; updatedAt: number };
    expect(body.cards.length).toBeGreaterThan(0);
    expect(db.getHistory().some((entry) => entry.sql.includes("dex_liquidity"))).toBe(true);
  });

  it("includes cards with expected dimensions", async () => {
    const asset = makeAsset({ id: "usdt-tether", symbol: "USDT" });
    const db = makeReportCardsDb([asset]);
    const res = await handleReportCards(db);
    const body = (await res.json()) as { cards: Array<Record<string, unknown>> };
    // Should have at least one card (tracked stablecoins + dead stablecoins)
    expect(body.cards.length).toBeGreaterThan(0);
    const card = body.cards[0];
    expect(card).toHaveProperty("id");
    expect(card).toHaveProperty("overallGrade");
    expect(card).toHaveProperty("overallScore");
    expect(card).toHaveProperty("dimensions");
  });

  it("every card exposes variant-aware parent-cap fields on the top-level payload and rawInputs", async () => {
    const asset = makeAsset({ id: "usdt-tether", symbol: "USDT" });
    const db = makeReportCardsDb([asset]);
    const res = await handleReportCards(db);
    const body = (await res.json()) as {
      cards: Array<{
        id: string;
        overallCapped?: unknown;
        uncappedOverallScore?: unknown;
        rawInputs?: { variantParentId?: unknown; variantKind?: unknown };
      }>;
    };

    expect(body.cards.length).toBeGreaterThan(0);
    for (const card of body.cards) {
      expect(card).toHaveProperty("overallCapped");
      expect(typeof card.overallCapped).toBe("boolean");
      expect(card).toHaveProperty("uncappedOverallScore");
      expect(card.uncappedOverallScore === null || typeof card.uncappedOverallScore === "number").toBe(true);
      expect(card.rawInputs).toBeDefined();
      expect(card.rawInputs).toHaveProperty("variantParentId");
      expect(card.rawInputs!.variantParentId === null || typeof card.rawInputs!.variantParentId === "string").toBe(
        true,
      );
      expect(card.rawInputs).toHaveProperty("variantKind");
      expect(card.rawInputs!.variantKind === null || typeof card.rawInputs!.variantKind === "string").toBe(true);
    }
  });

  it("emits unique non-numeric ids for defunct cards", async () => {
    const asset = makeAsset({ id: "usdt-tether", symbol: "USDT" });
    const db = makeReportCardsDb([asset]);
    const res = await handleReportCards(db);
    const body = (await res.json()) as {
      cards: Array<{ id: string; isDefunct?: boolean }>;
    };

    const defunctIds = body.cards.filter((card) => card.isDefunct === true).map((card) => card.id);

    expect(defunctIds.length).toBeGreaterThan(0);
    expect(new Set(defunctIds).size).toBe(defunctIds.length);
    expect(defunctIds.every((id) => !/^\d+$/.test(id))).toBe(true);
  });

  it("includes X-Data-Age header", async () => {
    const asset = makeAsset();
    const db = makeReportCardsDb([asset]);
    const res = await handleReportCards(db);
    expect(res.headers.has("X-Data-Age")).toBe(true);
  });
});
