import { describe, expect, it } from "vitest";
import { buildDependencyHubsModel } from "@shared/lib/dependency-hubs-model";
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

  it("classifies each hub's own published wrapper form when the dependent also has a mechanism parent", () => {
    const mixedCards = [
      ...cards,
      { id: "usdt-tether", name: "Tether", symbol: "USDT" },
      { id: "susdc-spark", name: "Spark Savings USDC", symbol: "spUSDC" },
      { id: "susdt-spark", name: "Spark Savings USDT", symbol: "spUSDT" },
      { id: "usdb-blast", name: "USD Balance", symbol: "USDB" },
    ];
    const mixedEdges: ReportCardsV9DependencyEdge[] = [
      { from: "usdc-circle", to: "susdc-spark", kind: "serial", materiality: "serial", weight: null, upstreamScore: 88, wrapperForm: "native-staked" },
      { from: "usds-sky", to: "susdc-spark", kind: "serial", materiality: "serial", weight: null, upstreamScore: 71, wrapperForm: null },
      { from: "usdt-tether", to: "susdt-spark", kind: "serial", materiality: "serial", weight: null, upstreamScore: 69, wrapperForm: "native-staked" },
      { from: "usds-sky", to: "susdt-spark", kind: "serial", materiality: "serial", weight: null, upstreamScore: 71, wrapperForm: null },
      { from: "dai-makerdao", to: "usdb-blast", kind: "serial", materiality: "serial", weight: null, upstreamScore: 76, wrapperForm: null },
    ];
    const model = buildDependencyHubsModel({
      cards: mixedCards,
      edges: mixedEdges,
      mcapMap: new Map([
        ["susdc-spark", 309_688_947.03],
        ["susdt-spark", 735_077_798.78],
        ["usdb-blast", 10_453_191.52],
      ]),
    });

    // The mechanism parent publishes no form; it must not erase the wrapper
    // parent's published form from that hub's own claim split.
    const usdc = model.hubs.find(hub => hub.id === "usdc-circle")!;
    expect(usdc.passThroughCount).toBe(1);
    expect(usdc.passThroughUsd).toBeCloseTo(309_688_947.03, 2);
    expect(usdc.unknownFormCount).toBe(0);
    expect(usdc.unknownFormUsd).toBeNull();

    const tether = model.hubs.find(hub => hub.id === "usdt-tether")!;
    expect(tether.passThroughUsd).toBeCloseTo(735_077_798.78, 2);
    expect(tether.unknownFormCount).toBe(0);

    // This hub's own edges all lack a published form and stay unavailable.
    const sky = model.hubs.find(hub => hub.id === "usds-sky")!;
    expect(sky.passThroughCount + sky.vaultClaimCount).toBe(0);
    expect(sky.passThroughUsd + sky.vaultClaimUsd).toBe(0);
    expect(sky.unknownFormCount).toBe(2);
    expect(sky.unknownFormUsd).toBeCloseTo(1_044_766_745.81, 2);

    expect(model.mappedSupply.passThroughCount).toBe(2);
    expect(model.mappedSupply.passThroughUsd).toBeCloseTo(1_044_766_745.81, 2);
    expect(model.mappedSupply.unknownFormCount).toBe(1);
    expect(model.mappedSupply.unknownFormUsd).toBeCloseTo(10_453_191.52, 2);
  });

  it("scopes a hub's USD split to its own published edge forms and classifies the dependent once globally", () => {
    const scopedEdges: ReportCardsV9DependencyEdge[] = [
      { from: "usdc-circle", to: "susdc-spark", kind: "serial", materiality: "serial", weight: null, upstreamScore: 88, wrapperForm: "native-staked" },
      { from: "usds-sky", to: "susdc-spark", kind: "serial", materiality: "serial", weight: null, upstreamScore: 71, wrapperForm: null },
      { from: "usds-sky", to: "susds-sky", kind: "serial", materiality: "serial", weight: null, upstreamScore: 80, wrapperForm: "pure" },
    ];
    const model = buildDependencyHubsModel({
      cards: [...cards, { id: "susdc-spark", name: "Spark Savings USDC", symbol: "spUSDC" }],
      edges: scopedEdges,
      mcapMap: new Map([["susdc-spark", 300], ["susds-sky", 100]]),
    });

    // The hub published no form on its susdc edge, so that supply stays unavailable
    // even though another parent published one; its own pure edge is pass-through.
    const sky = model.hubs.find(hub => hub.id === "usds-sky")!;
    expect(sky.passThroughCount).toBe(1);
    expect(sky.passThroughUsd).toBe(100);
    expect(sky.unknownFormCount).toBe(1);
    expect(sky.unknownFormUsd).toBe(300);

    const usdc = model.hubs.find(hub => hub.id === "usdc-circle")!;
    expect(usdc.passThroughCount).toBe(1);
    expect(usdc.passThroughUsd).toBe(300);

    // The mapped total counts the dependent once, preferring the published wrapper form.
    expect(model.mappedSupply.passThroughCount).toBe(2);
    expect(model.mappedSupply.passThroughUsd).toBe(400);
    expect(model.mappedSupply.unknownFormCount).toBe(0);
    expect(model.mappedSupply.unknownFormUsd).toBeNull();
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

  it("computes direct and claim knownness only over live edges", () => {
    const liveEdges: ReportCardsV9DependencyEdge[] = [
      { ...edges[0], wrapperForm: "pure" },
      { ...edges[0], to: "dai-makerdao", wrapperForm: "strategy-vault" },
    ];
    const ignoredEdges: ReportCardsV9DependencyEdge[] = [
      { ...edges[0], to: "retired", wrapperForm: "pure" },
      { ...edges[0], to: "absent", wrapperForm: "strategy-vault" },
    ];
    const model = buildDependencyHubsModel({ cards: [...cards, { id: "retired", name: "Retired", symbol: "R", isDefunct: true }], edges: [...liveEdges, ...ignoredEdges], mcapMap: new Map([["retired", 100], ["absent", 100]]) });
    expect(model.directEdgeCount).toBe(2);
    expect(model.mappedSupply.known).toBe(false);
    expect(model.hubs[0].directKnown).toBe(false);
    for (const split of [model.mappedSupply, model.hubs[0]]) {
      expect(Object.values(split.claimAvailability)).toEqual([
        { known: false, complete: false }, { known: false, complete: false }, { known: false, complete: false },
      ]);
    }
  });

  it.each([0, 100])("keeps observed supply %s measurable and empty claims known", supply => {
    const model = buildDependencyHubsModel({ cards, edges: [edges[1]], mcapMap: new Map([["dai-makerdao", supply]]) });
    expect(model.mappedSupply.known).toBe(true);
    expect(model.hubs[0].directKnown).toBe(true);
    expect(model.hubs[0].claimAvailability.classified).toEqual({ known: true, complete: true });
  });
});
