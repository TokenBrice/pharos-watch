import { describe, it, expect } from "vitest";
import { mockD1 } from "./helpers/mock-d1";
import { makeAsset, makeReportCardsDb } from "./helpers/fixtures";
import { handleReportCards } from "../report-cards";

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
      expect(
        card.uncappedOverallScore === null || typeof card.uncappedOverallScore === "number",
      ).toBe(true);
      expect(card.rawInputs).toBeDefined();
      expect(card.rawInputs).toHaveProperty("variantParentId");
      expect(
        card.rawInputs!.variantParentId === null ||
          typeof card.rawInputs!.variantParentId === "string",
      ).toBe(true);
      expect(card.rawInputs).toHaveProperty("variantKind");
      expect(
        card.rawInputs!.variantKind === null ||
          typeof card.rawInputs!.variantKind === "string",
      ).toBe(true);
    }
  });

  it("emits unique non-numeric ids for defunct cards", async () => {
    const asset = makeAsset({ id: "usdt-tether", symbol: "USDT" });
    const db = makeReportCardsDb([asset]);
    const res = await handleReportCards(db);
    const body = (await res.json()) as {
      cards: Array<{ id: string; isDefunct?: boolean }>;
    };

    const defunctIds = body.cards
      .filter((card) => card.isDefunct === true)
      .map((card) => card.id);

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
