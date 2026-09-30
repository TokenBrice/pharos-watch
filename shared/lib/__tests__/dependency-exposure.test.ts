import { describe, expect, it } from "vitest";
import snapshot from "../../test-utils/fixtures/dependency-graph-2026-09-29.json";
import { buildDirectHubExposures, edgeShare, mappedDependentSupply, v9DependencyEdgeScoreKnown, type ExposureOptions, type SupplyOf } from "../dependency-exposure";
import type { ReportCardsV9DependencyEdge } from "../../types/report-cards-v9";

const opts: ExposureOptions = {
  sharedBooks: { bookIdOf: () => null, measuredHoldingUsd: () => null },
  familyOf: id => id === "wrapper" ? "parent" : id,
  wrapperFormOf: id => id === "vault" ? "vault-claim" : "pass-through",
};
const edge = (from: string, to: string, kind: "serial" | "basket", weight: number | null): ReportCardsV9DependencyEdge => ({ from, to, kind, weight, materiality: kind === "serial" ? "serial" : "basket-weighted", upstreamScore: 80 });
const supply: SupplyOf = id => id === "missing" ? null : { usd: 100, asOf: null, basis: "market-cap-proxy" };

describe("direct dependency exposure", () => {
  it("ranks the captured full graph by USD rather than clone-family counts", () => {
    const edges = snapshot.edges as ReportCardsV9DependencyEdge[];
    const mcaps = new Map<string, number | null>(Object.entries(snapshot.supplyUsdById));
    const supplyOf: SupplyOf = id => { const usd = mcaps.get(id); return usd == null ? null : { usd, asOf: snapshot.asOfSec, basis: "market-cap-proxy" }; };
    const hubs = buildDirectHubExposures(edges, supplyOf, opts);
    expect(hubs[0].hubId).toBe("usds-sky");
    expect(hubs[0].direct.knownUsd).toBeCloseTo(4_795_333_141.296759, 2);
    expect(hubs[1].hubId).toBe("usdc-circle");
    expect(hubs[1].direct.knownUsd).toBeCloseTo(2_601_092_165.060186, 2);
    expect(hubs[0].topDependent?.shareOfHubExposure).toBeCloseTo(0.95916, 4);
    expect(hubs.slice(0, 6).map(hub => hub.hubId)).not.toContain("eurc-circle");
    expect(hubs.slice(0, 6).map(hub => hub.hubId)).not.toContain("europ-schuman");
    const gross = mappedDependentSupply(edges, supplyOf, opts);
    expect(gross.knownUsd).toBeCloseTo(13_978_503_982.307657, 2);
    expect(gross.overlapUsd).toBeCloseTo(1_087_888_787.0975633, 2);
  });

  it("counts multiple serial parents once and separates own-family wrapper and vault claims", () => {
    const edges = [edge("parent", "wrapper", "serial", null), edge("other", "wrapper", "serial", null), edge("parent", "vault", "serial", null)];
    const total = mappedDependentSupply(edges, supply, opts);
    expect(total.knownUsd).toBe(200);
    expect(total.passThroughUsd).toBe(100);
    expect(total.vaultClaimUsd).toBe(100);
    const parent = buildDirectHubExposures(edges, supply, opts).find(hub => hub.hubId === "parent")!;
    expect(parent.ownFamilyUsd).toBe(100);
    expect(parent.vaultClaimUsd).toBe(100);
    expect(parent.dependentCount).toBe(2);
  });

  it("excludes unknown supply and unknown shares without losing dependents", () => {
    const edges = [edge("parent", "missing", "serial", null), edge("parent", "unknown-share", "basket", null), edge("parent", "zero", "basket", 0)];
    const hub = buildDirectHubExposures(edges, supply, opts)[0];
    expect(hub.dependentCount).toBe(3);
    expect(hub.direct.excludedSupplyUnknownIds).toEqual(["missing"]);
    expect(hub.direct.unknownShareEdgeCount).toBe(1);
    expect(hub.direct.knownUsd).toBe(0);
    expect(hub.direct.complete).toBe(false);
    expect(mappedDependentSupply(edges, supply, opts).excludedSupplyUnknownIds).toEqual(["missing"]);
  });

  it("treats an observed zero supply as available rather than excluded", () => {
    const total = mappedDependentSupply([edge("parent", "child", "serial", null)], () => ({ usd: 0, asOf: null, basis: "market-cap-proxy" }), opts);
    expect(total.knownUsd).toBe(0);
    expect(total.excludedSupplyUnknownIds).toEqual([]);
    expect(total.complete).toBe(true);
  });

  it("flags excess basket shares without publishing a silently clamped statistic", () => {
    const edges = [edge("a", "dependent", "basket", 0.8), edge("b", "dependent", "basket", 0.4)];
    const total = mappedDependentSupply(edges, supply, opts);
    expect(total.integrityFlag).toBe(true);
    expect(total.complete).toBe(false);
    expect(total.knownUsd).toBeCloseTo(120);
    expect(buildDirectHubExposures(edges, supply, opts).every(hub => hub.direct.integrityFlag)).toBe(true);
    expect(mappedDependentSupply([edge("a", "dependent", "basket", 1.0000005)], supply, opts).integrityFlag).toBe(false);
  });

  it("retains a known basket share when the upstream is unrateable", () => {
    const blocked = { ...edge("parent", "dependent", "basket", 0.4), materiality: "basket-bounded-unknown" as const, upstreamScore: null };
    expect(edgeShare(blocked)).toBe(0.4);
    expect(v9DependencyEdgeScoreKnown(blocked)).toBe(false);
    expect(buildDirectHubExposures([blocked], supply, opts)[0].direct.knownUsd).toBe(40);
  });

  it("counts only the upstream mapped fraction as repeated-layer exposure", () => {
    const edges = [edge("root", "parent", "basket", 0.1), edge("parent", "wrapper", "serial", null)];
    expect(mappedDependentSupply(edges, supply, opts).knownUsd).toBe(110);
    expect(mappedDependentSupply(edges, supply, opts).overlapUsd).toBe(10);
  });

  it("counts each measured shared-book holding once per upstream in both totals", () => {
    const edges = [
      edge("usdc", "dai", "basket", 0.4), edge("usdc", "usds", "basket", 0.4),
      edge("other", "dai", "basket", 0.2), edge("other", "usds", "basket", 0.2),
    ];
    const sharedOpts: ExposureOptions = { ...opts, sharedBooks: {
      bookIdOf: id => id === "dai" || id === "usds" ? "sky" : null,
      measuredHoldingUsd: (_book, upstream) => upstream === "usdc" ? 50 : 20,
    } };
    const total = mappedDependentSupply(edges, supply, sharedOpts);
    expect(total.knownUsd).toBe(70);
    expect(total.complete).toBe(true);
    const hubs = buildDirectHubExposures(edges, supply, sharedOpts);
    expect(hubs.find(hub => hub.hubId === "usdc")?.direct.knownUsd).toBe(50);
    expect(hubs.find(hub => hub.hubId === "other")?.direct.knownUsd).toBe(20);
    expect(hubs[0].dependentCount).toBe(2);
  });

  it("falls back to weight times member supply when a book holding is not published", () => {
    const edges = [edge("usdc", "dai", "basket", 0.4), edge("usdc", "usds", "basket", 0.4)];
    const sharedOpts: ExposureOptions = { ...opts, sharedBooks: {
      bookIdOf: () => "sky", measuredHoldingUsd: () => null,
    } };
    const supplyOf: SupplyOf = id => ({ usd: id === "dai" ? 100 : 200, asOf: null, basis: "market-cap-proxy" });
    expect(mappedDependentSupply(edges, supplyOf, sharedOpts).knownUsd).toBe(120);
    expect(buildDirectHubExposures(edges, supplyOf, sharedOpts)[0].direct.knownUsd).toBe(120);
  });
});
