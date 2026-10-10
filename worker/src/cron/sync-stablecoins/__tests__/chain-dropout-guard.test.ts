import { beforeEach, describe, expect, it, vi } from "vitest";
import { CHAIN_META } from "@shared/types/chain-identity";
import { ACTIVE_META_BY_ID } from "@shared/lib/stablecoins/registry";
import { StablecoinListResponseSchema } from "@shared/types/market";
import { getCirculatingRawOrNull, SUPPLEMENTAL_RESTORE_MAX_AGE_SEC } from "@shared/lib/supply";
import { buildChainRpcs, hasRegistryRpc } from "../../../lib/chain-registry";
import { normalizeStablecoinsPayload } from "../shared";
import type { PeggedAsset } from "../enrich-prices-shared";
import type * as FetchRetry from "../../../lib/fetch-retry";
import type * as Onchain from "../../reserve-adapters/onchain";
import type * as DbCache from "../../../lib/db-cache";

const mocks = vi.hoisted(() => ({ chart: vi.fn(), onchain: vi.fn(), getCache: vi.fn(), setCache: vi.fn() }));
vi.mock("../../../lib/fetch-retry", async (importOriginal) => ({ ...(await importOriginal<typeof FetchRetry>()), fetchTextWithRetry: mocks.chart }));
vi.mock("../../reserve-adapters/onchain", async (importOriginal) => ({ ...(await importOriginal<typeof Onchain>()), fetchErc20TotalSupply: mocks.onchain }));
vi.mock("../../../lib/db-cache", async (importOriginal) => ({ ...(await importOriginal<typeof DbCache>()), getCache: mocks.getCache, setCacheIfNewer: mocks.setCache }));

import {
  CHAIN_DROPOUT_ONCHAIN_ROSTER,
  CHAIN_DROPOUT_POLICY,
  ChainDropoutStateSchema,
  guardChainDropouts,
  loadChainDropoutState,
  persistChainDropoutState,
  type ChainDropoutState,
} from "../chain-dropout-guard";
import { CHAIN_DROPOUT_SEED, CHAIN_DROPOUT_SEED_VALID_UNTIL } from "../chain-dropout-seed";

const NOW = Date.parse("2026-10-09T06:00:00Z") / 1000;
const DAY = 86400;

function usdg(): PeggedAsset {
  return {
    id: "usdg-paxos", name: "Global Dollar", symbol: "USDG", pegType: "peggedUSD", pegMechanism: "fiat-backed",
    supplySource: "defillama", price: 1, priceSource: "defillama",
    circulating: { peggedUSD: 321_300_000 + 696_500_000 + 627_500_000 },
    circulatingPrevDay: { peggedUSD: 3_134_000_000 }, circulatingPrevWeek: { peggedUSD: 3_000_000_000 }, circulatingPrevMonth: { peggedUSD: 2_900_000_000 },
    chains: ["X Layer", "Ink", "Hyperliquid L1", "Ethereum", "Robinhood", "Solana"],
    chainCirculating: {
      "X Layer": { current: 0, circulatingPrevDay: 1_427_900_000 },
      Ink: { current: 0, circulatingPrevDay: 63_600_000 },
      "Hyperliquid L1": { current: 0, circulatingPrevDay: 1_200_000 },
      Ethereum: { current: 321_300_000, circulatingPrevDay: 321_300_000 },
      Robinhood: { current: 696_500_000, circulatingPrevDay: 696_500_000 },
      Solana: { current: 627_500_000, circulatingPrevDay: 627_500_000 },
    },
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  mocks.onchain.mockResolvedValue(null);
  mocks.chart.mockResolvedValue(null);
  mocks.getCache.mockResolvedValue(null);
  mocks.setCache.mockResolvedValue({ written: true, skippedBecauseNewer: false });
});

