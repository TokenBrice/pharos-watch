import { describe, expect, it } from "vitest";
import snapshot from "../../test-utils/fixtures/dependency-graph-2026-09-29.json";
import { buildDirectHubExposures, edgeShare, exposureFootprint, lookThroughShares, mappedDependentSupply, v9DependencyEdgeScoreKnown, type ExposureOptions, type SupplyOf } from "../dependency-exposure";
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

describe("look-through dependency exposure", () => {
  const capturedEdges = snapshot.edges as ReportCardsV9DependencyEdge[];
  const capturedSupply: SupplyOf = id => {
    const usd = (snapshot.supplyUsdById as Record<string, number>)[id];
    return usd == null ? null : { usd, asOf: snapshot.asOfSec, basis: "market-cap-proxy" };
  };

  it("looks through the captured Yuzu basket and passes Spark's worst serial parent once", () => {
    expect(lookThroughShares(["usde-ethena"], capturedEdges).get("syzusd-yuzu")?.share).toBeCloseTo(0.52906, 5);
    const spark = [edge("usdc-circle", "susdc-spark", "serial", null), edge("usds-sky", "susdc-spark", "serial", null)];
    for (const roots of [["usdc-circle"], ["usds-sky"], ["usdc-circle", "usds-sky"]]) {
      expect(lookThroughShares(roots, spark).get("susdc-spark")).toEqual({ share: 1, minHop: 1, integrityFlag: false });
      expect(exposureFootprint(roots, spark, supply, opts).direct.knownUsd).toBe(100);
    }
  });

  it("keeps excess shares visible and marks the totals incomplete", () => {
    const edges = [edge("root", "coin", "basket", 0.7), edge("other", "coin", "basket", 0.6)];
    const share = lookThroughShares(["root", "other"], edges).get("coin")!;
    expect(share.share).toBeCloseTo(1.3);
    expect(share.minHop).toBe(1);
    expect(share.integrityFlag).toBe(true);
    const result = exposureFootprint(["root", "other"], edges, supply, opts);
    expect(result.direct.knownUsd).toBeCloseTo(130);
    expect(result.direct.integrityFlag).toBe(true);
    expect(result.direct.complete).toBe(false);
  });

  it("counts a diamond once and bounds paths without changing full-graph totals", () => {
    const edges = [edge("root", "a", "serial", null), edge("root", "b", "serial", null),
      edge("a", "coin", "basket", 0.4), edge("b", "coin", "basket", 0.2)];
    const result = exposureFootprint(["root"], edges, supply, opts);
    expect(result.reached).toBe(3);
    expect(result.direct.knownUsd).toBe(200);
    expect(result.indirect.knownUsd).toBeCloseTo(60);
    expect(result.indirect.overlapUsd).toBeCloseTo(60);
    expect(result.rows.find(row => row.id === "coin")?.paths).toEqual([["root", "a", "coin"], ["root", "b", "coin"]]);
    const bounded = exposureFootprint(["root"], edges, supply, { ...opts, topPaths: 1 });
    expect(bounded.direct).toEqual(result.direct);
    expect(bounded.indirect).toEqual(result.indirect);
    expect(bounded.rows.find(row => row.id === "coin")?.paths).toEqual([["root", "a", "coin"]]);
  });

  it("lists unknown supply without treating it as zero and preserves materiality unknowns", () => {
    const blocked = { ...edge("root", "missing", "basket", 0.2), materiality: "basket-bounded-unknown" as const };
    const result = exposureFootprint(["root"], [blocked], supply, opts);
    expect(result.rows).toEqual([{ id: "missing", minHop: 1, share: 0.2, band: "material", exposureUsd: null, scoreUnknown: true, paths: [["root", "missing"]] }]);
    expect(result.direct.excludedSupplyUnknownIds).toEqual(["missing"]);
    expect(result.direct.knownUsd).toBe(0);
    expect(result.direct.complete).toBe(false);
  });

  it("excludes null basket weights from the known sum and flags the dependent", () => {
    const edges = [edge("root", "coin", "basket", null), edge("root", "coin", "basket", 0.02)];
    expect(lookThroughShares(["root"], edges).get("coin")).toEqual({ share: null, minHop: 1, integrityFlag: true });
    const result = exposureFootprint(["root"], edges, supply, opts);
    expect(result.direct.knownUsd).toBe(0);
    expect(result.direct.unknownShareEdgeCount).toBe(1);
    expect(result.rows[0].band).toBe("unknown");
    expect(result.rows[0].exposureUsd).toBeNull();
    const descendant = exposureFootprint(["root"], [...edges, edge("coin", "child", "serial", null)], supply, opts);
    expect(descendant.rows.find(row => row.id === "child")?.share).toBeNull();
    expect(descendant.indirect.complete).toBe(false);
  });

  it("terminates cycles, marks only their shares unknown, and propagates uncertainty", () => {
    const edges = [edge("root", "a", "serial", null), edge("a", "b", "serial", null),
      edge("b", "a", "serial", null), edge("b", "descendant", "serial", null)];
    const shares = lookThroughShares(["root"], edges);
    expect(shares.get("a")).toEqual({ share: null, minHop: 1, integrityFlag: true });
    expect(shares.get("b")).toEqual({ share: null, minHop: 2, integrityFlag: true });
    expect(shares.get("descendant")?.share).toBeNull();
    const result = exposureFootprint(["root"], edges, supply, opts);
    expect(result.bandCounts.unknown).toBe(3);
    expect(result.rows.every(row => row.exposureUsd === null)).toBe(true);
    expect(result.direct.complete).toBe(false);
    expect(result.indirect.complete).toBe(false);
  });

  it("forms a joint root union without counting sUSDe as a dependent again", () => {
    const single = exposureFootprint(["usde-ethena"], capturedEdges, capturedSupply, opts);
    const joint = exposureFootprint(["usde-ethena", "susde-ethena"], capturedEdges, capturedSupply, opts);
    expect(joint.rows.some(row => row.id === "usde-ethena" || row.id === "susde-ethena")).toBe(false);
    expect(new Set(joint.rows.map(row => row.id)).size).toBe(joint.reached);
    expect(joint.reached).toBe(single.reached - 1);
  });

  it("reconciles the Sky shared holding once, including across hop buckets", () => {
    const edges = [edge("root", "bridge", "serial", null), edge("root", "dai", "basket", 0.4), edge("bridge", "usds", "basket", 0.4)];
    const sharedOpts: ExposureOptions = { ...opts, sharedBooks: {
      bookIdOf: id => id === "dai" || id === "usds" ? "sky" : null,
      measuredHoldingUsd: (_book, upstream) => upstream === "root" || upstream === "bridge" ? 30 : null,
    } };
    const result = exposureFootprint(["root"], edges, supply, sharedOpts);
    expect(result.direct.knownUsd).toBe(130);
    expect(result.indirect.knownUsd).toBe(30);
    expect(result.indirect.overlapUsd).toBe(30);
    const sameUpstream = [edge("root", "dai", "basket", 0.4), edge("root", "usds", "basket", 0.4)];
    expect(exposureFootprint(["root"], sameUpstream, supply, sharedOpts).direct.knownUsd).toBe(30);
  });
});

