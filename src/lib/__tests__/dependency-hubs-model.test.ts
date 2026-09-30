import { describe, expect, it } from "vitest";
import { buildDependencyHubsModel } from "@/lib/dependency-hubs-model";
import type { ReportCardsV9DependencyEdge } from "@shared/types/report-cards-v9";
import { makeV9Card } from "@/test/fixtures/safety-score-v9";

const cards = [
  { id: "usds-sky", name: "USDS", symbol: "USDS" },
  { id: "susds-sky", name: "Savings USDS", symbol: "sUSDS" },
  { id: "usdc-circle", name: "USD Coin", symbol: "USDC" },
  { id: "dai-makerdao", name: "Dai", symbol: "DAI" },
];
const edges: ReportCardsV9DependencyEdge[] = [
  { from: "usds-sky", to: "susds-sky", kind: "serial", materiality: "serial", weight: null, upstreamScore: 80 },
  { from: "usdc-circle", to: "dai-makerdao", kind: "basket", materiality: "basket-weighted", weight: 0.4, upstreamScore: 80 },
];
describe("buildDependencyHubsModel", () => {
  it("ranks v5 cards without shared-book metadata by known direct USD and classifies own-family wrappers", () => {
    const model = buildDependencyHubsModel({ cards, edges, mcapMap: new Map([["susds-sky", 500], ["dai-makerdao", 1000]]) });
    expect(model.hubs.map(hub => hub.id)).toEqual(["usds-sky", "usdc-circle"]);
    expect(model.hubs[0].ownFamilyUsd).toBe(500);
    expect(model.hubs[1].direct.knownUsd).toBe(400);
    expect(model.mappedSupply.knownUsd).toBe(900);
    expect(model.mappedSupply.complete).toBe(true);
  });
  it("keeps unknown supplies out of USD totals while preserving literal counts", () => {
    const model = buildDependencyHubsModel({ cards, edges, mcapMap: new Map([["susds-sky", null], ["dai-makerdao", 1000]]) });
    expect(model.uniqueDirectDependentCount).toBe(2);
    expect(model.mappedSupply.excludedSupplyUnknownIds).toEqual(["susds-sky"]);
    const usds = model.hubs.find(hub => hub.id === "usds-sky")!;
    expect(usds.dependentCount).toBe(1);
    expect(usds.hubMcapUsd).toBeNull();
    expect(usds.direct.knownUsd).toBe(0);
    expect(model.mappedSupply.knownUsd).toBe(400);
  });
  it("uses published wrapper forms to separate vault and pass-through amounts", () => {
    const vault = makeV9Card({ id: "susds-sky" });
    const trace = { ...vault.scoreTrace, wrapperParentLimit: { ...vault.scoreTrace?.wrapperParentLimit, form: "strategy-vault" } } as typeof vault.scoreTrace;
    const model = buildDependencyHubsModel({ cards: cards.map(card => card.id === vault.id ? { ...card, scoreTrace: trace } : card), edges, mcapMap: new Map([["susds-sky", 500], ["dai-makerdao", 1000]]) });
    expect(model.hubs[0].vaultClaimUsd).toBe(500);
    expect(model.hubs[0].passThroughUsd).toBe(0);
  });

  it("uses v6 shared-book member supply as the fallback for both board and hero", () => {
    const skyCards = cards.map(card => ({ ...card, sharedBookId: card.id === "dai-makerdao" || card.id === "usds-sky" ? "sky-maker" : null }));
    const skyEdges: ReportCardsV9DependencyEdge[] = [
      { from: "usdc-circle", to: "dai-makerdao", kind: "basket", materiality: "basket-weighted", weight: 0.4, upstreamScore: 80 },
      { from: "usdc-circle", to: "usds-sky", kind: "basket", materiality: "basket-weighted", weight: 0.4, upstreamScore: 80 },
    ];
    const model = buildDependencyHubsModel({ cards: skyCards, edges: skyEdges, mcapMap: new Map([["dai-makerdao", 100], ["usds-sky", 200]]) });
    expect(model.hubs[0].direct.knownUsd).toBe(120);
    expect(model.hubs[0].dependentCount).toBe(2);
    expect(model.mappedSupply.knownUsd).toBe(120);
  });
});
