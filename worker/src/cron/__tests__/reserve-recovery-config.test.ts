import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mockRegistry } from "../../test-helpers/cron";
import { createLatestSchemaFixtureTracker } from "@shared/test-utils/latest-schema-sqlite";
import { computeLiveReserveConfigFingerprint } from "@shared/lib/live-reserve-adapters";
import { mockLiveReserveAdapterRegistry, getReserveAdapterMock, shouldAttemptFetchMock, recordOutcomeSafeMock } from "./live-reserves.test-support";

vi.mock("@shared/lib/stablecoins/registry", () => mockRegistry({ stablecoins: Array.from({ length: 8 }, (_, index) => ({
  id: `coin-${index}`, name: `Coin ${index}`, symbol: `C${index}`,
  flags: { backing: "rwa-backed", pegCurrency: "USD", governance: "centralized", yieldBearing: false, rwa: true, navToken: false },
  liveReservesConfig: { adapter: "m0", version: 1, semantics: "collateral-mix", inputs: { primary: { kind: "http-json", url: `https://example.com/${index}` } } },
})) }));

import { CONFIGURED_COINS } from "../sync-live-reserves-shared";
import { syncReserveCoin } from "../sync-live-reserves-core";
import { syncLiveReserves } from "../sync-live-reserves";
import { recoverLiveReserveConfigChanges, RESERVE_CONFIG_RECOVERY_BACKOFF_SEC } from "../reserve-recovery-config";
import { loadFreshIndependentLiveReserveMap } from "../../lib/live-reserves/store";
import type { ConfiguredCoin, LiveReserveConfig } from "../sync-live-reserves-shared";
import type { AdapterContext } from "../reserve-adapters/index";

const fixtures = createLatestSchemaFixtureTracker();
const slices = [{ name: "Treasuries", pct: 100, risk: "low" as const }];
const signal = () => new AbortController().signal;
const good = async () => ({ slices, metadata: { freshnessMode: "verified" as const, sourceTimestamp: Math.floor(Date.now() / 1000) } });
afterEach(() => { fixtures.closeAll(); vi.restoreAllMocks(); vi.useRealTimers(); });
beforeEach(() => {
  vi.clearAllMocks();
  shouldAttemptFetchMock.mockResolvedValue(true);
  recordOutcomeSafeMock.mockResolvedValue(undefined);
});

async function seed(mismatches = 1) {
  const fetch = mockLiveReserveAdapterRegistry(good);
  const fixture = fixtures.open();
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

  it("keeps a failed mismatch rejected, backs off, and heals at the retry boundary", async () => {
    const { db, sqlite } = await seed();
    const fetch = mockLiveReserveAdapterRegistry(async () => { throw new Error("network unavailable"); });
    const now = Date.now();
    vi.spyOn(Date, "now").mockReturnValue(now);
    expect(await recoverLiveReserveConfigChanges(db, signal(), {})).toMatchObject({ failed: ["coin-0"], healed: [] });
    expect((await loadFreshIndependentLiveReserveMap(db)).has("coin-0")).toBe(false);
    expect(sqlite.prepare("SELECT config_fingerprint FROM reserve_composition WHERE stablecoin_id = 'coin-0'").get()).toEqual({ config_fingerprint: "previous-config" });
    expect(await recoverLiveReserveConfigChanges(db, signal(), {})).toMatchObject({ backoffCount: 1, attempted: [] });
    expect(fetch).toHaveBeenCalledTimes(1);
    vi.mocked(Date.now).mockReturnValue(now + RESERVE_CONFIG_RECOVERY_BACKOFF_SEC * 1_000 - 1_000);
    expect(await recoverLiveReserveConfigChanges(db, signal(), {})).toMatchObject({ attempted: [] });
    vi.mocked(Date.now).mockReturnValue(now + RESERVE_CONFIG_RECOVERY_BACKOFF_SEC * 1_000);
    mockLiveReserveAdapterRegistry(good);
    expect(await recoverLiveReserveConfigChanges(db, signal(), {})).toMatchObject({ healed: ["coin-0"] });
    expect((await loadFreshIndependentLiveReserveMap(db)).has("coin-0")).toBe(true);
  });

  it("does not fetch unchanged configs, absent snapshots, or legacy fingerprints", async () => {
    const { db, sqlite, fetch } = await seed(0);
    sqlite.prepare("DELETE FROM reserve_composition WHERE stablecoin_id = 'coin-0'").run();
    sqlite.prepare("UPDATE reserve_composition SET config_fingerprint = NULL WHERE stablecoin_id = 'coin-1'").run();
    expect(await recoverLiveReserveConfigChanges(db, signal(), {})).toMatchObject({ mismatchCount: 0, attempted: [] });
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
});
