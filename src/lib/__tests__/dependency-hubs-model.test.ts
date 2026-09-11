import { describe, expect, it } from "vitest";
import type { DependencyGraphEdge } from "@shared/lib/dependency-graph";
import type { ReportCardsV9Response } from "@shared/types/report-cards-v9";
import type { DependencyHubCard } from "@/lib/dependency-hubs-model";
import { buildDependencyHubsModel } from "@/lib/dependency-hubs-model";

const CARDS: readonly DependencyHubCard[] = [
  { id: "usdc-circle", name: "USD Coin", symbol: "USDC", isDefunct: false },
  { id: "dai-maker", name: "Dai", symbol: "DAI", isDefunct: false },
  { id: "frax-france", name: "Frax", symbol: "FRAX", isDefunct: false },
  { id: "ust-terra", name: "TerraClassicUSD", symbol: "USTC", isDefunct: true },
];

const V9_CARDS: readonly DependencyHubCard[] = [
  ...CARDS.slice(0, 3),
  { id: "usdp-paxos", name: "Pax Dollar", symbol: "USDP", isDefunct: false },
];

type V9Edge = ReportCardsV9Response["dependencyGraph"]["edges"][number];

describe("buildDependencyHubsModel", () => {
  it("dedupes direct dependents for count and market-cap context while summing direct edge weights", () => {
    const model = buildDependencyHubsModel({
      cards: CARDS,
      edges: [
        { from: "usdc-circle", to: "dai-maker", weight: 0.6, type: "collateral" },
        { from: "usdc-circle", to: "dai-maker", weight: 0.2, type: "mechanism" },
        { from: "usdc-circle", to: "frax-france", weight: 0.1, type: "wrapper" },
        { from: "usdc-circle", to: "ust-terra", weight: 0.9, type: "collateral" },
      ] satisfies readonly DependencyGraphEdge[],
      mcapMap: new Map([
        ["usdc-circle", 100],
        ["dai-maker", 5],
        ["frax-france", 2],
        ["ust-terra", 1],
      ]),
    });

    expect(model.directEdgeCount).toBe(3);
    expect(model.uniqueDirectDependentCount).toBe(2);
    expect(model.uniqueDependentMcapUsd).toBe(7);

    const usdcHub = model.hubs.find((hub) => hub.id === "usdc-circle");
    expect(usdcHub).toBeTruthy();
    expect(usdcHub?.dependentCount).toBe(2);
    expect(usdcHub?.summedDirectDependencyWeight).toBeCloseTo(0.9);
    expect(usdcHub?.uniqueDependentMcapUsd).toBe(7);
    expect(usdcHub?.hubMcapUsd).toBe(100);
    expect(usdcHub?.examples.map((example) => example.symbol)).toEqual(["DAI", "FRAX"]);
    expect(usdcHub?.edgeTypeBreakdown).toEqual([
      { type: "collateral", edgeCount: 1, summedDirectDependencyWeight: 0.6 },
      { type: "mechanism", edgeCount: 1, summedDirectDependencyWeight: 0.2 },
      { type: "wrapper", edgeCount: 1, summedDirectDependencyWeight: 0.1 },
    ]);
  });

  it("keeps hub market cap separate from modeled dependent market-cap context", () => {
    const model = buildDependencyHubsModel({
      cards: CARDS.slice(0, 2),
      edges: [
        { from: "usdc-circle", to: "dai-maker", weight: 0.75, type: "collateral" },
      ] satisfies readonly DependencyGraphEdge[],
      mcapMap: new Map([
        ["usdc-circle", 100_000_000_000],
      ]),
    });

    expect(model.hubs).toHaveLength(1);
    expect(model.hubs[0]?.hubMcapUsd).toBe(100_000_000_000);
    expect(model.hubs[0]?.uniqueDependentMcapUsd).toBe(0);
    expect(model.uniqueDependentMcapUsd).toBe(0);
  });

  it("weights native V9 edges by kind and keeps materiality in the breakdown", () => {
    const model = buildDependencyHubsModel({
      cards: V9_CARDS,
      edges: [
        { from: "usdc-circle", to: "dai-maker", kind: "serial", materiality: "serial", weight: null, upstreamScore: 80 },
        {
          from: "usdc-circle",
          to: "frax-france",
          kind: "basket",
          materiality: "basket-weighted",
          weight: 0.4,
          upstreamScore: 70,
        },
        {
          from: "usdc-circle",
          to: "usdp-paxos",
          kind: "basket",
          materiality: "basket-bounded-unknown",
          weight: null,
          upstreamScore: null,
        },
      ] satisfies readonly V9Edge[],
      mcapMap: new Map([["usdc-circle", 100]]),
    });

    const hub = model.hubs[0];
    expect(hub?.dependentCount).toBe(3);
    // serial edges count as a full dependency, weighted baskets use their
    // weight, and a bounded-unknown basket without a weight contributes zero.
    expect(hub?.summedDirectDependencyWeight).toBeCloseTo(1.4);
    expect(model.summedDirectDependencyWeight).toBeCloseTo(1.4);
    expect(hub?.edgeTypeBreakdown).toEqual([
      { type: "basket-bounded-unknown", edgeCount: 1, summedDirectDependencyWeight: 0 },
      { type: "basket-weighted", edgeCount: 1, summedDirectDependencyWeight: 0.4 },
      { type: "serial", edgeCount: 1, summedDirectDependencyWeight: 1 },
    ]);
  });

  it("counts a dependent shared by two hubs once globally and once per hub", () => {
    const model = buildDependencyHubsModel({
      cards: V9_CARDS,
      edges: [
        { from: "usdc-circle", to: "dai-maker", kind: "serial", materiality: "serial", weight: null, upstreamScore: 80 },
        {
          from: "frax-france",
          to: "dai-maker",
          kind: "serial",
          materiality: "serial",
          weight: null,
          upstreamScore: 60,
        },
      ] satisfies readonly V9Edge[],
      mcapMap: new Map([
        ["usdc-circle", 100],
        ["frax-france", 2],
        ["dai-maker", 5],
      ]),
    });

    expect(model.directEdgeCount).toBe(2);
    expect(model.uniqueDirectDependentCount).toBe(1);
    expect(model.uniqueDependentMcapUsd).toBe(5);
    expect(model.upstreamHubCount).toBe(2);
    for (const hub of model.hubs) {
      expect(hub.dependentCount, hub.id).toBe(1);
      expect(hub.uniqueDependentMcapUsd, hub.id).toBe(5);
    }
  });

  it("ranks more dependents above heavier weight and caps examples at three", () => {
    const model = buildDependencyHubsModel({
      cards: [
        { id: "hub-a", name: "Hub A", symbol: "HUBA", isDefunct: false },
        { id: "hub-b", name: "Hub B", symbol: "HUBB", isDefunct: false },
        { id: "dep-1", name: "Dep One", symbol: "D1", isDefunct: false },
        { id: "dep-2", name: "Dep Two", symbol: "D2", isDefunct: false },
        { id: "dep-3", name: "Dep Three", symbol: "D3", isDefunct: false },
        { id: "dep-4", name: "Dep Four", symbol: "D4", isDefunct: false },
      ],
      edges: [
        { from: "hub-a", to: "dep-1", weight: 0.1, type: "collateral" },
        { from: "hub-a", to: "dep-2", weight: 0.1, type: "collateral" },
        { from: "hub-a", to: "dep-3", weight: 0.1, type: "collateral" },
        { from: "hub-a", to: "dep-4", weight: 0.1, type: "collateral" },
        { from: "hub-b", to: "dep-1", weight: 0.9, type: "collateral" },
        { from: "hub-b", to: "dep-2", weight: 0.9, type: "collateral" },
        { from: "hub-b", to: "dep-3", weight: 0.9, type: "collateral" },
      ] satisfies readonly DependencyGraphEdge[],
      mcapMap: new Map([
        ["dep-1", 40],
        ["dep-2", 30],
        ["dep-3", 20],
        // Non-finite and non-positive market caps contribute nothing.
        ["dep-4", Number.NaN],
        ["hub-a", -5],
        ["hub-b", 7],
      ]),
    });

    expect(model.hubs.map((hub) => hub.id)).toEqual(["hub-a", "hub-b"]);
    expect(model.hubs[0]?.dependentCount).toBe(4);
    expect(model.hubs[0]?.examples.map((example) => example.symbol)).toEqual(["D1", "D2", "D3"]);
    expect(model.hubs[0]?.uniqueDependentMcapUsd).toBe(90);
    expect(model.hubs[0]?.hubMcapUsd).toBe(0);
    expect(model.hubs[1]?.hubMcapUsd).toBe(7);
    expect(model.uniqueDependentMcapUsd).toBe(90);
  });

  it("breaks equal dependent counts by summed weight, then dependent market cap", () => {
    const model = buildDependencyHubsModel({
      cards: [
        { id: "hub-x", name: "Hub X", symbol: "HUBX", isDefunct: false },
        { id: "hub-y", name: "Hub Y", symbol: "HUBY", isDefunct: false },
        { id: "hub-z", name: "Hub Z", symbol: "HUBZ", isDefunct: false },
        { id: "dep-x", name: "Dep X", symbol: "DEPX", isDefunct: false },
        { id: "dep-y", name: "Dep Y", symbol: "DEPY", isDefunct: false },
        { id: "dep-z", name: "Dep Z", symbol: "DEPZ", isDefunct: false },
      ],
      edges: [
        { from: "hub-x", to: "dep-x", weight: 0.5, type: "collateral" },
        { from: "hub-y", to: "dep-y", weight: 0.5, type: "collateral" },
        { from: "hub-z", to: "dep-z", weight: 0.9, type: "collateral" },
      ] satisfies readonly DependencyGraphEdge[],
      mcapMap: new Map([
        ["dep-x", 10],
        ["dep-y", 50],
        ["dep-z", 1],
      ]),
    });

    expect(model.hubs.map((hub) => hub.id)).toEqual(["hub-z", "hub-y", "hub-x"]);
  });
});