describe("chain dropout guard", () => {
  it("repairs today's USDG current chains from fresh daily charts, preserving historical buckets and wire provenance", async () => {
    const asset = usdg();
    const values: Record<string, number> = { "X Layer": 1_428_126_998.38, Ink: 63_474_779.8, "Hyperliquid L1": 1_209_462.75 };
    mocks.chart.mockImplementation(async (url: string) => {
      const label = decodeURIComponent(new URL(url).pathname.split("/").pop()!);
      return { response: { ok: true }, body: JSON.stringify([{ date: NOW - 6 * 3600, totalCirculatingUSD: { peggedUSD: values[label] } }]) };
    });
    const result = await guardChainDropouts({ assets: [asset], now: NOW, state: { version: 1, pairs: {} } });
    expect(result).toMatchObject({ flagged: 3, repaired: 3, historyFetches: 3, quarantinedAssetIds: [] });
    expect(getCirculatingRawOrNull(asset)).toBeCloseTo(3_138_111_240.93, 2);
    expect(asset).toMatchObject({ supplySource: "defillama-chain-repair", supplyObservedAt: NOW - 6 * 3600, supplyChainGuard: { status: "repaired", reason: "supply-chain-dropout" } });
    expect(asset.supplyRestored).toBeUndefined();
    expect(asset.circulatingPrevDay).toEqual({ peggedUSD: 3_134_000_000 });
    expect(asset.chainCirculating!["X Layer"].circulatingPrevDay).toBe(1_427_900_000);
    expect(mocks.chart.mock.calls[0][0]).toContain("stablecoincharts/X%20Layer?stablecoin=286");
    const normalized = normalizeStablecoinsPayload({ peggedAssets: [asset] });
    const published = StablecoinListResponseSchema.parse(normalized).peggedAssets[0];
    expect(published.supplyChainGuard).toEqual(asset.supplyChainGuard);
  });

  it("freezes vetted baseline across multi-day zeros, expires carry without releasing, then releases only on recovery", async () => {
    const day1 = usdg();
    const first = await guardChainDropouts({ assets: [day1], now: NOW, state: { version: 1, pairs: {} } });
    expect(day1).toMatchObject({ supplyRestored: true, supplyChainGuard: { status: "quarantined", quarantinedSince: NOW } });
    expect(day1.chainCirculating!["X Layer"].current).toBeNull();
    expect(getCirculatingRawOrNull(day1)).toBe(1_645_300_000 + 1_427_912_807 + 63_630_836 + 1_193_158);
    await persistChainDropoutState({} as D1Database, first, NOW);
    const saved = ChainDropoutStateSchema.parse(JSON.parse(mocks.setCache.mock.calls[0][2]));
    mocks.getCache.mockResolvedValue({ value: JSON.stringify(saved), updatedAt: NOW });
    const loaded = await loadChainDropoutState({} as D1Database);
    const day2 = usdg();
    for (const label of ["X Layer", "Ink", "Hyperliquid L1"]) day2.chainCirculating![label].circulatingPrevDay = 0;
    const second = await guardChainDropouts({ assets: [day2], now: NOW + DAY, ...loaded });
    expect(second.flagged).toBe(3);
    expect(day2.supplyChainGuard?.chains[0]).toMatchObject({ baselineSource: "state", baselineUsd: 1_427_912_807, baselineObservedAt: Date.parse("2026-10-08T00:00:00Z") / 1000 });
    expect(day2.supplyChainGuard?.quarantinedSince).toBe(NOW);
    const day8 = usdg();
    for (const label of ["X Layer", "Ink", "Hyperliquid L1"]) day8.chainCirculating![label].circulatingPrevDay = 0;
    const eighth = await guardChainDropouts({ assets: [day8], now: NOW + SUPPLEMENTAL_RESTORE_MAX_AGE_SEC + 1, state: second.state });
    expect(eighth).toMatchObject({ flagged: 3, quarantinedAssetIds: ["usdg-paxos"], unavailableAssetIds: ["usdg-paxos"] });
    expect(day8).toMatchObject({ circulating: {}, supplyRestored: true, supplyChainGuard: { status: "unavailable", quarantinedSince: NOW } });
    expect(getCirculatingRawOrNull(day8)).toBeNull();
    const recovered = usdg();
    recovered.chainCirculating!["X Layer"].current = 1_400_000_000;
    recovered.chainCirculating!.Ink.current = 64_000_000;
    recovered.chainCirculating!["Hyperliquid L1"].current = 1_300_000;
    recovered.circulating = { peggedUSD: 3_110_600_000 };
    const recovery = await guardChainDropouts({ assets: [recovered], now: NOW + 9 * DAY, state: eighth.state });
    expect(recovery.flagged).toBe(0);
    expect(recovered.supplyRestored).toBeUndefined();
    expect(recovered.supplyChainGuard).toBeUndefined();
    expect(Object.values(recovery.state.pairs).find((pair) => pair.chainId === "xlayer")).toMatchObject({ baselineUsd: 1_400_000_000, baselineObservedAt: NOW + 9 * DAY, quarantinedSince: null });
  });

  it.each([false, true])("keeps omitted quarantined chains sticky across generations (empty map: %s)", async (emptyMap) => {
    const initial: PeggedAsset = {
      ...usdg(), id: "usdc-circle", circulating: { peggedUSD: 20_000_000 },
      chainCirculating: {
        Ethereum: { current: 20_000_000, circulatingPrevDay: 20_000_000 },
        Sonic: { current: 0, circulatingPrevDay: 80_000_000 },
      },
    };
    // Pin the vetted fixture baseline; the incident seed has a different
    // real-world USDC/Sonic amount and intentionally outranks list prev-day.
    const state: ChainDropoutState = { version: 1, pairs: {
      [JSON.stringify(["usdc-circle", "sonic"])]: {
        assetId: "usdc-circle", chainLabel: "Sonic", chainId: "sonic",
        baselineUsd: 80_000_000, baselineObservedAt: NOW - DAY,
        baselineSource: "state", quarantinedSince: null,
      },
    } };
    const first = await guardChainDropouts({ assets: [initial], now: NOW, state });
    expect(getCirculatingRawOrNull(initial)).toBe(100_000_000);
    const omitted = (): PeggedAsset => ({
      ...usdg(), id: "usdc-circle", circulating: { peggedUSD: emptyMap ? 0 : 20_000_000 },
      chainCirculating: emptyMap ? {} : { Ethereum: { current: 20_000_000, circulatingPrevDay: 20_000_000 } },
    });
    const next = omitted();
    const second = await guardChainDropouts({ assets: [next], now: NOW + 900, state: first.state });
    expect(second.flagged).toBe(emptyMap ? 2 : 1);
    expect(getCirculatingRawOrNull(next)).toBe(100_000_000);
    expect(next.chainCirculating!.Sonic.current).toBeNull();
    expect(next).toMatchObject({ supplyRestored: true, supplyChainGuard: { status: "quarantined", quarantinedSince: NOW } });
    expect(next.supplyChainGuard?.chains.find((chain) => chain.chainId === "sonic")).toMatchObject({
      listCurrentUsd: null, baselineUsd: 80_000_000, baselineObservedAt: NOW - DAY,
    });

    // Recovery from an unreadable state must include the identity even though
    // the provider omitted the row and the accepted chain current is null.
    const recovered = omitted();
    await guardChainDropouts({
      assets: [recovered], now: NOW + 1800, state: { version: 1, pairs: {} }, stateReadFailed: true,
      previousAssetsById: new Map([["usdc-circle", next]]),
    });
    expect(getCirculatingRawOrNull(recovered)).toBe(100_000_000);
    expect(recovered.supplyChainGuard?.quarantinedSince).toBe(NOW);
    expect(recovered.chainCirculating!.Sonic.current).toBeNull();

    const expired = omitted();
    const expiry = await guardChainDropouts({
      assets: [expired], now: NOW + SUPPLEMENTAL_RESTORE_MAX_AGE_SEC + 1, state: second.state,
    });
    expect(getCirculatingRawOrNull(expired)).toBeNull();
    expect(expiry.unavailableAssetIds).toEqual(["usdc-circle"]);
    expect(expired).toMatchObject({ supplyRestored: true, supplyChainGuard: { status: "unavailable", quarantinedSince: NOW } });
  });

  it("recovers omitted material identities from the previous accepted publication even without a saved pair", async () => {
    const previous: PeggedAsset = {
      ...usdg(), id: "usdc-circle", supplyObservedAt: NOW - 900,
      circulating: { peggedUSD: 100_000_000 },
      chainCirculating: { Ethereum: { current: 20_000_000 }, Sonic: { current: 80_000_000 } },
    };
    const next: PeggedAsset = {
      ...previous, circulating: { peggedUSD: 20_000_000 }, chainCirculating: { Ethereum: { current: 20_000_000 } },
    };
    const result = await guardChainDropouts({
      assets: [next], now: NOW, state: { version: 1, pairs: {} }, previousAssetsById: new Map([["usdc-circle", previous]]),
    });
    expect(result.flagged).toBe(1);
    expect(getCirculatingRawOrNull(next)).toBe(100_000_000);
    expect(next.chainCirculating!.Sonic.current).toBeNull();
    expect(next.supplyRestored).toBe(true);
  });

  it("publishes the native amount, not the disproven list zero, when native supply corroborates a low-but-positive collapse", async () => {
    const contract = ACTIVE_META_BY_ID.get("usdg-paxos")!.contracts!.find((entry) => entry.chain === "xlayer")!;
    mocks.onchain.mockResolvedValue(40_000_000n * 10n ** BigInt(contract.decimals!));
    const asset = usdg();
    asset.chainCirculating = { "X Layer": asset.chainCirculating!["X Layer"] };
    const before = getCirculatingRawOrNull(asset)!;
    const result = await guardChainDropouts({ assets: [asset], now: NOW, state: { version: 1, pairs: {} } });
    expect(asset.chainCirculating!["X Layer"].current).toBe(40_000_000);
    expect(asset.supplyChainGuard?.chains.find((chain) => chain.chainId === "xlayer"))
      .toMatchObject({ resolution: "onchain-total-supply", listCurrentUsd: 0, repairedCurrentUsd: 40_000_000 });
    const xlayer = Object.values(result.state.pairs).find((pair) => pair.chainId === "xlayer")!;
    expect(xlayer).toMatchObject({ baselineUsd: 40_000_000, quarantinedSince: null, releasedAt: NOW });
    expect(asset.supplyChainGuard?.status).toBe("repaired");
    expect(asset.supplyRestored).toBeUndefined();
    expect(asset.supplySource).toBe("defillama-chain-repair");
    expect(getCirculatingRawOrNull(asset)).toBe(before + 40_000_000);
  });

  it("keeps a natively confirmed zero at zero across persist/reload when later native and chart reads fail", async () => {
    mocks.onchain.mockResolvedValueOnce(0n);
    const first = usdg();
    first.chainCirculating = { "X Layer": first.chainCirculating!["X Layer"] };
    const confirmed = await guardChainDropouts({ assets: [first], now: NOW, state: { version: 1, pairs: {} } });
    expect(first.chainCirculating!["X Layer"].current).toBe(0);
    expect(first.supplyRestored).toBeUndefined();
    await persistChainDropoutState({} as D1Database, confirmed, NOW);
    const saved = ChainDropoutStateSchema.parse(JSON.parse(mocks.setCache.mock.calls[0][2]));
    expect(Object.values(saved.pairs)).toEqual([expect.objectContaining({ chainId: "xlayer", baselineUsd: 0, releasedAt: NOW })]);

    mocks.getCache.mockResolvedValue({ value: JSON.stringify(saved), updatedAt: NOW });
    const loaded = await loadChainDropoutState({} as D1Database);
    mocks.onchain.mockRejectedValue(new Error("rpc down"));
    mocks.chart.mockResolvedValue({ response: { ok: false, status: 503 }, body: "" });
    const next = usdg();
    next.chainCirculating = { "X Layer": next.chainCirculating!["X Layer"] };
    const later = await guardChainDropouts({ assets: [next], now: NOW + 3600, ...loaded });
    expect(later.flagged).toBe(0);
    expect(next.chainCirculating!["X Layer"].current).toBe(0);
    expect(next.supplyRestored).toBeUndefined();
    expect(next.supplyChainGuard).toBeUndefined();
    expect(getCirculatingRawOrNull(next)).toBe(getCirculatingRawOrNull(usdg()));

    // The persisted state is unreadable too: the confirmed zero is recovered from the latest
    // publication (`next`), whose guard sidecar is already gone because the chain is no longer flagged.
    mocks.getCache.mockRejectedValue(new Error("D1 unavailable"));
    const unreadable = await loadChainDropoutState({} as D1Database);
    expect(unreadable.stateReadFailed).toBe(true);
    const afterFailure = usdg();
    afterFailure.chainCirculating = { "X Layer": afterFailure.chainCirculating!["X Layer"] };
    expect(next.supplyChainGuard).toBeUndefined();
    const recovered = await guardChainDropouts({ assets: [afterFailure], now: NOW + 7200, ...unreadable, previousAssetsById: new Map([["usdg-paxos", next]]) });
    expect(recovered.flagged).toBe(0);
    expect(afterFailure.chainCirculating!["X Layer"].current).toBe(0);
    expect(afterFailure.supplyRestored).toBeUndefined();
    expect(afterFailure.supplyChainGuard).toBeUndefined();
  });

  it.each([
    ["native zero", 0, 0, 25_000_000],
    ["native below list", 30_000_000, 10_000_000, 35_000_000],
  ])("keeps a %s confirmation despite a concurrent healthy-chain gain", async (_case, listUsd, nativeUsd, expectedTotal) => {
    const now = CHAIN_DROPOUT_SEED_VALID_UNTIL + DAY;
    const contract = ACTIVE_META_BY_ID.get("usdg-paxos")!.contracts!.find((entry) => entry.chain === "xlayer")!;
    mocks.onchain.mockResolvedValue(BigInt(nativeUsd) * 10n ** BigInt(contract.decimals!));
    const state: ChainDropoutState = { version: 1, pairs: {
      [JSON.stringify(["usdg-paxos", "xlayer"])]: { assetId: "usdg-paxos", chainLabel: "X Layer", chainId: "xlayer", baselineUsd: 100_000_000, baselineObservedAt: now - 900, baselineSource: "state", quarantinedSince: null },
      [JSON.stringify(["usdg-paxos", "ethereum"])]: { assetId: "usdg-paxos", chainLabel: "Ethereum", chainId: "ethereum", baselineUsd: 20_000_000, baselineObservedAt: now - 900, baselineSource: "state", quarantinedSince: null },
    } };
    const asset: PeggedAsset = {
      ...usdg(),
      circulating: { peggedUSD: 25_000_000 + listUsd },
      chainCirculating: {
        Ethereum: { current: 25_000_000, circulatingPrevDay: 20_000_000 },
        "X Layer": { current: listUsd, circulatingPrevDay: 100_000_000 },
      },
    };
    const result = await guardChainDropouts({ assets: [asset], now, state });
    expect(getCirculatingRawOrNull(asset)).toBe(expectedTotal);
    expect(asset.chainCirculating!["X Layer"].current).toBe(nativeUsd);
    expect(asset.supplyRestored).toBeUndefined();
    expect(asset.supplyChainGuard).toMatchObject({ status: "repaired", chains: [{ resolution: "onchain-total-supply", repairedCurrentUsd: nativeUsd }] });
    expect(result.state.pairs[JSON.stringify(["usdg-paxos", "xlayer"])]).toMatchObject({ baselineUsd: nativeUsd, quarantinedSince: null, releasedAt: now });
  });

  it("publishes unavailable, not a partial held total, when an ambiguous asset has a chain with no reference or current", async () => {
    const now = CHAIN_DROPOUT_SEED_VALID_UNTIL + DAY;
    const state: ChainDropoutState = { version: 1, pairs: {
      [JSON.stringify(["usdg-paxos", "xlayer"])]: { assetId: "usdg-paxos", chainLabel: "X Layer", chainId: "xlayer", baselineUsd: 100_000_000, baselineObservedAt: now - 900, baselineSource: "state", quarantinedSince: null },
      [JSON.stringify(["usdg-paxos", "ethereum"])]: { assetId: "usdg-paxos", chainLabel: "Ethereum", chainId: "ethereum", baselineUsd: 20_000_000, baselineObservedAt: now - 900, baselineSource: "state", quarantinedSince: null },
    } };
    const asset: PeggedAsset = {
      ...usdg(),
      circulating: { peggedUSD: 25_000_000 },
      chainCirculating: {
        Ethereum: { current: 25_000_000, circulatingPrevDay: 20_000_000 },
        "X Layer": { current: 0, circulatingPrevDay: 100_000_000 },
        Ink: { current: null },
      },
    };
    const result = await guardChainDropouts({ assets: [asset], now, state });
    expect(asset.circulating).toEqual({});
    expect(asset).toMatchObject({ supplyRestored: true, supplyChainGuard: { status: "unavailable" } });
    expect(result.unavailableAssetIds).toEqual(["usdg-paxos"]);
    expect(result.state.pairs[JSON.stringify(["usdg-paxos", "xlayer"])]).toMatchObject({ heldTotalUsd: null, quarantinedSince: now });
  });

  it("makes a persisted ambiguous hold unknown, never a clamped zero, when another chain is later natively confirmed", async () => {
    const now = CHAIN_DROPOUT_SEED_VALID_UNTIL + DAY;
    const contract = ACTIVE_META_BY_ID.get("usdg-paxos")!.contracts!.find((entry) => entry.chain === "xlayer")!;
    mocks.onchain.mockResolvedValue(0n * 10n ** BigInt(contract.decimals!));
    // Frozen $100M packet held for Solana (B=$80M) when X Layer (A) was $20M; A then grew to $100M
    // as an independent baseline before burning to a natively confirmed zero.
    const state: ChainDropoutState = { version: 1, pairs: {
      [JSON.stringify(["usdg-paxos", "solana"])]: { assetId: "usdg-paxos", chainLabel: "Solana", chainId: "solana", baselineUsd: 80_000_000, baselineObservedAt: now - 2 * DAY, baselineSource: "state", quarantinedSince: now - DAY, ambiguousSince: now - DAY, heldTotalUsd: 100_000_000 },
      [JSON.stringify(["usdg-paxos", "xlayer"])]: { assetId: "usdg-paxos", chainLabel: "X Layer", chainId: "xlayer", baselineUsd: 100_000_000, baselineObservedAt: now - 900, baselineSource: "state", quarantinedSince: null },
    } };
    const asset: PeggedAsset = {
      ...usdg(),
      circulating: { peggedUSD: 0 },
      chainCirculating: {
        Solana: { current: 0, circulatingPrevDay: 0 },
        "X Layer": { current: 0, circulatingPrevDay: 100_000_000 },
      },
    };
    const result = await guardChainDropouts({ assets: [asset], now, state });
    expect(asset.chainCirculating!["X Layer"].current).toBe(0);
    expect(asset.chainCirculating!.Solana.current).toBeNull();
    expect(asset.circulating).toEqual({});
    expect(asset).toMatchObject({ supplyRestored: true, supplyChainGuard: { status: "unavailable" } });
    expect(result.unavailableAssetIds).toEqual(["usdg-paxos"]);
    expect(result.state.pairs[JSON.stringify(["usdg-paxos", "solana"])]).toMatchObject({ heldTotalUsd: null, quarantinedSince: now - DAY });
  });

  it("uses reviewed native onchain units at USD par for repair", async () => {
    const contract = ACTIVE_META_BY_ID.get("usdg-paxos")!.contracts!.find((entry) => entry.chain === "xlayer")!;
    mocks.onchain.mockResolvedValue(1_409_030_000n * 10n ** BigInt(contract.decimals!));
    const asset = usdg();
    asset.chainCirculating = { "X Layer": asset.chainCirculating!["X Layer"] };
    await guardChainDropouts({ assets: [asset], now: NOW, state: { version: 1, pairs: {} } });
    expect(asset.chainCirculating!["X Layer"].current).toBe(1_409_030_000);
    expect(asset.supplyChainGuard?.chains[0]).toMatchObject({ resolution: "onchain-total-supply", observedAt: NOW });
    expect(mocks.onchain.mock.calls[0][1]).toBe(contract.address);
  });

  it.each(["failed-read", "invalid-json", "invalid-schema"])("does not clobber persisted quarantine after %s", async (failure) => {
    if (failure === "failed-read") mocks.getCache.mockRejectedValue(new Error("D1 unavailable"));
    else mocks.getCache.mockResolvedValue({ value: failure === "invalid-json" ? "{" : JSON.stringify({ version: 2, pairs: {} }), updatedAt: NOW });
    const loaded = await loadChainDropoutState({} as D1Database);
    expect(loaded.stateReadFailed).toBe(true);
    const result = await guardChainDropouts({ assets: [usdg()], now: NOW, ...loaded });
    expect(result.quarantinedAssetIds).toEqual(["usdg-paxos"]);
    await persistChainDropoutState({} as D1Database, result, NOW);
    expect(mocks.setCache).not.toHaveBeenCalled();
  });

  it("recovers a non-seeded quarantine from the last publication when the state read fails on a later outage day", async () => {
    const outage = (prevDay: number): PeggedAsset => ({
      ...usdg(),
      circulating: { peggedUSD: 321_300_000 },
      chainCirculating: {
        Ethereum: { current: 321_300_000, circulatingPrevDay: 321_300_000 },
        Solana: { current: 0, circulatingPrevDay: prevDay },
      },
    });
    const day1 = outage(627_500_000);
    await guardChainDropouts({ assets: [day1], now: NOW, state: { version: 1, pairs: {} } });
    expect(day1).toMatchObject({ supplyRestored: true, supplyChainGuard: { status: "quarantined", quarantinedSince: NOW } });

    mocks.getCache.mockRejectedValue(new Error("D1 unavailable"));
    const loaded = await loadChainDropoutState({} as D1Database);
    const day2 = outage(0);
    const second = await guardChainDropouts({ assets: [day2], now: NOW + DAY, ...loaded, previousAssetsById: new Map([["usdg-paxos", day1]]) });
    expect(second.quarantinedAssetIds).toEqual(["usdg-paxos"]);
    expect(day2.chainCirculating!.Solana.current).toBeNull();
    expect(day2.supplyChainGuard).toMatchObject({ status: "quarantined", quarantinedSince: NOW });
    expect(getCirculatingRawOrNull(day2)).toBe(321_300_000 + 627_500_000);
    await persistChainDropoutState({} as D1Database, second, NOW + DAY);
    expect(mocks.setCache).not.toHaveBeenCalled();
  });

  it.each([
    ["non-array chart", JSON.stringify({ error: "unavailable" })],
    ["unparseable chart", "{"],
    ["latest chart point without a usable peg bucket", JSON.stringify([
      { date: NOW - 2 * DAY, totalCirculatingUSD: { peggedUSD: 1_400_000_000 } },
      { date: NOW - 3600, totalCirculatingUSD: { peggedUSD: -1 } },
    ])],
  ])("fails closed when the native read throws and the chart is a %s", async (_case, body) => {
    mocks.onchain.mockRejectedValue(new Error("rpc down"));
    mocks.chart.mockResolvedValue({ response: { ok: true }, body });
    const asset = usdg();
    asset.chainCirculating = { "X Layer": asset.chainCirculating!["X Layer"] };
    const result = await guardChainDropouts({ assets: [asset], now: NOW, state: { version: 1, pairs: {} } });
    expect(result).toMatchObject({ repaired: 0, quarantinedAssetIds: ["usdg-paxos"] });
    expect(asset.chainCirculating!["X Layer"].current).toBeNull();
    expect(asset.supplyChainGuard?.chains[0]).toMatchObject({ resolution: "carried-baseline" });
    expect(Object.values(result.state.pairs)[0]).toMatchObject({ quarantinedSince: NOW, chartAttemptedAt: NOW });
    expect(Object.values(result.state.pairs)[0].chartPoint).toBeUndefined();
  });

  it("keeps publication successful when persisting guard state fails", async () => {
    mocks.setCache.mockRejectedValue(new Error("D1 write failed"));
    const result = await guardChainDropouts({ assets: [usdg()], now: NOW, state: { version: 1, pairs: {} } });
    await expect(persistChainDropoutState({} as D1Database, result, NOW)).resolves.toBeUndefined();
    expect(mocks.setCache).toHaveBeenCalledTimes(1);
  });

  it.each([
    ["full", 100_000_000],
    ["partial", 85_000_000],
  ])("never double-counts a %s source reattribution of a dropped destination, across two persisted runs", async (_case, source) => {
    // Past the incident seed so baselines come only from the asset's own healthy history.
    const start = CHAIN_DROPOUT_SEED_VALID_UNTIL + DAY;
    const bridged = (sourceUsd: number, destinationUsd: number): PeggedAsset => ({
      ...usdg(),
      circulating: { peggedUSD: sourceUsd + destinationUsd },
      chainCirculating: {
        Ethereum: { current: sourceUsd, circulatingPrevDay: 80_000_000 },
        "X Layer": { current: destinationUsd, circulatingPrevDay: 20_000_000 },
      },
    });
    // A chart lane that would "repair" the destination to its true $20M.
    mocks.chart.mockResolvedValue({ response: { ok: true }, body: JSON.stringify([{ date: start - 3600, totalCirculatingUSD: { peggedUSD: 20_000_000 } }]) });
    const healthy = await guardChainDropouts({ assets: [bridged(80_000_000, 20_000_000)], now: start, state: { version: 1, pairs: {} } });
    expect(healthy.flagged).toBe(0);

    let state = healthy.state;
    for (const now of [start + 900, start + 1800]) {
      await persistChainDropoutState({} as D1Database, { ...healthy, state }, now);
      const calls = mocks.setCache.mock.calls;
      mocks.getCache.mockResolvedValue({ value: calls[calls.length - 1][2], updatedAt: now });
      const loaded = await loadChainDropoutState({} as D1Database);
      const outage = bridged(source, 0);
      const run = await guardChainDropouts({ assets: [outage], now, ...loaded });
      // Never source + repaired destination ($120M / $105M): the vetted pre-reattribution total is held.
      expect(getCirculatingRawOrNull(outage)).toBe(100_000_000);
      expect(outage.chainCirculating!["X Layer"].current).toBeNull();
      expect(outage.chainCirculating!.Ethereum.current).toBe(source);
      expect(outage.supplyChainGuard).toMatchObject({ status: "quarantined", chains: [{ chainId: "xlayer", resolution: "carried-baseline" }] });
      expect(outage.supplyChainGuard?.chains[0].repairedCurrentUsd).toBeUndefined();
      state = run.state;
    }
  });

  it("keeps the first-detection clock when a native-low release is withheld for a concurrent healthy-chain gain", async () => {
    const contract = ACTIVE_META_BY_ID.get("usdg-paxos")!.contracts!.find((entry) => entry.chain === "xlayer")!;
    mocks.onchain.mockResolvedValue(40_000_000n * 10n ** BigInt(contract.decimals!));
    const asset = usdg();
    asset.chainCirculating = {
      "X Layer": asset.chainCirculating!["X Layer"],
      Ethereum: { current: 330_000_000, circulatingPrevDay: 321_300_000 },
    };
    asset.circulating = { peggedUSD: 330_000_000 };
    const result = await guardChainDropouts({ assets: [asset], now: NOW, state: { version: 1, pairs: {} } });
    expect(asset.chainCirculating!["X Layer"].current).toBeNull();
    expect(asset.supplyChainGuard).toMatchObject({ status: "quarantined", quarantinedSince: NOW, concurrentGainUsd: 8_700_000 });
    expect(asset.supplyChainGuard?.chains[0].repairedCurrentUsd).toBeUndefined();
    expect(getCirculatingRawOrNull(asset)).toBeGreaterThan(0);
    const xlayer = Object.values(result.state.pairs).find((pair) => pair.chainId === "xlayer")!;
    expect(xlayer).toMatchObject({ quarantinedSince: NOW, baselineSource: "seed", ambiguousSince: NOW });
    expect(xlayer.baselineUsd).toBeGreaterThan(1_400_000_000);
    expect(xlayer.releasedAt).toBeUndefined();
  });

  it("nulls an immaterial flagged chain without changing aggregate or restored status", async () => {
    const asset = usdg();
    asset.chainCirculating = { "Hyperliquid L1": asset.chainCirculating!["Hyperliquid L1"] };
    const before = { ...asset.circulating };
    const result = await guardChainDropouts({ assets: [asset], now: NOW, state: { version: 1, pairs: {} } });
    expect(asset.circulating).toEqual(before);
    expect(asset.supplyRestored).toBeUndefined();
    expect(asset.chainCirculating!["Hyperliquid L1"].current).toBeNull();
    expect(asset.supplyChainGuard?.status).toBe("chains-unavailable");
    expect(result.quarantinedAssetIds).toEqual([]);
  });

  it.each([-DAY, 0, DAY])("releases an immaterial pair only after a later low daily point (offset=%s)", async (pointOffset) => {
    const asset: PeggedAsset = {
      ...usdg(), id: "usdc-circle", symbol: "USDC", circulating: { peggedUSD: 70_000_000_000 },
      chainCirculating: { Tempo: { current: 44_854_806.82, circulatingPrevDay: 94_886_012 } },
    };
    const lowPoint = (date: number) => ({ response: { ok: true }, body: JSON.stringify([{ date, totalCirculatingUSD: { peggedUSD: 44_854_806.82 } }]) });
    mocks.chart.mockResolvedValue(lowPoint(NOW));
    const first = await guardChainDropouts({ assets: [asset], now: NOW, state: { version: 1, pairs: {} } });
    expect(asset.chainCirculating!.Tempo.current).toBeNull();
    expect(asset.supplyRestored).toBeUndefined();
    const state = ChainDropoutStateSchema.parse(JSON.parse(JSON.stringify(first.state)));
    expect(Object.values(state.pairs)[0].quarantinedSince).toBe(NOW);
    mocks.chart.mockResolvedValue(lowPoint(NOW + pointOffset));
    const later: PeggedAsset = {
      ...usdg(), id: "usdc-circle", symbol: "USDC", circulating: { peggedUSD: 70_000_000_000 },
      chainCirculating: { Tempo: { current: 44_854_806.82, circulatingPrevDay: 44_854_806.82 } },
    };
    const result = await guardChainDropouts({ assets: [later], now: NOW + DAY, state });
    expect(later.circulating).toEqual({ peggedUSD: 70_000_000_000 });
    expect(result.quarantinedAssetIds).toEqual([]);
    expect(later.supplyRestored).toBeUndefined();
    if (pointOffset > 0) {
      expect(later.chainCirculating!.Tempo.current).toBe(44_854_806.82);
      expect(later.supplyChainGuard).toBeUndefined();
      expect(Object.values(result.state.pairs)[0]).toMatchObject({
        baselineUsd: 44_854_806.82, baselineObservedAt: NOW + DAY, quarantinedSince: null,
      });
      const recovered = await guardChainDropouts({ assets: [later], now: NOW + DAY + 900, state: result.state });
      expect(recovered.flagged).toBe(0);
    } else {
      expect(later.chainCirculating!.Tempo.current).toBeNull();
      expect(later.supplyChainGuard?.status).toBe("chains-unavailable");
      expect(Object.values(result.state.pairs)[0]).toMatchObject({
        baselineUsd: 94_886_012, quarantinedSince: NOW,
      });
    }
  });

  it("never releases a material dropout from the same later low daily chart evidence", async () => {
    const makeTempo = (): PeggedAsset => ({
      ...usdg(), id: "usdc-circle", symbol: "USDC", circulating: { peggedUSD: 80_000_000 },
      chainCirculating: { Tempo: { current: 44_854_806.82, circulatingPrevDay: 94_886_012 } },
    });
    const first = await guardChainDropouts({ assets: [makeTempo()], now: NOW, state: { version: 1, pairs: {} } });
    mocks.chart.mockResolvedValue({ response: { ok: true }, body: JSON.stringify([{ date: NOW + DAY, totalCirculatingUSD: { peggedUSD: 44_854_806.82 } }]) });
    const later = makeTempo();
    const result = await guardChainDropouts({ assets: [later], now: NOW + DAY, state: first.state });
    expect(result.quarantinedAssetIds).toEqual(["usdc-circle"]);
    expect(later).toMatchObject({ supplyRestored: true, supplyChainGuard: { status: "quarantined", quarantinedSince: NOW } });
    expect(later.chainCirculating!.Tempo.current).toBeNull();
    expect(Object.values(result.state.pairs)[0]).toMatchObject({ baselineUsd: 94_886_012, quarantinedSince: NOW });
  });

  it("keeps low same-provider chart evidence quarantined and caches attempts hourly", async () => {
    const asset = usdg();
    mocks.chart.mockResolvedValue({ response: { ok: true }, body: JSON.stringify([{ date: NOW, totalCirculatingUSD: { peggedUSD: 0 } }]) });
    const first = await guardChainDropouts({ assets: [asset], now: NOW, state: { version: 1, pairs: {} } });
    expect(first.quarantinedAssetIds).toEqual(["usdg-paxos"]);
    const later = await guardChainDropouts({ assets: [usdg()], now: NOW + 900, state: first.state });
    expect(later.historyFetches).toBe(0);
    expect(later.flagged).toBe(3);
    expect(mocks.chart).toHaveBeenCalledTimes(3);
  });

  it("prioritizes deficits and caps sequential fresh chart attempts at eight", async () => {
    const asset = usdg();
    asset.chainCirculating = Object.fromEntries(Array.from({ length: 10 }, (_, index) => [`Unknown ${index}`, { current: 0, circulatingPrevDay: (index + 1) * 1_000_000 }]));
    let inflight = 0;
    let peak = 0;
    mocks.chart.mockImplementation(async () => { inflight++; peak = Math.max(peak, inflight); await Promise.resolve(); inflight--; return null; });
    const result = await guardChainDropouts({ assets: [asset], now: NOW, state: { version: 1, pairs: {} } });
    expect(result).toMatchObject({ flagged: 10, historyFetches: CHAIN_DROPOUT_POLICY.maxHistoryFetches });
    expect(peak).toBe(1);
    expect(mocks.chart.mock.calls[0][0]).toContain("Unknown%209");
  });

  it("bootstraps from prevDay after seed expiry and respects threshold boundaries", async () => {
    const asset = usdg();
    asset.chainCirculating = { "X Layer": { current: 500_000, circulatingPrevDay: 1_000_000 }, Ink: { current: 0, circulatingPrevDay: 999_999 } };
    await guardChainDropouts({ assets: [asset], now: CHAIN_DROPOUT_SEED_VALID_UNTIL + 1, state: { version: 1, pairs: {} } });
    expect(asset.supplyChainGuard?.chains).toHaveLength(1);
    expect(asset.supplyChainGuard?.chains[0]).toMatchObject({ baselineSource: "list-prev-day", baselineUsd: 1_000_000 });
    expect(asset.chainCirculating!.Ink.current).toBe(0);
  });

  it("retains seeds for noncanonical chain labels", async () => {
    const seed = CHAIN_DROPOUT_SEED.find((entry) => entry.chainLabel === "XDC")!;
    const asset: PeggedAsset = { ...usdg(), id: seed.assetId, chainCirculating: { XDC: { current: 0, circulatingPrevDay: 0 } } };
    await guardChainDropouts({ assets: [asset], now: NOW, state: { version: 1, pairs: {} } });
    expect(asset.supplyChainGuard?.chains[0]).toMatchObject({ chainLabel: "XDC", baselineUsd: seed.baselineUsd, baselineSource: "seed" });
  });

  it("ignores frozen, other-lane restored and reconciled assets", async () => {
    const assets = [{ ...usdg(), frozen: true }, { ...usdg(), supplyRestored: true }, { ...usdg(), supplySource: "coingecko-gap-fill" }];
    const result = await guardChainDropouts({ assets, now: NOW, state: { version: 1, pairs: {} } });
    expect(result.flagged).toBe(0);
    const skipped = await guardChainDropouts({ assets: [usdg()], now: NOW, state: { version: 1, pairs: {} }, skipAssetIds: new Set(["usdg-paxos"]) });
    expect(skipped.flagged).toBe(0);
    expect(mocks.chart).not.toHaveBeenCalled();
  });

  it("keeps the reviewed onchain roster RPC-readable with catalog contracts and seed state versioned", () => {
    // Ink's existing registry route is Alchemy-keyed; X Layer also has a public route.
    const rpcs = buildChainRpcs("test-placeholder");
    for (const pair of CHAIN_DROPOUT_ONCHAIN_ROSTER) {
      expect(CHAIN_META[pair.chainId]).toBeDefined();
      expect(hasRegistryRpc(rpcs.get(pair.chainId))).toBe(true);
      expect(ACTIVE_META_BY_ID.get(pair.assetId)?.contracts?.filter((entry) => entry.chain === pair.chainId)).toHaveLength(1);
    }
    expect(CHAIN_DROPOUT_SEED).toHaveLength(39);
    expect(ChainDropoutStateSchema.parse({ version: 1, pairs: {} })).toEqual({ version: 1, pairs: {} } satisfies ChainDropoutState);
  });
});
