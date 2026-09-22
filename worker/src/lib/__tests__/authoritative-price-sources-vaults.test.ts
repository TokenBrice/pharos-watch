import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  asset,
  fetchEvmCallHexAtBlockMock,
  fetchEvmRpcBatchMock,
  fetchLiveOverrides,
  freshParent,
  makeCircuitCacheRow,
  resetAuthoritativePriceSourceMocks,
  unpricedChild,
} from "./authoritative-price-sources.test-support";


import {
  AUTHORITATIVE_LIVE_CANDIDATE_TIMEOUT_MS,
  createAuthoritativeLivePriceOverrideStats,
} from "../authoritative-price-sources";
import { CIRCUIT_SOURCE } from "../constants";
import { PRICING_SOURCE_REGISTRY } from "@shared/lib/pricing-source-registry";
import { mockD1 } from "@shared/test-utils/mock-d1";
import {
  encodeUint256,
  fetchVaultAssetsPerShareViaSelector,
  type Erc4626NavVaultConfig,
} from "../authoritative-price-sources/helpers";

const IUSD_QUOTE_HEX = "0x00000000000000000000000000000000000000000000000000000000000f4240";
const ZERO_WORD_HEX = `0x${"0".repeat(64)}` as `0x${string}`;

describe("authoritative-price-sources", () => {
  beforeEach(() => {
    resetAuthoritativePriceSourceMocks();
  });

  describe("fetchVaultAssetsPerShareViaSelector", () => {
    const vaultConfig = {
      id: "test-vault",
      parentId: "usdc-circle",
      chain: "ethereum",
      vault: "0xvault",
      vaultDecimals: 18,
      assetDecimals: 6,
      rpcUrls: ["https://rpc.example"],
    } satisfies Erc4626NavVaultConfig;

    it("returns an assets-per-share ratio from a selector quote", async () => {
      const signal = new AbortController().signal;
      fetchEvmCallHexAtBlockMock.mockResolvedValue(IUSD_QUOTE_HEX);

      await expect(
        fetchVaultAssetsPerShareViaSelector(vaultConfig, "0x12345678", "previewRedeem", 123, signal),
      ).resolves.toBe(1);

      expect(fetchEvmCallHexAtBlockMock).toHaveBeenCalledWith(
        "ethereum",
        "0xvault",
        `0x12345678${encodeUint256(10n ** 18n)}`,
        123,
        {
          signal,
          extraRpcUrls: ["https://rpc.example"],
          chainRpcs: undefined,
        },
      );
    });

    it("preserves explicit vault RPC priority over configured routing", async () => {
      const chainRpcs = new Map();
      fetchEvmCallHexAtBlockMock.mockResolvedValue(IUSD_QUOTE_HEX);
      await fetchVaultAssetsPerShareViaSelector(vaultConfig, "0x12345678", "previewRedeem", 123, undefined, { chainRpcs });
      expect(fetchEvmCallHexAtBlockMock.mock.calls[fetchEvmCallHexAtBlockMock.mock.calls.length - 1]?.[4]).toMatchObject({
        extraRpcUrls: ["https://rpc.example"], chainRpcs: undefined,
      });
    });

    it("rejects null, zero, and out-of-bounds selector quotes", async () => {
      const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => undefined);

      fetchEvmCallHexAtBlockMock.mockResolvedValueOnce(null);
      await expect(
        fetchVaultAssetsPerShareViaSelector(vaultConfig, "0x12345678", "previewRedeem", "latest"),
      ).resolves.toBeNull();

      fetchEvmCallHexAtBlockMock.mockResolvedValueOnce(ZERO_WORD_HEX);
      await expect(
        fetchVaultAssetsPerShareViaSelector(vaultConfig, "0x12345678", "previewRedeem", "latest"),
      ).resolves.toBeNull();

      fetchEvmCallHexAtBlockMock.mockResolvedValueOnce(`0x${encodeUint256(11_000_000)}`);
      await expect(
        fetchVaultAssetsPerShareViaSelector(vaultConfig, "0x12345678", "previewRedeem", "latest"),
      ).resolves.toBeNull();

      expect(warnSpy).toHaveBeenCalledWith(expect.stringContaining("[authoritative-price-sources] test-vault: previewRedeem() returned null"));
      expect(warnSpy).toHaveBeenCalledWith(
        expect.stringContaining("[authoritative-price-sources] test-vault: previewRedeem() returned zero or invalid output"),
      );
      expect(warnSpy).toHaveBeenCalledWith(
        expect.stringContaining("[authoritative-price-sources] test-vault: previewRedeem() ratio 11 outside trusted bounds"),
      );
    });
  });
  it("prices an ERC-4626 NAV vault from convertToAssets() x parent price", async () => {
    // convertToAssets(10^18 gtUSDC shares) -> 1_010_000 USDC (1.01 per share)
    const oneShareUsdcRaw = 1_010_000n.toString(16).padStart(64, "0");
    fetchEvmCallHexAtBlockMock.mockResolvedValueOnce(`0x${oneShareUsdcRaw}`);
    const nowSec = Math.floor(Date.now() / 1000);

    const overrides = await fetchLiveOverrides([
      asset("gtusdc-gauntlet", { circulating: { peggedUSD: 128_000_000 } }),
      freshParent("usdc-circle", 0.9999, "coingecko+pyth", { nowSec }),
    ]);

    expect(fetchEvmCallHexAtBlockMock).toHaveBeenCalledTimes(1);
    expect(fetchEvmCallHexAtBlockMock).toHaveBeenCalledWith(
      "ethereum",
      "0xdd0f28e19c1780eb6396170735d45153d261490d",
      expect.stringMatching(/^0x07a2d13a/),
      "latest",
      expect.any(Object),
    );

    const override = overrides.get("gtusdc-gauntlet");
    expect(override).toMatchObject({
      source: "protocol-redeem",
      confidence: "high",
      metadata: {
        inheritedFrom: "usdc-circle",
        parentSource: "coingecko+pyth",
        parentConfidence: "high",
      },
    });
    // 1.01 assets per share * $0.9999 parent = ~$1.009899
    expect(override?.price).toBeCloseTo(1.01 * 0.9999, 4);
  });

  it("prices an ERC-4626 NAV vault when a fresh same-run composite parent has an older component timestamp", async () => {
    const oneShareUsdcRaw = 1_115_989n.toString(16).padStart(64, "0");
    fetchEvmCallHexAtBlockMock.mockResolvedValueOnce(`0x${oneShareUsdcRaw}`);
    const nowSec = Math.floor(Date.now() / 1000);

    const overrides = await fetchLiveOverrides([
      asset("gtusdc-gauntlet", { circulating: { peggedUSD: 128_000_000 } }),
      freshParent("usdc-circle", 0.9999, "coingecko+pyth", {
        nowSec,
        observedAt: nowSec - 900,
        priceSyncedAt: nowSec - 60,
      }),
    ]);

    const override = overrides.get("gtusdc-gauntlet");
    expect(override).toMatchObject({
      source: "protocol-redeem",
      confidence: "high",
      observedAt: nowSec - 60,
      observedAtMode: "local_fetch",
      metadata: {
        inheritedFrom: "usdc-circle",
        parentSource: "coingecko+pyth",
        parentConfidence: "high",
      },
    });
    expect(override?.price).toBeCloseTo(1.115989 * 0.9999, 4);
  });

  it("prices audited ERC-4626 NAV vaults from their configured parent assets", async () => {
    const nowSec = Math.floor(Date.now() / 1000);
    const cases = [
      {
        id: "susdt-spark",
        parentId: "usdt-tether",
        parentSymbol: "USDT",
        vault: "0xe2e7a17dff93280dec073c995595155283e3c372",
        chain: "ethereum",
        vaultDecimals: 6,
        outputRaw: 1_020_856n,
        expectedRatio: 1.020856,
      },
      {
        id: "susdc-spark",
        parentId: "usdc-circle",
        parentSymbol: "USDC",
        vault: "0x28b3a8fb53b741a8fd78c0fb9a6b2393d896a43d",
        chain: "ethereum",
        vaultDecimals: 6,
        outputRaw: 1_022_324n,
        expectedRatio: 1.022324,
      },
      {
        id: "gtusdcp-gauntlet",
        parentId: "usdc-circle",
        parentSymbol: "USDC",
        vault: "0x8c106eedad96553e64287a5a6839c3cc78afa3d0",
        chain: "ethereum",
        vaultDecimals: 18,
        outputRaw: 1_021_717n,
        expectedRatio: 1.021717,
      },
      {
        id: "steakusdt-steakhouse",
        parentId: "usdt-tether",
        parentSymbol: "USDT",
        vault: "0xbeef003c68896c7d2c3c60d363e8d71a49ab2bf9",
        chain: "ethereum",
        vaultDecimals: 18,
        outputRaw: 1_013_670n,
        expectedRatio: 1.01367,
      },
      {
        id: "steakusdc-steakhouse",
        parentId: "usdc-circle",
        parentSymbol: "USDC",
        vault: "0xbeef088055857739c12cd3765f20b7679def0f51",
        chain: "ethereum",
        vaultDecimals: 18,
        outputRaw: 1_029_307n,
        expectedRatio: 1.029307,
      },
      {
        id: "bbqusdc-steakhouse",
        parentId: "usdc-circle",
        parentSymbol: "USDC",
        vault: "0xbeefff209270748ddd194831b3fa287a5386f5bc",
        chain: "ethereum",
        vaultDecimals: 18,
        outputRaw: 1_114_859n,
        expectedRatio: 1.114859,
      },
      {
        id: "susds-sky",
        parentId: "usds-sky",
        parentSymbol: "USDS",
        vault: "0xa3931d71877c0e7a3148cb7eb4463524fec27fbd",
        chain: "ethereum",
        vaultDecimals: 18,
        outputRaw: 1_107_520_438_997_439_491n,
        expectedRatio: 1.10752043,
      },
      {
        id: "susde-ethena",
        parentId: "usde-ethena",
        parentSymbol: "USDe",
        vault: "0x9d39a5de30e57443bff2a8307a4256c8797a3497",
        chain: "ethereum",
        vaultDecimals: 18,
        outputRaw: 1_245_114_135_085_881_836n,
        expectedRatio: 1.24511413,
      },
      {
        id: "srusde-strata",
        parentId: "usde-ethena",
        parentSymbol: "USDe",
        vault: "0x3d7d6fdf07ee548b939a80edbc9b2256d0cdc003",
        chain: "ethereum",
        vaultDecimals: 18,
        outputRaw: 1_020_871_205_300_000_000n,
        expectedRatio: 1.0208712,
      },
      {
        id: "autousd-auto-finance",
        parentId: "usdc-circle",
        parentSymbol: "USDC",
        vault: "0xa7569a44f348d3d70d8ad5889e50f78e33d80d35",
        chain: "ethereum",
        vaultDecimals: 18,
        outputRaw: 1_089_794n,
        expectedRatio: 1.089794,
      },
      {
        id: "eearn-ember",
        parentId: "usdc-circle",
        parentSymbol: "USDC",
        vault: "0x9be9294722f8aad37b11a9792be2c782182cafa2",
        chain: "ethereum",
        vaultDecimals: 6,
        outputRaw: 1_026_816n,
        expectedRatio: 1.026816,
      },
      {
        id: "syusd-aegis",
        parentId: "yusd-aegis",
        parentSymbol: "YUSD",
        vault: "0xfe0ccc9942e98c963fe6b4e5194eb6e3baa4cb64",
        chain: "ethereum",
        vaultDecimals: 18,
        outputRaw: 1_041_919_601_032_091_731n,
        expectedRatio: 1.0419196,
      },
      {
        id: "sbold-k3-capital",
        parentId: "bold-liquity",
        parentSymbol: "BOLD",
        vault: "0x50bd66d59911f5e086ec87ae43c811e0d059dd11",
        chain: "ethereum",
        vaultDecimals: 18,
        outputRaw: 1_041_000_000_000_000_000n,
        expectedRatio: 1.041,
      },
      {
        id: "ybold-yearn",
        parentId: "bold-liquity",
        parentSymbol: "BOLD",
        vault: "0x9f4330700a36b29952869fac9b33f45eedd8a3d8",
        chain: "ethereum",
        vaultDecimals: 18,
        outputRaw: 1_000_000_000_000_000_000n,
        expectedRatio: 1,
      },
    ];

    for (const testCase of cases) {
      fetchEvmCallHexAtBlockMock.mockResolvedValueOnce(`0x${testCase.outputRaw.toString(16).padStart(64, "0")}`);

      const overrides = await fetchLiveOverrides([
        asset(testCase.id, { circulating: { peggedUSD: 1_000_000 } }),
        freshParent(testCase.parentId, 1, "coingecko+pyth", { nowSec }),
      ]);

      expect(fetchEvmCallHexAtBlockMock).toHaveBeenLastCalledWith(
        testCase.chain,
        testCase.vault,
        `0x07a2d13a${(10n ** BigInt(testCase.vaultDecimals)).toString(16).padStart(64, "0")}`,
        "latest",
        expect.any(Object),
      );
      expect(overrides.get(testCase.id)).toMatchObject({
        source: "protocol-redeem",
        confidence: "high",
        metadata: {
          inheritedFrom: testCase.parentId,
        },
      });
      expect(overrides.get(testCase.id)?.price).toBeCloseTo(testCase.expectedRatio, 6);
    }
  });

  it("allows scoped BOLD ERC-4626 wrappers to use a fresh high-confidence address-composite parent", async () => {
    const outputRaw = 1_062_000_000_000_000_000n.toString(16).padStart(64, "0");
    fetchEvmCallHexAtBlockMock.mockResolvedValueOnce(`0x${outputRaw}`);
    const nowSec = Math.floor(Date.now() / 1000);

    const overrides = await fetchLiveOverrides([
      asset("gtusdc-gauntlet", { circulating: { peggedUSD: 128_000_000 } }),
      freshParent("usdc-circle", 0.9999, "alchemy-address+coingecko+moralis-address", {
        nowSec,
        priceObservedAtMode: "local_fetch",
      }),
      asset("sbold-k3-capital", { circulating: { peggedUSD: 8_000_000 } }),
      freshParent("bold-liquity", 1.0001, "alchemy-address+coingecko+moralis-address", {
        nowSec,
        priceObservedAtMode: "local_fetch",
      }),
    ]);

    expect(fetchEvmCallHexAtBlockMock).toHaveBeenCalledTimes(1);
    expect(fetchEvmCallHexAtBlockMock).toHaveBeenCalledWith(
      "ethereum",
      "0x50bd66d59911f5e086ec87ae43c811e0d059dd11",
      expect.stringMatching(/^0x07a2d13a/),
      "latest",
      expect.any(Object),
    );
    expect(overrides.has("gtusdc-gauntlet")).toBe(false);
    expect(overrides.get("sbold-k3-capital")).toMatchObject({
      source: "protocol-redeem",
      confidence: "high",
      metadata: {
        inheritedFrom: "bold-liquity",
        parentReplaySafe: false,
      },
    });
    expect(overrides.get("sbold-k3-capital")?.price).toBeCloseTo(1.062 * 1.0001, 6);
  });

  it("prices unscoped ERC-4626 NAV vaults from a high-confidence parent carrying an agreeing non-replay-safe corroborator", async () => {
    // Reproduces the 2026-07-19 outage: the exact-address augmentation lane
    // joined the USDC winning cluster, and the every-member replay-safety rule
    // rejected the parent for every unscoped wrapper.
    const oneShareUsdcRaw = 1_010_000n.toString(16).padStart(64, "0");
    fetchEvmCallHexAtBlockMock.mockResolvedValueOnce(`0x${oneShareUsdcRaw}`);
    const nowSec = Math.floor(Date.now() / 1000);

    const overrides = await fetchLiveOverrides([
      asset("gtusdc-gauntlet", { circulating: { peggedUSD: 128_000_000 } }),
      freshParent("usdc-circle", 0.9999, "bitstamp+coingecko+coingecko-onchain-address+kraken+pyth+redstone", {
        nowSec,
        priceObservedAtMode: "local_fetch",
      }),
    ]);

    const override = overrides.get("gtusdc-gauntlet");
    expect(override).toMatchObject({
      source: "protocol-redeem",
      confidence: "high",
      metadata: {
        inheritedFrom: "usdc-circle",
        parentReplaySafe: true,
      },
    });
    expect(override?.price).toBeCloseTo(1.01 * 0.9999, 4);
  });

  it("keeps a trusted composite parent trusted when any registered non-replay-safe lane joins its label", async () => {
    // Trust monotonicity: agreeing corroborators must never downgrade a parent
    // whose replay-safe core is trusted on its own. Iterates every registered
    // non-replay-safe lane so a future soft source cannot regress the gate.
    const softLanes = PRICING_SOURCE_REGISTRY.filter(
      (entry) => !entry.isReplaySafe && entry.trustTier !== "cached_replay",
    ).map((entry) => entry.key);
    expect(softLanes.length).toBeGreaterThan(0);
    const oneShareUsdcRaw = 1_010_000n.toString(16).padStart(64, "0");
    fetchEvmCallHexAtBlockMock.mockResolvedValue(`0x${oneShareUsdcRaw}`);
    const nowSec = Math.floor(Date.now() / 1000);

    for (const lane of softLanes) {
      const overrides = await fetchLiveOverrides([
        asset("gtusdc-gauntlet", { circulating: { peggedUSD: 128_000_000 } }),
        freshParent("usdc-circle", 0.9999, `coingecko+pyth+${lane}`, { nowSec }),
      ]);

      expect(overrides.has("gtusdc-gauntlet"), lane).toBe(true);
    }
  });

  it("passes configured RPC routing through the authoritative stage to vault readers", async () => {
    const chainRpcs = new Map();
    fetchEvmCallHexAtBlockMock.mockResolvedValue(`0x${(1_000_000n).toString(16).padStart(64, "0")}`);
    await fetchLiveOverrides([
      asset("gtusdc-gauntlet"),
      freshParent("usdc-circle", 1, "coingecko+kraken", { nowSec: Math.floor(Date.now() / 1000) }),
    ], { chainRpcs });
    expect(fetchEvmCallHexAtBlockMock.mock.calls[fetchEvmCallHexAtBlockMock.mock.calls.length - 1]?.[4].chainRpcs).toBe(chainRpcs);
    expect(fetchEvmCallHexAtBlockMock.mock.calls[fetchEvmCallHexAtBlockMock.mock.calls.length - 1]?.[4].extraRpcUrls).toContain("https://ethereum-rpc.publicnode.com");
  });

  it("records a provider stage rejection without leaking it into the next missing quote", async () => {
    fetchEvmRpcBatchMock.mockResolvedValue(null);
    fetchEvmCallHexAtBlockMock.mockResolvedValue(null);
    const stats = createAuthoritativeLivePriceOverrideStats();
    await fetchLiveOverrides([
      asset("deuro-deuro"),
      asset("cusd-cap"),
      freshParent("eurc-circle", 1.15, "coingecko+kraken", { nowSec: Math.floor(Date.now() / 1000) }),
    ], { stats });
    expect(stats.assetAttempts.find((row) => row.assetId === "deuro-deuro")).toMatchObject({
      result: "empty", rejectionClass: "deuro-eurc-bridge:head-unavailable",
    });
    expect(stats.assetAttempts.find((row) => row.assetId === "cusd-cap")).toMatchObject({
      result: "empty", rejectionClass: "missing-quote",
    });
  });

  it("still rejects a thin replay-safe core padded to high confidence and names the parent in the attempt ledger", async () => {
    // No-upgrade guard: a single replay-safe member padded to "high" by a soft
    // corroborator must not become a trusted composite for unscoped vaults, and
    // the rejection must be attributable in the persisted attempt ledger.
    const nowSec = Math.floor(Date.now() / 1000);
    const stats = createAuthoritativeLivePriceOverrideStats();

    const overrides = await fetchLiveOverrides(
      [
        asset("gtusdc-gauntlet", { circulating: { peggedUSD: 128_000_000 } }),
        freshParent("usdc-circle", 0.9999, "coingecko+coingecko-onchain-address", {
          nowSec,
          priceObservedAtMode: "local_fetch",
        }),
      ],
      { stats },
    );

    expect(overrides.has("gtusdc-gauntlet")).toBe(false);
    expect(fetchEvmCallHexAtBlockMock).not.toHaveBeenCalled();
    expect(stats.assetAttempts).toEqual([
      expect.objectContaining({
        assetId: "gtusdc-gauntlet",
        state: "attempted",
        result: "empty",
        rejectionClass: "untrusted-parent:usdc-circle:thin-replay-safe-core",
      }),
    ]);
  });

  it("prices inheritance wrappers from a high-confidence parent carrying an agreeing non-replay-safe corroborator", async () => {
    // WEUSD has no on-chain leg at all — its 2026-07-19 outage was purely the
    // poisoned-parent gate, so it is the cleanest inheritance regression.
    const nowSec = Math.floor(Date.now() / 1000);

    const overrides = await fetchLiveOverrides([
      asset("weusd-picwe", { circulating: { peggedUSD: 500_000 } }),
      freshParent("usdc-circle", 0.9999, "bitstamp+coingecko+coingecko-onchain-address+kraken+pyth+redstone", {
        nowSec,
        priceObservedAtMode: "local_fetch",
      }),
    ]);

    expect(overrides.get("weusd-picwe")).toMatchObject({
      source: "protocol-redeem",
      confidence: "high",
      metadata: {
        inheritedFrom: "usdc-circle",
        parentReplaySafe: true,
      },
    });
    expect(overrides.get("weusd-picwe")?.price).toBeCloseTo(0.99 * 0.9999, 6);
  });

  it("publishes a cached-rate degradation price when the live vault read fails for a missing asset", async () => {
    fetchEvmCallHexAtBlockMock.mockRejectedValue(new Error("rpc down"));
    const nowSec = Math.floor(Date.now() / 1000);
    const db = mockD1([
      {
        match: "SELECT value, updated_at FROM cache WHERE key = ?",
        rows: [],
        first: null,
      },
      {
        match: "FROM authoritative_vault_rates",
        rows: [{ stablecoin_id: "gtusdc-gauntlet", rate: 1.0221, observed_at: nowSec - 3600 }],
      },
    ], { assertMatchesUsed: true });
    const stats = createAuthoritativeLivePriceOverrideStats();

    const overrides = await fetchLiveOverrides(
      [
        asset("gtusdc-gauntlet", { circulating: { peggedUSD: 128_000_000 } }),
        freshParent("usdc-circle", 0.9999, "coingecko+pyth", { nowSec }),
      ],
      { db, stats },
    );

    const override = overrides.get("gtusdc-gauntlet");
    expect(override).toMatchObject({
      source: "protocol-redeem-cached-rate",
      confidence: "low",
      metadata: {
        inheritedFrom: "usdc-circle",
        cachedVaultRate: { rate: 1.0221, rateObservedAt: nowSec - 3600 },
      },
    });
    expect(override?.price).toBeCloseTo(1.0221 * 0.9999, 6);
    expect(override?.observedAt).toBe(nowSec - 3600);
    expect(stats.cachedRateFallbacks).toBe(1);
    const circuitWrite = db.getHistory().find((entry) =>
      entry.sql.includes("INSERT OR REPLACE INTO cache") && entry.binds[0] === `circuit:${CIRCUIT_SOURCE.PROTOCOL_REDEEM}`);
    expect(JSON.parse(String(circuitWrite?.binds[1]))).toMatchObject({ consecutiveFailures: 1 });
    expect(stats.assetAttempts).toEqual([
      expect.objectContaining({
        assetId: "gtusdc-gauntlet",
        result: "resolved",
        source: "protocol-redeem-cached-rate",
      }),
    ]);
  });

  it("keeps a cached-rate rescue of a candidate timeout circuit-neutral", async () => {
    vi.useFakeTimers();
    try {
      fetchEvmCallHexAtBlockMock.mockImplementation(
        (_chain, _target, _data, _block, options) => new Promise((_resolve, reject) => {
          options?.signal?.addEventListener("abort", () => reject(options.signal?.reason), { once: true });
        }),
      );
      const nowSec = Math.floor(Date.now() / 1000);
      const db = mockD1([
        makeCircuitCacheRow(CIRCUIT_SOURCE.PROTOCOL_REDEEM),
        {
          match: "FROM authoritative_vault_rates",
          rows: [{ stablecoin_id: "gtusdc-gauntlet", rate: 1.0221, observed_at: nowSec - 3600 }],
        },
      ], { assertMatchesUsed: true });
      const pending = fetchLiveOverrides([
        unpricedChild("gtusdc-gauntlet"),
        freshParent("usdc-circle", 1, "coingecko+pyth", { nowSec }),
      ], { db, wallClockBudgetMs: 10_000 });
      await vi.advanceTimersByTimeAsync(AUTHORITATIVE_LIVE_CANDIDATE_TIMEOUT_MS);
      expect((await pending).get("gtusdc-gauntlet")?.source).toBe("protocol-redeem-cached-rate");
      expect(db.getHistory().filter((entry) =>
        entry.sql.includes("INSERT OR REPLACE INTO cache") && entry.binds[0] === `circuit:${CIRCUIT_SOURCE.PROTOCOL_REDEEM}`,
      )).toHaveLength(0);
    } finally {
      vi.useRealTimers();
    }
  });

  it("keeps failing hard when the cached vault rate is too old to trust", async () => {
    fetchEvmCallHexAtBlockMock.mockRejectedValue(new Error("rpc down"));
    const nowSec = Math.floor(Date.now() / 1000);
    const db = mockD1([
      {
        match: "SELECT value, updated_at FROM cache WHERE key = ?",
        rows: [],
        first: null,
      },
      {
        // The 24h read-side WHERE bound excludes this row, and even a returned
        // stale row would fail the in-memory trust check.
        match: "FROM authoritative_vault_rates",
        rows: [{ stablecoin_id: "gtusdc-gauntlet", rate: 1.0221, observed_at: nowSec - 25 * 3600 }],
      },
    ], { assertMatchesUsed: true });
    const stats = createAuthoritativeLivePriceOverrideStats();

    const overrides = await fetchLiveOverrides(
      [
        asset("gtusdc-gauntlet", { circulating: { peggedUSD: 128_000_000 } }),
        freshParent("usdc-circle", 0.9999, "coingecko+pyth", { nowSec }),
      ],
      { db, stats },
    );

    expect(overrides.size).toBe(0);
    expect(stats.cachedRateFallbacks).toBe(0);
    expect(stats.failedCount).toBe(1);
  });

  it("persists fresh live vault rates for the durable cache after a successful read", async () => {
    const oneShareUsdcRaw = 1_010_000n.toString(16).padStart(64, "0");
    fetchEvmCallHexAtBlockMock.mockResolvedValueOnce(`0x${oneShareUsdcRaw}`);
    const nowSec = Math.floor(Date.now() / 1000);
    const db = mockD1([
      {
        match: "SELECT value, updated_at FROM cache WHERE key = ?",
        rows: [],
        first: null,
      },
      {
        match: "INSERT INTO authoritative_vault_rates",
        rows: [],
      },
    ], { assertMatchesUsed: true });

    const overrides = await fetchLiveOverrides(
      [
        asset("gtusdc-gauntlet", { circulating: { peggedUSD: 128_000_000 } }),
        freshParent("usdc-circle", 0.9999, "coingecko+pyth", { nowSec }),
      ],
      { db },
    );

    expect(overrides.get("gtusdc-gauntlet")).toMatchObject({ source: "protocol-redeem" });
    const rateWrite = db
      .getHistory()
      .find((entry) => entry.sql.includes("INSERT INTO authoritative_vault_rates"));
    expect(rateWrite?.binds[0]).toBe("gtusdc-gauntlet");
    expect(rateWrite?.binds[1]).toBeCloseTo(1.01, 8);
  });

  it("prices sYUSD before GT hardening from a fresh replay-safe single-source YUSD parent", async () => {
    const assetsPerShareRaw = 1_044_572_348_140_406_493n.toString(16).padStart(64, "0");
    fetchEvmCallHexAtBlockMock.mockResolvedValueOnce(`0x${assetsPerShareRaw}`);
    const nowSec = Math.floor(Date.now() / 1000);

    const overrides = await fetchLiveOverrides([
      unpricedChild("syusd-aegis"),
      freshParent("yusd-aegis", 0.99896, "coingecko", {
        nowSec,
        priceConfidence: "single-source",
      }),
    ]);

    expect(fetchEvmCallHexAtBlockMock).toHaveBeenCalledWith(
      "ethereum",
      "0xfe0ccc9942e98c963fe6b4e5194eb6e3baa4cb64",
      expect.stringMatching(/^0x07a2d13a/),
      "latest",
      expect.any(Object),
    );
    expect(overrides.get("syusd-aegis")).toMatchObject({
      price: expect.closeTo(1.043486, 6),
      source: "coingecko",
      confidence: "single-source",
      metadata: {
        inheritedFrom: "yusd-aegis",
        parentSource: "coingecko",
        parentConfidence: "single-source",
        parentReplaySafe: true,
      },
    });
  });

  it("prices Aave sGHO from the registry vault previewRedeem() x tracked GHO price", async () => {
    const oneGhoRaw = 1_000_000_000_000_000_000n.toString(16).padStart(64, "0");
    fetchEvmCallHexAtBlockMock.mockResolvedValueOnce(`0x${oneGhoRaw}`);
    const nowSec = Math.floor(Date.now() / 1000);

    const overrides = await fetchLiveOverrides([
      asset("sgho-aave", { circulating: { peggedUSD: 4_000_000 } }),
      freshParent("gho-aave", 0.9997, "coingecko+pyth", { nowSec }),
    ]);

    expect(fetchEvmCallHexAtBlockMock).toHaveBeenCalledWith(
      "ethereum",
      "0xe1753f2e00940cc31213dd92013cf019dfe4ca1d",
      expect.stringMatching(/^0x4cdad506/),
      "latest",
      expect.any(Object),
    );
    expect(overrides.get("sgho-aave")).toMatchObject({
      price: 0.9997,
      source: "protocol-redeem",
      confidence: "high",
      metadata: { inheritedFrom: "gho-aave" },
    });
  });

  it("prices GAIB sAID from its registry ERC-4626 vault x tracked AID price", async () => {
    const assetsPerShareRaw = 1_059_200_000_000_000_000n.toString(16).padStart(64, "0");
    fetchEvmCallHexAtBlockMock.mockResolvedValueOnce(`0x${assetsPerShareRaw}`);
    const nowSec = Math.floor(Date.now() / 1000);

    const overrides = await fetchLiveOverrides([
      unpricedChild("said-gaib"),
      freshParent("aid-gaib", 1, "coingecko+defillama-list", { nowSec }),
    ]);

    expect(fetchEvmCallHexAtBlockMock).toHaveBeenCalledWith(
      "ethereum",
      "0xb3b3c527ba57cd61648e2ec2f5e006a0b390a9f8",
      expect.stringMatching(/^0x07a2d13a/),
      "latest",
      expect.any(Object),
    );
    expect(overrides.get("said-gaib")).toMatchObject({
      price: 1.0592,
      source: "protocol-redeem",
      confidence: "high",
      metadata: { inheritedFrom: "aid-gaib" },
    });
  });

  it("allows sAID to use a fresh high-confidence non-replay-safe AID parent in the same run", async () => {
    const assetsPerShareRaw = 1_059_200_000_000_000_000n.toString(16).padStart(64, "0");
    fetchEvmCallHexAtBlockMock.mockResolvedValueOnce(`0x${assetsPerShareRaw}`);
    const nowSec = Math.floor(Date.now() / 1000);

    const overrides = await fetchLiveOverrides([
      unpricedChild("said-gaib"),
      freshParent("aid-gaib", 0.9998, "alchemy-address+coingecko+moralis-address", {
        nowSec,
        priceObservedAtMode: "local_fetch",
        priceSyncedAt: nowSec - 30,
      }),
    ]);

    expect(overrides.get("said-gaib")).toMatchObject({
      price: 1.05898816,
      source: "protocol-redeem",
      confidence: "high",
      metadata: {
        inheritedFrom: "aid-gaib",
        parentReplaySafe: false,
      },
    });
    expect(fetchEvmCallHexAtBlockMock).toHaveBeenCalledTimes(1);
  });

  it("allows sAID to use a fresh replay-safe single-source AID parent", async () => {
    const assetsPerShareRaw = 1_059_200_000_000_000_000n.toString(16).padStart(64, "0");
    fetchEvmCallHexAtBlockMock.mockResolvedValueOnce(`0x${assetsPerShareRaw}`);
    const nowSec = Math.floor(Date.now() / 1000);

    const overrides = await fetchLiveOverrides([
      unpricedChild("said-gaib"),
      freshParent("aid-gaib", 0.998441, "coingecko", {
        nowSec,
        priceConfidence: "single-source",
        priceSyncedAt: nowSec - 30,
      }),
    ]);

    expect(overrides.get("said-gaib")).toMatchObject({
      price: 1.0575487072,
      source: "coingecko",
      confidence: "single-source",
      metadata: {
        inheritedFrom: "aid-gaib",
        parentReplaySafe: true,
      },
    });
    expect(fetchEvmCallHexAtBlockMock).toHaveBeenCalledTimes(1);
  });

  it("still rejects cached, stale, or low-confidence non-replay-safe AID parents for sAID", async () => {
    vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const nowSec = Math.floor(Date.now() / 1000);
    const parentCases = [
      {
        priceSource: "cached+alchemy-address+moralis-address",
        priceConfidence: "high" as const,
        priceObservedAt: nowSec - 60,
      },
      {
        priceSource: "alchemy-address+coingecko+moralis-address",
        priceConfidence: "high" as const,
        priceObservedAt: nowSec - 20 * 60,
      },
      {
        priceSource: "alchemy-address+coingecko+moralis-address",
        priceConfidence: "high" as const,
        priceObservedAt: nowSec - 20 * 60,
        priceSyncedAt: nowSec - 30,
      },
      {
        priceSource: "alchemy-address+coingecko+moralis-address",
        priceConfidence: "low" as const,
        priceObservedAt: nowSec - 60,
      },
    ];

    for (const parentCase of parentCases) {
      const overrides = await fetchLiveOverrides([
        unpricedChild("said-gaib"),
        asset("aid-gaib", { price: 0.9998, priceObservedAtMode: "local_fetch", ...parentCase }),
      ]);

      expect(overrides.has("said-gaib")).toBe(false);
    }
    expect(fetchEvmCallHexAtBlockMock).not.toHaveBeenCalled();
  });

  it("skips ERC-4626 NAV override when parent price is stale or untrusted", async () => {
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
    const nowSec = Math.floor(Date.now() / 1000);

    const overrides = await fetchLiveOverrides([
      asset("gtusdc-gauntlet", { circulating: { peggedUSD: 128_000_000 } }),
      freshParent("usdc-circle", 0.9999, "coingecko+pyth", { nowSec, priceConfidence: "low" }),
    ]);

    expect(fetchEvmCallHexAtBlockMock).not.toHaveBeenCalled();
    expect(overrides.has("gtusdc-gauntlet")).toBe(false);
    warnSpy.mockRestore();
  });

  it.each([
    { childId: "susds-sky", parentId: "usds-sky" },
    { childId: "susde-ethena", parentId: "usde-ethena" },
  ])("keeps $childId unpriced when its parent is stale or untrusted", async ({ childId, parentId }) => {
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
    const nowSec = Math.floor(Date.now() / 1000);
    const parents = [
      freshParent(parentId, 1, "coingecko+pyth", { nowSec, priceConfidence: "low" }),
      freshParent(parentId, 1, "coingecko+pyth", { nowSec, observedAt: nowSec - 24 * 60 * 60 }),
    ];

    for (const parent of parents) {
      const overrides = await fetchLiveOverrides([unpricedChild(childId), parent]);
      expect(overrides.has(childId)).toBe(false);
    }

    expect(fetchEvmCallHexAtBlockMock).not.toHaveBeenCalled();
    warnSpy.mockRestore();
  });

  it("prices an Idle CDO senior tranche from virtualPrice() x parent USDC price", async () => {
    // virtualPrice returns 1_081_076 (= 1.081076 USDC per AA share, 6 decimals)
    const virtualPriceRaw = 1_081_076n.toString(16).padStart(64, "0");
    fetchEvmCallHexAtBlockMock.mockResolvedValueOnce(`0x${virtualPriceRaw}`);
    const nowSec = Math.floor(Date.now() / 1000);

    const overrides = await fetchLiveOverrides([
      asset("aa-falconx-mev-capital", { circulating: { peggedUSD: 117_450_000 } }),
      freshParent("usdc-circle", 0.9999, "coingecko+pyth", { nowSec }),
    ]);

    expect(fetchEvmCallHexAtBlockMock).toHaveBeenCalledTimes(1);
    expect(fetchEvmCallHexAtBlockMock).toHaveBeenCalledWith(
      "ethereum",
      "0x433d5b175148da32ffe1e1a37a939e1b7e79be4d",
      expect.stringMatching(new RegExp("^0x9290d427000000000000000000000000c26a6fa2c37b38e549a4a1807543801db684f99c$")),
      "latest",
      expect.any(Object),
    );

    const override = overrides.get("aa-falconx-mev-capital");
    expect(override).toMatchObject({
      source: "protocol-redeem",
      confidence: "high",
      metadata: { inheritedFrom: "usdc-circle" },
    });
    expect(override?.price).toBeCloseTo(1.081076 * 0.9999, 4);
  });

  it("rejects ERC-4626 NAV override when convertToAssets ratio is outside trusted bounds", async () => {
    // convertToAssets returns 100x the share amount — should be rejected
    const insaneRaw = 100_000_000n.toString(16).padStart(64, "0");
    fetchEvmCallHexAtBlockMock.mockResolvedValueOnce(`0x${insaneRaw}`);
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
    const nowSec = Math.floor(Date.now() / 1000);

    const overrides = await fetchLiveOverrides([
      asset("gtusdc-gauntlet", { circulating: { peggedUSD: 128_000_000 } }),
      freshParent("usdc-circle", 0.9999, "coingecko+pyth", { nowSec }),
    ]);

    expect(overrides.has("gtusdc-gauntlet")).toBe(false);
    warnSpy.mockRestore();
  });
});
