import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mockRegistry } from "../../../../test-helpers/cron";
import type * as FetchRetry from "../../../../lib/fetch-retry";
import type * as EvmRpc from "../../../../lib/evm-rpc";
import type * as OnchainSupply from "../onchain-supply";
import type { PeggedAsset } from "../../enrich-prices-shared";
import type { CoinGeckoMcapData } from "../shared";
import { buildChainRpcs, type ChainRpcConfig } from "../../../../lib/chain-registry";
import { TOTAL_SUPPLY_SELECTOR } from "../../../../lib/evm-selectors";
import { fetchEvmBlockHeader } from "../../../../lib/evm-rpc";
import { SUPPLEMENTAL_RESTORE_MAX_AGE_SEC } from "@shared/lib/supply";
import { CRON_SCHEDULE_CADENCES } from "@shared/lib/cron-cadences";
import { ONCHAIN_PARTITION_DIVERGENCE_DETAIL_LIMIT, OnchainPartitionSummarySchema, type OnchainPartitionSummary } from "@shared/types/status/cron";
import ftusd from "@shared/data/stablecoins/coins/ftusd-flying-tulip.json";
import aa from "@shared/data/stablecoins/coins/aa-falconx-mev-capital.json";
import susde from "@shared/data/stablecoins/coins/susde-ethena.json";

const mocks = vi.hoisted(() => ({ read: vi.fn(), escrow: vi.fn(), partitionRead: vi.fn() }));

vi.mock("@shared/lib/stablecoins/registry", () => mockRegistry({
  stablecoins: [ftusd, { ...aa, geckoId: "fixture-aa" }, susde].map((meta) => ({
    ...meta, detailProvider: "coingecko", flags: { ...meta.flags, pegCurrency: "USD" },
  })),
}));
vi.mock("../../../../lib/fetch-retry", async (importOriginal) => ({
  ...(await importOriginal<typeof FetchRetry>()),
  fetchTextWithRetry: async () => ({ response: Response.json({ coins: {} }), body: '{"coins":{}}' }),
}));
vi.mock("../../../../lib/authoritative-price-sources", () => ({
  resolveVaultNavSupplyPrice: vi.fn().mockResolvedValue(null),
}));
vi.mock("../../../reserve-adapters/helpers", () => ({
  probeTrackedTokenSupply: async (meta: unknown, input: { chain?: string; kind: string }, signal: AbortSignal,
    _label: string, context?: { chainRpcs: Map<string, ChainRpcConfig> }) => {
    const raw = await mocks.read(input.kind === "onchain-solana" ? "solana" : input.chain, meta, signal, context);
    if (raw === 0n) throw new Error("positive-only supply probe rejected observed zero");
    return raw;
  },
  fetchErc20TotalSupply: (input: { chain: string }, _contract: string, signal: AbortSignal,
    context?: { chainRpcs: Map<string, ChainRpcConfig> }) => mocks.read(input.chain, undefined, signal, context),
  fetchSolanaTokenSupply: (_contract: string, signal: AbortSignal) => mocks.read("solana", undefined, signal),
  fetchOnchainUint256: (...args: unknown[]) => mocks.escrow(...args),
  fetchIcrcLedgerTotalSupply: vi.fn(), fetchMoveFungibleAssetSupply: vi.fn(), fetchStarknetTotalSupply: vi.fn(),
}));
vi.mock("../../../../lib/evm-rpc", async (importOriginal) => ({
  ...(await importOriginal<typeof EvmRpc>()),
  fetchEvmBlockNumber: vi.fn().mockResolvedValue(123),
  fetchEvmBlockHeader: vi.fn(async () => ({
    number: 123, hash: `0x${"1".repeat(64)}`, timestamp: Math.floor(Date.now() / 1000) - 30,
  })),
  fetchEvmUint256AtBlock: (chain: string, _contract: string, data: string, _block: number, options: { signal?: AbortSignal }) =>
    data === TOTAL_SUPPLY_SELECTOR ? mocks.read(chain, undefined, options.signal) : mocks.escrow(),
}));
vi.mock("../onchain-supply", async (importOriginal) => {
  const actual = await importOriginal<typeof OnchainSupply>();
  return {
    ...actual,
    fetchOnChainSupplyPartition: (...args: Parameters<typeof actual.fetchOnChainSupplyPartition>) => {
      mocks.partitionRead(args[0].id);
      return actual.fetchOnChainSupplyPartition(...args);
    },
  };
});

