import { describe, expect, it } from "vitest";
import { canonicalExitRouteScopedKey } from "@shared/types/exit-route-identity";
import { DexLiquidityCronMetadataSchema } from "../../../lib/schemas";
import { makeDexRouteHoldFixture, makeDexRouteObservation } from "../../__tests__/dex-liquidity-persistence.test-support";
import { selectStillFreshDexRouteSetHold } from "../persistence";
import { collectDexRoutePackingOmissions, selectDexRouteObservations } from "../dex-route-observation-selection";
import { makePool } from "./scoring-test-builders";
import { addDexRouteTurnover, boundMeasuredTargetFunnelGroups, boundTelemetryEntries, buildDexRouteTurnover, getMeasuredTargetFunnelGroup, measuredPoolProfileIds, projectDexRecoveryStageResult, summarizeMeasuredTargetFunnel, type ExitRouteSelection, type MeasuredTargetFunnelGroup } from "../route-telemetry";

function summary(): ExitRouteSelection {
  return { baselineAvailable: true, baselineUnavailableReason: null, comparedCoins: 0, unavailableCoins: 0, changedCoins: 0, routesAdded: 0, routesRemoved: 0, removalReasons: {}, topCoins: [], topCoinsOmitted: 0 };
}

describe("telemetry byte bounds", () => {
  it("bounds UTF-8 bytes, not string character counts, with a complete prefix", () => {
    const entries = [{ reason: "é".repeat(20) }, { reason: "é".repeat(20) }];
    const maxBytes = new TextEncoder().encode(JSON.stringify(entries.slice(0, 1))).byteLength + 1;
    expect(boundTelemetryEntries(entries, 64, maxBytes)).toEqual(entries.slice(0, 1));
  });

  it("re-bounds enriched counters and preserves prior omissions without double counting", () => {
    const groups = new Map<string, MeasuredTargetFunnelGroup>();
    const group = getMeasuredTargetFunnelGroup(groups, "uniswap-v3-quoter-v2", "ethereum");
    group.candidates = 3;
    const paddingBytes = 12_280 - new TextEncoder().encode(JSON.stringify([group])).byteLength;
    group.dropReasons["x".repeat(paddingBytes)] = 1;
    getMeasuredTargetFunnelGroup(groups, "uniswap-v3-quoter-v2", "base").candidates = 1;
    getMeasuredTargetFunnelGroup(groups, "uniswap-v3-quoter-v2", "arbitrum").candidates = 1;
    const funnel = summarizeMeasuredTargetFunnel(groups);
    expect(funnel.groups).toHaveLength(1);
    expect(funnel.groupsOmitted).toBe(2);

    funnel.groups[0]!.enriched = 999_999_999_999_999;
    expect(new TextEncoder().encode(JSON.stringify(funnel.groups)).byteLength).toBeGreaterThan(12_288);
    boundMeasuredTargetFunnelGroups(funnel);
    expect(new TextEncoder().encode(JSON.stringify(funnel.groups)).byteLength).toBeLessThanOrEqual(12_288);
    expect(funnel.groups).toEqual([]);
    expect(funnel.groupsOmitted).toBe(3);
    boundMeasuredTargetFunnelGroups(funnel);
    expect(funnel.groupsOmitted).toBe(3);
  });
});

describe("measured target funnel", () => {
  it("names descriptor-free V4 candidates from the real protocol, not discovery pool type", () => {
    expect(measuredPoolProfileIds(makePool({ project: "uniswap-v4", poolType: "cg-concentrated" }))).toHaveLength(1);
    expect(measuredPoolProfileIds(makePool({ project: "curve", poolType: "curve-stableswap" }))).toEqual([]);
  });

  it("aggregates adapter-chain populations without silently dropping omitted groups", () => {
    const groups = new Map<string, MeasuredTargetFunnelGroup>();
    for (let i = 0; i < 70; i++) getMeasuredTargetFunnelGroup(groups, "uniswap-v3-quoter-v2", `chain-${i}`).candidates = i + 1;
    const existing = getMeasuredTargetFunnelGroup(groups, "uniswap-v3-quoter-v2", "chain-69");
    existing.descriptorResolved = 50;
    existing.retained = 60;
    existing.activeTargets = 48;
    existing.dropReasons["missing-descriptor"] = 10;
    const funnel = summarizeMeasuredTargetFunnel(groups);
    expect(funnel.groups).toHaveLength(64);
    expect(funnel.groupsOmitted).toBe(6);
    expect(funnel.groups[0]).toMatchObject({ candidates: 70, descriptorResolved: 50, retained: 60, activeTargets: 48, dropReasons: { "missing-descriptor": 10 } });
    expect(DexLiquidityCronMetadataSchema.parse({ measuredTargetFunnel: funnel }).measuredTargetFunnel).toEqual(funnel);
  });
});

