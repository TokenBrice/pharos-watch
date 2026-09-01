import { describe, it, expect, vi, beforeEach } from "vitest";
import type { StablecoinMeta } from "@shared/types/core";
import type { LiveReservesConfig } from "@shared/types/live-reserves";

vi.mock("../helpers", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../helpers")>();
  return {
    ...actual,
    fetchJsonWithRetry: vi.fn(),
    probeOptionalRedemptionRateBps: vi.fn(),
    probeOnchainTotalSupply: vi.fn(),
    makeOnchainCallers: vi.fn(),
  };
});

import { fetchSingleAssetReserves } from "../single-asset";
import {
  fetchJsonWithRetry,
  makeOnchainCallers,
  probeOnchainTotalSupply,
  probeOptionalRedemptionRateBps,
} from "../helpers";

const signal = AbortSignal.timeout(5000);

function makeSingleAssetConfig(
  overrides: {
    primary?: LiveReservesConfig["inputs"]["primary"];
    params?: Record<string, unknown>;
  } = {},
): LiveReservesConfig {
  return {
    adapter: "single-asset",
    version: 1,
    semantics: "single-asset",
    inputs: {
      primary: overrides.primary ?? { kind: "http-json", url: "https://example.com/api" },
    },
    params: overrides.params ?? {},
  };
}

function makeCoin(contracts?: Array<{ chain: string; address: string }>): StablecoinMeta {
  return { id: "test-coin", name: "Test", ticker: "TST", contracts } as unknown as StablecoinMeta;
}

beforeEach(() => {
  vi.clearAllMocks();
});

