import { describe, expect, it } from "vitest";
import { projectV9Detail, projectV9DetailNeighborhoodCard, projectV9Table } from "@shared/lib/report-cards-v9-projections";
import { stableJsonStringifyV1 } from "@shared/lib/stable-json";
import { deepFreeze } from "@shared/types/safety-score-v9-immutable";
import { makeReportCardsV9Response, makeWorkerSafetyScoreV9Publication, makeWorkerV9Card } from "../../test-helpers/report-cards-v9";
import { projectSafetyScoreV9PublicationForMaterialization } from "../report-cards-v9-cache";

describe("V9 detail neighborhood projection reuse", () => {
  it("preserves exact detail bytes, closure membership and card order without mutating input", () => {
    const cards = ["alpha", "beta", "delta", "gamma", "zeta"].map(id => makeWorkerV9Card({ id }));
    cards[1]!.dependencies.basket = ["alpha", "gamma"].map(upstreamAssetId => ({
      upstreamAssetId, weight: 0.5, score: 80, ratingStatus: "rated", partialEvidence: null,
      causeGapRefs: [], limitedEvidenceCauses: [], boundedUnknown: false,
    }));
    const publication = makeWorkerSafetyScoreV9Publication({ cards, commonModeGroups: [{
      id: "chain:ethereum", kind: "chain", key: "ethereum", memberAssetIds: ["alpha", "delta"],
    }] });
    const snapshot = deepFreeze(projectSafetyScoreV9PublicationForMaterialization(publication, makeReportCardsV9Response().publicationHealth));
    const graph = projectV9Table(snapshot).dependencyGraph;
    const neighborhood = deepFreeze(snapshot.cards.map(projectV9DetailNeighborhoodCard));
    const before = stableJsonStringifyV1({ snapshot, neighborhood });
    for (const card of snapshot.cards) {
      const ordinary = projectV9Detail(snapshot, card.id, graph);
      const reused = projectV9Detail(snapshot, card.id, graph, neighborhood);
      expect(stableJsonStringifyV1(reused)).toBe(stableJsonStringifyV1(ordinary));
      expect(JSON.stringify(reused)).toBe(JSON.stringify(ordinary));
      expect(reused.cards.map(row => row.id)).toEqual([card.id]);
    }
    expect(projectV9Detail(snapshot, "alpha", graph, neighborhood).neighborhood.map(row => row.id))
      .toEqual(["alpha", "beta", "delta", "gamma"]);
    expect(projectV9Detail(snapshot, "beta", graph, neighborhood).neighborhood.map(row => row.id))
      .toEqual(["alpha", "beta", "gamma"]);
    expect(projectV9Detail(snapshot, "zeta", graph, neighborhood).neighborhood.map(row => row.id)).toEqual(["zeta"]);
    expect(stableJsonStringifyV1({ snapshot, neighborhood })).toBe(before);
  });

  it("reads other cards' compact-neighborhood fields once for cohort-wide common modes", () => {
    const ids = Array.from({ length: 12 }, (_, index) => `asset-${String(index).padStart(2, "0")}`);
    const publication = makeWorkerSafetyScoreV9Publication({
      cards: ids.map(id => makeWorkerV9Card({ id })),
      commonModeGroups: [{ id: "chain:ethereum", kind: "chain", key: "ethereum", memberAssetIds: ids }],
    });
    const snapshot = projectSafetyScoreV9PublicationForMaterialization(publication, makeReportCardsV9Response().publicationHealth);
    const graph = projectV9Table(snapshot).dependencyGraph;
    const reads = new Map(ids.map(id => [id, 0]));
    for (const card of snapshot.cards) {
      const pillars = card.pillars;
      Object.defineProperty(card, "pillars", { enumerable: true, get() {
        reads.set(card.id, reads.get(card.id)! + 1);
        return pillars;
      } });
    }
    const neighborhood = snapshot.cards.map(projectV9DetailNeighborhoodCard);
    expect([...reads.values()]).toEqual(ids.map(() => 1));
    for (const id of ids) {
      for (const other of ids) reads.set(other, 0);
      const detail = projectV9Detail(snapshot, id, graph, neighborhood);
      expect(detail.neighborhood.map(row => row.id)).toEqual(ids);
      expect(reads.get(id)).toBeGreaterThan(0);
      expect(ids.filter(other => other !== id).map(other => reads.get(other))).toEqual(ids.slice(1).map(() => 0));
    }
  });
});
