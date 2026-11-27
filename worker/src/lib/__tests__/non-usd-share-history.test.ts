import { afterEach, describe, expect, it, vi } from "vitest";
import { CORE_AGGREGATE_ACTIVE_STABLECOINS } from "@shared/lib/stablecoins/aggregate-registry";
import { mockD1 as baseMockD1 } from "@shared/test-utils/mock-d1";
import { createLatestSchemaFixtureTracker } from "@shared/test-utils/latest-schema-sqlite";
import {
  CORE_STABLECOIN_AGGREGATE_UNIVERSE, CORE_STABLECOIN_AGGREGATE_UNIVERSE_V1,
  CORE_STABLECOIN_AGGREGATE_V2_CUTOVER_DATE, CORE_STABLECOIN_AGGREGATE_V2_CUTOVER_SEC,
} from "@shared/lib/stablecoins/aggregate-universe";
import { CORE_AGGREGATE_V1_MEMBER_LIST, CORE_AGGREGATE_V1_NON_ACTIVE_MEMBER_LIST } from "@shared/lib/stablecoins/aggregate-universe-v1";
import {
  buildNonUsdShareCoreMembers, computeNonUsdShareHistory, sampleNonUsdShareHistory, publishNonUsdShareHistory,
  readNonUsdShareHistory, NON_USD_SHARE_COHORT_IDENTITY, NON_USD_SHARE_HISTORY_KEY,
} from "../non-usd-share-history";
import { D1_MAX_BOUND_PARAMETERS } from "../../lib/db";
import { SUPPLY_HISTORY_UPSERT_SQL, writeSupplyHistoryBatch } from "../supply-history-db";

function mockD1(tables: Parameters<typeof baseMockD1>[0]) {
  const db = baseMockD1(tables);
  db.batch = async <T>(statements: Parameters<typeof db.batch>[0]) => Promise.all(statements.map((s) => s.all<T>()));
  return db;
}

const fixtures = createLatestSchemaFixtureTracker();
const COIN_HISTORY_GAPS = { match: "LEAD(snapshot_date)", rows: [] };
const COMPLETE_COVERAGE = { basis: "interior-gap-prior-value", total: 1, commodity: 1, fiatNonUsd: 1 };
const unix = (iso: string) => Math.floor(new Date(iso).getTime() / 1000);
const COMMODITY_PEGS = new Set(["GOLD", "SILVER"]);
const COMMODITY_IDS = CORE_AGGREGATE_ACTIVE_STABLECOINS.filter((c) => COMMODITY_PEGS.has(c.flags.pegCurrency)).map((c) => c.id);
const FIAT_NON_USD_IDS = CORE_AGGREGATE_ACTIVE_STABLECOINS.filter((c) => c.flags.pegCurrency !== "USD" && !COMMODITY_PEGS.has(c.flags.pegCurrency)).map((c) => c.id);
const USD_IDS = CORE_AGGREGATE_ACTIVE_STABLECOINS.filter((c) => c.flags.pegCurrency === "USD").map((c) => c.id);

async function computeHistory(db: D1Database, days = 5000) {
  const nowSec = Math.floor(Date.now() / 1000);
  const cutoff = nowSec - days * 86400;
  return sampleNonUsdShareHistory((await computeNonUsdShareHistory(db, nowSec, cutoff)).points, cutoff, nowSec);
}

describe("non-USD share chronological sampling parity", () => {
  it("retains inclusive 90d/2y spacing, cutoff, duplicate precedence and no forced latest point", () => {
    const now = 1_800_000_000;
    const ages = [800, 799, 770, 740, 731, 730, 729, 723, 100, 96, 91, 90, 89, 88, 88, 87.5, 87, 0.5, 0];
    const points = ages.map((age, index) => ({
      date: now - age * 86400, total: 100 + index,
      commodity: 0, fiatNonUsd: 0, commodityShare: 0, fiatNonUsdShare: 0,
    }));
    const kept = [0, 2, 3, 5, 7, 8, 10, 11, 12, 13, 16, 17].map((index) => points[index]);
    expect(JSON.stringify(sampleNonUsdShareHistory(points, 0, now))).toBe(JSON.stringify(kept));
    expect(JSON.stringify(sampleNonUsdShareHistory(points, now - 740 * 86400, now)))
      .toBe(JSON.stringify(kept.slice(2)));
  });
});

