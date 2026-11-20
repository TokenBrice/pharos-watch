import { afterEach, describe, expect, it } from "vitest";
import { mockD1 } from "@shared/test-utils/mock-d1";
import { createLatestSchemaFixtureTracker } from "@shared/test-utils/latest-schema-sqlite";
import { formatCurrency } from "@shared/lib/format";
import { DAY_SECONDS, HOUR_SECONDS } from "@shared/lib/time-constants";
import type { DigestEditorialCandidate, DigestInputData, DigestNextTrigger } from "@shared/types/digest";
import { collectActiveDepegs, collectResolvedDepegs } from "../collectors-market";
import { collectDewsStress, collectYieldAnomalies } from "../collectors-risk";
import { buildChangeSummary } from "../digest-change-summary";
import { buildForwardLookOutcomes, buildNextTriggers } from "../digest-next-triggers";
import { comparableDepegs, type DigestEvidence } from "../digest-evidence";
import { buildEditorialCandidates } from "../editorial-candidates";
import { buildUserPrompt } from "../prompt";
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
  const fixtures = createLatestSchemaFixtureTracker();
  afterEach(fixtures.closeAll);
  it.each([
    ['{"publication":{"generationId":"current"}}', [3]],
    ['{"publication":{"generationId":"empty"}}', []],
    ["{", undefined], ["{}", undefined], ['{"publication":{"generationId":[]}}', undefined], [null, undefined],
  ])("scopes USDC evidence to the served generation (%s)", async (cache, apys) => {
    const { db, sqlite } = fixtures.open();
    const ctx = makeCollectorCtx(db);
    ctx.evidence = {};
    if (cache !== null) sqlite.prepare("INSERT INTO cache (key, value, updated_at) VALUES ('yield-rankings', ?, ?)")
      .run(cache, ctx.nowSec);
    const row = sqlite.prepare(`INSERT INTO yield_data (stablecoin_id, source_key, symbol, current_apy, apy_7d, apy_30d,
      yield_source, yield_type, data_source, is_best, updated_at, publication_generation_id, publication_state)
      VALUES ('usdc-circle', ?, 'USDC', ?, 3, 3, 'USDC vault', 'lending-opportunity', 'protocol-api', 1, ?, ?, 'published')`);
    row.run("older-vault", 5, ctx.nowSec - 3600, "older");
    row.run("linked-variant:gtusdc-gauntlet:protocol-api:morpho-net:test", 3, ctx.nowSec, "current");
    const result = await collectYieldAnomalies(ctx);
    expect.soft(result.degradedReasons).toEqual(apys === undefined ? ["yield-published-generation"] : []);
    expect.soft(ctx.evidence.yields).toEqual(apys?.map((currentApy) => ({ stablecoinId: "usdc-circle", symbol: "USDC", currentApy })));
  });
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
    const ctx = makeCollectorCtx(mockD1([{ match: "FROM depeg_events", rows: [{ stablecoin_id: "usdt-tether", symbol: "USDT", peg_type: "peggedUSD", direction: "below", peak_deviation_bps: -900, started_at: 1, ended_at: 199999, close_reason: closeReason, recovery_price: closeReason === "recovered-primary" ? 1 : null }] }]));
    ctx.nowSec = 200000;
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

  it("excludes reviewed disputes from the active count while keeping the active evidence rows", async () => {
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
  });

  it("admits only public recoveries and keeps disputed peaks out of active severity", async () => {
    const { db, sqlite } = fixtures.open();
    const now = 1_795_017_600, start = now - 4 * HOUR_SECONDS, end = now - 600, restart = now - 300;
    const insert = sqlite.prepare(`INSERT INTO depeg_events
      (id, stablecoin_id, symbol, peg_type, direction, peak_deviation_bps, started_at, ended_at, start_price,
       peg_reference, recovery_price, recovery_peg_reference, close_reason, last_trusted_price_at, price_coverage_json)
      VALUES (?, ?, ?, ?, 'below', -310, ?, ?, ?, ?, ?, ?, ?, ?, ?)`);
    const coverage = JSON.stringify({ intervals: [[start, end]], atParIntervals: [[end - 300, end]] });
    insert.run(101, "eurc-circle", "EURC", "peggedEUR", start, end, 1.0659, 1.1, 1.1, 1.1, "recovered-dex", end, coverage);
    insert.run(102, "audd-novatti", "AUDD", "peggedAUD", start, end, 0.65, 0.67, 0.67, 0.67, "recovered-primary", null, null);
    insert.run(103, "audd-novatti", "AUDD", "peggedAUD", restart, null, 0.65, 0.67, null, null, null, null, null);
    for (const [id, verdict] of [[104, "disputed"], [105, "false_positive"]] as const) {
      insert.run(id, "usdc-circle", "USDC", "peggedUSD", start + id, end, 0.969, 1, 1, 1, "recovered-primary", null, null);
      sqlite.prepare(`INSERT INTO depeg_event_provenance (event_id, source_kind, audit_verdict, created_at, updated_at)
        VALUES (?, 'live', ?, ?, ?)`).run(id, verdict, end, end);
    }
    sqlite.prepare("UPDATE depeg_events SET disposition = 'repaired', admitted_coverage_json = '[]' WHERE id = 101").run();
    const key = `ddr2:${"a".repeat(32)}`;
    sqlite.prepare(`INSERT INTO depeg_resolver_incident_event_links (incident_key, event_id, relation, linked_at)
      VALUES (?, 102, 'observed', ?), (?, 103, 'observed', ?)`).run(key, start, key, restart);
    sqlite.prepare(`INSERT INTO depeg_resolver_incidents (incident_key, stablecoin_id, peg_currency, direction, first_event_id,
      current_event_id, first_started_at, current_started_at, first_observed_peak_bucket_bps, source_fingerprint, created_at, updated_at)
      VALUES (?, 'audd-novatti', 'AUD', 'below', 102, 103, ?, ?, 300, ?, ?, ?)`).run(key, start, restart, "b".repeat(64), start, restart);
    const ids = ["eurc-circle", "audd-novatti", "usdc-circle"];
    const ctx = makeCollectorCtx(db);
    Object.assign(ctx, { nowSec: now, trackedStablecoinIds: new Set(ids), mcapById: new Map(ids.map(id => [id, 1e8])), evidence: {} });
    expect((await collectResolvedDepegs(ctx)).value).toEqual({
      resolvedDepegCount: 0, resolvedDepegSignalKeys: [], resolvedDepegs: undefined,
    });
    expect(ctx.evidence?.recoveredDepegs).toEqual([]);

    sqlite.prepare("UPDATE depeg_events SET disposition = NULL, admitted_coverage_json = NULL WHERE id = 101").run();
    const { value } = await collectResolvedDepegs(ctx);
    expect(value.resolvedDepegCount).toBe(1);
    expect(value.resolvedDepegSignalKeys).toEqual([`eurc-circle:${start}:resolved`]);
    expect(value.resolvedDepegs).toMatchObject([{ symbol: "EURC", durationHours: 4 }]);

    sqlite.exec("UPDATE depeg_events SET peak_deviation_bps = CASE id WHEN 102 THEN -960 ELSE -437 END WHERE id IN (102, 103)");
    expect((await collectActiveDepegs(ctx)).value.topDepegs[0]).toMatchObject({ bps: -960, severityBasis: "peak-fallback" });
    sqlite.exec("UPDATE depeg_events SET peak_price = 0, peg_reference = 1 WHERE id = 102");
    const [projected] = (await collectActiveDepegs(ctx)).value.topDepegs;
    expect(projected).toMatchObject({ bps: -960, peakBps: -960, quoteMode: "usd", severityBasis: "peak-fallback" });
    expect(projected).not.toHaveProperty("peakPriceNative");
    sqlite.exec(`UPDATE depeg_events SET peak_deviation_bps = -963, peak_price = 0.67 * 0.9037,
      peak_peg_reference = 0.67, peak_quote_domain = 'usd', pending_reason = 'peer-relative' WHERE id = 102`);
    const { topDepegs } = (await collectActiveDepegs(ctx)).value;
    const peak = "963 bps below the peer median";
    const data = { ...input(now), topDepegs, editorialCandidates: [] };
    const candidate = buildEditorialCandidates(data)[0];
    expect(buildUserPrompt(data)).toContain(`AUDD | peak ${peak} (stored peak; live price unavailable)`);
    expect(candidate.title).toContain(peak);
    expect(candidate.headlineFacts).toContain(`${peak} (stored peak; live price unavailable)`);
    expect(ctx.evidence?.activeDepegs?.[0]?.peakBasis).toBe("peer-relative");

    const live = { ...data, topDepegs: [{ ...topDepegs[0], currentBps: -963, severityBasis: "current" as const }] };
    expect(buildUserPrompt(live)).toContain(`AUDD | now 963 bps below peg | peak ${peak}`);
    expect(buildEditorialCandidates(live)[0].headlineFacts).toContain(`peak was ${peak}`);

    const tiedPeak = { basis: "peer-relative", observedAt: now, price: 0.68 * 0.9037, pegReference: 0.68, bps: -963 };
    sqlite.prepare(`UPDATE depeg_events SET peak_deviation_bps = -963, peak_price = ?,
      peak_peg_reference = 0.68, peak_quote_domain = 'usd', peer_basis_json = ? WHERE id = 103`)
      .run(tiedPeak.price, JSON.stringify({ peak: tiedPeak }));
    const tied = (await collectActiveDepegs(ctx)).value.topDepegs;
    expect(tied[0]).toMatchObject({ peakPriceUsd: tiedPeak.price, peakBasis: "peer-relative" });
    expect(buildUserPrompt({ ...data, topDepegs: tied })).toContain(`AUDD | peak ${peak}`);
    sqlite.exec(`UPDATE depeg_events SET peak_deviation_bps = -437, peak_price = NULL,
      peak_peg_reference = NULL, peak_quote_domain = NULL, peer_basis_json = NULL WHERE id = 103`);
    sqlite.prepare(`INSERT INTO depeg_event_provenance (event_id, source_kind, audit_verdict, created_at, updated_at)
      VALUES (102, 'live', 'false_positive', ?, ?)`).run(end, end);
    expect((await collectActiveDepegs(ctx)).value.topDepegs[0]).toMatchObject({ bps: -437, severityBasis: "peak-fallback" });
  });

  it("uses admitted recovery time for daily counts, signal keys and duration", async () => {
    const now = 1_795_010_400;
    const id = "eurc-circle";
    const closedRow = (ended_at: number, atPar: boolean) => {
      const started_at = ended_at - 3.5 * HOUR_SECONDS - 300;
      const last = ended_at - 900;
      return {
        id: ended_at, stablecoin_id: id, symbol: "EURC", peg_type: "peggedEUR", direction: "below",
        peak_deviation_bps: -310, started_at, ended_at, close_reason: "recovered-dex", recovery_price: 1.1,
        recovery_peg_reference: 1.1, last_trusted_price_at: last,
        price_coverage_json: JSON.stringify({ intervals: [[started_at, last]], atParIntervals: atPar ? [[last, last]] : [] }),
      };
    };
    const admitted = closedRow(now - 600, true);
    const ctx = makeCollectorCtx(mockD1([{ match: "FROM depeg_events", rows: [
      closedRow(now - 300, false), admitted, closedRow(now - DAY_SECONDS + 60, true),
    ] }]));
    Object.assign(ctx, { nowSec: now, trackedStablecoinIds: new Set([id]), mcapById: new Map([[id, 1e8]]), evidence: {} });
    const result = await collectResolvedDepegs(ctx);
    expect(result.value.resolvedDepegCount).toBe(1);
    expect(result.value.resolvedDepegSignalKeys).toEqual([`${id}:${admitted.started_at}:resolved`]);
    expect(result.value.resolvedDepegs).toMatchObject([{ endedAt: admitted.last_trusted_price_at, durationHours: 3 }]);
    expect(ctx.evidence?.recoveredDepegs).toEqual(result.value.resolvedDepegs);
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
    const now = 1_795_017_600;
    const collect = async (at: number, quote: number, kind: "traded-pair" | "conversion" = "traded-pair") => {
      const ctx = makeCollectorCtx(mockD1([{
        match: "FROM depeg_events",
        rows: [{
          stablecoin_id: "eurc-circle", symbol: "EURC", peg_type: "peggedEUR", source: "live",
          direction: "below", peak_deviation_bps: -800, started_at: now - 3 * DAY_SECONDS,
          start_price: 0.985, peak_price: 0.92, peg_reference: 1, quote_mode: "native-peg",
          incident_peak_json: JSON.stringify({
            id: 1, stablecoin_id: "eurc-circle", peg_type: "peggedEUR", source: "live", quote_mode: "usd",
            peg_reference: 1.2, peak_deviation_bps: -1000, peak_price: 1.08, peak_peg_reference: 1.2,
            peak_quote_domain: "usd", started_at: now - 4 * DAY_SECONDS, ended_at: now - 3 * DAY_SECONDS,
            pending_reason: null, peer_basis_json: null,
          }),
          current_native_quote: JSON.stringify({
            value: quote, observedAt: at - NATIVE_QUOTE_AGE_SEC, source: "coingecko",
            derivation: { kind, lineage: { venue: "bitstamp", pair: "EURC/EUR" } },
          }),
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
      currentBps: -800, priceObservedAt: now - NATIVE_QUOTE_AGE_SEC, peakBps: -1000, peakPriceUsd: 1.08,
    });
    const converted = await collect(now, 0.92, "conversion");
    expect(converted[0]).toMatchObject({ severityBasis: "peak-fallback", bps: -1000 });
    expect(converted[0].priceObservedAt).toBeUndefined();
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

  it("compares current-reference USD rows across reference drift, but never a legacy latched row", () => {
    const DAY_SECONDS = 86_400;
    const now = 1_800_000_000;
    const gold = (at: number, pegReference: number, currentBps: number, current = true) => ({
      stablecoinId: "xaum-matrixdock", symbol: "XAUM", bps: 1660, startedAt: now - 20 * DAY_SECONDS, direction: "above" as const,
      mcapUsd: 6.8e7, quoteMode: "usd" as const, pegReference, severityBasis: "current" as const, currentBps, priceObservedAt: at,
      ...(current ? { pegReferenceBasis: "current" as const } : {}),
    });
    const today = gold(now, 3902, -3);
    // Two current-basis editions measured against each run's own gold reference.
    expect(comparableDepegs(today, gold(now - DAY_SECONDS, 3950, 120), input(now), input(now - DAY_SECONDS))).toBe(true);
    // A pre-fix edition measured against the latched opening reference is not a baseline.
    expect(comparableDepegs(today, gold(now - DAY_SECONDS, 4051, -372, false), input(now), input(now - DAY_SECONDS))).toBe(false);
    // Legacy USD-peg rows keep reference 1 and stay comparable with current-basis rows.
    const usd = (at: number, currentBps: number, current: boolean) => ({ ...gold(at, 1, currentBps, current), stablecoinId: "usdt-tether", symbol: "USDT" });
    expect(comparableDepegs(usd(now, -150, true), usd(now - DAY_SECONDS, -120, false), input(now), input(now - DAY_SECONDS))).toBe(true);
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