describe("fetchSingleAssetReserves", () => {
  it("returns 100% slice in http-json mode when probe returns non-zero", async () => {
    vi.mocked(fetchJsonWithRetry).mockResolvedValue({ total_supply: "1000000" });
    const config = makeSingleAssetConfig({
      params: {
        label: "ETH collateral",
        risk: "low",
        probe: { kind: "json-path", path: ["total_supply"] },
      },
    });

    const result = await fetchSingleAssetReserves(makeCoin(), config, signal);
    expect(result.slices).toEqual([
      { name: "ETH collateral", pct: 100, risk: "low" },
    ]);
    expect(result.metadata).toMatchObject({
      freshnessMode: "unverified",
      details: {
        proofKind: "single-asset-liveness-probe",
        reserveSourceLabel: "ETH collateral",
      },
    });
  });

  it("preserves optional coinId and depType in the slice", async () => {
    vi.mocked(fetchJsonWithRetry).mockResolvedValue({ value: "42" });
    const config = makeSingleAssetConfig({
      params: {
        label: "USDC backing",
        risk: "very-low",
        coinId: "usdc-circle",
        depType: "wrapper",
        probe: { kind: "json-path", path: ["value"] },
      },
    });

    const result = await fetchSingleAssetReserves(makeCoin(), config, signal);
    expect(result.slices).toEqual([
      { name: "USDC backing", pct: 100, risk: "very-low", coinId: "usdc-circle", depType: "wrapper" },
    ]);
  });

  it.each(["0", "0.0"])("throws on '%s' probe value in http-json mode", async (probeValue) => {
    vi.mocked(fetchJsonWithRetry).mockResolvedValue({ total_supply: probeValue });
    const config = makeSingleAssetConfig({
      params: {
        label: "ETH collateral",
        risk: "low",
        probe: { kind: "json-path", path: ["total_supply"] },
      },
    });

    await expect(fetchSingleAssetReserves(makeCoin(), config, signal))
      .rejects.toThrow("zero/empty");
  });

  it("throws when http-json mode has no probe configured", async () => {
    vi.mocked(fetchJsonWithRetry).mockResolvedValue({ value: "100" });
    const config = makeSingleAssetConfig({ params: { label: "Test", risk: "low" } });

    await expect(fetchSingleAssetReserves(makeCoin(), config, signal))
      .rejects.toThrow("params.probe/reserveProbe or params.supplyProbe");
  });

  it.each([
    { name: "invalid risk value", params: { label: "Test", risk: "invalid-risk" } },
    { name: "label is missing", params: { risk: "low" } },
  ])("throws when $name", async ({ params }) => {
    const config = makeSingleAssetConfig({ params });

    await expect(fetchSingleAssetReserves(makeCoin(), config, signal))
      .rejects.toThrow("single-asset adapter params invalid");
  });

  it("returns 100% slice in onchain mode when probe succeeds", async () => {
    vi.mocked(probeOnchainTotalSupply).mockResolvedValue(1000000n);
    const config = makeSingleAssetConfig({
      primary: { kind: "onchain-evm", chain: "ethereum", rpcMode: "public-rpc" },
      params: { label: "ETH collateral", risk: "low" },
    });

    const result = await fetchSingleAssetReserves(
      makeCoin([{ chain: "ethereum", address: "0x1234" }]),
      config,
      signal,
    );
    expect(result.slices).toEqual([
      { name: "ETH collateral", pct: 100, risk: "low" },
    ]);
    expect(result.metadata).toMatchObject({
      freshnessMode: "not-applicable",
      details: {
        proofKind: "erc20-total-supply-liveness",
      },
    });
  });

  it("includes live redemption fee metadata when a probe is configured", async () => {
    vi.mocked(probeOnchainTotalSupply).mockResolvedValue(1000000n);
    vi.mocked(probeOptionalRedemptionRateBps).mockResolvedValue(50);
    const config = makeSingleAssetConfig({
      primary: { kind: "onchain-evm", chain: "ethereum", rpcMode: "public-rpc" },
      params: {
        label: "ETH collateral",
        risk: "low",
        redemptionRateProbe: {
          contract: "0xA39739EF8b0231DbFA0DcdA07d7e29faAbCf4bb2",
          selector: "0xc52861f2",
          decimals: 18,
        },
      },
    });

    const result = await fetchSingleAssetReserves(
      makeCoin([{ chain: "ethereum", address: "0x1234" }]),
      config,
      signal,
    );

    expect(result.metadata).toMatchObject({
      freshnessMode: "not-applicable",
      redemptionFeeBps: 50,
      details: {
        proofKind: "erc20-total-supply-liveness",
      },
    });
  });

  it("computes reserve and supply metadata when richer json probes are configured", async () => {
    vi.mocked(fetchJsonWithRetry).mockResolvedValue({
      reserve_total: "105000000",
      supply_total: "100000000",
      asOf: "2026-03-20T12:00:00Z",
    });
    const config = makeSingleAssetConfig({
      params: {
        label: "Treasury reserve",
        risk: "very-low",
        reserveProbe: { kind: "json-path", path: ["reserve_total"] },
        supplyProbe: { kind: "json-path", path: ["supply_total"] },
        timestampProbe: { kind: "json-path", path: ["asOf"] },
        reserveSourceLabel: "Issuer reserve dashboard",
      },
    });

    const result = await fetchSingleAssetReserves(makeCoin(), config, signal);
    expect(result.metadata).toMatchObject({
      totalReserveUsd: 105000000,
      supplyUsd: 100000000,
      collateralizationRatio: 1.05,
      sourceTimestamp: Date.parse("2026-03-20T12:00:00Z") / 1000,
      freshnessMode: "verified",
      details: {
        proofKind: "reserve-and-supply-probe",
        reserveSourceLabel: "Issuer reserve dashboard",
      },
    });
  });

  it("emits a degraded warning when meaningful reserve/supply probes are undercollateralized", async () => {
    vi.mocked(fetchJsonWithRetry).mockResolvedValue({
      reserve_total: "99000000",
      supply_total: "100000000",
      asOf: "2026-03-20T12:00:00Z",
    });
    const config = makeSingleAssetConfig({
      params: {
        label: "Treasury reserve",
        risk: "very-low",
        reserveProbe: { kind: "json-path", path: ["reserve_total"] },
        supplyProbe: { kind: "json-path", path: ["supply_total"] },
        timestampProbe: { kind: "json-path", path: ["asOf"] },
      },
    });

    const result = await fetchSingleAssetReserves(makeCoin(), config, signal);
    expect(result.metadata?.collateralizationRatio).toBe(0.99);
    expect(result.warnings).toEqual([
      expect.objectContaining({
        code: "reserve-undercollateralized",
        effect: "degraded",
      }),
    ]);
  });

  it("marks timestamp-backed liveness probes as freshness-verified even without reserve totals", async () => {
    vi.mocked(fetchJsonWithRetry).mockResolvedValue({
      data: {
        price: "1.120735576038699094",
        timestamp: "1774874195",
      },
    });
    const config = makeSingleAssetConfig({
      params: {
        label: "Treasury reserve",
        risk: "very-low",
        probe: { kind: "json-path", path: ["data", "price"] },
        timestampProbe: { kind: "json-path", path: ["data", "timestamp"] },
      },
    });

    const result = await fetchSingleAssetReserves(makeCoin(), config, signal);
    expect(result.metadata).toMatchObject({
      sourceTimestamp: 1_774_874_195,
      freshnessMode: "verified",
      details: {
        proofKind: "single-asset-liveness-probe",
        reserveSourceLabel: "Treasury reserve",
      },
    });
  });

  it.each([
    {
      name: "on-chain probe fails",
      error: "single-asset could not find a ethereum contract for test-coin",
      coin: makeCoin([{ chain: "arbitrum", address: "0xABCD" }]),
      params: { label: "Collateral", risk: "medium" },
      expected: "could not find a ethereum contract",
    },
    {
      name: "on-chain probe returns zero supply",
      error: "single-asset totalSupply probe failed for test-coin",
      coin: makeCoin([{ chain: "ethereum", address: "0x1234" }]),
      params: { label: "ETH collateral", risk: "low" },
      expected: "totalSupply probe failed",
    },
  ])("throws when $name", async ({ error, coin, params, expected }) => {
    vi.mocked(probeOnchainTotalSupply).mockRejectedValue(new Error(error));
    const config = makeSingleAssetConfig({
      primary: { kind: "onchain-evm", chain: "ethereum", rpcMode: "public-rpc" },
      params,
    });

    await expect(fetchSingleAssetReserves(coin, config, signal)).rejects.toThrow(expected);
  });
});

