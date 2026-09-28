import { describe, expect, it } from "vitest";
import { mockD1 } from "@shared/test-utils/mock-d1";
import type { DigestInputData, DigestNextTrigger } from "@shared/types/digest";
import { collectActiveDepegs, collectResolvedDepegs } from "../collectors-market";
import { collectDewsStress, collectYieldAnomalies } from "../collectors-risk";
import { buildChangeSummary } from "../digest-change-summary";
import { buildForwardLookOutcomes, buildNextTriggers } from "../digest-next-triggers";
import type { DigestEvidence } from "../digest-evidence";
import { makeCollectorCtx, makePublishedDewsTables } from "../../__tests__/daily-digest.test-support";

function input(at: number, current = true): DigestInputData {
  return {
    totalMcapUsd: 1e9, mcap7dDelta: 0, activeDepegCount: 1, biggestSupplyChange: null, stabilityIndex: null, yesterdayIndex: null,
    dataQuality: { generatedAt: at, stablecoinsCacheUpdatedAt: at, stablecoinsCacheAgeSec: 0, windows: { blacklistActivity: { label: "24h", start: at - 86400, end: at }, mintBurnFlows: { label: "24h", start: at - 86400, end: at }, supplyVelocity: { label: "UTC", dates: [] }, psi: { label: "latest", sampleAt: at, dailySnapshotAt: null } } },
    topDepegs: [{ stablecoinId: "usdt-tether", symbol: "USDT", bps: -900, startedAt: 1, direction: "below", mcapUsd: 1e9, pegReference: 1, severityBasis: current ? "current" : "peak-fallback", ...(current ? { currentBps: at === 200000 ? -200 : -100, priceObservedAt: at } : {}) }],
    editorialCandidates: [{ id: "depeg:usdt-tether:active", kind: "depeg", title: "USDT depeg", symbols: ["USDT"], impactScore: 10, novelty: "recurring", confidence: "high", artifactRisk: "low", headlineFacts: [], whyItMatters: "Peg stress" }],
  };
}
const trigger: DigestNextTrigger = { id: "trigger:depeg:usdt-tether", stablecoinId: "usdt-tether", symbol: "USDT", metric: "depeg-bps", comparator: "abs-gte", thresholdValue: 150, thresholdLabel: "150 bps", label: "Widening", rationale: "Stress", detail: "Widening" };

