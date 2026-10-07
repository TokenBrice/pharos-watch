import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mockWorkerRuntimeRegistry } from "../../test-helpers/cron";
import { createLatestSchemaFixtureTracker } from "@shared/test-utils/latest-schema-sqlite";
import { computeLiveReserveConfigFingerprint } from "@shared/lib/live-reserve-adapters";
import { mockLiveReserveAdapterRegistry, getReserveAdapterMock, shouldAttemptFetchMock, recordOutcomeSafeMock } from "./live-reserves.test-support";

vi.mock("@shared/lib/stablecoins/worker-runtime-registry", () => mockWorkerRuntimeRegistry({ stablecoins: Array.from({ length: 8 }, (_, index) => ({
  id: `coin-${index}`, name: `Coin ${index}`, symbol: `C${index}`,
  flags: { backing: "rwa-backed", pegCurrency: "USD", governance: "centralized", yieldBearing: false, rwa: true, navToken: false },
  liveReservesConfig: { adapter: "m0", version: 1, semantics: "collateral-mix", inputs: { primary: { kind: "http-json", url: `https://example.com/${index}` } } },
})) }));

import { CONFIGURED_COINS } from "../sync-live-reserves-shared";
import { syncReserveCoin } from "../sync-live-reserves-core";
import { syncLiveReserves } from "../sync-live-reserves";
import { recoverLiveReserveConfigChanges } from "../reserve-recovery-config";
import { loadFreshIndependentLiveReserveMap } from "../../lib/live-reserves/store";
import type { ConfiguredCoin, LiveReserveConfig } from "../sync-live-reserves-shared";
import type { AdapterContext } from "../reserve-adapters/index";
import { getCronSlotStartedAtForSchedule } from "@shared/lib/cron-jobs";
import { createSqliteD1 } from "@shared/test-utils/sqlite-d1";

const fixtures = createLatestSchemaFixtureTracker();
const slices = [{ name: "Treasuries", pct: 100, risk: "low" as const }];
const signal = () => new AbortController().signal;
const good = async () => ({ slices, metadata: { freshnessMode: "verified" as const, sourceTimestamp: Math.floor(Date.now() / 1000) } });
afterEach(() => { fixtures.closeAll(); vi.restoreAllMocks(); vi.useRealTimers(); });
beforeEach(() => {
  vi.clearAllMocks();
  vi.spyOn(Date, "now").mockReturnValue(Date.parse("2026-10-07T01:00:00Z"));
  shouldAttemptFetchMock.mockResolvedValue(true);
  recordOutcomeSafeMock.mockResolvedValue(undefined);
});

async function seed(mismatches = 1) {
  const fetch = mockLiveReserveAdapterRegistry(good);
  const fixture = fixtures.open();
  fixture.sqlite.function("unixepoch", () => Math.floor(Date.now() / 1000));
  // SQL deadline fences and JS admission must share the fixture's advancing clock.
  fixture.sqlite.function("julianday", () => Date.now() / 86_400_000 + 2_440_587.5);
  fixture.sqlite.prepare(`INSERT INTO cron_slot_executions
    (slot_key, slot_started_at, state, execution_owner, execution_generation, started_at, finished_at, updated_at)
    VALUES ('fourHourlyReserveSync', ?, 'finished', 'producer', 1, ?, ?, ?)`)
    .run(getCronSlotStartedAtForSchedule("fourHourlyReserveSync", Date.now()), Math.floor(Date.now() / 1000) - 60,
      Math.floor(Date.now() / 1000) - 1, Math.floor(Date.now() / 1000) - 1);
  await syncLiveReserves(fixture.db, signal(), {});
  for (const coin of CONFIGURED_COINS.slice(0, mismatches)) {
    fixture.sqlite.prepare("UPDATE reserve_composition SET config_fingerprint = ? WHERE stablecoin_id = ?").run("previous-config", coin.id);
    fixture.sqlite.prepare("UPDATE reserve_sync_state SET config_fingerprint = ? WHERE stablecoin_id = ?").run("previous-config", coin.id);
    fixture.sqlite.prepare("UPDATE reserve_composition SET fetched_at = fetched_at - 60 WHERE stablecoin_id = ?").run(coin.id);
    fixture.sqlite.prepare("UPDATE reserve_sync_state SET last_success_at = last_success_at - 60 WHERE stablecoin_id = ?").run(coin.id);
  }
  fetch.mockClear();
  return { ...fixture, fetch };
}