import { fetchFiatCoinGeckoTokens, FIAT_CG_METAS, ONCHAIN_PARTITION_STAGE_BUDGET_MS } from "../fiat-cg";
import { mergeSupplementalLastKnownGood, restoreMissingTrackedAssets } from "../../shared";

const NOW_SEC = 1_790_000_000;
const fixtureMetas = [...FIAT_CG_METAS];
const ftMeta = fixtureMetas.find((meta) => meta.id === ftusd.id)!;
const aaMeta = fixtureMetas.find((meta) => meta.id === aa.id)!;
const susdeMeta = fixtureMetas.find((meta) => meta.id === susde.id)!;

function cgData(total: number, price: number | null = 1, meta = ftMeta): CoinGeckoMcapData {
  return { [meta.geckoId!]: { usd: price ?? undefined, usd_market_cap: total, last_updated_at: Math.floor(Date.now() / 1_000) - 60 } };
}

async function readFt(total = 100, previous?: PeggedAsset, report?: (summary: OnchainPartitionSummary) => void): Promise<PeggedAsset> {
  return (await fetchFiatCoinGeckoTokens(cgData(total), undefined, undefined, undefined, undefined,
    previous ? new Map([[previous.id, previous]]) : undefined, undefined, report))[0];
}

function sumRows(asset: PeggedAsset): number {
  return Object.values(asset.chainCirculating ?? {}).reduce((sum, row) => sum + Number(row.current), 0);
}

function supplyPacket(asset: PeggedAsset): string {
  return JSON.stringify({
    circulating: asset.circulating, supplySource: asset.supplySource, supplyObservedAt: asset.supplyObservedAt,
    circulatingPrevDay: asset.circulatingPrevDay, circulatingPrevWeek: asset.circulatingPrevWeek,
    circulatingPrevMonth: asset.circulatingPrevMonth,
  });
}

function mockSusdeSupply(canonicalUnits = 1_000): void {
  FIAT_CG_METAS.splice(0, FIAT_CG_METAS.length, susdeMeta);
  mocks.read.mockImplementation(async (chain) => BigInt(chain === "ethereum" ? canonicalUnits : 10)
    * 10n ** BigInt(chain === "solana" ? 9 : 18));
  mocks.escrow.mockResolvedValue(300n * 10n ** 18n);
}

