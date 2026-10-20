import { readJsonResponse } from "../../test-helpers/__shared/auth";
import { afterEach, describe, it, expect } from "vitest";
import { mockD1 } from "@shared/test-utils/mock-d1";
import { handleDigestSnapshot } from "../digest-snapshot";
import { createLatestSchemaFixtureTracker } from "@shared/test-utils/latest-schema-sqlite";
import { DigestSnapshotResponseSchema } from "@shared/types/digest";

const fixtures = createLatestSchemaFixtureTracker();
afterEach(() => fixtures.closeAll());

const nowSec = Math.floor(Date.now() / 1000);
const todayStr = new Date(nowSec * 1000).toISOString().slice(0, 10);

describe("handleDigestSnapshot", () => {
  it("returns 400 when date param is missing", async () => {
    const db = mockD1();
    const res = await handleDigestSnapshot(db, new URL("https://x/api/digest-snapshot"));
    expect(res.status).toBe(400);
  });

  it("returns 400 for invalid date format", async () => {
    const db = mockD1();
    const res = await handleDigestSnapshot(db, new URL("https://x/api/digest-snapshot?date=not-a-date"));
    expect(res.status).toBe(400);
  });

  it("returns 404 when no digest found for date", async () => {
    const db = mockD1([
      { match: "daily_digest", rows: [] },
    ]);
    const res = await handleDigestSnapshot(db, new URL(`https://x/api/digest-snapshot?date=${todayStr}`));
    expect(res.status).toBe(404);
  });

  it("returns 200 with snapshot data when digest exists", async () => {
    const dayStart = Math.floor(new Date(`${todayStr}T00:00:00Z`).getTime() / 1000);
    const digestRow = {
      generated_at: dayStart + 3600, // 1 hour after midnight
      input_data: JSON.stringify({ totalMcapUsd: 100e9, mcap7dDelta: 5 }),
    };
    const db = mockD1([
      { match: "daily_digest", rows: [digestRow] },
      { match: "depeg_events", rows: [] },
      { match: "digest-snapshot:blacklist-summary", rows: [{ total_events: 0, valued_events: 0, known_amount_usd: null }] },
      { match: "blacklist_events", rows: [] },
    ]);
    const res = await handleDigestSnapshot(db, new URL(`https://x/api/digest-snapshot?date=${todayStr}`));
    const body = (await readJsonResponse(res, 200)) as {
      date: string;
      inputData: Record<string, unknown>;
      depegEvents: unknown[];
      blacklistEvents: unknown[];
    };
    expect(body.date).toBe(todayStr);
    expect(body).toHaveProperty("inputData");
    expect(body).toHaveProperty("depegEvents");
    expect(body).toHaveProperty("blacklistEvents");
  });

  it("extracts last daily inputData from weekly recap input_data", async () => {
    const dayStart = Math.floor(new Date(`${todayStr}T00:00:00Z`).getTime() / 1000);
    const weeklyInputData = {
      weekStartDate: "2026-03-10",
      weekEndDate: "2026-03-16",
      dailyDigests: [
        { date: "2026-03-10", title: "Day 1", text: "...", inputData: { totalMcapUsd: 90e9, mcap7dDelta: 1 } },
        { date: "2026-03-14", title: "Day 5", text: "...", inputData: { totalMcapUsd: 95e9, mcap7dDelta: 3 } },
        { date: "2026-03-16", title: "Day 7", text: "...", inputData: { totalMcapUsd: 100e9, mcap7dDelta: 5 } },
      ],
    };
    const digestRow = {
      generated_at: dayStart + 3600,
      input_data: JSON.stringify(weeklyInputData),
    };
    const db = mockD1([
      { match: "daily_digest", rows: [digestRow] },
      { match: "depeg_events", rows: [] },
      { match: "digest-snapshot:blacklist-summary", rows: [{ total_events: 0, valued_events: 0, known_amount_usd: null }] },
      { match: "blacklist_events", rows: [] },
    ]);
    const res = await handleDigestSnapshot(db, new URL(`https://x/api/digest-snapshot?date=${todayStr}`));
    const body = (await readJsonResponse(res, 200)) as {
      inputData: { totalMcapUsd: number; mcap7dDelta: number } | null;
      prevInputData: { totalMcapUsd: number; mcap7dDelta: number } | null;
    };
    // Should extract last daily (end-of-week) as inputData
    expect(body.inputData?.totalMcapUsd).toBe(100e9);
    expect(body.inputData?.mcap7dDelta).toBe(5);
    // Should extract first daily (start-of-week) as prevInputData
    expect(body.prevInputData?.totalMcapUsd).toBe(90e9);
  });

  it("uses the requested digest type when daily and weekly rows share a date", async () => {
    const dayStart = Math.floor(new Date(`${todayStr}T00:00:00Z`).getTime() / 1000);
    const dailyRow = {
      generated_at: dayStart + 3600,
      input_data: JSON.stringify({ totalMcapUsd: 100e9, mcap7dDelta: 1 }),
    };
    const weeklyRow = {
      generated_at: dayStart + 7200,
      input_data: JSON.stringify({
        dailyDigests: [
          { inputData: { totalMcapUsd: 90e9, mcap7dDelta: 1 } },
          { inputData: { totalMcapUsd: 110e9, mcap7dDelta: 2 } },
        ],
      }),
    };
    const db = mockD1([
      { match: "json_extract(digest_meta, '$.type') = 'weekly'", rows: [], first: weeklyRow },
      { match: "digest_meta IS NULL OR json_extract", rows: [], first: dailyRow },
      { match: "depeg_events", rows: [] },
      { match: "digest-snapshot:blacklist-summary", rows: [{ total_events: 0, valued_events: 0, known_amount_usd: null }] },
      { match: "blacklist_events", rows: [] },
    ]);

    const dailyRes = await handleDigestSnapshot(db, new URL(`https://x/api/digest-snapshot?date=${todayStr}`));
    const weeklyRes = await handleDigestSnapshot(db, new URL(`https://x/api/digest-snapshot?date=${todayStr}-weekly`));

    const dailyBody = await readJsonResponse(dailyRes, 200) as { inputData: { totalMcapUsd: number } | null };
    const weeklyBody = await readJsonResponse(weeklyRes, 200) as { inputData: { totalMcapUsd: number } | null };
    expect(dailyBody.inputData?.totalMcapUsd).toBe(100e9);
    expect(weeklyBody.inputData?.totalMcapUsd).toBe(110e9);
  });

  it("returns null inputData when the stored blob fails the shape guard", async () => {
    const dayStart = Math.floor(new Date(`${todayStr}T00:00:00Z`).getTime() / 1000);
    const db = mockD1([
      {
        match: "daily_digest",
        rows: [{
          generated_at: dayStart + 3600,
          // Malformed / old-schema row: no numeric totalMcapUsd anchor.
          input_data: JSON.stringify({ legacyShape: true, mcap7dDelta: 5 }),
        }],
      },
      { match: "depeg_events", rows: [] },
      { match: "digest-snapshot:blacklist-summary", rows: [{ total_events: 0, valued_events: 0, known_amount_usd: null }] },
      { match: "blacklist_events", rows: [] },
    ]);
    const res = await handleDigestSnapshot(db, new URL(`https://x/api/digest-snapshot?date=${todayStr}`));
    const body = (await readJsonResponse(res, 200)) as { inputData: unknown };
    expect(body.inputData).toBeNull();
  });

  it.each([
    [0, { complete: false, observedCount: 0, unavailableCount: 2 }],
    [100e9, { complete: false, observedCount: 1, unavailableCount: 1 }],
    [100e9, undefined],
  ])("preserves optional captured supply coverage without upgrading legacy proof", async (totalMcapUsd, supplyCoverage) => {
    const { sqlite, db } = fixtures.open();
    const day = Date.parse("2026-10-01T00:00:00Z") / 1000;
    sqlite.prepare("INSERT INTO daily_digest (generated_at, digest_text, input_data) VALUES (?, '', ?)")
      .run(day + 3600, JSON.stringify({ totalMcapUsd, supplyCoverage }));
    const body = DigestSnapshotResponseSchema.parse(await (await handleDigestSnapshot(
      db, new URL("https://x/api/digest-snapshot?date=2026-10-01"),
    )).json());
    expect(body.inputData?.totalMcapUsd).toBe(totalMcapUsd);
    expect(body.inputData?.supplyCoverage).toEqual(supplyCoverage);
    expect(body.comparison).toBeNull();
  });

  it.each([
    { complete: true, observedCount: 2, unavailableCount: 1 },
    { complete: false, observedCount: -1, unavailableCount: 2 },
    { complete: true, observedCount: 2, unavailableCount: 0, memberFingerprint: "not-a-hash" },
  ])("withholds malformed supply proof at the snapshot boundary", async (supplyCoverage) => {
    const { sqlite, db } = fixtures.open();
    sqlite.prepare("INSERT INTO daily_digest (generated_at, digest_text, input_data) VALUES (?, '', ?)")
      .run(Date.parse("2026-10-01T01:00:00Z") / 1000, JSON.stringify({ totalMcapUsd: 100e9, supplyCoverage }));
    const body = DigestSnapshotResponseSchema.parse(await (await handleDigestSnapshot(
      db, new URL("https://x/api/digest-snapshot?date=2026-10-01"),
    )).json());
    expect(body.inputData).toBeNull();
    expect(body.comparison).toBeNull();
  });

  it.each(["matched", "changed", "partial", "legacy", "counts-only"])(
    "returns the actual skipped-day endpoint and requires cohort proof (%s)",
    async (kind) => {
      const { sqlite, db } = fixtures.open();
      const day = Date.parse("2026-10-01T00:00:00Z") / 1000;
      const coverage = { complete: true, observedCount: 2, unavailableCount: 0, memberFingerprint: "a".repeat(64) };
      const priorCoverage = kind === "legacy" ? undefined
        : kind === "changed" ? { ...coverage, memberFingerprint: "b".repeat(64) }
          : kind === "partial" ? { ...coverage, complete: false, observedCount: 1, unavailableCount: 1 }
            : kind === "counts-only" ? { complete: true, observedCount: 2, unavailableCount: 0 }
              : coverage;
      const insert = sqlite.prepare("INSERT INTO daily_digest (generated_at, digest_text, input_data) VALUES (?, '', ?)");
      insert.run(day - 2 * 86400 + 3600, JSON.stringify({
        aggregateUniverse: "core-stablecoins-v1", totalMcapUsd: 90e9, supplyCoverage: priorCoverage,
      }));
      insert.run(day + 3600, JSON.stringify({
        aggregateUniverse: "core-stablecoins-v1", totalMcapUsd: 100e9, supplyCoverage: coverage,
      }));
      const body = DigestSnapshotResponseSchema.parse(await (await handleDigestSnapshot(
        db, new URL("https://x/api/digest-snapshot?date=2026-10-01"),
      )).json());
      expect(body.comparison).toEqual({
        fromDate: "2026-09-29", toDate: "2026-10-01", supplyComparable: kind === "matched",
      });
    },
  );

  it.each([true, false])("keeps weekly first-to-last endpoint semantics only with known dates (%s)", async (dated) => {
    const { sqlite, db } = fixtures.open();
    const supplyCoverage = { complete: true, observedCount: 2, unavailableCount: 0, memberFingerprint: "a".repeat(64) };
    sqlite.prepare("INSERT INTO daily_digest (generated_at, digest_text, digest_meta, input_data) VALUES (?, '', ?, ?)")
      .run(Date.parse("2026-10-05T08:00:00Z") / 1000, '{"type":"weekly"}', JSON.stringify({
        dailyDigests: [
          { ...(dated ? { date: "2026-09-29" } : {}), inputData: { aggregateUniverse: "core-stablecoins-v1", totalMcapUsd: 90e9, supplyCoverage } },
          { ...(dated ? { date: "2026-10-05" } : {}), inputData: { aggregateUniverse: "core-stablecoins-v1", totalMcapUsd: 100e9, supplyCoverage } },
        ],
      }));
    const body = DigestSnapshotResponseSchema.parse(await (await handleDigestSnapshot(
      db, new URL("https://x/api/digest-snapshot?date=2026-10-05-weekly"),
    )).json());
    expect(body.inputData?.totalMcapUsd).toBe(100e9);
    expect(body.prevInputData?.totalMcapUsd).toBe(90e9);
    expect(body.comparison).toEqual(dated
      ? { fromDate: "2026-09-29", toDate: "2026-10-05", supplyComparable: true } : null);
  });

  it("orders snapshot depeg events by absolute deviation", async () => {
    const dayStart = Math.floor(new Date(`${todayStr}T00:00:00Z`).getTime() / 1000);
    const { sqlite, db } = fixtures.open();
    sqlite.prepare("INSERT INTO daily_digest (generated_at, digest_text, input_data) VALUES (?, '', ?)")
      .run(dayStart + 3600, JSON.stringify({ totalMcapUsd: 100e9 }));
    const insert = sqlite.prepare(`INSERT INTO depeg_events
      (stablecoin_id, symbol, peg_type, direction, peak_deviation_bps, started_at, ended_at, start_price, peg_reference)
      VALUES (?, 'TEST', 'peggedUSD', ?, ?, ?, ?, 1, 1)`);
    insert.run("small", "above", 100, dayStart, null);
    insert.run("negative", "below", -900, dayStart - 100, null);
    insert.run("positive", "above", 500, dayStart, null);
    insert.run("future", "below", -2000, dayStart + 86400, null);
    insert.run("closed", "below", -3000, dayStart - 1000, dayStart - 1);
    const body = await readJsonResponse<{ depegEvents: { stablecoinId: string; peakDeviationBps: number }[] }>(
      await handleDigestSnapshot(db, new URL(`https://x/api/digest-snapshot?date=${todayStr}`)), 200);
    expect(body.depegEvents.map((event) => [event.stablecoinId, event.peakDeviationBps]))
      .toEqual([["negative", -900], ["positive", 500], ["small", 100]]);
  });

  it("counts the full daily blacklist cohort beyond the 50-row sample with partial valuation", async () => {
    const day = Date.parse("2026-10-01T00:00:00Z") / 1000;
    const { sqlite, db } = fixtures.open();
    sqlite.prepare("INSERT INTO daily_digest (generated_at, digest_text, input_data) VALUES (?, '', ?)")
      .run(day + 3600, JSON.stringify({ totalMcapUsd: 100e9 }));
    const insert = sqlite.prepare(`INSERT INTO blacklist_events
      (id, stablecoin, chain_id, chain_name, event_type, address, tx_hash, block_number,
       timestamp, amount_usd_at_event, amount_status, explorer_tx_url, explorer_address_url, suppression_reason)
      VALUES (?, 'USDC', 'ethereum', 'Ethereum', 'blacklist', ?, ?, 1, ?, ?, 'resolved', '', '', ?)`);
    for (let i = 0; i < 52; i++) insert.run(`event-${i}`, `address-${i}`, `tx-${i}`, day + i, i < 50 ? 10 : null, null);
    insert.run("suppressed", "other", "other", day + 60, 1000, "duplicate");
    insert.run("outside", "outside", "outside", day + 86400, 1000, null);
    const body = await readJsonResponse<{
      blacklistEvents: Array<{ address: string }>;
      blacklistSummary: { totalEvents: number; knownAmountUsd: number | null; valuedEvents: number; unavailableAmountEvents: number };
    }>(await handleDigestSnapshot(db, new URL("https://x/api/digest-snapshot?date=2026-10-01")), 200);
    expect(body.blacklistEvents).toHaveLength(50);
    expect(body.blacklistEvents[0].address).toBe("address-51");
    expect(body.blacklistSummary).toEqual({ totalEvents: 52, knownAmountUsd: 500, valuedEvents: 50, unavailableAmountEvents: 2 });
  });
});
