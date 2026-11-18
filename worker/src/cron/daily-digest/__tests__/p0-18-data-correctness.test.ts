import { describe, expect, it, vi } from "vitest";
import { mockTapeD1, tapeInsertBindsForType } from "../../../lib/tape-projectors/__tests__/test-support";
import { projectFreezeBlocked } from "../../../lib/tape-projectors/freeze";
import { mockD1 } from "@shared/test-utils/mock-d1";
import { createLatestSchemaSqlite } from "@shared/test-utils/latest-schema-sqlite";
import { makeAsset } from "../../../test-helpers/__shared/fixtures";
import type { DigestInputData } from "@shared/types/digest";
import type { ReferenceAdmission } from "@shared/types/reference-admission";
import { currentPegObservation, makeCollectorCtx } from "../../__tests__/daily-digest.test-support";
import { collectActiveDepegs, collectBlacklistActivity } from "../collectors-market";
import { collectHistoricalContext } from "../collectors-history";
import { buildDailyDigestInput } from "../input";
import { DEPEG_LIFECYCLE_FLAGS_CACHE_KEY } from "../../../lib/depeg-lifecycle";
import { buildUserPrompt } from "../prompt";
import { BLACKLIST_EVENT_COVERAGE_KEY, collectWeeklyBlacklistActivity, collectWeeklyBlacklistPeriods, getBlacklistCoverageRosterFingerprint } from "../../weekly-recap/blacklist";
import { buildWeeklyInputData } from "../../weekly-recap/input-data";
import { buildWeeklyLeadRequirements, buildWeeklyPrompt } from "../../weekly-recap/prompt";
import { generateWeeklyRecap } from "../../weekly-recap";

const NOW = 1_800_000_000;

function blacklistDb(rows: Record<string, unknown>[]) {
  return mockD1([{ match: "FROM blacklist_events", rows }]);
}

