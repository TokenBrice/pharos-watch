import { describe, expect, it } from "vitest";
import { severityForFreezeBlocked } from "../../../lib/tape-event-helpers";
import { mockTapeD1, tapeInsertBindsForType } from "../../../lib/tape-projectors/__tests__/test-support";
import { projectFreezeBlocked } from "../../../lib/tape-projectors/freeze";
import { mockD1 } from "@shared/test-utils/mock-d1";
import { makeCollectorCtx } from "../../__tests__/daily-digest.test-support";
import { collectBlacklistActivity } from "../collectors-market";
import { collectHistoricalContext } from "../collectors-history";

const NOW = 1_800_000_000;

function blacklistDb(rows: Record<string, unknown>[]) {
  return mockD1([{ match: "FROM blacklist_events", rows }]);
}

describe("P0-18 daily digest data correctness", () => {

  it("keeps unknown blocked freezes below the highest known severity tier", () => {
    expect(severityForFreezeBlocked(null)).toBe("warning");
  });
  it("does not promote unfreeze rows into blacklist activity", async () => {

    const result = await collectBlacklistActivity(
      makeCollectorCtx(blacklistDb([
        { symbol: "USDC", chain_name: "Ethereum", event_type: "unblacklist", amount_usd_at_event: 50_000_000 },
        { symbol: "USDT", chain_name: "Ethereum", event_type: "unblacklist", amount_usd_at_event: 25_000_000 },
      ])),
    );

    expect(result).toEqual({ value: undefined, degradedReasons: [] });
  });
  it("marks a blocked tape event when its amount is unknown", async () => {
    const db = mockTapeD1([
      { match: "FROM cache WHERE key = ?", rows: [] },
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
      { match: "ORDER BY computed_at DESC LIMIT 90", rows: [{ computed_at: NOW, band: "BEDROCK" }] },
    ];
    const result = await collectHistoricalContext(
      makeCollectorCtx(mockD1(baseTables)),
      91,
      "BEDROCK",
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
      null,
    );
    expect(noPrecedent.value?.psiPrecedent).toBeNull();
    expect(noPrecedent.degradedReasons).toEqual([]);
  });
});