describe("CoinGecko on-chain share partitions", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(NOW_SEC * 1_000);
    vi.spyOn(console, "warn").mockImplementation(() => {});
    vi.spyOn(console, "info").mockImplementation(() => {});
    FIAT_CG_METAS.splice(0, FIAT_CG_METAS.length, ftMeta);
    mocks.read.mockReset().mockImplementation(async (chain) => BigInt(chain === "ethereum" ? 70 : 30) * 10n ** 6n);
    mocks.escrow.mockReset();
    mocks.partitionRead.mockClear();
    vi.mocked(fetchEvmBlockHeader).mockReset().mockResolvedValue({
      number: 123, hash: `0x${"1".repeat(64)}`, timestamp: NOW_SEC - 30,
    });
  });

  afterEach(() => {
    FIAT_CG_METAS.splice(0, FIAT_CG_METAS.length, ...fixtureMetas);
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it("reports measured admissions, divergence, unreadable carry and expiry without changing supply", async () => {
    const report = vi.fn<(summary: OnchainPartitionSummary) => void>();
    const previous = await readFt(100, undefined, report);
    const base = { candidates: 1, entered: 0, retained: 0, carried: 0, divergent: 0, unreadable: 0,
      deadlineSkipped: 0, carryExpired: 0, divergences: [], divergencesTruncated: 0 };
    expect(report).toHaveBeenLastCalledWith({ ...base, entered: 1 });
    mocks.read.mockImplementation(async (chain) => BigInt(chain === "ethereum" ? 84 : 30) * 10n ** 6n);
    await readFt(100, previous, report);
    expect(report).toHaveBeenLastCalledWith({ ...base, retained: 1 });
    const divergent = await readFt(100, undefined, report);
    expect(report).toHaveBeenLastCalledWith({ ...base, divergent: 1, divergences: [{ id: ftMeta.id, ratio: 1.14 }] });
    expect(supplyPacket(divergent)).toBe(supplyPacket(previous));
    mocks.read.mockResolvedValue(null);
    await readFt(100, previous, report);
    expect(report).toHaveBeenLastCalledWith({ ...base, unreadable: 1, carried: 1 });
    previous.chainPartition!.observedAt = NOW_SEC - SUPPLEMENTAL_RESTORE_MAX_AGE_SEC - 1;
    await readFt(100, previous, report);
    expect(report).toHaveBeenLastCalledWith({ ...base, unreadable: 1, carryExpired: 1 });
    await fetchFiatCoinGeckoTokens({}, undefined, undefined, undefined, undefined, undefined, undefined, report);
    expect(report).toHaveBeenLastCalledWith({ ...base, candidates: 0 });
    for (const [summary] of report.mock.calls) expect(OnchainPartitionSummarySchema.safeParse(summary).success).toBe(true);
  });

  it("caps divergence details while retaining the complete count and ratios", async () => {
    const metas = Array.from({ length: ONCHAIN_PARTITION_DIVERGENCE_DETAIL_LIMIT + 2 }, (_, i) => ({
      ...aaMeta, id: `partition-fixture-${i}`, geckoId: `partition-fixture-${i}`,
    }));
    FIAT_CG_METAS.splice(0, FIAT_CG_METAS.length, ...metas);
    mocks.read.mockResolvedValue(200n * 10n ** 18n);
    const report = vi.fn<(summary: OnchainPartitionSummary) => void>();
    await fetchFiatCoinGeckoTokens(Object.assign({}, ...metas.map((meta) => cgData(100, 1, meta))),
      undefined, undefined, undefined, undefined, undefined, undefined, report);
    const summary = report.mock.calls[0][0];
    expect(summary).toMatchObject({ candidates: metas.length, divergent: metas.length, divergencesTruncated: 2 });
    expect(summary.divergences).toHaveLength(ONCHAIN_PARTITION_DIVERGENCE_DETAIL_LIMIT);
    expect(summary.divergences.every(({ ratio }) => ratio === 2)).toBe(true);
  });

  it("does not report observed zeroes after an interrupted collection", async () => {
    const controller = new AbortController();
    controller.abort(new Error("cancelled"));
    const report = vi.fn();
    await expect(fetchFiatCoinGeckoTokens(cgData(100), controller.signal, undefined, undefined,
      undefined, undefined, undefined, report)).rejects.toThrow("cancelled");
    expect(report).not.toHaveBeenCalled();
  });

  it("attaches reconciled shares while keeping the CG total, source, clock and history byte-identical", async () => {
    const admitted = await readFt(101);
    expect(admitted.chainCirculating).toEqual({
      Ethereum: { chainId: "ethereum", current: expect.closeTo(70.7, 10) },
      Sonic: { chainId: "sonic", current: expect.closeTo(30.3, 10) },
    });
    expect(Math.abs(sumRows(admitted) - 101)).toBeLessThanOrEqual(Math.max(0.01, 101 * 1e-9));
    expect(admitted.chainPartition).toEqual({
      basis: "onchain-share", observedAt: NOW_SEC, onchainUsd: 100, ratio: 100 / 101, admission: "entered",
    });
    mocks.read.mockResolvedValue(null);
    const aggregateOnly = await readFt(101);
    expect(aggregateOnly.chainCirculating).toEqual({});
    expect(aggregateOnly.chainPartition).toBeUndefined();
    expect(supplyPacket(admitted)).toBe(supplyPacket(aggregateOnly));
    expect(admitted).toMatchObject({
      circulating: { peggedUSD: 101 }, supplySource: "coingecko-fallback", supplyObservedAt: NOW_SEC - 60,
      circulatingPrevDay: null, circulatingPrevWeek: null, circulatingPrevMonth: null,
    });
  });

  it.each([[90, true], [110, true], [89, false], [111, false]] as const)(
    "admits entry-band on-chain USD %s against CG 100: %s", async (onchainUsd, admitted) => {
      mocks.read.mockImplementation(async (chain) => BigInt(chain === "ethereum" ? onchainUsd - 30 : 30) * 10n ** 6n);
      const asset = await readFt();
      expect(asset.chainPartition?.admission).toBe(admitted ? "entered" : undefined);
      expect(asset.circulating).toEqual({ peggedUSD: 100 });
      if (admitted) expect(sumRows(asset)).toBeCloseTo(100, 10);
      else expect(asset.chainCirculating).toEqual({});
    },
  );

  it("uses the retain band only after an admitted partition, and does not carry a divergent read", async () => {
    const previous = await readFt();
    mocks.read.mockImplementation(async (chain) => BigInt(chain === "ethereum" ? 84 : 30) * 10n ** 6n);
    expect((await readFt()).chainPartition).toBeUndefined();
    expect((await readFt(100, previous)).chainPartition).toMatchObject({ admission: "retained", ratio: 1.14 });

    mocks.read.mockImplementation(async (chain) => BigInt(chain === "ethereum" ? 90 : 30) * 10n ** 6n);
    const divergent = await readFt(100, previous);
    expect(divergent.chainCirculating).toEqual({});
    expect(divergent.chainPartition).toBeUndefined();
    expect(mergeSupplementalLastKnownGood([divergent], new Map([[previous.id, previous]]), new Set(), NOW_SEC)
      .assets[0].chainCirculating).toEqual({});
    expect(vi.mocked(console.warn).mock.calls.map(([line]) => JSON.parse(String(line))))
      .toContainEqual(expect.objectContaining({
        event: "onchain-partition-divergence",
        metadata: expect.objectContaining({ stablecoinId: ftMeta.id, ratio: 1.2, reason: "ratio-out-of-band" }),
      }));
  });

  it("requires entry-band re-admission after a carried partition", async () => {
    const previous = await readFt();
    previous.chainPartition!.admission = "carried";
    mocks.read.mockImplementation(async (chain) => BigInt(chain === "ethereum" ? 84 : 30) * 10n ** 6n);
    const rejected = await readFt(100, previous);
    expect(rejected.chainPartition).toBeUndefined();
    expect(rejected.chainCirculating).toEqual({});
    mocks.read.mockImplementation(async (chain) => BigInt(chain === "ethereum" ? 70 : 30) * 10n ** 6n);
    expect((await readFt(100, previous)).chainPartition?.admission).toBe("entered");
  });

  it("never publishes partial rows when one deployment is unreadable", async () => {
    mocks.read.mockImplementation(async (chain) => chain === "ethereum" ? 70n * 10n ** 6n : null);
    const asset = await readFt();
    expect(asset.chainCirculating).toEqual({});
    expect(asset.chainPartition).toBeUndefined();
    expect(asset.circulating).toEqual({ peggedUSD: 100 });
  });

  it.each(["ethereum", "sonic"])("does not carry when a required %s leg is observed at zero", async (zeroChain) => {
    const previous = await readFt();
    mocks.read.mockImplementation(async (chain) => chain === zeroChain ? 0n : BigInt(chain === "ethereum" ? 70 : 30) * 10n ** 6n);
    const asset = await readFt(120, previous);
    expect(asset.circulating).toEqual({ peggedUSD: 120 });
    expect(asset.chainCirculating).toEqual({});
    expect(asset.chainPartition).toBeUndefined();
    expect(vi.mocked(console.warn).mock.calls.map(([line]) => JSON.parse(String(line))))
      .toContainEqual(expect.objectContaining({
        event: "onchain-partition-divergence",
        metadata: expect.objectContaining({ stablecoinId: ftMeta.id, reason: "partition-invalid" }),
      }));
  });

  it.each([SUPPLEMENTAL_RESTORE_MAX_AGE_SEC, SUPPLEMENTAL_RESTORE_MAX_AGE_SEC + 1])(
    "carries original shares only within the partition observation ceiling (age %s)", async (age) => {
      const previous = await readFt();
      previous.chainPartition!.observedAt = NOW_SEC - age;
      // A fresh CG clock cannot renew the age of a retained on-chain partition.
      previous.supplyObservedAt = NOW_SEC;
      mocks.read.mockImplementation(async (chain) => chain === "ethereum" ? 70n * 10n ** 6n : null);
      const carried = await readFt(120, previous);
      expect(carried.circulating).toEqual({ peggedUSD: 120 });
      if (age > SUPPLEMENTAL_RESTORE_MAX_AGE_SEC) {
        expect(carried.chainCirculating).toEqual({});
        expect(carried.chainPartition).toBeUndefined();
        expect(vi.mocked(console.warn).mock.calls.map(([line]) => JSON.parse(String(line))))
          .toContainEqual(expect.objectContaining({
            event: "onchain-partition-divergence",
            metadata: expect.objectContaining({ stablecoinId: ftMeta.id, reason: "carry-expired" }),
          }));
      } else {
        expect(carried.chainCirculating).toEqual({
          Ethereum: { chainId: "ethereum", current: 84 }, Sonic: { chainId: "sonic", current: 36 },
        });
        expect(carried.chainPartition).toEqual({ ...previous.chainPartition, admission: "carried" });
        expect(sumRows(carried)).toBe(120);
        const carriedAgain = await readFt(180, carried);
        expect(carriedAgain.chainPartition).toEqual(carried.chainPartition);
        expect(sumRows(carriedAgain)).toBe(180);
      }
    },
  );

  it("attaches an unambiguous single deployment using the same admitted supply price", async () => {
    FIAT_CG_METAS.splice(0, FIAT_CG_METAS.length, aaMeta);
    mocks.read.mockResolvedValue(100n * 10n ** 18n);
    const [asset] = await fetchFiatCoinGeckoTokens(cgData(123, 1.2, aaMeta));
    expect(asset.chainCirculating).toEqual({ Ethereum: { chainId: "ethereum", current: 123 } });
    expect(asset.chainPartition).toMatchObject({ onchainUsd: 120, ratio: 120 / 123, admission: "entered" });
    expect(asset.supplySource).toBe("coingecko-fallback");
    mocks.read.mockResolvedValue(null);
    const [carried] = await fetchFiatCoinGeckoTokens(cgData(150, 1.2, aaMeta), undefined, undefined, undefined,
      undefined, new Map([[asset.id, asset]]));
    expect(carried.chainPartition).toEqual({ ...asset.chainPartition, admission: "carried" });
    expect(carried.chainCirculating).toEqual({ Ethereum: { chainId: "ethereum", current: 150 } });
    expect(carried.circulating).toEqual({ peggedUSD: 150 });
  });

  it.each(["missing-chain", "negative-row"] as const)("does not carry a %s previous partition after an unreadable leg", async (fault) => {
    const previous = await readFt();
    if (fault === "missing-chain") delete previous.chainCirculating!.Sonic;
    else previous.chainCirculating!.Sonic.current = -30;
    mocks.read.mockImplementation(async (chain) => chain === "ethereum" ? 70n * 10n ** 6n : null);
    const asset = await readFt(120, previous);
    expect(asset.circulating).toEqual({ peggedUSD: 120 });
    expect(asset.chainCirculating).toEqual({});
    expect(asset.chainPartition).toBeUndefined();
  });

  it("rejects prior shares for an obsolete chain set even when their sum still matches", async () => {
    const previous = await readFt();
    previous.chainCirculating!.Base = { ...previous.chainCirculating!.Sonic, chainId: "base" };
    delete previous.chainCirculating!.Sonic;
    expect(sumRows(previous)).toBe(100);
    mocks.read.mockResolvedValue(null);
    const asset = await readFt(120, previous);
    expect(asset.chainPartition).toBeUndefined();
    expect(asset.chainCirculating).toEqual({});
    expect(asset.circulating).toEqual({ peggedUSD: 120 });
  });

  it("labels whole-row supply restoration as carried without changing the original shares or clock", async () => {
    const previous = await readFt();
    const previousById = new Map([[previous.id, previous]]);
    const current = { ...previous, circulating: {}, chainCirculating: {}, chainPartition: undefined };
    const restored = [
      restoreMissingTrackedAssets([], previousById, NOW_SEC).assets[0],
      mergeSupplementalLastKnownGood([current], previousById, new Set(), NOW_SEC).assets[0],
    ];
    for (const asset of restored) {
      expect(asset.supplyRestored).toBe(true);
      expect(asset.circulating).toEqual(previous.circulating);
      expect(asset.chainCirculating).toEqual(previous.chainCirculating);
      expect(asset.chainPartition).toEqual({ ...previous.chainPartition, admission: "carried" });
      expect(asset.supplyObservedAt).toBe(previous.supplyObservedAt);
    }
  });

  it("carries shares after a per-leg timeout before the stage deadline", async () => {
    const previous = await readFt();
    mocks.read.mockImplementation(() => new Promise((_resolve, reject) => {
      setTimeout(() => reject(new DOMException("RPC response timeout", "TimeoutError")), ONCHAIN_PARTITION_STAGE_BUDGET_MS / 2);
    }));
    const pending = readFt(120, previous);
    await vi.advanceTimersByTimeAsync(ONCHAIN_PARTITION_STAGE_BUDGET_MS / 2);
    const asset = await pending;
    expect(asset.chainPartition).toEqual({ ...previous.chainPartition, admission: "carried" });
    expect(sumRows(asset)).toBe(120);
    expect(vi.mocked(console.warn).mock.calls.map(([line]) => JSON.parse(String(line))))
      .toContainEqual(expect.objectContaining({
        event: "onchain-partition-divergence",
        metadata: expect.objectContaining({ stablecoinId: ftMeta.id, reason: "legs-unreadable" }),
      }));
  });

  it("conserves the canonical total and scales unattributed escrow without assigning it a chain", async () => {
    mockSusdeSupply();
    const [asset] = await fetchFiatCoinGeckoTokens(cgData(1_020, 1, susdeMeta));
    expect(asset.chainPartition).toMatchObject({ onchainUsd: 1_000, observedAt: NOW_SEC - 30 });
    expect(asset.chainCirculating?.Ethereum?.current).toBeCloseTo(714, 10);
    expect(asset.chainCirculating?.["sUSDe unattributed OFT escrow"]?.current).toBeCloseTo(71.4, 10);
    expect(asset.chainCirculating?.["sUSDe unattributed OFT escrow"]).not.toHaveProperty("chainId");
    expect(sumRows(asset)).toBeCloseTo(1_020, 10);
  });

  it.each(["unreadable-escrow", "escrow-below-representations", "escrow-at-canonical", "representations-above-canonical"] as const)(
    "only carries sUSDe for an unreadable observation, never a contradictory numeric %s", async (fault) => {
      mockSusdeSupply();
      const [previous] = await fetchFiatCoinGeckoTokens(cgData(1_020, 1, susdeMeta));
      if (fault === "representations-above-canonical") mockSusdeSupply(200);
      else mocks.escrow.mockResolvedValue(fault === "unreadable-escrow" ? null : BigInt(fault === "escrow-at-canonical" ? 1_000 : 100) * 10n ** 18n);
      const [asset] = await fetchFiatCoinGeckoTokens(cgData(1_050, 1, susdeMeta), undefined, undefined, undefined,
        undefined, new Map([[previous.id, previous]]));
      expect(asset.circulating).toEqual({ peggedUSD: 1_050 });
      if (fault === "unreadable-escrow") {
        expect(asset.chainPartition).toEqual({ ...previous.chainPartition, admission: "carried" });
        expect(sumRows(asset)).toBeCloseTo(1_050, 10);
        expect(asset.chainCirculating?.["sUSDe unattributed OFT escrow"]).not.toHaveProperty("chainId");
      } else {
        expect(asset.chainPartition).toBeUndefined();
        expect(asset.chainCirculating).toEqual({});
      }
    },
  );

  it.each(["hash-drift", "stale-header"] as const)("does not carry after a fresh joined read fails %s validation", async (fault) => {
    mockSusdeSupply();
    const [previous] = await fetchFiatCoinGeckoTokens(cgData(1_020, 1, susdeMeta));
    vi.mocked(fetchEvmBlockHeader).mockClear().mockImplementation(async () => ({
      number: 123,
      hash: `0x${(fault === "hash-drift" && vi.mocked(fetchEvmBlockHeader).mock.calls.length > 1 ? "2" : "1").repeat(64)}`,
      timestamp: NOW_SEC - (fault === "stale-header" ? 301 : 30),
    }));
    const [asset] = await fetchFiatCoinGeckoTokens(cgData(1_050, 1, susdeMeta), undefined, undefined, undefined,
      undefined, new Map([[previous.id, previous]]));
    expect(asset.circulating).toEqual({ peggedUSD: 1_050 });
    expect(asset.chainCirculating).toEqual({});
    expect(asset.chainPartition).toBeUndefined();
    expect(vi.mocked(console.warn).mock.calls.map(([line]) => JSON.parse(String(line))))
      .toContainEqual(expect.objectContaining({
        event: "onchain-partition-divergence",
        metadata: expect.objectContaining({ stablecoinId: susdeMeta.id, reason: "partition-invalid" }),
      }));
  });

  it("excludes Dwellir routes from the added partition reads without mutating the caller's routing map", async () => {
    const chainRpcs = buildChainRpcs("test-alchemy", undefined, { dwellirApiKey: "test-dwellir" });
    expect(chainRpcs.get("ethereum")?.endpoints.some((endpoint) => endpoint.operator === "dwellir")).toBe(true);
    const [asset] = await fetchFiatCoinGeckoTokens(cgData(100), undefined, chainRpcs);
    expect(asset.chainPartition?.admission).toBe("entered");
    for (const [, , , context] of mocks.read.mock.calls) {
      expect(context.chainRpcs).not.toBe(chainRpcs);
      expect([...context.chainRpcs.values()].flatMap((config: ChainRpcConfig) => config.endpoints)
        .some((endpoint) => endpoint.operator === "dwellir")).toBe(false);
    }
    expect(chainRpcs.get("ethereum")?.endpoints.some((endpoint) => endpoint.operator === "dwellir")).toBe(true);
  });

  it("leaves independently admitted CG supply alone without a NAV price, and keeps no-cap NAV withheld", async () => {
    FIAT_CG_METAS.splice(0, FIAT_CG_METAS.length, aaMeta);
    const [asset] = await fetchFiatCoinGeckoTokens(cgData(100, null, aaMeta));
    expect(asset.chainCirculating).toEqual({});
    expect(asset.chainPartition).toBeUndefined();
    expect(asset.circulating).toEqual({ peggedUSD: 100 });
    expect(mocks.read).not.toHaveBeenCalled();
    expect(await fetchFiatCoinGeckoTokens({})).toEqual([]);
    expect(vi.mocked(console.warn).mock.calls.map(([line]) => JSON.parse(String(line))))
      .toContainEqual(expect.objectContaining({
        event: "supplemental-supply-withheld",
        metadata: expect.objectContaining({ stablecoinId: aaMeta.id, reason: "nav-price-unavailable" }),
      }));
  });

  it("does not carry a previous NAV partition without an admitted current supply price", async () => {
    FIAT_CG_METAS.splice(0, FIAT_CG_METAS.length, aaMeta);
    mocks.read.mockResolvedValue(100n * 10n ** 18n);
    const [previous] = await fetchFiatCoinGeckoTokens(cgData(100, 1, aaMeta));
    mocks.read.mockClear();
    const [asset] = await fetchFiatCoinGeckoTokens(cgData(120, null, aaMeta), undefined, undefined, undefined,
      undefined, new Map([[previous.id, previous]]));
    expect(asset.circulating).toEqual({ peggedUSD: 120 });
    expect(asset.chainCirculating).toEqual({});
    expect(asset.chainPartition).toBeUndefined();
    expect(mocks.read).not.toHaveBeenCalled();
  });

  it("propagates caller cancellation through the partition read", async () => {
    const controller = new AbortController();
    mocks.read.mockImplementation((_chain, _meta, signal: AbortSignal) => new Promise((_resolve, reject) => {
      signal.addEventListener("abort", () => reject(signal.reason), { once: true });
    }));
    const pending = fetchFiatCoinGeckoTokens(cgData(100), controller.signal);
    const failure = new Error("caller stopped the sync");
    const rejected = expect(pending).rejects.toBe(failure);
    await vi.advanceTimersByTimeAsync(0);
    expect(mocks.read).toHaveBeenCalledTimes(1);
    controller.abort(failure);
    await rejected;
  });

  it("stops partition reads at the stage deadline and publishes remaining CG totals without partitions", async () => {
    FIAT_CG_METAS.splice(0, FIAT_CG_METAS.length, ftMeta, aaMeta, susdeMeta);
    mocks.read.mockImplementation((_chain, _meta, signal: AbortSignal) => new Promise((_resolve, reject) => {
      signal.addEventListener("abort", () => reject(signal.reason), { once: true });
    }));
    const report = vi.fn();
    const pending = fetchFiatCoinGeckoTokens({ ...cgData(100), ...cgData(100, 1, aaMeta), ...cgData(100, 1, susdeMeta) },
      undefined, undefined, undefined, undefined, undefined, undefined, report);
    await vi.advanceTimersByTimeAsync(0);
    expect(mocks.read).toHaveBeenCalledTimes(2);
    const offset = Math.floor(NOW_SEC / CRON_SCHEDULE_CADENCES.quarterHourly.intervalSec) % fixtureMetas.length;
    expect(mocks.partitionRead.mock.calls.map(([id]) => id)).toEqual([
      fixtureMetas[offset].id, fixtureMetas[(offset + 1) % fixtureMetas.length].id,
    ]);
    await vi.advanceTimersByTimeAsync(ONCHAIN_PARTITION_STAGE_BUDGET_MS);
    const assets = await pending;
    expect(report).toHaveBeenCalledWith(expect.objectContaining({ candidates: 3, deadlineSkipped: 3, unreadable: 0 }));
    expect(assets).toHaveLength(3);
    expect(mocks.read).toHaveBeenCalledTimes(2);
    for (const asset of assets) {
      expect(asset.circulating).toEqual({ peggedUSD: 100 });
      expect(asset.supplySource).toBe("coingecko-fallback");
      expect(asset.chainCirculating).toEqual({});
      expect(asset.chainPartition).toBeUndefined();
    }
    expect(vi.mocked(console.warn).mock.calls.map(([line]) => JSON.parse(String(line))))
      .toContainEqual(expect.objectContaining({
        event: "onchain-partition-divergence",
        metadata: expect.objectContaining({
          reason: "deadline-exhausted", deadlineSkippedCount: 1, partitionCandidateCount: fixtureMetas.length, partitionStartOffset: offset,
        }),
      }));
  });

  it.each([false, true])("carries a deadline-skipped coin's shares only before expiry (expired %s)", async (expired) => {
    const previousFt = await readFt();
    FIAT_CG_METAS.splice(0, FIAT_CG_METAS.length, aaMeta);
    mocks.read.mockResolvedValue(100n * 10n ** 18n);
    const [previousAa] = await fetchFiatCoinGeckoTokens(cgData(100, 1, aaMeta));
    mockSusdeSupply();
    const [previousSusde] = await fetchFiatCoinGeckoTokens(cgData(1_000, 1, susdeMeta));
    const previousById = new Map([previousFt, previousAa, previousSusde].map((asset) => [asset.id, asset]));
    const offset = Math.floor(NOW_SEC / CRON_SCHEDULE_CADENCES.quarterHourly.intervalSec) % fixtureMetas.length;
    const skippedId = fixtureMetas[(offset + 2) % fixtureMetas.length].id;
    if (expired) previousById.get(skippedId)!.chainPartition!.observedAt = NOW_SEC - SUPPLEMENTAL_RESTORE_MAX_AGE_SEC - 1;
    FIAT_CG_METAS.splice(0, FIAT_CG_METAS.length, ...fixtureMetas);
    mocks.partitionRead.mockClear();
    mocks.read.mockReset().mockImplementation((_chain, _meta, signal: AbortSignal) => new Promise((_resolve, reject) => {
      signal.addEventListener("abort", () => reject(signal.reason), { once: true });
    }));
    const pending = fetchFiatCoinGeckoTokens({ ...cgData(120), ...cgData(150, 1, aaMeta), ...cgData(1_050, 1, susdeMeta) },
      undefined, undefined, undefined, undefined, previousById);
    await vi.advanceTimersByTimeAsync(ONCHAIN_PARTITION_STAGE_BUDGET_MS);
    const assets = await pending;
    expect(mocks.partitionRead.mock.calls.map(([id]) => id)).not.toContain(skippedId);
    expect(assets.map(({ id }) => id)).toEqual(fixtureMetas.map(({ id }) => id));
    for (const asset of assets) {
      if (expired && asset.id === skippedId) {
        expect(asset.chainPartition).toBeUndefined();
        expect(asset.chainCirculating).toEqual({});
      } else {
        expect(asset.chainPartition).toEqual({ ...previousById.get(asset.id)!.chainPartition, admission: "carried" });
        expect(sumRows(asset)).toBeCloseTo(Number(asset.circulating?.peggedUSD), 10);
      }
    }
    if (expired) expect(vi.mocked(console.warn).mock.calls.map(([line]) => JSON.parse(String(line))))
      .toContainEqual(expect.objectContaining({
        event: "onchain-partition-divergence",
        metadata: expect.objectContaining({ stablecoinId: skippedId, reason: "carry-expired" }),
      }));
  });

  it("rotates every candidate into the first read position over consecutive slots while preserving output order", async () => {
    FIAT_CG_METAS.splice(0, FIAT_CG_METAS.length, ...fixtureMetas);
    mocks.read.mockResolvedValue(null);
    const firstIds: string[] = [];
    const orders: string[][] = [];
    for (let slot = 0; slot <= fixtureMetas.length; slot++) {
      const runSec = NOW_SEC + (slot % fixtureMetas.length) * CRON_SCHEDULE_CADENCES.quarterHourly.intervalSec;
      vi.setSystemTime(runSec * 1_000);
      mocks.partitionRead.mockClear();
      const assets = await fetchFiatCoinGeckoTokens({ ...cgData(100), ...cgData(100, 1, aaMeta), ...cgData(100, 1, susdeMeta) });
      const order = mocks.partitionRead.mock.calls.map(([id]) => String(id));
      const offset = Math.floor(runSec / CRON_SCHEDULE_CADENCES.quarterHourly.intervalSec) % fixtureMetas.length;
      expect(order).toEqual(fixtureMetas.map((_meta, index) => fixtureMetas[(offset + index) % fixtureMetas.length].id));
      expect(assets.map(({ id }) => id)).toEqual(fixtureMetas.map(({ id }) => id));
      firstIds.push(order[0]);
      orders.push(order);
    }
    expect(new Set(firstIds.slice(0, fixtureMetas.length)).size).toBe(fixtureMetas.length);
    expect(orders[fixtureMetas.length]).toEqual(orders[0]);
  });
});