describe("P0-18 daily digest data correctness", () => {

  it.each([
    ["admitted", -250.25, NOW - 120, -250.25, undefined],
    ["admitted", -250, NOW - 121, undefined, "active-depeg-reference-unavailable"],
    ["held-closed-session", -250, NOW - 120, undefined, "active-depeg-reference-market-closed"],
    [undefined, undefined, NOW - 120, 2_000, undefined],
  ] as const)("uses the published reference pair for a non-USD event (%s, quote %s at %s)", async (
    status, admittedDeviationBps, quoteObservedAtSec, expected, reason,
  ) => {
    const id = "paxg-paxos";
    const ctx = makeCollectorCtx(mockD1([{ match: "FROM depeg_events e", rows: [{
      stablecoin_id: id, symbol: "PAXG", peg_type: "peggedGOLD", quote_mode: "usd",
      direction: "below", peak_deviation_bps: -600, started_at: NOW - 86_400, peg_reference: 3_500,
    }] }]));
    const evidence = {
      kind: "fallback", source: "gold-api.com", cadence: "intraday",
      quoteObservedAtSec, referenceObservedAtSec: NOW - 60, decisionAtSec: NOW, budgetSec: 21_600,
      generation: "test", sessionOpenedAtSec: NOW - 1_000, policyVersion: 1,
    } as const;
    const referenceAdmission: ReferenceAdmission | undefined = status === undefined ? undefined
      : status === "admitted" ? { ...evidence, status, reason: "live-reference" }
      : { ...evidence, status, reason: "reference-market-closed", sessionOpenedAtSec: null };
    const currentPeg = { ...currentPegObservation(4_000, { currentDeviationBps: -250 }), referenceAdmission, admittedDeviationBps };
    ctx.nowSec = NOW;
    ctx.trackedStablecoinIds = new Set([id]);
    ctx.mcapById.set(id, 100e6);
    ctx.currentPegObservationById = new Map([[id, currentPegObservation(3_250, { currentDeviationBps: 2_000 })]]);
    ctx.stablecoinAssetById.set(id, makeAsset({
      id, name: "Pax Gold", symbol: "PAXG", pegType: "peggedGOLD", price: 3_900, priceObservedAt: NOW - 120, currentPeg,
      ...(status === undefined ? { priceSource: "pyth", priceObservedAtMode: undefined, priceObservedAt: undefined, priceUpdatedAt: NOW - 120 } : {}),
    }));
    const result = await collectActiveDepegs(ctx);
    expect(result.value.topDepegs[0]).toMatchObject({ bps: -600, severityBasis: expected == null ? "peak-fallback" : "current" });
    expect(result.value.topDepegs[0].currentBps).toBe(expected);
    expect(result.value.topDepegs[0].priceObservedAt).toBe(expected == null ? undefined : quoteObservedAtSec);
    expect(result.qualityReasons).toEqual(reason ? [reason] : undefined);
  });

  it.each([
    ["pyth", undefined, -200], ["pyth", null, undefined], ["binance+pyth", undefined, undefined],
    ["coingecko", undefined, undefined],
  ] as const)("recovers a legacy USD quote clock only for a dated source (%s, %s)", async (priceSource, priceObservedAt, expected) => {
    const id = "usdt-tether";
    const ctx = makeCollectorCtx(mockD1([{ match: "FROM depeg_events e", rows: [{
      stablecoin_id: id, symbol: "USDT", peg_type: "peggedUSD", quote_mode: "usd",
      direction: "below", peak_deviation_bps: -1_000, started_at: NOW - 86_400, peg_reference: 1,
    }] }]));
    ctx.nowSec = NOW;
    ctx.stablecoinAssetById.set(id, makeAsset({
      id, price: 0.98, priceSource, priceSyncedAt: NOW - 60, priceUpdatedAt: NOW - 60, priceObservedAtMode: undefined, priceObservedAt,
    }));
    const { value } = await collectActiveDepegs(ctx);
    expect(value.topDepegs[0].currentBps).toBe(expected);
    expect(value.topDepegs[0].severityBasis).toBe(expected == null ? "peak-fallback" : "current");
  });

  it.each([true, false])("updates unaffected lifecycle flags and retains the unavailable native incident (clocked=%s)", async (clocked) => {
    const { sqlite, db } = createLatestSchemaSqlite();
    try {
      const now = Math.floor(Date.now() / 1000);
      const priorAt = now - 86_400;
      const startedAt = now - 30 * 86_400;
      const quoteAt = priorAt - 120;
      const insert = sqlite.prepare(`INSERT INTO depeg_events
        (id, stablecoin_id, symbol, peg_type, direction, peak_deviation_bps, started_at, start_price, peak_price, peg_reference, source)
        VALUES (?, ?, ?, ?, 'below', -6000, ?, 0.4, 0.4, 1, 'live')`);
      insert.run(101, "xaut-tether", "XAUT", "peggedGOLD", startedAt);
      insert.run(102, "usdc-circle", "USDC", "peggedUSD", startedAt);
      const cache = sqlite.prepare("INSERT INTO cache (key, value, updated_at) VALUES (?, ?, ?)");
      cache.run("stablecoins", JSON.stringify({ peggedAssets: [
        makeAsset({ id: "xaut-tether", symbol: "XAUT", pegType: "peggedGOLD", circulating: { peggedGOLD: 80e6 } }),
        makeAsset({ id: "usdc-circle", symbol: "USDC", price: 0.7, priceObservedAt: now, circulating: { peggedUSD: 120e6 } }),
      ] }), now);
      cache.run(DEPEG_LIFECYCLE_FLAGS_CACHE_KEY, JSON.stringify({ updatedAt: priorAt, flags: [{
        stablecoinId: "xaut-tether", symbol: "XAUT", kind: "stalled-collapse", currentBps: -6000, ageDays: 29, mcapUsd: 80e6,
        ...(clocked ? { eventId: 101, startedAt, evaluatedAt: priorAt, priceObservedAt: quoteAt } : {}),
      }] }), priorAt);
      const input = await buildDailyDigestInput(db);
      const [native, usd] = input.lifecycleFlags;
      expect(native).toMatchObject({ eventId: 101, evaluatedAt: priorAt, currentBps: -6000 });
      expect(native.priceObservedAt).toBe(clocked ? quoteAt : undefined);
      expect(usd).toMatchObject({ eventId: 102, kind: "stalled-collapse", priceObservedAt: now, currentBps: -3000 });
      expect(input.inputData.degradedSources).toContain("active-depeg-native-quote-unavailable:partial");
      expect(input.inputData.degradedSources).not.toContain("active-depeg-reference-unavailable");
    } finally {
      sqlite.close();
    }
  });

  it("does not promote unfreeze rows into blacklist activity", async () => {

    const result = await collectBlacklistActivity(
      makeCollectorCtx(blacklistDb([
        { symbol: "USDC", chain_name: "Ethereum", event_type: "unblacklist", amount_usd_at_event: 50_000_000 },
        { symbol: "USDT", chain_name: "Ethereum", event_type: "unblacklist", amount_usd_at_event: 25_000_000 },
      ])),
    );

    expect(result).toEqual({
      value: { eventCount: 0, totalAmountUsd: 0, unpricedEventCount: 0, editorialEligible: false, topEvents: [] },
      degradedReasons: [],
    });
  });
  it("marks a blocked tape event when its amount is unknown", async () => {
    const db = mockTapeD1([
      { match: "FROM cache WHERE key = ?", rows: [] },
      { match: "FROM tape_events INDEXED BY idx_tape_type_ts", rows: [] },
      { match: "WITH changed AS MATERIALIZED", rows: [] },
      {
        match: "FROM blacklist_events",
        rows: [{
          id: "blacklist-unknown",
          stablecoin: "USDC",
          chain_id: "ethereum",
          chain_name: "Ethereum",
          event_type: "blacklist",
          amount_usd_at_event: null,
          timestamp: 1_800_000_000,
          methodology_version: "3.1",
          config_key: null,
          rowid: 1,
        }],
      },
    ]);

    await expect(projectFreezeBlocked(db, { since: 0 })).resolves.toMatchObject({ projected: 1 });
    const insert = tapeInsertBindsForType(db, "freeze.blocked")[0];
    expect(insert?.[2]).toBe("warning");
    expect(JSON.parse(String(insert?.[11]))).toMatchObject({
      amountUsdAtEvent: null,
      amountUnknown: true,
    });
  });

  it("excludes unknown amounts from totals and surfaces their quality count", async () => {
    const result = await collectBlacklistActivity(
      makeCollectorCtx(blacklistDb([
        { symbol: "USDC", chain_name: "Ethereum", event_type: "blacklist", amount_usd_at_event: null },
      ])),
    );

    expect(result.value).toMatchObject({
      eventCount: 1,
      totalAmountUsd: 0,
      unpricedEventCount: 1,
    });
    expect(result.degradedReasons).toEqual([]);
  });

  it("reads contiguous weekly blacklist totals and dates directly from the public ledger", async () => {
    const { sqlite, db } = createLatestSchemaSqlite();
    const clock = vi.spyOn(Date, "now").mockReturnValue(Date.parse("2026-11-18T12:00:00Z"));
    try {
      const cutoff = Date.parse("2026-11-16T08:10:00Z") / 1_000;
      const start = cutoff - 7 * 86_400;
      const quietEnd = cutoff + 86_400;
      const insert = sqlite.prepare(`INSERT INTO blacklist_events
        (id, stablecoin, chain_id, chain_name, event_type, address, tx_hash, block_number,
         timestamp, amount_usd_at_event, suppression_reason, explorer_tx_url, explorer_address_url)
        VALUES (?, 'USDC', 'ethereum', 'Ethereum', ?, '0x1', ?, 1, ?, ?, ?, '', '')`);
      insert.run("prior", "blacklist", "0xtx1", start - 1, 2_000_000, null);
      const period = { start, end: cutoff };
      expect(await collectWeeklyBlacklistActivity(db, period)).toMatchObject({
        eventCount: 0, coverage: { reason: "weekly-blacklist-coverage-missing" },
      });
      insert.run("current", "blacklist", "0xtx2", start, 20_000_000, null);
      insert.run("late", "destroy", "0xtx3", cutoff - 40 * 60, null, null);
      insert.run("next", "blacklist", "0xtx4", cutoff, 90_000_000, null);
      insert.run("suppressed", "blacklist", "0xtx5", start, 0, "circle_mirror_zero_balance");
      insert.run("released", "unblacklist", "0xtx6", start, 30_000_000, null);
      const prior = await collectWeeklyBlacklistActivity(db, { start: start - 7 * 86_400, end: start });
      const current = await collectWeeklyBlacklistActivity(db, period);
      expect(prior).toMatchObject({ eventCount: 1, totalAmountUsd: 2_000_000, unpricedEventCount: 0 });
      expect(current).toMatchObject({
        eventCount: 2, totalAmountUsd: 20_000_000, unpricedEventCount: 1,
        coverage: { reason: "weekly-blacklist-coverage-missing" },
      });
      expect(current?.topEvents.map((event) => [event.date, event.amountUsd])).toEqual([
        [new Date(start * 1_000).toISOString().slice(0, 10), 20_000_000],
        ["2026-11-16", null],
      ]);
      sqlite.prepare("INSERT INTO cache (key, value, updated_at) VALUES (?, ?, ?)").run(
        BLACKLIST_EVENT_COVERAGE_KEY,
        JSON.stringify({ version: 1, generation: "test", rosterFingerprint: getBlacklistCoverageRosterFingerprint(),
          eventPeriod: { start, end: quietEnd } }),
        quietEnd,
      );
      expect(await collectWeeklyBlacklistActivity(db, { start: cutoff + 1, end: quietEnd })).toMatchObject({
        eventCount: 0, totalAmountUsd: 0, unpricedEventCount: 0, coverage: { reason: null },
      });
      const batch = db.batch.bind(db);
      const collect = vi.spyOn(db, "batch").mockImplementationOnce((statements) => {
        // A repair commits just as the collector starts its D1 snapshot.
        sqlite.exec("BEGIN; DELETE FROM cache WHERE key = 'blacklist:event-coverage:v1'; DELETE FROM blacklist_events WHERE id IN ('current','late'); COMMIT");
        return batch(statements);
      });
      expect(await collectWeeklyBlacklistPeriods(db, {
        current: period, prior: { start: start - 7 * 86_400, end: start },
      })).toMatchObject({
        current: { eventCount: 0, coverage: { reason: "weekly-blacklist-coverage-missing" } },
        prior: { eventCount: 1, totalAmountUsd: 2_000_000, coverage: { reason: "weekly-blacklist-coverage-missing" } },
      });
      expect(collect.mock.calls[0]?.[0]).toHaveLength(3);
    } finally {
      clock.mockRestore();
      sqlite.close();
    }
  });

  it("uses the quote's date for the weekly max and admits Monday's post-cutoff onset", () => {
    const start = Date.parse("2026-11-09T08:10:00Z") / 1_000;
    const startedAt = Date.parse("2026-11-09T14:00:00Z") / 1_000;
    const firstEdition = Date.parse("2026-11-10T00:02:00Z") / 1_000;
    const observedAt = firstEdition - 240;
    const rows = Array.from({ length: 5 }, (_, day) => ({
      generated_at: firstEdition + day * 86_400,
      digest_title: "Daily fixture",
      digest_text: "Daily fixture",
      input_data: JSON.stringify({
        totalMcapUsd: 1e9, mcap7dDelta: 0, activeDepegCount: 1, biggestSupplyChange: null,
        stabilityIndex: { score: 90, band: "BEDROCK", components: { severity: 0, breadth: 0, trend: 0 } },
        yesterdayIndex: null,
        topDepegs: day === 0 ? [{
          symbol: "USDC", stablecoinId: "usdc-circle", startedAt, mcapUsd: 1e9, bps: -3000,
          severityBasis: "current", currentBps: -2600, pegReference: 1, priceObservedAt: observedAt,
        }] : [{
          symbol: "XAUM", stablecoinId: "xaum-matrixdock", startedAt: start - 86_400, mcapUsd: 1e8,
          bps: 4000, severityBasis: "peak-fallback",
        }],
      }),
    }));
    const weekly = buildWeeklyInputData(rows, [], undefined, undefined, {
      current: { start, end: start + 7 * 86_400 }, prior: { start: start - 7 * 86_400, end: start },
    })!;
    expect(weekly.spikeMetrics.maxDepeg).toMatchObject({ symbol: "USDC", bps: 2600, date: "2026-11-09", observedAt });
    expect(buildWeeklyLeadRequirements(weekly)).toMatchObject([{ severity: "hard", mentionTokens: ["USDC"] }]);
    expect(buildWeeklyPrompt(weekly)).toMatch(/Undated lifetime depeg peaks[^\n]*\n[^\n]*XAUM[^\n]*4000 bps/);
  });

  it("skips a manual recap before its weekly event period has closed", async () => {
    const eventCutoff = Date.parse("2026-11-16T08:10:00Z") / 1_000;
    const result = await generateWeeklyRecap(mockD1(), "fixture", null, null, undefined, undefined, eventCutoff - 1);
    expect(result).toMatchObject({ status: "skipped_neutral", metadata: expect.stringContaining("weekly-event-cutoff-not-reached") });
  });

  it("limits PSI precedent to the core aggregate universe and falls back cleanly when absent", async () => {
    const baseTables = [
      { match: "SELECT COUNT(*) as cnt FROM stability_index", rows: [], first: { cnt: 31 } },
      { match: "SELECT MIN(generated_at) as oldest FROM daily_digest", rows: [], first: { oldest: null } },
      {
        match: "json_extract(input_data, '$.aggregateUniverse') = 'core-stablecoins-v1'",
        rows: [],
        first: {
          generated_at: NOW - 86_400,
          psi_score: 89,
          psi_band: "STEADY",
        },
      },
      { match: "ORDER BY computed_at DESC LIMIT 90", rows: [{ date: NOW, score: 91, band: "BEDROCK" }] },
    ];
    const result = await collectHistoricalContext(
      makeCollectorCtx(mockD1(baseTables)),
      91,
      "BEDROCK",
      NOW,
      null,
    );

    expect(result.value?.psiPrecedent).toMatchObject({ lastSeenScore: 89, lastSeenBand: "STEADY" });
    expect(result.degradedReasons).toEqual([]);

    const noPrecedent = await collectHistoricalContext(
      makeCollectorCtx(mockD1(baseTables.map((table) =>
        table.match.includes("aggregateUniverse") ? { ...table, first: null } : table,
      ))),
      91,
      "BEDROCK",
      NOW,
      null,
    );
    expect(noPrecedent.value?.psiPrecedent).toBeNull();
    expect(noPrecedent.degradedReasons).toEqual([]);
  });

  it("scopes the PSI record-low window to the core-universe precedent search", async () => {
    const { sqlite, db } = createLatestSchemaSqlite();
    const DAY_SECONDS = 86_400;
    // 2026-07-15T00:00:00Z: new daily digests start carrying aggregateUniverse.
    const CORE_UNIVERSE_CUTOVER = 1_784_073_600;
    // 2026-10-30T00:00:00Z: fixed "today" for the digest run.
    const TODAY = 1_793_318_400;
    const DAYS_SINCE_CUTOVER = (TODAY - CORE_UNIVERSE_CUTOVER) / DAY_SECONDS;
    // Production daily rows never carry digest_meta.type (only weekly rows do),
    // so the non-weekly filter must not swallow the core-universe predicate.
    const DAILY_META = JSON.stringify({ editorialStyleVersion: 1, editorialStyleHash: "seed", styleGateMode: "enforce" });
    const insertDigest = (generatedAt: number, input: Record<string, unknown>) => {
      sqlite
        .prepare(
          `INSERT INTO daily_digest (generated_at, digest_text, input_data, digest_title, digest_extended, digest_meta)
           VALUES (?, ?, ?, ?, ?, ?)`,
        )
        .run(generatedAt, "seed edition", JSON.stringify(input), "Seed edition", "Seed extended", DAILY_META);
    };
    try {
      // Enough archived PSI days for historicalContext to be admitted (>30).
      for (let daysAgo = 0; daysAgo < 40; daysAgo += 1) {
        sqlite
          .prepare(
            `INSERT INTO stability_index (computed_at, score, band, components, input_snapshot, methodology_version)
             VALUES (?, ?, ?, ?, ?, ?)`,
          )
          .run(TODAY - daysAgo * DAY_SECONDS, 85, "STEADY", "{}", "{}", "3.0");
      }
      // The pre-cutover archive holds a lower PSI (70) than today's 75, but the
      // precedent query only searches core-marked rows, so it cannot see it.
      insertDigest(CORE_UNIVERSE_CUTOVER - 5 * DAY_SECONDS, {
        stabilityIndex: { score: 70, band: "TREMOR", components: { severity: 24, breadth: 6, trend: 0 } },
      });
      for (let index = 0; index < 7; index += 1) {
        insertDigest(CORE_UNIVERSE_CUTOVER + (index + 1) * 7 * DAY_SECONDS, {
          aggregateUniverse: "core-stablecoins-v1",
          stabilityIndex: { score: 80 + index, band: "STEADY", components: { severity: 12, breadth: 4, trend: 0 } },
        });
      }

      const ctx = makeCollectorCtx(db);
      ctx.nowSec = TODAY;
      ctx.todayTs = TODAY;
      const historical = await collectHistoricalContext(ctx, 75, "STEADY", TODAY, null);
      expect(historical.value).toBeDefined();

      const digestInput: DigestInputData = {
        totalMcapUsd: 0,
        mcap7dDelta: null,
        activeDepegCount: 0,
        biggestSupplyChange: null,
        topDepegs: [],
        stabilityIndex: { score: 75, band: "STEADY", components: { severity: 12, breadth: 4, trend: -2 } },
        yesterdayIndex: { score: 78, band: "STEADY" },
        historicalContext: historical.value,
      };
      const prompt = buildUserPrompt(digestInput);
      const claimLine = prompt
        .split("\n")
        .find((line) => line.toLowerCase().includes("lowest since digest tracking began"));
      expect(claimLine).toBeDefined();
      const windowMatch = /(\d+) days?/.exec(claimLine!.split("Current")[0] ?? "");
      expect(windowMatch).not.toBeNull();
      // The claim may not span pre-cutover editions the comparison never read.
      expect(Number(windowMatch?.[1])).toBeLessThanOrEqual(DAYS_SINCE_CUTOVER);
    } finally {
      sqlite.close();
    }
  });
});