describe("deploy config reserve recovery", () => {
  it("rejects the old generation, fetches/admit the deployed fingerprint, and does not fetch again", async () => {
    const { db, sqlite, fetch } = await seed();
    expect((await loadFreshIndependentLiveReserveMap(db)).has("coin-0")).toBe(false);
    expect(await recoverLiveReserveConfigChanges(db, signal(), {})).toMatchObject({ attempted: ["coin-0"], healed: ["coin-0"], failed: [] });
    expect(fetch.mock.calls.map(([coin]) => coin.id)).toEqual(["coin-0"]);
    expect(sqlite.prepare("SELECT config_fingerprint FROM reserve_composition WHERE stablecoin_id = 'coin-0'").get()).toEqual({
      config_fingerprint: computeLiveReserveConfigFingerprint(CONFIGURED_COINS[0]!.liveReservesConfig!),
    });
    expect((await loadFreshIndependentLiveReserveMap(db)).get("coin-0")).toEqual(slices);
    expect(await recoverLiveReserveConfigChanges(db, signal(), {})).toMatchObject({ attempted: [], healed: [] });
    expect(fetch).toHaveBeenCalledTimes(1);
  });

  it.each(["producer", "heavy"])("does not consume a changed fingerprint when direct config recovery is protected by %s", async (lane) => {
    const { db, sqlite, fetch } = await seed();
    if (lane === "producer") sqlite.prepare("UPDATE cron_slot_executions SET state = 'running'").run();
    else sqlite.prepare(`INSERT INTO cron_slot_executions
      (slot_key, slot_started_at, state, execution_owner, execution_generation, started_at, updated_at)
      VALUES ('halfHourlyChartsOffset', ?, 'running', 'heavy', 1, ?, ?)`)
      .run(Math.floor(Date.now() / 1000), Math.floor(Date.now() / 1000), Math.floor(Date.now() / 1000));
    getReserveAdapterMock.mockClear();
    expect(await recoverLiveReserveConfigChanges(db, signal(), {}, {
      invocationId: "poll", scheduleKey: "fiveMinuteReserveRecovery", slotStartedAt: Math.floor(Date.now() / 1000),
    })).toMatchObject({
      disposition: "config-recovery-priority", attempted: [], attemptedCount: 0,
      reason: lane === "producer" ? "producer-slot-priority" : "heavy-slot-co-tenancy",
    });
    expect(fetch).not.toHaveBeenCalled();
    expect(getReserveAdapterMock).not.toHaveBeenCalled();
    expect(sqlite.prepare("SELECT config_fingerprint FROM reserve_sync_state WHERE stablecoin_id = 'coin-0'").get())
      .toEqual({ config_fingerprint: "previous-config" });
    expect(sqlite.prepare("SELECT COUNT(*) AS count FROM cron_leases").get()).toEqual({ count: 0 });
  });

  it("consumes one opportunity after stale evidence rejection across ten minutes, four hours and isolate restarts", async () => {
    const { db, sqlite } = await seed();
    const fetch = mockLiveReserveAdapterRegistry(async () => ({
      slices, metadata: {
        freshnessMode: "verified", sourceTimestamp: Math.floor(Date.now() / 1000),
        redemption: { freshnessKind: "verified-source-timestamp", sourceTimestamp: Math.floor(Date.now() / 1000) - 100 * 86400 },
      },
    }));
    const now = Date.now();
    expect(await recoverLiveReserveConfigChanges(db, signal(), {})).toMatchObject({ failed: ["coin-0"], healed: [] });
    expect((await loadFreshIndependentLiveReserveMap(db)).has("coin-0")).toBe(false);
    expect(sqlite.prepare("SELECT config_fingerprint FROM reserve_composition WHERE stablecoin_id = 'coin-0'").get()).toEqual({ config_fingerprint: "previous-config" });
    for (const elapsedMs of [10 * 60_000, 4 * 3600_000]) {
      vi.mocked(Date.now).mockReturnValue(now + elapsedMs);
      if (elapsedMs === 4 * 3600_000) sqlite.prepare(`INSERT INTO cron_slot_executions
        (slot_key, slot_started_at, state, execution_owner, execution_generation, started_at, finished_at, updated_at)
        VALUES ('fourHourlyReserveSync', ?, 'finished', 'next-producer', 1, ?, ?, ?)`)
        .run(getCronSlotStartedAtForSchedule("fourHourlyReserveSync", Date.now()),
          Math.floor(Date.now() / 1000) - 60, Math.floor(Date.now() / 1000) - 1, Math.floor(Date.now() / 1000) - 1);
      expect(await recoverLiveReserveConfigChanges(createSqliteD1(sqlite), signal(), {})).toMatchObject({
        mismatchCount: 1, skippedSameFingerprintCount: 1, skippedSameFingerprint: ["coin-0"], attempted: [],
      });
    }
    expect(fetch).toHaveBeenCalledTimes(1);
    mockLiveReserveAdapterRegistry(good);
    const coin = CONFIGURED_COINS[0]!;
    const priorConfig = coin.liveReservesConfig!;
    try {
      coin.liveReservesConfig = { ...priorConfig, version: 2 };
      expect(await recoverLiveReserveConfigChanges(db, signal(), {})).toMatchObject({ healed: ["coin-0"] });
      expect(await recoverLiveReserveConfigChanges(db, signal(), {})).toMatchObject({ attempted: [] });
    } finally {
      coin.liveReservesConfig = priorConfig;
    }
    vi.mocked(Date.now).mockReturnValue(Date.now() + 1000);
    await syncLiveReserves(db, signal(), {});
    expect((await loadFreshIndependentLiveReserveMap(db)).has("coin-0")).toBe(true);
  });

  it("does not fetch unchanged configs, absent snapshots, or legacy fingerprints", async () => {
    const { db, sqlite, fetch } = await seed(0);
    sqlite.prepare("DELETE FROM reserve_composition WHERE stablecoin_id = 'coin-0'").run();
    sqlite.prepare("UPDATE reserve_composition SET config_fingerprint = NULL WHERE stablecoin_id = 'coin-1'").run();
    getReserveAdapterMock.mockClear();
    expect(await recoverLiveReserveConfigChanges(db, signal(), {})).toMatchObject({ mismatchCount: 0, attempted: [] });
    expect(fetch).not.toHaveBeenCalled();
    expect(getReserveAdapterMock).not.toHaveBeenCalled();
  });

  it("recovers a changed prior failed config without a published snapshot", async () => {
    const { db, sqlite, fetch } = await seed();
    sqlite.prepare("DELETE FROM reserve_composition WHERE stablecoin_id = 'coin-0'").run();
    sqlite.prepare("UPDATE reserve_sync_state SET last_status = 'error', last_success_at = NULL, last_success_attempt_id = NULL, last_error = 'prior config failed' WHERE stablecoin_id = 'coin-0'").run();
    expect(await recoverLiveReserveConfigChanges(db, signal(), {})).toMatchObject({
      mismatchCount: 1, priorBindingSources: { snapshot: 0, attempt: 1 },
      attempted: ["coin-0"], healed: ["coin-0"], failed: [],
    });
    expect(fetch.mock.calls.map(([coin]) => coin.id)).toEqual(["coin-0"]);
    expect((await loadFreshIndependentLiveReserveMap(db)).get("coin-0")).toEqual(slices);
  });

  it("leaves a failed current no-snapshot binding to the normal producer after its changed-config attempt", async () => {
    const { db, sqlite } = await seed();
    sqlite.prepare("DELETE FROM reserve_composition WHERE stablecoin_id = 'coin-0'").run();
    const fetch = mockLiveReserveAdapterRegistry(async () => { throw new Error("network unavailable"); });
    expect(await recoverLiveReserveConfigChanges(db, signal(), {})).toMatchObject({
      priorBindingSources: { snapshot: 0, attempt: 1 }, attempted: ["coin-0"], failed: ["coin-0"],
    });
    expect(sqlite.prepare("SELECT config_fingerprint FROM reserve_sync_state WHERE stablecoin_id = 'coin-0'").get()).toEqual({
      config_fingerprint: computeLiveReserveConfigFingerprint(CONFIGURED_COINS[0]!.liveReservesConfig!),
    });
    expect(await recoverLiveReserveConfigChanges(db, signal(), {})).toMatchObject({ mismatchCount: 0, attempted: [] });
    vi.mocked(Date.now).mockReturnValue(Date.now() + 10 * 60_000);
    expect(await recoverLiveReserveConfigChanges(db, signal(), {})).toMatchObject({ mismatchCount: 0, attempted: [] });
    expect(fetch).toHaveBeenCalledTimes(1);
  });

  it("does not bootstrap new, unattempted, or unchanged no-snapshot bindings", async () => {
    const { db, sqlite, fetch } = await seed(0);
    for (const id of ["coin-0", "coin-1", "coin-2"]) {
      sqlite.prepare("DELETE FROM reserve_composition WHERE stablecoin_id = ?").run(id);
    }
    sqlite.prepare("DELETE FROM reserve_sync_state WHERE stablecoin_id = 'coin-0'").run();
    sqlite.prepare("UPDATE reserve_sync_state SET config_fingerprint = ?, last_attempted_at = NULL WHERE stablecoin_id = 'coin-1'")
      .run("previous-config");
    expect(await recoverLiveReserveConfigChanges(db, signal(), {})).toMatchObject({ mismatchCount: 0, attempted: [] });
    expect(fetch).not.toHaveBeenCalled();
  });

  it("keeps snapshot authority separate from a consumed attempted fingerprint", async () => {
    const { db, sqlite, fetch } = await seed(0);
    sqlite.prepare("UPDATE reserve_sync_state SET config_fingerprint = ? WHERE stablecoin_id = 'coin-0'").run("previous-config");
    expect(await recoverLiveReserveConfigChanges(db, signal(), {})).toMatchObject({ mismatchCount: 0, attempted: [] });
    expect(fetch).not.toHaveBeenCalled();

    sqlite.prepare("UPDATE reserve_composition SET config_fingerprint = ?, fetched_at = fetched_at - 60 WHERE stablecoin_id = 'coin-0'").run("previous-config");
    sqlite.prepare("UPDATE reserve_sync_state SET config_fingerprint = ?, last_attempted_at = last_attempted_at - ? WHERE stablecoin_id = 'coin-0'")
      .run(computeLiveReserveConfigFingerprint(CONFIGURED_COINS[0]!.liveReservesConfig!), 4 * 3600);
    expect(await recoverLiveReserveConfigChanges(db, signal(), {})).toMatchObject({
      mismatchCount: 1, priorBindingSources: { snapshot: 1, attempt: 0 }, attempted: [], skippedSameFingerprintCount: 1,
    });
    expect(fetch).not.toHaveBeenCalled();
  });

  it("heals six coins in one run and an over-cap deployment within two runs", async () => {
    const { db, fetch } = await seed(8);
    const first = await recoverLiveReserveConfigChanges(db, signal(), {});
    expect(first).toMatchObject({ healed: CONFIGURED_COINS.slice(0, 6).map((coin) => coin.id), deferredCount: 2 });
    const second = await recoverLiveReserveConfigChanges(db, signal(), {});
    expect(second).toMatchObject({ healed: ["coin-6", "coin-7"], deferredCount: 0 });
    expect((await loadFreshIndependentLiveReserveMap(db)).get("coin-7")).toEqual(slices);
    expect(fetch).toHaveBeenCalledTimes(8);
  });

  it("skips a held producer lease without fetching or touching snapshot authority", async () => {
    const { db, sqlite, fetch } = await seed();
    sqlite.prepare("INSERT INTO cron_leases (job, lease_owner, lease_until, heartbeat_at, updated_at) VALUES (?, ?, ?, ?, ?)")
      .run("sync-live-reserves", "normal-sync", Math.floor(Date.now() / 1000) + 900, Math.floor(Date.now() / 1000), Math.floor(Date.now() / 1000));
    expect(await recoverLiveReserveConfigChanges(db, signal(), {})).toMatchObject({ disposition: "config-recovery-skipped", reason: "sync-live-reserves-lease-held", attempted: [] });
    expect(fetch).not.toHaveBeenCalled();
    expect((await loadFreshIndependentLiveReserveMap(db)).has("coin-0")).toBe(false);
    expect(sqlite.prepare("SELECT lease_owner FROM cron_leases WHERE job = 'sync-live-reserves'").get()).toEqual({ lease_owner: "normal-sync" });
  });

  it("limits nested body-consuming I/O to two operations and serializes coins", async () => {
    const { db } = await seed(2);
    let active = 0;
    let peak = 0;
    const seen: string[] = [];
    const definition = getReserveAdapterMock("m0")!;
    getReserveAdapterMock.mockReturnValue({ ...definition, sharedSourceMode: "none", fetch: async (coin: ConfiguredCoin, _config: LiveReserveConfig, _signal: AbortSignal, ctx: AdapterContext) => {
      seen.push(coin.id);
      await Promise.all(Array.from({ length: 5 }, (_, index) => ctx.ioLimiter!.run(`request-${index}`, async () => {
        active++;
        peak = Math.max(peak, active);
        const response = new Response(JSON.stringify({ index }));
        await Promise.resolve();
        expect(await response.json()).toEqual({ index });
        active--;
      })));
      expect(active).toBe(0);
      return good();
    } });
    expect(await recoverLiveReserveConfigChanges(db, signal(), {})).toMatchObject({ healed: ["coin-0", "coin-1"] });
    expect(peak).toBe(2);
    expect(active).toBe(0);
    expect(seen).toEqual(["coin-0", "coin-1"]);
  });

  it("does not publish when cancellation arrives after fetch and before success finalization", async () => {
    const { db, sqlite } = await seed();
    const controller = new AbortController();
    const coin = CONFIGURED_COINS[0]!;
    const result = await syncReserveCoin({
      db, coin, signal: controller.signal, adapter: getReserveAdapterMock("m0"),
      breakerCanFetch: new Map(), previousState: null, d1FinalizeTimeoutMs: 30_000,
      runAdapter: async () => {
        const result = await good();
        controller.abort(new Error("lease ownership lost"));
        return result;
      },
    });
    expect(result.status).toBe("failed");
    expect(sqlite.prepare("SELECT config_fingerprint FROM reserve_composition WHERE stablecoin_id = 'coin-0'").get())
      .toEqual({ config_fingerprint: "previous-config" });
    expect((await loadFreshIndependentLiveReserveMap(db)).has("coin-0")).toBe(false);
  });

  it("defers untouched coins when one attempt consumes the remaining admission window", async () => {
    const { db } = await seed(2);
    const started = Date.now();
    const clock = vi.spyOn(Date, "now").mockReturnValue(started);
    const fetch = mockLiveReserveAdapterRegistry(async () => {
      clock.mockReturnValue(started + 90_000);
      return good();
    });
    expect(await recoverLiveReserveConfigChanges(db, signal(), {})).toMatchObject({
      attempted: ["coin-0"], healed: ["coin-0"], deferredCount: 1,
    });
    expect(fetch.mock.calls.map(([coin]) => coin.id)).toEqual(["coin-0"]);
    clock.mockReturnValue(started + 300_000);
    expect(await recoverLiveReserveConfigChanges(db, signal(), {})).toMatchObject({ healed: ["coin-1"] });
  });

  it("quarantines a missing fetcher, warns, and admits the remaining mismatch", async () => {
    const { db, sqlite, fetch } = await seed(2);
    const coin = CONFIGURED_COINS[0]!;
    const original = coin.liveReservesConfig!;
    const getter = getReserveAdapterMock.getMockImplementation()!;
    getReserveAdapterMock.mockImplementation((key: LiveReserveConfig["adapter"]) => key === "single-asset" ? null : getter(key));
    coin.liveReservesConfig = { ...original, adapter: "single-asset" };
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    try {
      expect(await recoverLiveReserveConfigChanges(db, signal(), {})).toMatchObject({
        disposition: "config-recovery-partial", mismatchCount: 2, suspendedCount: 0,
        missingFetcherCount: 1, skippedSameFingerprintCount: 0, dueCount: 1, attemptedCount: 1,
        attempted: ["coin-1"], healed: ["coin-1"], failed: [],
        warnings: [{ stablecoinId: "coin-0", code: "config-recovery-missing-fetcher", severity: "warning" }],
      });
      expect(fetch.mock.calls.map(([fetched]) => fetched.id)).toEqual(["coin-1"]);
      expect((await loadFreshIndependentLiveReserveMap(db)).get("coin-1")).toEqual(slices);
      expect((await loadFreshIndependentLiveReserveMap(db)).has("coin-0")).toBe(false);
      expect(sqlite.prepare("SELECT config_fingerprint FROM reserve_composition WHERE stablecoin_id = 'coin-0'").get())
        .toEqual({ config_fingerprint: "previous-config" });
      expect(warn).toHaveBeenCalledWith(expect.stringContaining('"event":"config-recovery-missing-fetcher"'));
    } finally {
      coin.liveReservesConfig = original;
    }
  });

  it("counts suspended, missing-fetcher, consumed, due and attempted coins as one disjoint partition", async () => {
    const { db, sqlite, fetch } = await seed(5);
    const suspendedCoin = CONFIGURED_COINS[0]!;
    const missingCoin = CONFIGURED_COINS[2]!;
    const originalSuspended = suspendedCoin.liveReservesConfig!;
    const originalMissing = missingCoin.liveReservesConfig!;
    const getter = getReserveAdapterMock.getMockImplementation()!;
    getReserveAdapterMock.mockImplementation((key: LiveReserveConfig["adapter"]) => key === "single-asset" ? null : getter(key));
    suspendedCoin.liveReservesConfig = { ...originalSuspended, suspended: { reason: "Feed parked", since: "2026-10-03" } };
    missingCoin.liveReservesConfig = { ...originalMissing, adapter: "single-asset" };
    const consumed = CONFIGURED_COINS[1]!;
    sqlite.prepare("UPDATE reserve_sync_state SET config_fingerprint = ?, last_attempted_at = ? WHERE stablecoin_id = ?")
      .run(computeLiveReserveConfigFingerprint(consumed.liveReservesConfig!), Math.floor(Date.now() / 1000), consumed.id);
    try {
      const result = await recoverLiveReserveConfigChanges(db, signal(), {});
      expect(result).toMatchObject({
        mismatchCount: 5, suspendedCount: 1, missingFetcherCount: 1,
        skippedSameFingerprintCount: 1, dueCount: 2, attemptedCount: 2, deferredCount: 0,
        attempted: ["coin-3", "coin-4"], healed: ["coin-3", "coin-4"],
        warnings: [{ stablecoinId: "coin-2", code: "config-recovery-missing-fetcher", severity: "warning" }],
      });
      expect(fetch.mock.calls.map(([coin]) => coin.id)).toEqual(["coin-3", "coin-4"]);
    } finally {
      suspendedCoin.liveReservesConfig = originalSuspended;
      missingCoin.liveReservesConfig = originalMissing;
    }
  });
});