// AID-shaped fixture: the GAIB Redeemer beacon proxy pays USDC out of its own
// balance, gated on stablecoin()/aid() identity and the beacon implementation,
// and metered by redeemLimitPerDay() - dailyRedeemed(day).
const REDEEMER = "0x52323f33551188F170D8de14fE8d8423a839629d";
const USDC = "0xA0b86991c6218b36c1d19D4a2e9eb0ce3606eb48";
const AID = "0x18f52b3fb465118731d9e0d276d4eb3599d57596";
const BEACON = "0xc787e7f060acab38d30aceb539355b328024e8b8";
const IMPLEMENTATION = "0xb835004007296f5278fbf85f090af7195361e946";

const STABLECOIN_SELECTOR = "0xe9cbd822";
const AID_SELECTOR = "0xb91cc136";
const IMPLEMENTATION_SELECTOR = "0x5c60da1b";
const LIMIT_SELECTOR = "0xd9d48e04";
const USED_SELECTOR = "0x9ac929fb";
const FEE_SELECTOR = "0xd68002f3";

const CAPACITY_CONFIG: LiveReservesConfig = {
  adapter: "single-asset",
  version: 1,
  semantics: "single-asset",
  inputs: { primary: { kind: "onchain-evm", chain: "ethereum", rpcMode: "public-rpc" } },
  params: {
    label: "U.S. Treasury and accepted stablecoin reserves",
    risk: "low",
    redemptionCapacity: {
      chain: "ethereum",
      redeemer: REDEEMER,
      payoutToken: { address: USDC, decimals: 6 },
      identityChecks: [
        { contract: REDEEMER, selector: STABLECOIN_SELECTOR, expectedAddress: USDC },
        { contract: REDEEMER, selector: AID_SELECTOR, expectedAddress: AID },
        { contract: BEACON, selector: IMPLEMENTATION_SELECTOR, expectedAddress: IMPLEMENTATION },
      ],
      dailyLimit: { limitSelector: LIMIT_SELECTOR, usedSelector: USED_SELECTOR, decimals: 18 },
      feeBpsSelector: FEE_SELECTOR,
      holderEligibility: "whitelisted-primary",
      sourceUrls: ["https://docs.gaib.ai/products/gaib-products/aid-and-said-contracts"],
    },
  },
};

