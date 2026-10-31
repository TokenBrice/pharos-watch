import { describe, expect, it } from "vitest";
import { mockTapeD1, tapeInsertBindsForType } from "../../../lib/tape-projectors/__tests__/test-support";
import { projectFreezeBlocked } from "../../../lib/tape-projectors/freeze";
import { mockD1 } from "@shared/test-utils/mock-d1";
import { createLatestSchemaSqlite } from "@shared/test-utils/latest-schema-sqlite";
import type { DigestInputData } from "@shared/types/digest";
import { makeCollectorCtx } from "../../__tests__/daily-digest.test-support";
import { collectBlacklistActivity } from "../collectors-market";
import { collectHistoricalContext } from "../collectors-history";
import { buildUserPrompt } from "../prompt";

const NOW = 1_800_000_000;

function blacklistDb(rows: Record<string, unknown>[]) {
  return mockD1([{ match: "FROM blacklist_events", rows }]);
}

describe("P0-18 daily digest data correctness", () => {

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
      { match: "FROM blacklist_events AS b", rows: [] },
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
