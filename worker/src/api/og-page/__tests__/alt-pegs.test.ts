import { afterEach, describe, expect, it, vi } from "vitest";
import { CLIENT_ACTIVE_META_BY_ID } from "@shared/lib/stablecoins/client-registry";
import { CLIENT_CORE_AGGREGATE_ACTIVE_IDS } from "@shared/lib/stablecoins/aggregate-client-registry";
import { makeAsset } from "../../../test-helpers/__shared/fixtures";

const mocks = vi.hoisted(() => ({ loadStablecoinsCache: vi.fn() }));
vi.mock("../../../lib/stablecoins-cache", () => ({ loadStablecoinsCache: mocks.loadStablecoinsCache }));

import { loadAltPegsOgPage } from "../alt-pegs";
import { OG_PAGE_LOADERS } from "../index";
import { OG_SOURCE_BUDGET_SEC } from "../types";

const NOW = 1_790_000_000;
const db = {} as D1Database;
const NON_USD_IDS = [...CLIENT_CORE_AGGREGATE_ACTIVE_IDS].filter(
  (id) => (CLIENT_ACTIVE_META_BY_ID.get(id)?.flags.pegCurrency ?? "USD") !== "USD",
);

function cache(assets: unknown[], updatedAt = NOW - 60) {
  return { kind: "ok", payload: { peggedAssets: assets }, updatedAt };
}

afterEach(() => {
  vi.clearAllMocks();
});

describe("alt-pegs route card", () => {
  it("is registered for the live slug", () => {
    expect(OG_PAGE_LOADERS["alt-pegs"]).toBe(loadAltPegsOgPage);
  });

  it("publishes the core non-USD market cap with top peg shares, stamped with the list generation", async () => {
    const usd = makeAsset({ id: "usdc-circle", circulating: { peggedUSD: 50_000_000_000 } });
    const nonUsd = NON_USD_IDS.map((id) => makeAsset({ id, circulating: { peggedUSD: id === "xaut-tether" ? 2_000_000_000 : 10_000_000 } }));
    mocks.loadStablecoinsCache.mockResolvedValue(cache([usd, ...nonUsd]));

    const load = await loadAltPegsOgPage(db, NOW);
    if (load.kind !== "ok") throw new Error(`expected a live card, got ${load.reason}`);
    const expectedUsd = 2_000_000_000 + (NON_USD_IDS.length - 1) * 10_000_000;
    expect(load.hero).toBe(`$${(expectedUsd / 1e9).toFixed(1)}B`);
    expect(load.context).toBe("market cap of non-USD stablecoins");
    expect(load.support[0]).toMatch(/^Gold \d+\.\d%$/);
    expect(load.support).toHaveLength(3);
    expect(load.visual).toMatchObject({ kind: "share-bar" });
    expect(load).toMatchObject({ asOfSec: NOW - 60, budgetSec: OG_SOURCE_BUDGET_SEC.stablecoins, generation: `stablecoins:${NOW - 60}` });
    expect(load.stampNote).toBeUndefined();
  });

  it("mirrors the page's labelled known subtotal and withholds shares when a coin has no supply", async () => {
    const [missing, ...rest] = NON_USD_IDS;
    mocks.loadStablecoinsCache.mockResolvedValue(cache([
      makeAsset({ id: missing!, circulating: {} }),
      ...rest.map((id) => makeAsset({ id, circulating: { peggedUSD: 10_000_000 } })),
    ]));
    const load = await loadAltPegsOgPage(db, NOW);
    if (load.kind !== "ok") throw new Error("expected a live card");
    expect(load.context).toBe("known market cap subtotal of non-USD stablecoins");
    expect(load.support).toEqual([]);
    expect(load.visual).toBeUndefined();
    expect(load.stampNote).toBe(`Partial · ${rest.length}/${NON_USD_IDS.length} non-USD coins observed`);
  });

  it("stamps a recorded partial-chain remainder as incomplete and withholds shares", async () => {
    const [partial, ...rest] = NON_USD_IDS;
    mocks.loadStablecoinsCache.mockResolvedValue(cache([
      makeAsset({
        id: partial!,
        circulating: { peggedUSD: 10_000_000 },
        supplyChainGuard: {
          reason: "supply-chain-dropout",
          status: "chains-unavailable",
          partialCoverage: true,
          quarantinedSince: NOW - 3_600,
          chains: [{
            chainId: "tempo", chainLabel: "Tempo", listCurrentUsd: 0, baselineUsd: 1_653_927,
            baselineObservedAt: NOW - 7_200, baselineSource: "seed", resolution: "unavailable",
          }],
        },
      }),
      ...rest.map((id) => makeAsset({ id, circulating: { peggedUSD: 10_000_000 } })),
    ]));
    const load = await loadAltPegsOgPage(db, NOW);
    if (load.kind !== "ok") throw new Error("expected a live card");
    expect(load.context).toBe("known market cap subtotal of non-USD stablecoins");
    expect(load.support).toEqual([]);
    expect(load.visual).toBeUndefined();
    expect(load.stampNote).toBe(`Partial · ${NON_USD_IDS.length}/${NON_USD_IDS.length} non-USD coins observed`);
  });

  it("treats a core non-USD coin missing from the cache as partial, never complete", async () => {
    const [omitted, ...rest] = NON_USD_IDS;
    mocks.loadStablecoinsCache.mockResolvedValue(cache(rest.map((id) => makeAsset({ id, circulating: { peggedUSD: 10_000_000 } }))));
    const load = await loadAltPegsOgPage(db, NOW);
    if (load.kind !== "ok") throw new Error("expected a live card");
    expect(omitted).toBeDefined();
    expect(load.context).toBe("known market cap subtotal of non-USD stablecoins");
    expect(load.support).toEqual([]);
    expect(load.stampNote).toBe(`Partial · ${rest.length}/${NON_USD_IDS.length} non-USD coins observed`);
  });

  it.each([
    ["cache-missing", { kind: "error", reason: "missing" }],
    ["stale-cache", cache([], NOW - OG_SOURCE_BUDGET_SEC.stablecoins - 1)],
    ["figure-null", cache([makeAsset({ id: NON_USD_IDS[0]!, circulating: {} })])],
  ])("falls back to the timeless card (%s)", async (reason, result) => {
    mocks.loadStablecoinsCache.mockResolvedValue(result);
    expect(await loadAltPegsOgPage(db, NOW)).toEqual({ kind: "unavailable", reason });
  });
});
