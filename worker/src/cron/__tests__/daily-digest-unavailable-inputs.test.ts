import { describe, expect, it } from "vitest";
import { mockD1 } from "@shared/test-utils/mock-d1";
import { DigestSnapshotResponseSchema, type DigestInputData } from "@shared/types/digest";
import { BASE_DIGEST_INPUT, makeCollectorCtx, publishedGaugePayload, publishedGaugeTable } from "./daily-digest.test-support";
import { classifyRegime } from "../daily-digest/prompt/regime";
import { buildRiskTape } from "../daily-digest/digest-risk-tape";
import { rollupDigestInputs } from "../daily-digest/collectors-shared";
import { buildUserPrompt } from "../daily-digest/prompt";
import { buildEditorialCandidates } from "../daily-digest/editorial-candidates";
import { collectActiveDepegs, collectBlacklistActivity, collectMintBurnFlows, collectResolvedDepegs } from "../daily-digest/collectors-market";
import { resolveDailyDigestEditionNumber } from "../digest/publish";
import { buildWeeklyInputData } from "../weekly-recap/input-data";
import { buildWeeklyPrompt } from "../weekly-recap/prompt";

const QUIET_INPUT: DigestInputData = {
  ...BASE_DIGEST_INPUT,
  activeDepegCount: 0,
  topDepegs: [],
};

function dayInput(overrides: Partial<DigestInputData> = {}): DigestInputData {
  return { ...QUIET_INPUT, ...overrides };
}