describe("route turnover attribution", () => {
  it("partitions removals with exact evidence and does not infer causes from absent evidence", () => {
    const previous = ["packed", "missing", "invalid", "stale", "swap", "unknown"].map((id) => makeDexRouteObservation(id, 100_000, 100));
    const swap = previous[4]!;
    swap.output.assetKeys = ["ethereum:0xabc"];
    const current = [{ ...swap, routeId: "new-source" }];
    const reasons = new Map([
      [canonicalExitRouteScopedKey("Ethereum", "missing"), "target-missing"],
      [canonicalExitRouteScopedKey("Ethereum", "invalid"), "invalid-model:invalid-solidly-freshness"],
      [canonicalExitRouteScopedKey("Ethereum", "stale"), "quote-stale"],
    ]);
    const coin = buildDexRouteTurnover("usdt-tether", previous, current, { omittedRouteIds: new Set(["packed"]), poolReasons: reasons });
    expect(coin).toEqual({ stablecoinId: "usdt-tether", routesAdded: 1, routesRemoved: 6, removalReasons: {
      "payload-overflow": 1, "target-missing": 1, "invalid-model:invalid-solidly-freshness": 1,
      "quote-stale": 1, "representative-change": 1, unknown: 1,
    } });
    expect(buildDexRouteTurnover("usdt-tether", [previous[1]!], []).removalReasons).toEqual({ unknown: 1 });
  });

  it("records final packing omissions including concentration limits", () => {
    const routes = Array.from({ length: 10 }, (_, i) => makeDexRouteObservation(`route-${i}`, 1_000_000 - i, 100));
    const selected = selectDexRouteObservations(routes).observations;
    const omitted = collectDexRoutePackingOmissions(routes, selected);
    expect(selected).toHaveLength(7);
    expect(omitted.size).toBe(3);
    expect(buildDexRouteTurnover("usdc-circle", routes, selected, { omittedRouteIds: omitted, poolReasons: new Map() }).removalReasons).toEqual({ "payload-overflow": 3 });
  });

  it("bounds top coins while preserving population totals and omitted counts", () => {
    const result = summary();
    for (let i = 0; i < 30; i++) addDexRouteTurnover(result, { stablecoinId: `coin-${i}`, routesAdded: i, routesRemoved: 1, removalReasons: { unknown: 1 } });
    expect(result.topCoins).toHaveLength(25);
    expect(result.topCoinsOmitted).toBe(5);
    expect(result.routesRemoved).toBe(30);
    expect(result.routesAdded).toBe(435);
    expect(result.removalReasons).toEqual({ unknown: 30 });
    expect(result.topCoins[0]?.stablecoinId).toBe("coin-29");
  });
});

describe("continuity decision reasons", () => {
  it.each(["empty-candidate", "empty-previous", "invalid-previous", "prior-too-old", "prior-future", "capacity-below-floor", "not-collapsed", "ids-unchanged", "held"])("records %s without changing the hold policy", (reason) => {
    const f = makeDexRouteHoldFixture();
    let raw: string | null = f.previousRaw;
    if (reason === "empty-candidate") f.candidate.exitRouteObservations = [];
    if (reason === "empty-previous") raw = null;
    if (reason === "invalid-previous") raw = "{}";
    if (reason === "ids-unchanged") f.candidate.exitRouteObservations[0]!.routeId = f.previousObservation.routeId;
    if (reason === "prior-too-old" || reason === "prior-future") f.previousObservation.observedAt = f.nowSec + (reason === "prior-future" ? 1 : -3_601);
    if (reason === "capacity-below-floor") f.previousObservation = f.observation("old", 99_999, f.nowSec);
    if (reason === "not-collapsed") f.candidate.exitRouteObservations = [f.observation("new", 24_000_000, f.nowSec)];
    if (["prior-too-old", "prior-future", "capacity-below-floor"].includes(reason)) raw = JSON.stringify({ exitRouteObservations: [f.previousObservation], exitRouteObservationCoverage: f.coverage });
    const reasons: string[] = [];
    const held = selectStillFreshDexRouteSetHold(f.candidate, raw, f.nowSec, (decision) => reasons.push(decision));
    expect(reasons).toEqual([reason]);
    expect(held !== null).toBe(reason === "held");
    if (held) expect(held.observations[0]?.observedAt).toBe(f.previousObservation.observedAt);
  });
});

describe("recovered stage result forwarding", () => {
  it("preserves producer failure and capture telemetry without copying bulky or secret fields", () => {
    const targetEnrichment = [{ adapterProfileId: "uniswap-v3-quoter-v2", chain: "ethereum", candidates: 10, attempted: 3, enriched: 2, dropReasons: { "enrichment-cap": 7, "descriptor-builder-unresolved": 1 } }];
    const projected = projectDexRecoveryStageResult({ status: "degraded", itemCount: 4, metadata: JSON.stringify({ failedSources: ["univ3-subgraph:ethereum"], graphApiKeyConfigured: false, targetEnrichment, poolRejections: Array(100).fill({}), secret: "not-forwarded" }) });
    expect(projected).toEqual({ status: "degraded", itemCount: 4, metadata: { failedSources: ["univ3-subgraph:ethereum"], graphApiKeyConfigured: false, targetEnrichment } });
  });
});
