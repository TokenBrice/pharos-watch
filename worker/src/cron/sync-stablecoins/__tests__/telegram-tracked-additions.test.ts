import { afterEach, describe, expect, it, vi } from "vitest";
import { createLatestSchemaFixtureTracker } from "@shared/test-utils/latest-schema-sqlite";
import { ACTIVE_STABLECOINS } from "@shared/lib/stablecoins/registry";
import { isFallbackBackedTrackedBaseline, queueTrackedAdditionsNotice } from "../telegram-tracked-additions";
import { getCache } from "../../../lib/db-cache";
import { prepareTelegramDigestAppendices } from "../../../telegram/digest/digest-appendices";
import { validateAndWriteStablecoinsCache } from "../cache-publication";
import { buildFallbackAssetsFromCoinGecko } from "../fallback-intake";
import { loadPreviousStablecoinsById } from "../shared";
import { mockD1 } from "@shared/test-utils/mock-d1";
import { makePeggedAsset } from "./_fixtures";

const fixtures = createLatestSchemaFixtureTracker();
afterEach(() => { fixtures.closeAll(); vi.restoreAllMocks(); });

describe("tracked-addition publication adapter", () => {
  it("persists only newly tracked IDs and does not duplicate the pending notice", async () => {
    const { db } = fixtures.open();
    const assets = [
      makePeggedAsset({ id: "usdt-tether" }),
      makePeggedAsset({ id: "usdc-circle" }),
      makePeggedAsset({ id: "not-a-tracked-coin" }),
    ];
    await queueTrackedAdditionsNotice(db, new Set(["usdt-tether"]), assets);
    expect(JSON.parse((await getCache(db, "telegram:tracked-stablecoins-pending"))!.value)).toEqual(["usdc-circle"]);
    await queueTrackedAdditionsNotice(db, ["usdt-tether"], assets);
    expect(JSON.parse((await getCache(db, "telegram:tracked-stablecoins-pending"))!.value)).toEqual(["usdc-circle"]);
  });

  it("does not announce every asset when the previous baseline is unavailable", async () => {
    const { db } = fixtures.open();
    await queueTrackedAdditionsNotice(db, [], [makePeggedAsset({ id: "usdc-circle" })]);
    expect(await getCache(db, "telegram:tracked-stablecoins-pending")).toBeNull();
  });

  it("does not fail stablecoin publication when the notice queue read fails", async () => {
    const db = mockD1([]);
    vi.spyOn(db, "prepare").mockImplementation(() => { throw new Error("queue unavailable"); });
    const warning = vi.spyOn(console, "warn").mockImplementation(() => {});
    await expect(queueTrackedAdditionsNotice(db, ["usdt-tether"], [makePeggedAsset({ id: "usdc-circle" })])).resolves.toBeUndefined();
    expect(warning).toHaveBeenCalled();
  });
});

describe("tracked additions after a degraded fallback publication", () => {
  const MAIN_SYNC_SEC = 1_800_000_000;
  const FALLBACK_SYNC_SEC = MAIN_SYNC_SEC + 900;

  /** The full tracked-active cohort a healthy main publication writes to the canonical cache. */
  function makeMainPublishedCohort() {
    return ACTIVE_STABLECOINS.map((meta) => makePeggedAsset({
      id: meta.id,
      name: meta.name,
      symbol: meta.symbol,
      pegMechanism: meta.flags.backing,
      price: 1,
      priceSource: "defillama",
      priceConfidence: "single-source",
      priceObservedAt: MAIN_SYNC_SEC - 60,
      priceObservedAtMode: "upstream",
      circulating: { peggedUSD: 10_000_000 },
      chainCirculating: {},
      chains: [],
      supplySource: "defillama",
      supplyObservedAt: MAIN_SYNC_SEC - 60,
    }));
  }

  async function publishCohort(
    db: D1Database,
    assets: ReturnType<typeof makeMainPublishedCohort>,
    syncStartSec: number,
    validationContext: "main" | "fallback",
  ): Promise<string[]> {
    const result = await validateAndWriteStablecoinsCache({
      assets, db, syncStartSec, validationContext,
    }, () => ({ metadata: "blocked" }));
    expect(result).toMatchObject({ written: true, quarantinedAssets: [] });
    const cached = JSON.parse((await getCache(db, "stablecoins"))!.value) as { peggedAssets: Array<{ id: string }> };
    return cached.peggedAssets.map((row) => row.id);
  }

  it("does not announce long-tracked coins as newly tracked when the prior cache is a CoinGecko fallback cohort", async () => {
    const { db } = fixtures.open();
    const mainCohort = makeMainPublishedCohort();
    const mainIds = await publishCohort(db, mainCohort, MAIN_SYNC_SEC, "main");
    expect(mainIds).toEqual(mainCohort.map((asset) => asset.id));

    // DefiLlama outage: the CoinGecko fallback can only price ACTIVE_STABLECOINS
    // with a fresh market cap, and that smaller cohort replaces the canonical cache.
    const cgData: Record<string, { usd: number; usd_market_cap: number; last_updated_at: number }> = {};
    for (const meta of ACTIVE_STABLECOINS) {
      if (!meta.geckoId) continue;
      cgData[meta.geckoId] = { usd: 1, usd_market_cap: 100_000_000, last_updated_at: FALLBACK_SYNC_SEC - 60 };
    }
    const fallbackCohort = buildFallbackAssetsFromCoinGecko({ cgData, syncStartSec: FALLBACK_SYNC_SEC });
    const fallbackIds = await publishCohort(db, fallbackCohort, FALLBACK_SYNC_SEC, "fallback");
    expect(fallbackIds.length).toBeLessThan(mainIds.length);

    // The next main run detects that its previous payload was the degraded
    // fallback cohort instead of treating it as the tracked-set baseline.
    const { previousAssetsById } = await loadPreviousStablecoinsById(db);
    expect(isFallbackBackedTrackedBaseline(previousAssetsById.values())).toBe(true);
    const omittedFromFallback = mainCohort.filter((asset) => !previousAssetsById.has(String(asset.id)));
    expect(omittedFromFallback.length).toBeGreaterThan(0);

    await queueTrackedAdditionsNotice(db, new Set(previousAssetsById.keys()), mainCohort, {
      previousBaselineFallbackBacked: true,
    });

    const pending = await getCache(db, "telegram:tracked-stablecoins-pending");
    const pendingIds = pending ? JSON.parse(pending.value) as string[] : [];
    expect(pendingIds).toEqual([]);

    const digest = await prepareTelegramDigestAppendices(db);
    expect(digest.metadata.trackedDetected).toBe(0);
    expect(digest.metadata.trackedSymbols).toEqual([]);
    expect(digest.appendixHtml ?? "").not.toContain("Newly tracked stablecoins");
  });
});
