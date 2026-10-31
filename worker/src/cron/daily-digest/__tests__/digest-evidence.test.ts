import { describe, expect, it } from "vitest";
import { mockD1 } from "@shared/test-utils/mock-d1";
import { formatCurrency } from "@shared/lib/format";
import type { DigestEditorialCandidate, DigestInputData, DigestNextTrigger } from "@shared/types/digest";
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

  it("excludes reviewed disputes from active and resolved event counts while keeping the evidence rows", async () => {
    const verdicts = ["disputed", "false_positive", "confirmed", null] as const;
    const activeRows = verdicts.map((audit_verdict, index) => ({
      stablecoin_id: `coin-${index}`, symbol: `C${index}`, direction: "below", peak_deviation_bps: -900,
      started_at: 1, peg_reference: 1, peg_type: "peggedUSD", source: "live", audit_verdict,
    }));
    const activeCtx = makeCollectorCtx(mockD1([{ match: "FROM depeg_events", rows: activeRows }]));
    activeCtx.evidence = {};
    activeCtx.trackedStablecoinIds = new Set(activeRows.map((row) => row.stablecoin_id));
    activeCtx.mcapById = new Map(activeRows.map((row) => [row.stablecoin_id, 1e9]));
    const active = await collectActiveDepegs(activeCtx);
    expect(active.value.activeDepegCount).toBe(2);
    expect(activeCtx.evidence.activeDepegs).toHaveLength(4);

    const resolvedRows = verdicts.map((audit_verdict, index) => ({
      stablecoin_id: `coin-${index}`, symbol: `C${index}`, direction: "below", peak_deviation_bps: -900,
      started_at: 1, ended_at: 2, close_reason: "recovered-primary", recovery_price: 1, audit_verdict,
    }));
    const resolvedCtx = makeCollectorCtx(mockD1([{ match: "FROM depeg_events", rows: resolvedRows }]));
    resolvedCtx.evidence = {};
    resolvedCtx.trackedStablecoinIds = new Set(resolvedRows.map((row) => row.stablecoin_id));
    resolvedCtx.mcapById = new Map(resolvedRows.map((row) => [row.stablecoin_id, 1e9]));
    const resolved = await collectResolvedDepegs(resolvedCtx);
    expect(resolved.value.resolvedDepegCount).toBe(2);
    expect(resolvedCtx.evidence.recoveredDepegs).toHaveLength(4);
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

  it("evaluates a native-peg depeg under the six-hour event-native budget", async () => {
    const NATIVE_QUOTE_AGE_SEC = 20 * 60;
    const DAY_SECONDS = 86_400;
    const now = Math.floor(Date.now() / 1000);
    const collect = async (at: number, quote: number) => {
      const ctx = makeCollectorCtx(mockD1([{
        match: "FROM depeg_events",
        rows: [{
          stablecoin_id: "eurc-circle", symbol: "EURC", peg_type: "peggedEUR", source: "live",
          direction: "below", peak_deviation_bps: -800, started_at: now - 3 * DAY_SECONDS,
          start_price: 0.985, peak_price: 0.92, peg_reference: 1, quote_mode: "native-peg",
          current_native_quote: JSON.stringify({ value: quote, observedAt: at - NATIVE_QUOTE_AGE_SEC, source: "coingecko" }),
        }],
      }]));
      ctx.nowSec = at;
      ctx.trackedStablecoinIds = new Set([...ctx.trackedStablecoinIds, "eurc-circle"]);
      ctx.mcapById.set("eurc-circle", 250_000_000);
      const collected = await collectActiveDepegs(ctx);
      expect(collected.degradedReasons).toEqual([]);
      return collected.value.topDepegs;
    };

    // The collector admitted the quote under the six-hour native policy and
    // stamped it current; the same 20-minute-old observation must not be
    // rejected by the USD-reference 600 s budget downstream.
    const current = await collect(now, 0.92);
    expect(current[0]).toMatchObject({
      stablecoinId: "eurc-circle", quoteMode: "native-peg", severityBasis: "current",
      currentBps: -800, priceObservedAt: now - NATIVE_QUOTE_AGE_SEC,
    });
    const armed = buildNextTriggers({ ...input(now), topDepegs: current })
      .find((row) => row.metric === "depeg-bps");
    expect(armed).toMatchObject({ stablecoinId: "eurc-circle", symbol: "EURC" });
    expect(armed!.thresholdValue).toBeGreaterThan(800);

    const previous = await collect(now - DAY_SECONDS, 0.925);
    expect(previous[0]).toMatchObject({ severityBasis: "current", currentBps: -750 });
    const outcomes = buildForwardLookOutcomes(
      { ...input(now), topDepegs: current },
      { ...input(now - DAY_SECONDS), topDepegs: previous, nextTriggers: [armed!] },
    );
    expect(outcomes[0]).toMatchObject({ status: "pending" });
    expect(outcomes[0].detail).toContain("800 bps");
  });

  it("keeps supply-7d outcomes attached to the armed coin when symbols collide", () => {
    const ALPHA_PARTNER = "usda-alpha-partner";
    const YESTERDAY = 1_793_097_600;
    const TODAY = YESTERDAY + 86_400;
    const candidate: DigestEditorialCandidate = {
      id: `market:${ALPHA_PARTNER}:weekly-supply`, kind: "market", title: "USDA is the largest weekly supply mover",
      symbols: ["USDA"], impactScore: 30, novelty: "structural", confidence: "high", artifactRisk: "low",
      headlineFacts: ["+$30.00M in 7d", "$83.37M current market cap"], whyItMatters: "Supply moved.",
    };
    const digestDay = (generatedAt: number, weekly: { avalon: number; alphaPartner: number; anzens: number }): DigestInputData => ({
      ...input(generatedAt),
      activeDepegCount: 0,
      topDepegs: [],
      biggestSupplyChange: { id: ALPHA_PARTNER, symbol: "USDA", name: "AP USDA", changeUsd: weekly.alphaPartner, currentMcap: 83_368_092 },
      // Three core coins print USDA; payload order puts usda-avalon first.
      supplyChanges7d: [
        { stablecoinId: "usda-avalon", coin: "USDA", change7d: weekly.avalon },
        { stablecoinId: ALPHA_PARTNER, coin: "USDA", change7d: weekly.alphaPartner },
        { stablecoinId: "usda-anzens", coin: "USDA", change7d: weekly.anzens },
      ],
      editorialCandidates: [candidate],
    });
    const yesterday = digestDay(YESTERDAY, { avalon: 2_000_000, alphaPartner: 30_000_000, anzens: -500_000 });
    const armed = buildNextTriggers(yesterday);
    expect(armed.find((entry) => entry.metric === "supply-7d-usd")).toMatchObject({
      symbol: "USDA", stablecoinId: ALPHA_PARTNER,
    });

    const today = digestDay(TODAY, { avalon: 1_200_000, alphaPartner: 45_000_000, anzens: -400_000 });
    const outcome = buildForwardLookOutcomes(today, { ...yesterday, nextTriggers: armed })[0];
    expect(outcome.status).toBe("hit");
    expect(outcome.detail).toContain(formatCurrency(45_000_000, 0));
  });

  it("keeps supply-1d outcomes attached to the armed coin when symbols collide", () => {
    const ALPHA_PARTNER = "usda-alpha-partner";
    const AT = 1_793_184_000;
    const day: DigestInputData = {
      ...input(AT),
      activeDepegCount: 0,
      topDepegs: [],
      biggestSupplyChange: null,
      supplyVelocity: [
        { stablecoinId: "usda-avalon", coin: "USDA", change1d: 2_000_000, change7d: 2_000_000, signal: "accelerating" },
        { stablecoinId: ALPHA_PARTNER, coin: "USDA", change1d: 45_000_000, change7d: 45_000_000, signal: "accelerating" },
      ],
    };
    const armed: DigestNextTrigger = {
      id: "trigger:supply-1d:usda", stablecoinId: ALPHA_PARTNER, symbol: "USDA",
      metric: "supply-1d-usd", comparator: "abs-gte", thresholdValue: 40_000_000,
      thresholdLabel: "$40M 1d move", label: "USDA 1d supply velocity", rationale: "x", detail: "x",
    };
    const outcome = buildForwardLookOutcomes(day, { ...day, nextTriggers: [armed] })[0];
    expect(outcome.status).toBe("hit");
    expect(outcome.detail).toContain(formatCurrency(45_000_000, 0));
  });
});