describe("digest publishes unavailable inputs as unavailable", () => {
  it("never classifies a day CALM when a regime-critical collector could not read", () => {
    expect(classifyRegime(QUIET_INPUT)).toBe("CALM");
    expect(classifyRegime({ ...QUIET_INPUT, degradedSources: ["active-depegs-query"] })).toBe("WATCHFUL");
    expect(classifyRegime({ ...QUIET_INPUT, degradedSources: ["dews-published-generation"] })).toBe("WATCHFUL");
  });

  it("names a published null gauge and keeps its regime above CALM", async () => {
    const collected = await collectMintBurnFlows(makeCollectorCtx(mockD1([publishedGaugeTable({
      value: JSON.stringify(publishedGaugePayload({ gauge: { score: null, band: null, flightToQuality: false, flightIntensity: 0, partialValuationInputs: 0 } })),
    })])));
    expect(collected.value).toBeUndefined();
    expect(collected.degradedReasons).toEqual([]);
    expect(collected.qualityReasons).toEqual(["mint-burn-gauge-unavailable"]);
    const input = dayInput({
      mintBurnFlows: collected.value, degradedSources: collected.qualityReasons,
      dataQuality: {
        generatedAt: 2000, stablecoinsCacheUpdatedAt: 2000, stablecoinsCacheAgeSec: 0, degradedSources: collected.qualityReasons,
        windows: {
          blacklistActivity: { label: "24h", start: 1000, end: 2000 },
          mintBurnFlows: { label: "24h", start: 1000, end: 2000 },
          supplyVelocity: { label: "UTC", dates: [] },
          psi: { label: "latest", sampleAt: 2000, dailySnapshotAt: null },
        },
      },
    });
    expect(classifyRegime(input)).toBe("WATCHFUL");
    expect(buildUserPrompt(input)).toContain("Market regime: WATCHFUL");
    expect(buildUserPrompt(input)).toContain("mint-burn-gauge-unavailable");
    expect(classifyRegime({ ...input, stabilityIndex: { score: 50, band: "CRISIS", components: { severity: 50, breadth: 5, trend: 0 } } })).toBe("CRISIS");
  });

  it.each(["missing", "malformed", "expired", "read"])("does not classify an unavailable %s gauge as CALM", (reason) => {
    expect(classifyRegime(dayInput({ degradedSources: [`mint-burn-gauge-${reason}`] }))).toBe("WATCHFUL");
  });

  it("persists null depeg counts and renders failed reads unavailable, including legacy zero fallbacks", async () => {
    const ctx = makeCollectorCtx(mockD1([{ match: "FROM depeg_events", rows: [], throwError: new Error("unavailable") }]));
    const active = await collectActiveDepegs(ctx);
    const resolved = await collectResolvedDepegs(ctx);
    expect(active.value).toMatchObject({ activeDepegCount: null, activeDepegSignalKeys: null });
    expect(resolved.value).toMatchObject({ resolvedDepegCount: null, resolvedDepegSignalKeys: null });
    const input = dayInput({
      ...active.value, ...resolved.value,
      depegSignalKeys: { active: active.value.activeDepegSignalKeys, resolved: resolved.value.resolvedDepegSignalKeys },
      degradedSources: [...active.degradedReasons, ...resolved.degradedReasons],
    });
    for (const activeDepegCount of [null, 0]) {
      const prompt = buildUserPrompt({ ...input, activeDepegCount });
      expect(prompt).toContain("Currently active depegs (ongoing, not yet resolved): unavailable (active-depegs-query)");
      expect(prompt).toContain("Depegs resolved in last 24h: unavailable (resolved-depegs-query)");
    }
    const parsed = DigestSnapshotResponseSchema.parse({
      date: "2026-10-10", inputData: input, prevInputData: null, depegEvents: [], blacklistEvents: [],
    });
    expect(parsed.inputData).toMatchObject({ activeDepegCount: null, resolvedDepegCount: null, depegSignalKeys: { active: null, resolved: null } });
    const weekly = rollupDigestInputs(Array.from({ length: 7 }, () => input));
    expect(weekly.activeDepegObs).toBeNull();
    expect(weekly.uniqueDepegSignals).toBeNull();
    expect(weekly.unavailableReasons.uniqueDepegSignals).toContain("resolved-depegs-query");
  });

  it("retains uncapped active and recovered identities before display, supply and severity filters", async () => {
    const rows = Array.from({ length: 12 }, (_, index) => ({
      stablecoin_id: `coin-${index}`, symbol: `C${index}`, direction: "below",
      peak_deviation_bps: index === 10 ? 50 : 200, started_at: 1000 + index,
      ended_at: 2000, close_reason: "recovered-primary", recovery_price: 1,
    }));
    const ctx = makeCollectorCtx(mockD1([{ match: "FROM depeg_events", rows: [
      ...rows,
      { ...rows[0], stablecoin_id: "not-tracked" },
      { ...rows[0], stablecoin_id: "usr-resolv" },
      { ...rows[0], stablecoin_id: "coin-0", started_at: 999, close_reason: "superseded" },
    ] }]));
    ctx.trackedStablecoinIds = new Set([...rows.map((row) => row.stablecoin_id), "usr-resolv"]);
    ctx.mcapById = new Map(rows.slice(0, 11).map((row, index) => [row.stablecoin_id, index === 9 ? 1_000_000 : 100_000_000]));
    const active = await collectActiveDepegs(ctx);
    const resolved = await collectResolvedDepegs(ctx);
    expect(active.value.activeDepegCount).toBe(13);
    expect(active.value.topDepegs).toHaveLength(8);
    expect(active.value.activeDepegSignalKeys).toHaveLength(13);
    expect(resolved.value.resolvedDepegCount).toBe(12);
    expect(resolved.value.resolvedDepegs).toHaveLength(5);
    expect(resolved.value.resolvedDepegSignalKeys).toHaveLength(12);
    expect(resolved.value.resolvedDepegSignalKeys).toContain("coin-11:1011:resolved");
    const input = dayInput({
      activeDepegCount: active.value.activeDepegCount, topDepegs: active.value.topDepegs,
      ...resolved.value,
      depegSignalKeys: { active: active.value.activeDepegSignalKeys, resolved: resolved.value.resolvedDepegSignalKeys },
    });
    expect(buildUserPrompt(input)).toContain("Depegs resolved in last 24h: 12");
    expect(rollupDigestInputs(Array.from({ length: 7 }, () => input))).toMatchObject({ activeDepegObs: 91, uniqueDepegSignals: 25 });
    const weekly = buildWeeklyInputData(Array.from({ length: 7 }, (_, index) => ({
      generated_at: 1_772_000_000 + index * 86400, digest_title: "Day", digest_text: "Day",
      input_data: JSON.stringify(input),
    })))!;
    expect(weekly.uniqueDepegSignalsThisWeek).toBe(25);
    expect(buildWeeklyPrompt(weekly)).toContain("Unique depeg signals reconstructed from daily inputs: 25");
  });

  it("keeps observed zero counts distinct from legacy missing authoritative identities", async () => {
    const ctx = makeCollectorCtx(mockD1([{ match: "FROM depeg_events", rows: [] }]));
    const active = await collectActiveDepegs(ctx);
    const resolved = await collectResolvedDepegs(ctx);
    const input = dayInput({
      ...active.value, ...resolved.value,
      depegSignalKeys: { active: active.value.activeDepegSignalKeys, resolved: resolved.value.resolvedDepegSignalKeys },
    });
    expect(buildUserPrompt(input)).toContain("Depegs resolved in last 24h: 0");
    expect(rollupDigestInputs(Array.from({ length: 7 }, () => input)).uniqueDepegSignals).toBe(0);
    const legacy = rollupDigestInputs(Array.from({ length: 7 }, () => dayInput()));
    expect(legacy.uniqueDepegSignals).toBeNull();
    expect(legacy.unavailableReasons.uniqueDepegSignals).toContain("uniqueDepegSignals-observation-missing");
    expect(buildUserPrompt(dayInput())).toContain("Depegs resolved in last 24h: unavailable (resolved-depegs-observation-missing)");
    const weekly = buildWeeklyInputData(Array.from({ length: 7 }, (_, index) => ({
      generated_at: 1_772_000_000 + index * 86400, digest_title: "Day", digest_text: "Day",
      input_data: JSON.stringify(dayInput()),
    })))!;
    expect(buildWeeklyPrompt(weekly)).toContain("Unique depeg signals reconstructed from daily inputs: N/A (uniqueDepegSignals-observation-missing)");
  });

  it("does not assert an absence of peg breaks on a failed active-depeg query", () => {
    const clean = buildRiskTape(QUIET_INPUT).find((item) => item.id === "risk-tape:depegs");
    expect(clean?.detail).toBe("No active peg breaks in the digest input.");

    const degraded = buildRiskTape({ ...QUIET_INPUT, degradedSources: ["active-depegs-query"] })
      .find((item) => item.id === "risk-tape:depegs");
    expect(degraded?.value).toBe("Unavailable");
    expect(degraded?.detail).not.toContain("No active peg breaks");
  });

  it("publishes null weekly totals below full daily coverage", () => {
    const day = dayInput({ activeDepegCount: 2, blacklistActivity: { eventCount: 1, totalAmountUsd: 5, topEvents: [] } });
    const partial = rollupDigestInputs(Array.from({ length: 5 }, () => day));
    expect(partial.activeDepegObs).toBeNull();
    expect(partial.blacklistEvents).toBeNull();
    expect(partial.blacklistUsd).toBeNull();
    expect(partial.days).toBe(5);

    const full = rollupDigestInputs(Array.from({ length: 7 }, () => day));
    expect(full.activeDepegObs).toBe(14);
    expect(full.blacklistEvents).toBe(7);
  });

  it("withholds only failed metrics across seven editions and names the failed observations", () => {
    const days = Array.from({ length: 7 }, (_, index) => dayInput({
      blacklistActivity: { eventCount: 0, totalAmountUsd: 0, unpricedEventCount: 0, topEvents: [] },
      gradeTransitions: [],
      ...(index === 1 ? { degradedSources: ["active-depegs-query"] } : {}),
      ...(index === 2 ? { blacklistActivity: undefined, degradedSources: ["blacklist-activity-query"] } : {}),
    }));
    const rollup = rollupDigestInputs(days);
    expect(rollup).toMatchObject({
      activeDepegObs: null, uniqueDepegSignals: null, blacklistEvents: null, blacklistUsd: null,
      gradeTransitions: 0,
    });
    expect(rollup.unavailableReasons.activeDepegObs).toContain("active-depegs-query");
    expect(rollup.unavailableReasons.blacklistEvents).toContain("blacklist-activity-query");
    const weekly = buildWeeklyInputData(days.map((inputData, index) => ({
      generated_at: 1_772_000_000 + index * 86400, digest_title: "Day", digest_text: "Day",
      input_data: JSON.stringify(inputData),
    })))!;
    const prompt = buildWeeklyPrompt(weekly);
    expect(prompt).toContain("Active depeg observations across daily editions: N/A (active-depegs-query)");
    expect(prompt).toContain("Total blacklist events: N/A (blacklist-activity-query");
    expect(prompt).not.toContain("Total blacklist events: 0");
    expect(prompt).not.toContain("Active depeg observations across daily editions: 0");
    expect(weekly.degradedSources).toContain("blacklist-activity-query");
  });

  it("retains sub-threshold daily freezes for weekly accounting without promoting candidates", async () => {
    const collected = await collectBlacklistActivity(makeCollectorCtx(mockD1([{
      match: "FROM blacklist_events",
      rows: [{ symbol: "USDC", chain_name: "Ethereum", event_type: "blacklist", amount_usd_at_event: 1_000_000 }],
    }])));
    const input = dayInput({ blacklistActivity: collected.value });
    expect(collected.value).toMatchObject({ eventCount: 1, totalAmountUsd: 1_000_000, editorialEligible: false });
    expect(buildEditorialCandidates(input, null).some((candidate) => candidate.kind === "blacklist")).toBe(false);
    expect(buildUserPrompt(input)).not.toContain("Blacklist activity (rolling last 24h)");
    expect(rollupDigestInputs(Array.from({ length: 7 }, () => input))).toMatchObject({
      blacklistEvents: 7, blacklistUsd: 7_000_000, blacklistUnpricedEvents: 0,
    });
  });

  it("preserves unpriced counts and labels weekly known amounts as a lower bound", () => {
    const input = dayInput({
      blacklistActivity: { eventCount: 2, totalAmountUsd: 5, unpricedEventCount: 1, topEvents: [] },
    });
    const weekly = buildWeeklyInputData(Array.from({ length: 7 }, (_, index) => ({
      generated_at: 1_772_000_000 + index * 86400, digest_title: "Day", digest_text: "Day",
      input_data: JSON.stringify(input),
    })))!;
    expect(weekly).toMatchObject({ totalBlacklistEventsThisWeek: 14, totalBlacklistAmountUsd: 35, blacklistUnpricedEventCount: 7 });
    expect(buildWeeklyPrompt(weekly)).toContain("at least $35.00 known subtotal (7 unpriced events)");
    expect(buildWeeklyPrompt(weekly)).not.toContain("$35.00 affected");
  });

  it.each(["partial", "legacy"] as const)("withholds weekly ecosystem mcap for %s supply coverage", (coverage) => {
    const input = dayInput({
      supplyCoverage: coverage === "partial" ? { complete: false, observedCount: 1, unavailableCount: 1 } : undefined,
    });
    expect(rollupDigestInputs([input])).toMatchObject({
      mcapEnd: null, unavailableReasons: { mcapEnd: ["supply-coverage-incomplete"] },
    });
    const rows = Array.from({ length: 7 }, (_, index) => ({
      generated_at: 1_772_000_000 + index * 86400, digest_title: "Day", digest_text: "Day",
      input_data: JSON.stringify(input),
    }));
    const weekly = buildWeeklyInputData(rows, rows)!;
    expect(weekly.mcapRange).toMatchObject({
      start: null, end: null, netChange: null, pctChange: null, unavailableReason: "supply-coverage-incomplete",
    });
    expect(weekly.weekOverWeekDeltas?.mcap).toEqual({ current: null, prior: null, deltaPct: null });
    expect(buildWeeklyPrompt(weekly)).toContain("Market cap: N/A (supply-coverage-incomplete)");
    expect(weekly.psiRange.end).toBe(BASE_DIGEST_INPUT.stabilityIndex!.score);
  });

  it("renders an absent prior DEWS generation as unavailable rather than an all-calm day", () => {
    const prompt = buildUserPrompt(dayInput({
      dewsStress: {
        bandCounts: { calm: 3, watch: 1, alert: 0, warning: 0, danger: 0 },
        yesterdayBandCounts: null,
        bandChanges: [],
        elevatedCoins: [],
      },
    }));
    expect(prompt).toContain("(vs yesterday: unavailable)");
    expect(prompt).not.toContain("vs yesterday: 0/0/0/0/0");
  });

  it("never prints Infinity for a 7-day change without a baseline", () => {
    const prompt = buildUserPrompt(dayInput({
      totalMcapUsd: 1_000_000,
      mcap7dDelta: 1_000_000,
      mcap7dDeltaCoverage: { coveredCoins: 1, totalCoins: 3, coveredMcapUsd: 1_000_000 },
    }));
    expect(prompt).not.toContain("Infinity");
    expect(prompt).toContain("n/a (no 7d baseline)");
    expect(prompt).toContain("baseline covers 1 of 3 core coins");
  });

  it("keeps a non-finite depeg impact from defusing the regime thresholds", () => {
    const regime = classifyRegime(dayInput({
      activeDepegCount: 1,
      topDepegs: [{ symbol: "USDX", bps: -900, mcapUsd: Number.NaN, impactScore: Number.NaN }],
      stabilityIndex: { score: 65, band: "TREMOR", components: { severity: 30, breadth: 5, trend: -3 } },
    }));
    expect(regime).toBe("CRISIS");
  });

  it("counts the daily edition number from the rows readers actually saw", async () => {
    const db = mockD1([{ match: "COUNT(*) as cnt FROM daily_digest", rows: [{ cnt: 209 }] }]);
    await expect(resolveDailyDigestEditionNumber(db)).resolves.toBe(209);
    const sql = db.getHistory().find((entry) => entry.sql.includes("COUNT(*) as cnt"))?.sql ?? "";
    expect(sql).toContain("$.qualityGate");
    expect(sql).toContain("$.type");
  });

  it("publishes an unknown blacklist amount as unknown and does not suppress it", async () => {
    const collected = await collectBlacklistActivity(makeCollectorCtx(mockD1([{
      match: "FROM blacklist_events",
      rows: [
        { symbol: "USDC", chain_name: "Ethereum", event_type: "blacklist", amount_usd_at_event: null },
        { symbol: "USDT", chain_name: "Ethereum", event_type: "blacklist", amount_usd_at_event: 5_000_000 },
      ],
    }])));
    const blacklistActivity = collected.value;
    expect(blacklistActivity).toMatchObject({ eventCount: 2, totalAmountUsd: 5_000_000, unpricedEventCount: 1 });
    expect(blacklistActivity?.topEvents[0]?.amountUsd).toBeNull();

    const data = dayInput({ blacklistActivity });
    const prompt = buildUserPrompt(data);
    expect(prompt).toContain("USDC on Ethereum: blacklist (amount unknown)");
    expect(prompt).not.toContain("blacklist ($0)");

    const candidate = buildEditorialCandidates(data, null).find((entry) => entry.kind === "blacklist");
    expect(candidate?.suppressReason).toBeUndefined();
    expect(candidate?.artifactRisk).not.toBe("high");
  });

  it("still suppresses a fully priced zero-dollar blacklist day", () => {
    const data = dayInput({
      blacklistActivity: {
        eventCount: 2,
        totalAmountUsd: 0,
        unpricedEventCount: 0,
        topEvents: [{ symbol: "USDC", chain: "Ethereum", type: "blacklist", amountUsd: 0 }],
      },
    });
    const candidate = buildEditorialCandidates(data, null).find((entry) => entry.kind === "blacklist");
    expect(candidate?.suppressReason).toContain("zero-dollar");
    expect(candidate?.artifactRisk).toBe("high");
  });
});