describe("non-USD share producer aggregation", () => {
  afterEach(() => {
    fixtures.closeAll();
    vi.restoreAllMocks();
  });


  it.each(["commodity", "fiat_non_usd"])("rejects a missing %s cohort instead of publishing a zero share", async (field) => {
    const db = mockD1([
      { match: "FROM cache", rows: [] },
      COIN_HISTORY_GAPS,
      { match: "FROM supply_history", rows: [
        { snapshot_date: Math.floor(Date.now() / 1000), total: 100, commodity: 0, fiat_non_usd: 0, [field]: null },
      ] },
    ]);
    await expect(computeHistory(db)).rejects.toThrow("non-usd-share:invalid-history");
  });

  it("preserves an observed zero cohort in the public schema", async () => {
    const date = Math.floor(Date.now() / 1000);
    const db = mockD1([
      { match: "FROM cache", rows: [] },
      COIN_HISTORY_GAPS,
      { match: "FROM supply_history", rows: [
        { snapshot_date: date, total: 100, commodity: 0, fiat_non_usd: 0 },
      ] },
    ]);
    expect(await computeHistory(db)).toEqual([
      { date, total: 100, commodity: 0, fiatNonUsd: 0, commodityShare: 0, fiatNonUsdShare: 0, coverage: COMPLETE_COVERAGE },
    ]);
  });

  it("carries admitted partial cohort value coverage without changing the suppression floors", async () => {
    const date = Math.floor(Date.now() / 1000) - 86400;
    const db = mockD1([
      { match: "FROM cache", rows: [] },
      { match: "LEAD(snapshot_date)", rows: [
        { stablecoin_id: COMMODITY_IDS[0], previous_date: date - 86400, next_date: date + 86400, previous_usd: 10 },
        { stablecoin_id: FIAT_NON_USD_IDS[0], previous_date: date - 86400, next_date: date + 86400, previous_usd: 15 },
      ] },
      { match: "FROM supply_history", rows: [
        { snapshot_date: date, total: 990, commodity: 10, fiat_non_usd: 15 },
      ] },
    ]);
    const body = await computeHistory(db);
    expect(body).toHaveLength(1);
    expect(body[0].coverage).toEqual({
      basis: "interior-gap-prior-value", total: 990 / 1015, commodity: 0.5, fiatNonUsd: 0.5,
    });
    expect(body[0].commodityShare).toBe(1.0101);
  });

  it("requests the default long-range window and returns split non-USD shares within D1 bind limits", async () => {
    const nowMs = Date.UTC(2026, 3, 8, 12, 0, 0);
    const cutoff = Math.floor(nowMs / 1000) - 5000 * 86400;
    const completedSnapshotDate = unix("2026-04-07T00:00:00Z");
    vi.spyOn(Date, "now").mockReturnValue(nowMs);

    const db = mockD1([
      {
        match: "FROM cache", matchBinds: ["snapshot-supply:last-write"],
        rows: [{ key: "snapshot-supply:last-write", value: JSON.stringify({ snapshotDate: completedSnapshotDate }), updated_at: Math.floor(nowMs / 1000) - 600 }],
        first: { key: "snapshot-supply:last-write", value: JSON.stringify({ snapshotDate: completedSnapshotDate }), updated_at: Math.floor(nowMs / 1000) - 600 },
      },
      COIN_HISTORY_GAPS,
      {
        match: "FROM supply_history",
        rows: [
          { snapshot_date: unix("2021-04-10T00:00:00Z"), total: 64_785_915_681.46, commodity: 1_873_999_608.17, fiat_non_usd: 132_274_790.42 },
          { snapshot_date: unix("2024-06-04T00:00:00Z"), total: 162_264_669_603.31, commodity: 2_812_795_250.77, fiat_non_usd: 352_546_495.83 },
          { snapshot_date: unix("2026-04-07T00:00:00Z"), total: 327_905_730_184.74, commodity: 5_936_875_143.74, fiat_non_usd: 1_826_608_786.57 },
        ],
      },
    ]);

    const body = await computeHistory(db);
    const aggregate = db.getHistory().find((entry) => entry.sql.includes("GROUP BY snapshot_date"));
    expect(aggregate?.binds.slice(1)).toEqual([cutoff, completedSnapshotDate]);
    expect(JSON.parse(String(aggregate?.binds[0]))["aeur-anchored-coins"]).toEqual({ bucket: "fiat-non-usd", inactiveFrom: unix("2026-07-11T00:00:00Z") });
    expect(db.getHistory().filter((entry) => entry.sql.includes("FROM supply_history")).every((entry) => entry.binds.length <= D1_MAX_BOUND_PARAMETERS)).toBe(true);

    expect(body).toEqual([
      { date: unix("2021-04-10T00:00:00Z"), commodityShare: 2.8926, fiatNonUsdShare: 0.2042, commodity: 1_873_999_608.17, fiatNonUsd: 132_274_790.42, total: 64_785_915_681.46, coverage: COMPLETE_COVERAGE },
      { date: unix("2024-06-04T00:00:00Z"), commodityShare: 1.7335, fiatNonUsdShare: 0.2173, commodity: 2_812_795_250.77, fiatNonUsd: 352_546_495.83, total: 162_264_669_603.31, coverage: COMPLETE_COVERAGE },
      { date: unix("2026-04-07T00:00:00Z"), commodityShare: 1.8105, fiatNonUsdShare: 0.5571, commodity: 5_936_875_143.74, fiatNonUsd: 1_826_608_786.57, total: 327_905_730_184.74, coverage: COMPLETE_COVERAGE },
    ]);
    db.assertAllMatchesUsed();
  });

  describe("partial snapshot days", () => {
    const [largeUsdId, smallUsdId] = USD_IDS;
    const commodityId = COMMODITY_IDS[0]!;
    const fiatId = FIAT_NON_USD_IDS[0]!;
    const completeDay: Record<string, number> = {
      [largeUsdId!]: 940,
      [smallUsdId!]: 10,
      [commodityId]: 20,
      [fiatId]: 30,
    };
    const before = unix("2026-08-05T00:00:00Z");
    const partial = unix("2026-08-06T00:00:00Z");
    const after = unix("2026-08-07T00:00:00Z");

    it("includes dated frozen coins before freeze and ends their coverage obligation at freeze", async () => {
      const { db, sqlite } = fixtures.open();
      const frozenAt = unix("2026-07-11T00:00:00Z");
      const day = 86_400;
      const insert = sqlite.prepare("INSERT INTO supply_history (stablecoin_id, snapshot_date, circulating_usd) VALUES (?, ?, ?)");
      for (const date of [frozenAt - 3 * day, frozenAt - 2 * day, frozenAt - day, frozenAt]) {
        insert.run(largeUsdId!, date, 10_000_000);
        if (date !== frozenAt - 2 * day) insert.run("aeur-anchored-coins", date, 1_117_775.59);
      }
      const { points } = await computeNonUsdShareHistory(db, frozenAt + 600, frozenAt - 3 * day);
      expect(points.map(({ date, fiatNonUsd, total }) => [date, fiatNonUsd, total])).toEqual([
        [frozenAt - 3 * day, 1_117_775.59, 11_117_775.59],
        [frozenAt - day, 1_117_775.59, 11_117_775.59],
        [frozenAt, 0, 10_000_000],
      ]);
    });

    it("omits the first window date when a dominant asset's predecessor is before cutoff", async () => {
      vi.spyOn(Date, "now").mockReturnValue((before + 30 * 86400 + 12 * 3600) * 1000);
      const { db, sqlite } = fixtures.open();
      const insert = sqlite.prepare("INSERT INTO supply_history (stablecoin_id, snapshot_date, circulating_usd, price) VALUES (?, ?, ?, 1)");
      for (const date of [before, partial, after]) {
        for (const [id, value] of Object.entries(completeDay)) {
          if (date === partial && id === largeUsdId) continue;
          insert.run(id, date, value);
        }
      }
      const body = await computeHistory(db, 30);
      expect(body.map(point => point.date)).toEqual([after]);
      expect(body[0]!.total).toBe(1000);
    });

    it.each([
      { name: "a small asset's hole", missing: [smallUsdId!], published: true },
      { name: "every asset but one small row", missing: [largeUsdId!, commodityId, fiatId], published: false },
      { name: "the dominant asset", missing: [largeUsdId!], published: false },
      { name: "a whole commodity cohort", missing: [commodityId], published: false },
      { name: "a whole fiat non-USD cohort", missing: [fiatId], published: false },
    ])("publishes a day missing $name only while coverage floors hold", async ({ missing, published }) => {
      vi.spyOn(Date, "now").mockReturnValue((after + 12 * 3600) * 1000);
      const { db, sqlite } = fixtures.open();
      const insert = sqlite.prepare(
        "INSERT INTO supply_history (stablecoin_id, snapshot_date, circulating_usd, price) VALUES (?, ?, ?, 1)",
      );
      for (const date of [before, partial, after]) {
        for (const [stablecoinId, circulatingUsd] of Object.entries(completeDay)) {
          if (date === partial && missing.includes(stablecoinId)) continue;
          insert.run(stablecoinId, date, circulatingUsd);
        }
      }

      const body = await computeHistory(db);

      expect(body.map((point) => point.date)).toEqual(published ? [before, partial, after] : [before, after]);
      if (published) expect(body.find((point) => point.date === partial)?.coverage).toEqual({
        basis: "interior-gap-prior-value", total: 0.99, commodity: 1, fiatNonUsd: 1,
      });
      expect(body.find((point) => point.date === before)).toEqual({
        date: before,
        total: 1000,
        commodity: 20,
        fiatNonUsd: 30,
        commodityShare: 2,
        fiatNonUsdShare: 3,
        coverage: COMPLETE_COVERAGE,
      });
    });

    it.each([
      { name: "a small asset", missing: smallUsdId!, published: true },
      { name: "the dominant asset", missing: largeUsdId!, published: false },
    ])("counts $name absent from the latest day with no later row", async ({ missing, published }) => {
      vi.spyOn(Date, "now").mockReturnValue((partial + 12 * 3600) * 1000);
      const { db, sqlite } = fixtures.open();
      const insert = sqlite.prepare(
        "INSERT INTO supply_history (stablecoin_id, snapshot_date, circulating_usd, price) VALUES (?, ?, ?, 1)",
      );
      for (const date of [before, partial]) {
        for (const [stablecoinId, circulatingUsd] of Object.entries(completeDay)) {
          if (date === partial && stablecoinId === missing) continue;
          insert.run(stablecoinId, date, circulatingUsd);
        }
      }

      const body = await computeHistory(db);

      expect(body.map((point) => point.date)).toEqual(published ? [before, partial] : [before]);
      if (published) expect(body.find((point) => point.date === partial)?.coverage).toEqual({
        basis: "interior-gap-prior-value", total: 0.99, commodity: 1, fiatNonUsd: 1,
      });
    });
  });

  it("publishes only once per exact source marker and rebuilds a same-second replacement", async () => {
    const { db, sqlite } = fixtures.open();
    const now = Math.floor(Date.now() / 1000);
    const date = Math.floor(now / 86400) * 86400;
    sqlite.prepare("INSERT INTO supply_history (stablecoin_id, snapshot_date, circulating_usd) VALUES ('usdt-tether', ?, 100)").run(date);
    const source = (generationId: string) => JSON.stringify({ snapshotDate: date, generationId });
    sqlite.prepare("INSERT INTO cache (key, value, updated_at) VALUES ('snapshot-supply:last-write', ?, ?)").run(source("first"), now);
    await publishNonUsdShareHistory(db, now);
    const prepare = vi.spyOn(db, "prepare");
    await publishNonUsdShareHistory(db, now + 60);
    expect(prepare.mock.calls.every(([sql]) => !sql.includes("supply_history"))).toBe(true);
    sqlite.prepare("UPDATE supply_history SET circulating_usd = 200").run();
    sqlite.prepare("UPDATE cache SET value = ? WHERE key = 'snapshot-supply:last-write'").run(source("second"));
    expect(await readNonUsdShareHistory(db)).toMatchObject({ status: "invalid" });
    await publishNonUsdShareHistory(db, now + 60);
    expect(await readNonUsdShareHistory(db)).toMatchObject({ updatedAt: now, points: [{ total: 200 }] });
  });

  it("does not publish when a concurrent replacement wins after the history read", async () => {
    const { db, sqlite } = fixtures.open();
    const now = Math.floor(Date.now() / 1000);
    const date = Math.floor(now / 86400) * 86400;
    sqlite.prepare("INSERT INTO supply_history (stablecoin_id, snapshot_date, circulating_usd) VALUES ('usdt-tether', ?, 100)").run(date);
    sqlite.prepare("INSERT INTO cache (key, value, updated_at) VALUES ('snapshot-supply:last-write', ?, ?)").run(
      JSON.stringify({ snapshotDate: date, generationId: "first" }), now,
    );
    const batch = db.batch.bind(db);
    vi.spyOn(db, "batch").mockImplementation(async (statements) => {
      const results = await batch(statements);
      sqlite.prepare("UPDATE cache SET value = ? WHERE key = 'snapshot-supply:last-write'").run(
        JSON.stringify({ snapshotDate: date, generationId: "second" }),
      );
      return results;
    });
    await expect(publishNonUsdShareHistory(db, now)).rejects.toThrow("non-usd-share:source-generation-changed");
    expect(sqlite.prepare("SELECT value FROM cache WHERE key = ?").get(NON_USD_SHARE_HISTORY_KEY)).toBeUndefined();
  });

  it("does not turn a missing source marker into an empty publication", async () => {
    const { db } = fixtures.open();
    await expect(publishNonUsdShareHistory(db, Math.floor(Date.now() / 1000)))
      .rejects.toThrow("non-usd-share:source-marker-unavailable");
  });

  it("atomically invalidates a published basis during historical backfill without renewing its clock", async () => {
    const { db, sqlite } = fixtures.open();
    const now = Math.floor(Date.now() / 1000);
    const date = Math.floor(now / 86400) * 86400;
    sqlite.prepare("INSERT INTO supply_history (stablecoin_id, snapshot_date, circulating_usd) VALUES ('usdt-tether', ?, 100)").run(date);
    sqlite.prepare("INSERT INTO cache (key, value, updated_at) VALUES ('snapshot-supply:last-write', ?, ?)").run(
      JSON.stringify({ snapshotDate: date, generationId: "daily-generation" }), now,
    );
    await publishNonUsdShareHistory(db, now);
    await writeSupplyHistoryBatch(db, [db.prepare(SUPPLY_HISTORY_UPSERT_SQL).bind("usdt-tether", date, 300, 1)]);
    expect(await readNonUsdShareHistory(db)).toMatchObject({ status: "invalid" });
    expect(sqlite.prepare("SELECT updated_at FROM cache WHERE key = 'snapshot-supply:last-write'").get())
      .toEqual({ updated_at: now });
    await publishNonUsdShareHistory(db, now + 900);
    expect(await readNonUsdShareHistory(db)).toMatchObject({ updatedAt: now, points: [{ total: 300 }] });
  });

  it("reports cohort-mismatch for a valid matching-marker row from a prior cohort and rebuilds on publish", async () => {
    const { db, sqlite } = fixtures.open();
    const now = Math.floor(Date.now() / 1000);
    const date = Math.floor(now / 86400) * 86400;
    sqlite.prepare("INSERT INTO supply_history (stablecoin_id, snapshot_date, circulating_usd) VALUES ('usdt-tether', ?, 100)").run(date);
    sqlite.prepare("INSERT INTO cache (key, value, updated_at) VALUES ('snapshot-supply:last-write', ?, ?)").run(
      JSON.stringify({ snapshotDate: date, generationId: "cohort-rollout" }), now,
    );
    await publishNonUsdShareHistory(db, now);
    const row = sqlite.prepare("SELECT value FROM cache WHERE key = ?").get(NON_USD_SHARE_HISTORY_KEY) as { value: string };
    const payload = JSON.parse(row.value) as Record<string, unknown>;
    payload.cohortIdentity = "prior-deploy-cohort";
    sqlite.prepare("UPDATE cache SET value = ? WHERE key = ?").run(JSON.stringify(payload), NON_USD_SHARE_HISTORY_KEY);

    expect(await readNonUsdShareHistory(db)).toEqual({ status: "cohort-mismatch", points: null, updatedAt: null });

    for (const blankIdentity of ["", "   \t\n"]) {
      payload.cohortIdentity = blankIdentity;
      sqlite.prepare("UPDATE cache SET value = ? WHERE key = ?").run(JSON.stringify(payload), NON_USD_SHARE_HISTORY_KEY);
      expect(await readNonUsdShareHistory(db)).toEqual({ status: "invalid", points: null, updatedAt: null });
    }

    payload.cohortIdentity = "prior-deploy-cohort";
    sqlite.prepare("UPDATE cache SET value = ? WHERE key = ?").run(JSON.stringify(payload), NON_USD_SHARE_HISTORY_KEY);
    await publishNonUsdShareHistory(db, now + 60);
    expect(await readNonUsdShareHistory(db)).toMatchObject({ status: "ok", updatedAt: now, points: [{ total: 100 }] });
  });

  it("fences pre-cutover dates to frozen v1 membership and post-cutover dates to current membership", async () => {
    const { db, sqlite } = fixtures.open();
    const cutover = CORE_STABLECOIN_AGGREGATE_V2_CUTOVER_SEC;
    const day = 86_400;
    const members = buildNonUsdShareCoreMembers({
      coins: [
        { id: "usdt-tether", status: "active", flags: { pegCurrency: "USD" } as never },
        { id: "eutbl-spiko", status: "active", flags: { pegCurrency: "EUR" } as never },
        { id: "eursafo-spiko", status: "delisted", flags: { pegCurrency: "EUR" } as never },
        { id: "fpi-frax", status: "frozen", frozenAt: "2026-06-28", flags: { pegCurrency: "VAR" } as never },
        { id: "eurc-circle", status: "active", flags: { pegCurrency: "EUR" } as never },
        { id: "gldy-example", status: "active", flags: { pegCurrency: "GOLD" } as never },
      ],
      v1ActiveIds: new Set(["usdt-tether", "eutbl-spiko", "eursafo-spiko", "fpi-frax", "eurc-circle"]),
      v1NonActiveIds: new Set(),
      currentCoreIds: new Set(["usdt-tether", "eurc-circle", "gldy-example", "fpi-frax"]),
      cutoverSec: cutover,
    });
    // Backdated frozenAt on a v1 active member (fpi-frax) must not restate pre-cutover history.
    expect(members.get("fpi-frax")).toEqual({ bucket: "fiat-non-usd", inactiveFrom: cutover });
    expect(members.get("eutbl-spiko")).toEqual({ bucket: "fiat-non-usd", inactiveFrom: cutover });
    expect(members.get("eursafo-spiko")).toEqual({ bucket: "fiat-non-usd", inactiveFrom: cutover });
    expect(members.get("gldy-example")).toEqual({ bucket: "commodity", activeFrom: cutover, inactiveFrom: null });

    const insert = sqlite.prepare("INSERT INTO supply_history (stablecoin_id, snapshot_date, circulating_usd) VALUES (?, ?, ?)");
    for (const date of [cutover - day, cutover, cutover + day]) {
      insert.run("usdt-tether", date, 900);
      insert.run("eurc-circle", date, 25);
      // Pre-cutover rows for a coin entering in v2 must stay out of pre-cutover totals.
      insert.run("gldy-example", date, 50);
      // Kept tokenized fund still receives post-cutover supply_history rows, which the fence must exclude.
      insert.run("eutbl-spiko", date, 45);
      // Delisted fund and backdated-frozen v1 active member stop producing rows at cutover without creating gaps.
      if (date < cutover) {
        insert.run("eursafo-spiko", date, 20);
        insert.run("fpi-frax", date, 10);
      }
    }

    const { points } = await computeNonUsdShareHistory(db, cutover + 2 * day, cutover - 2 * day, members);
    expect(points.map(({ date, total, fiatNonUsd, commodity, coverage }) => ({ date, total, fiatNonUsd, commodity, coverage }))).toEqual([
      { date: cutover - day, total: 1000, fiatNonUsd: 100, commodity: 0, coverage: COMPLETE_COVERAGE },
      { date: cutover, total: 975, fiatNonUsd: 25, commodity: 50, coverage: COMPLETE_COVERAGE },
      { date: cutover + day, total: 975, fiatNonUsd: 25, commodity: 50, coverage: COMPLETE_COVERAGE },
    ]);

    const actualMembers = buildNonUsdShareCoreMembers();
    expect(actualMembers.get("fpi-frax")).toEqual({ bucket: "fiat-non-usd", inactiveFrom: cutover });
    expect(actualMembers.get("eutbl-spiko")).toEqual({ bucket: "fiat-non-usd", inactiveFrom: cutover });
    expect(actualMembers.get("usdcx-movement")).toEqual({ bucket: "usd", inactiveFrom: unix("2026-11-27T00:00:00Z") });
    expect(actualMembers.get("jpydf-deltaforesight")).toEqual({ bucket: "fiat-non-usd", activeFrom: unix("2026-11-27T00:00:00Z"), inactiveFrom: null });
    expect(actualMembers.get("aeur-anchored-coins")).toEqual({
      bucket: "fiat-non-usd",
      inactiveFrom: unix("2026-07-11T00:00:00Z"),
    });
    expect(NON_USD_SHARE_COHORT_IDENTITY).toBe(JSON.stringify({
      universe: CORE_STABLECOIN_AGGREGATE_UNIVERSE,
      cutoverDate: CORE_STABLECOIN_AGGREGATE_V2_CUTOVER_DATE,
      v1Universe: CORE_STABLECOIN_AGGREGATE_UNIVERSE_V1,
      v1MemberIds: CORE_AGGREGATE_V1_MEMBER_LIST,
      v1NonActiveMemberIds: CORE_AGGREGATE_V1_NON_ACTIVE_MEMBER_LIST,
      members: Object.fromEntries(actualMembers),
    }));
  });
});