function addressWord(address: string): string {
  return `0x${address.replace(/^0x/, "").toLowerCase().padStart(64, "0")}`;
}

/** Live values observed on Ethereum mainnet 2026-08-12. */
const LIVE_USDC_BALANCE = 239_938_892_162n;
const LIVE_DAILY_LIMIT = 10n ** 36n;

function mockCapacityCallers(overrides: {
  stablecoin?: string | null;
  aid?: string | null;
  implementation?: string | null;
  usdcBalance?: bigint | null;
  dailyLimit?: bigint | null;
  dailyUsed?: bigint | null;
  feeBps?: bigint | null;
} = {}): void {
  vi.mocked(makeOnchainCallers).mockReturnValue({
    raw: vi.fn(async (contract: string, data: string) => {
      if (data === STABLECOIN_SELECTOR) {
        return overrides.stablecoin === null ? null : addressWord(overrides.stablecoin ?? USDC);
      }
      if (data === AID_SELECTOR) return overrides.aid === null ? null : addressWord(overrides.aid ?? AID);
      if (data === IMPLEMENTATION_SELECTOR) {
        return overrides.implementation === null ? null : addressWord(overrides.implementation ?? IMPLEMENTATION);
      }
      throw new Error(`unexpected raw call ${contract} ${data}`);
    }),
    uint256: vi.fn(async (contract: string, data: string) => {
      if (data.startsWith("0x70a08231")) {
        return overrides.usdcBalance === undefined ? LIVE_USDC_BALANCE : overrides.usdcBalance;
      }
      if (data === LIMIT_SELECTOR) return overrides.dailyLimit === undefined ? LIVE_DAILY_LIMIT : overrides.dailyLimit;
      if (data.startsWith(USED_SELECTOR)) return overrides.dailyUsed === undefined ? 0n : overrides.dailyUsed;
      if (data === FEE_SELECTOR) return overrides.feeBps === undefined ? 10n : overrides.feeBps;
      throw new Error(`unexpected uint256 call ${contract} ${data}`);
    }),
  });
}