describe("exposure band boundaries", () => {
  it("uses material, minor, trace and unknown bands without using upstream scores as availability", () => {
    const edges = [edge("root", "material", "basket", 0.1), edge("root", "minor", "basket", 0.01),
      edge("root", "trace", "basket", 0.009), edge("root", "unknown", "basket", null)];
    const result = exposureFootprint(["root"], edges, supply, opts);
    expect(Object.fromEntries(result.rows.map(row => [row.id, row.band]))).toEqual({ material: "material", minor: "minor", trace: "trace", unknown: "unknown" });
    expect(result.bandCounts).toEqual({ material: 1, minor: 1, trace: 1, unknown: 1 });
    expect(result.rows.every(row => !row.scoreUnknown)).toBe(true);
  });
});

describe("exposure uncertainty and reach", () => {
  it("excludes known-zero rows and their zero-share descendants from reach and bands", () => {
    const result = exposureFootprint(["root"], [
      edge("root", "zero", "basket", 0), edge("zero", "child", "serial", null),
      edge("root", "positive", "basket", 0.2),
    ], supply, opts);
    expect(result.rows.map(row => row.id)).toEqual(["positive"]);
    expect(result.reached).toBe(1);
    expect(result.bandCounts).toEqual({ material: 1, minor: 0, trace: 0, unknown: 0 });
    expect(result.direct.knownUsd).toBe(20);
    expect(result.indirect.knownUsd).toBe(0);
  });

  it("does not fabricate zero-weight paths through unknown basket edges", () => {
    const result = exposureFootprint(["root"], [
      edge("root", "unknown", "basket", null), edge("unknown", "child", "serial", null),
    ], supply, opts);
    expect(result.rows.map(row => [row.id, row.share, row.paths])).toEqual([
      ["unknown", null, []], ["child", null, []],
    ]);
  });

  it("derives scoreUnknown from all incoming edge materialities, not reaching shares", () => {
    const result = exposureFootprint(["root"], [
      edge("root", "coin", "basket", 0.2),
      { ...edge("unreached", "coin", "basket", 0.1), materiality: "basket-bounded-unknown" },
    ], supply, opts);
    expect(result.rows[0].share).toBe(0.2);
    expect(result.rows[0].scoreUnknown).toBe(true);
  });
});
