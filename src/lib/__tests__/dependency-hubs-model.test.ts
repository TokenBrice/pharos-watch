import { describe, expect, it } from "vitest";
import { buildDependencyHubsModel } from "@/lib/dependency-hubs-model";
import type { ReportCardsV9DependencyEdge } from "@shared/types/report-cards-v9";

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
  it("ranks v5 cards by known direct USD while preserving unavailable wrapper classification", () => {
    const model = buildDependencyHubsModel({ cards, edges, mcapMap: new Map([["susds-sky", 500], ["dai-makerdao", 1000]]) });
    expect(model.hubs.map(hub => hub.id)).toEqual(["usds-sky", "usdc-circle"]);
    expect(model.hubs[0].ownFamilyUsd).toBe(0);
    expect(model.hubs[0].unknownFormUsd).toBe(500);
    expect(model.hubs[0].unknownFormCount).toBe(1);
    expect(model.hubs[0].passThroughCount + model.hubs[0].vaultClaimCount).toBe(0);
    expect(model.mappedSupply.unknownFormUsd).toBe(500);
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
    expect(model.hubs.find(hub => hub.id === "usds-sky")!.unknownFormUsd).toBeNull();
  });
  it("uses published wrapper forms to separate vault and pass-through amounts", () => {
    const publishedEdges = edges.map(edge => edge.to === "susds-sky" ? { ...edge, wrapperForm: "strategy-vault" as const } : edge);
    const model = buildDependencyHubsModel({ cards, edges: publishedEdges, mcapMap: new Map([["susds-sky", 500], ["dai-makerdao", 1000]]) });
    expect(model.hubs[0].vaultClaimUsd).toBe(500);
    expect(model.hubs[0].passThroughUsd).toBe(0);
  });
  it("separates classified and unknown serial supplies without changing total mapped exposure", () => {
    const splitCards = [...cards, { id: "child-pure", name: "Pure", symbol: "P" }, { id: "child-vault", name: "Vault", symbol: "V" }];
    const splitEdges: ReportCardsV9DependencyEdge[] = [
      ...edges,
      { from: "usds-sky", to: "child-pure", kind: "serial", materiality: "serial", weight: null, upstreamScore: 80, wrapperForm: "pure" },
      { from: "usds-sky", to: "child-vault", kind: "serial", materiality: "serial", weight: null, upstreamScore: 80, wrapperForm: "strategy-vault" },
    ];
    const model = buildDependencyHubsModel({ cards: splitCards, edges: splitEdges, mcapMap: new Map([["susds-sky", 500], ["child-pure", 200], ["child-vault", 100], ["dai-makerdao", 1000]]) });
    const hub = model.hubs.find(hub => hub.id === "usds-sky")!;
    expect(hub.direct.knownUsd).toBe(800);
    expect(hub.passThroughUsd).toBe(200);
    expect(hub.vaultClaimUsd).toBe(100);
    expect(hub.unknownFormUsd).toBe(500);
    expect(hub.passThroughCount).toBe(1);
    expect(hub.vaultClaimCount).toBe(1);
    expect(model.mappedSupply.passThroughUsd + model.mappedSupply.vaultClaimUsd + model.mappedSupply.unknownFormUsd!).toBe(800);
    expect(model.mappedSupply.knownUsd).toBe(1200);
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