describe("canonical comparable digest evidence", () => {
  it.each([[true, false], [false, true], [false, false], [true, true]])("compares current=%s to current=%s without borrowing the peak", (before, after) => {
    const previous = { ...input(113600, before), nextTriggers: [trigger] };
    const current = input(200000, after);
    const summary = buildChangeSummary(current, previous);
    expect(summary.worsenedSignals.some((row) => row.kind === "depeg")).toBe(before && after);
    expect(buildForwardLookOutcomes(current, previous)[0].status).toBe(before && after ? "hit" : "unavailable");
    if (!after) expect(buildNextTriggers(current, previous).some((row) => row.metric === "depeg-bps")).toBe(false);
  });

  it.each(["reference", "event", "stale", "legacy"])("withholds a %s mismatch", (kind) => {
    const previous = { ...input(113600), nextTriggers: [trigger] };
    const current = input(200000);
    if (kind === "reference") current.topDepegs[0].pegReference = 2;
    if (kind === "event") current.topDepegs[0].startedAt = 2;
    if (kind === "stale") current.topDepegs[0].priceObservedAt = 1;
    if (kind === "legacy") delete previous.topDepegs[0].priceObservedAt;
    expect(buildForwardLookOutcomes(current, previous)[0].status).toBe("unavailable");
    expect(buildChangeSummary(current, previous).worsenedSignals).toEqual([]);
  });

  it("looks beyond the prompt cap without inventing recovery", async () => {
    const rows = Array.from({ length: 9 }, (_, index) => ({ stablecoin_id: index === 8 ? "usdt-tether" : `coin-${index}`, symbol: index === 8 ? "USDT" : `C${index}`, direction: "below", peak_deviation_bps: -900, started_at: 1, peg_reference: 1 }));
    const ctx = makeCollectorCtx(mockD1([{ match: "FROM depeg_events", rows }]));
    ctx.evidence = {};
    ctx.trackedStablecoinIds = new Set(rows.map((row) => row.stablecoin_id));
    ctx.mcapById = new Map(rows.map((row, index) => [row.stablecoin_id, (10 - index) * 1e9]));
    const collected = await collectActiveDepegs(ctx);
    expect(collected.value.topDepegs.some((row) => row.stablecoinId === "usdt-tether")).toBe(false);
    expect(ctx.evidence.activeDepegs?.some((row) => row.stablecoinId === "usdt-tether")).toBe(true);
    const previous = { ...input(113600), nextTriggers: [trigger] };
    const current = { ...input(200000), topDepegs: collected.value.topDepegs, editorialCandidates: [] };
    expect(buildChangeSummary(current, previous, ctx.evidence).resolvedSignals).toEqual([]);
    expect(buildForwardLookOutcomes(current, previous, ctx.evidence)[0].status).toBe("unavailable");
  });

  it.each(["recovered-primary", "coverage-lost-supply"])("requires positive closure: %s", async (closeReason) => {
    const ctx = makeCollectorCtx(mockD1([{ match: "FROM depeg_events", rows: [{ stablecoin_id: "usdt-tether", symbol: "USDT", direction: "below", peak_deviation_bps: -900, started_at: 1, ended_at: 199999, close_reason: closeReason, recovery_price: closeReason === "recovered-primary" ? 1 : null }] }]));
    ctx.evidence = {};
    await collectResolvedDepegs(ctx);
    const current = { ...input(200000), topDepegs: [], editorialCandidates: [] };
    const previous = { ...input(113600), nextTriggers: [trigger] };
    expect(buildChangeSummary(current, previous, ctx.evidence).resolvedSignals.length).toBe(closeReason === "recovered-primary" ? 1 : 0);
    expect(buildForwardLookOutcomes(current, previous, ctx.evidence)[0].status).toBe(closeReason === "recovered-primary" ? "missed" : "unavailable");
  });

  it("reads sixth DEWS from canonical state and excludes failed/cap-excluded evidence", async () => {
    const dewsTrigger = { ...trigger, metric: "dews-band" as const, comparator: "band-gte" as const, thresholdValue: 2 };
    const previous: DigestInputData = { ...input(113600), nextTriggers: [dewsTrigger] };
    const now = Math.floor(Date.now() / 1000);
    const rows = Array.from({ length: 6 }, (_, index) => ({ stablecoin_id: index === 5 ? "usdt-tether" : `coin-${index}`, score: 70 - index, band: "ALERT", computed_at: now, signals_json: "{}" }));
    const dewsCtx = makeCollectorCtx(mockD1([
      ...makePublishedDewsTables(rows),
      { match: "FROM stress_signal_history WHERE snapshot_date = ?", rows: [] },
    ]));
    const base = dewsCtx.trackedStablecoinAssets[0];
    dewsCtx.trackedStablecoinAssets = rows.map((row, index) => ({ ...base, id: row.stablecoin_id, symbol: index === 5 ? "USDT" : `C${index}` }));
    dewsCtx.trackedStablecoinIds = new Set(rows.map((row) => row.stablecoin_id));
    dewsCtx.stablecoinAssetById = new Map(dewsCtx.trackedStablecoinAssets.map((coin) => [coin.id, coin]));
    const evidence: DigestEvidence = {};
    dewsCtx.evidence = evidence;
    const dews = await collectDewsStress(dewsCtx);
    expect(dews.value?.elevatedCoins.some((coin) => coin.symbol === "USDT")).toBe(false);
    expect(buildForwardLookOutcomes(input(200000), previous, evidence)[0].status).toBe("hit");
    expect(buildForwardLookOutcomes(input(200000), previous, {})[0].status).toBe("unavailable");
    const ctx = makeCollectorCtx(mockD1([{ match: "FROM yield_data", rows: [{ stablecoin_id: "usdt-tether", symbol: "USDT", current_apy: 501, apy_7d: 2, apy_30d: 2, warning_signals: '["spike"]' }] }]));
    ctx.evidence = {};
    await collectYieldAnomalies(ctx);
    previous.nextTriggers = [{ ...trigger, metric: "yield-apy", comparator: "lte", thresholdValue: 3 }];
    expect(buildForwardLookOutcomes(input(200000), previous, ctx.evidence)[0].status).toBe("unavailable");
  });

  it("never resolves or scores an unavailable active-event query", async () => {
    const ctx = makeCollectorCtx(mockD1([{ match: "FROM depeg_events", rows: [], throwError: new Error("unavailable") }]));
    ctx.evidence = {};
    await collectActiveDepegs(ctx);
    const previous = { ...input(113600), nextTriggers: [trigger] };
    const current = { ...input(200000), topDepegs: [], editorialCandidates: [] };
    expect(buildChangeSummary(current, previous, ctx.evidence).resolvedSignals).toEqual([]);
    expect(buildForwardLookOutcomes(current, previous, ctx.evidence)[0].status).toBe("unavailable");
  });
});