describe("fetchSingleAssetReserves redemption capacity probe", () => {
  beforeEach(() => {
    vi.mocked(probeOnchainTotalSupply).mockResolvedValue(1n);
    vi.mocked(probeOptionalRedemptionRateBps).mockResolvedValue(null);
  });

  it("emits live-direct-bounded capacity when every identity gate and read passes", async () => {
    mockCapacityCallers();

    const result = await fetchSingleAssetReserves(
      makeCoin([{ chain: "ethereum", address: AID }]),
      CAPACITY_CONFIG,
      signal,
    );

    expect(result.warnings).toBeUndefined();
    expect(result.metadata?.redemption).toMatchObject({
      capacityUsd: 239_938.892162,
      capacityKind: "live-direct-bounded",
      freshnessKind: "same-run-onchain",
      routeStatus: "open",
      routeStatusSource: "onchain",
      holderEligibility: "whitelisted-primary",
      settlementDelaySec: 0,
      feeBps: 10,
    });
    expect(result.metadata?.redemptionFeeBps).toBe(10);
    // The pinned cap is 12 orders of magnitude above the float, so publishing it
    // as a daily limit would be noise rather than a bound.
    expect(result.metadata?.redemption).not.toHaveProperty("dailyLimitUsd");
  });

  it("floors capacity at the remaining daily allowance and publishes it when it binds", async () => {
    mockCapacityCallers({ dailyLimit: 5_000n * 10n ** 18n, dailyUsed: 4_900n * 10n ** 18n });

    const result = await fetchSingleAssetReserves(
      makeCoin([{ chain: "ethereum", address: AID }]),
      CAPACITY_CONFIG,
      signal,
    );

    expect(result.metadata?.redemption).toMatchObject({
      capacityUsd: 100,
      dailyLimitUsd: 100,
      routeStatus: "open",
    });
  });

  it("does not assert openness from a measured zero payout float", async () => {
    mockCapacityCallers({ usdcBalance: 0n });

    const result = await fetchSingleAssetReserves(
      makeCoin([{ chain: "ethereum", address: AID }]),
      CAPACITY_CONFIG,
      signal,
    );

    expect(result.metadata?.redemption).toMatchObject({
      capacityUsd: 0,
      capacityKind: "live-direct-bounded",
      routeStatus: "unknown",
    });
    expect(result.metadata?.redemption).not.toHaveProperty("routeStatusSource");
  });

  it("withholds the live block when the beacon implementation no longer matches", async () => {
    mockCapacityCallers({ implementation: "0x1111111111111111111111111111111111111111" });

    const result = await fetchSingleAssetReserves(
      makeCoin([{ chain: "ethereum", address: AID }]),
      CAPACITY_CONFIG,
      signal,
    );

    expect(result.metadata?.redemption).toEqual({
      capacityKind: "documented-bound",
      freshnessKind: "same-run-onchain",
      routeStatus: "unknown",
    });
    expect(result.warnings?.[0]?.code).toBe("single-asset-redemption-capacity-unreadable");
  });

  it("withholds the live block when the payout balance read fails", async () => {
    mockCapacityCallers({ usdcBalance: null });

    const result = await fetchSingleAssetReserves(
      makeCoin([{ chain: "ethereum", address: AID }]),
      CAPACITY_CONFIG,
      signal,
    );

    expect(result.metadata?.redemption).not.toHaveProperty("capacityUsd");
    expect(result.warnings?.[0]?.code).toBe("single-asset-redemption-capacity-unreadable");
  });

  it("withholds the live block when the fee getter returns an out-of-range value", async () => {
    mockCapacityCallers({ feeBps: 10_001n });

    const result = await fetchSingleAssetReserves(
      makeCoin([{ chain: "ethereum", address: AID }]),
      CAPACITY_CONFIG,
      signal,
    );

    expect(result.metadata?.redemption).not.toHaveProperty("capacityUsd");
    expect(result.warnings?.[0]?.code).toBe("single-asset-redemption-capacity-unreadable");
  });

  it("never opens a capacity call for a coin without redemptionCapacity params", async () => {
    mockCapacityCallers();
    vi.mocked(probeOptionalRedemptionRateBps).mockResolvedValue(25);

    const result = await fetchSingleAssetReserves(
      makeCoin([{ chain: "ethereum", address: "0x1234" }]),
      {
        ...CAPACITY_CONFIG,
        params: { label: "ETH collateral", risk: "low" },
      },
      signal,
    );

    expect(makeOnchainCallers).not.toHaveBeenCalled();
    expect(result.warnings).toBeUndefined();
    expect(result.metadata?.redemption).toEqual({
      capacityKind: "documented-bound",
      freshnessKind: "same-run-onchain",
      routeStatus: "unknown",
      feeBps: 25,
    });
  });
});
