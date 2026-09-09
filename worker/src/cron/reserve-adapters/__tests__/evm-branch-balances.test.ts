vi.mock("../../../lib/evm-rpc", async (importOriginal) => ({
  ...await importOriginal<typeof import("../../../lib/evm-rpc")>(),
  fetchEvmBlockNumber: vi.fn(async () => 123),
  fetchEvmBlockTimestamp: vi.fn(async () => 1_800_000_000),
}));

import { describe, it, expect, vi, beforeEach } from "vitest";
import type { StablecoinMeta } from "@shared/types/core";
import type { LiveReservesConfig } from "@shared/types/live-reserves";
import { mockD1 } from "@shared/test-utils/mock-d1";

vi.mock("../helpers", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../helpers")>();
  const { makeOnchainCallersMock } = await import("./helpers/onchain-callers-mock");
  const fetchOnchainUint256 = vi.fn();
  const fetchOnchainRawCall = vi.fn();
  return {
    ...actual,
    fetchErc20Balance: vi.fn(),
    fetchDefiLlamaPrices: vi.fn(),
    fetchOnchainMulticall3: vi.fn(),
    fetchOnchainUint256,
    makeOnchainCallers: makeOnchainCallersMock({
      uint256: fetchOnchainUint256,
      raw: fetchOnchainRawCall,
    }),
    fetchOnchainRawCall,
    probeOptionalRedemptionRateBps: vi.fn(),
  };
});

import { fetchEvmBranchBalancesReserves } from "../evm-branch-balances";
import { hasFatalWarnings, validateAdapterOutput } from "../validate";
import {
  fetchDefiLlamaPrices,
  fetchErc20Balance,
  fetchOnchainMulticall3,
  fetchOnchainUint256,
  fetchOnchainRawCall,
  probeOptionalRedemptionRateBps,
} from "../helpers";

let signal: AbortSignal;
const coin = { id: "test-coin" } as unknown as StablecoinMeta;

const HONEY_FACTORY = "0xa4afef880f5ce1f63c9fb48f661e27f8b4216401";
const HONEY_TOKEN = "0xfcbd14dc51f0a4d49d5e53c2e0950e0bc26d0dce";
const HONEY_ASSET = "0x549943e04f40284185054145c6e4e9568c1d3241";
const HONEY_VAULT = "0x90bc07408f5b5eac4de38af76ea6069e1fcee363";
const HONEY_CUSTODY = "0x83e672c9949af428687ecc9b6a3ba74db7bb0ed0";
const WAD = 10n ** 18n;

function addressWord(address: string): bigint {
  return BigInt(address);
}

function abiWords(...words: bigint[]): string {
  return `0x${words.map((word) => word.toString(16).padStart(64, "0")).join("")}`;
}

function uintArrayResult(values: bigint[]): string {
  return abiWords(32n, BigInt(values.length), ...values);
}

function honeyRedemptionCapacity(maxAssets = 4) {
  return {
    kind: "honey-factory-vaults",
    factoryAddress: HONEY_FACTORY,
    expectedHoneyAddress: HONEY_TOKEN,
    maxAssets,
    stableAssets: [{ address: HONEY_ASSET, decimals: 6 }],
    sourceUrls: ["https://docs.berachain.com/general/tokens/honey"],
  };
}

function mockHoneyOnchain(options: { assetCount?: bigint; failVaultAsset?: boolean } = {}) {
  const assetCount = options.assetCount ?? 1n;
  vi.mocked(fetchOnchainUint256).mockReset();
  vi.mocked(fetchOnchainRawCall).mockReset();
  vi.mocked(fetchOnchainUint256).mockImplementation(async ({ contract, data }) => {
    const normalizedContract = contract.toLowerCase();
    const selector = data.slice(0, 10);
    if (normalizedContract === HONEY_FACTORY) {
      if (selector === "0x36b2c4b2") return addressWord(HONEY_TOKEN);
      if (selector === "0xbb85d15b") return assetCount;
      if (selector === "0xa083bd3c") return addressWord(HONEY_ASSET);
      if (selector === "0xa622ee7c") return addressWord(HONEY_VAULT);
      if (selector === "0x5c975abb" || selector === "0x7b34b5d8" || selector === "0xde4bc640") return 0n;
      if (selector === "0x99a2af75" || selector === "0xbdb912f3") return WAD;
      if (selector === "0x64f76eaa") return 0n;
      if (selector === "0x2cfb0e10") return 999_500_000_000_000_000n;
      if (selector === "0xbc7c2902") return 1n;
    }
    if (normalizedContract === HONEY_VAULT) {
      if (selector === "0x38d52e0f") return options.failVaultAsset ? null : addressWord(HONEY_ASSET);
      if (selector === "0x5c975abb") return 0n;
      if (selector === "0x70a08231") return 10n * WAD;
      if (selector === "0x07a2d13a") return 10_000_000n;
    }
    if (normalizedContract === HONEY_ASSET && selector === "0x70a08231") return 8_000_000n;
    if (normalizedContract === HONEY_ASSET && selector === "0x313ce567") return 6n;
    return null;
  });
  vi.mocked(fetchOnchainRawCall).mockImplementation(async ({ contract, data }) => {
    const normalizedContract = contract.toLowerCase();
    if (normalizedContract === HONEY_FACTORY && data === "0x22acb867") {
      return uintArrayResult(Array.from({ length: Number(assetCount) }, () => WAD));
    }
    if (normalizedContract === HONEY_VAULT && data === "0x72d4b21a") return abiWords(0n, 0n);
    return null;
  });
  vi.mocked(fetchOnchainMulticall3).mockImplementation(async ({ calls }) => {
    if (calls.every((call) => call.label.startsWith("branch-"))) return null;
    return Promise.all(calls.map(async (call) => {
      const raw = call.data === "0x22acb867" || call.data === "0x72d4b21a"
        ? await fetchOnchainRawCall({ contract: call.contract, data: call.data } as never)
        : await fetchOnchainUint256({ contract: call.contract, data: call.data } as never);
      return raw == null
        ? { label: call.label, success: false, returnData: "0x" as const }
        : {
            label: call.label,
            success: true,
            returnData: (typeof raw === "bigint" ? abiWords(raw) : raw) as `0x${string}`,
          };
    }));
  });
}

function mockFourAssetHoneyBatches(custody: boolean) {
  const assets = Array.from({ length: 4 }, (_, index) =>
    `0x${(0xa1 + index).toString(16).padStart(40, "0")}`
  );
  const vaults = Array.from({ length: 4 }, (_, index) =>
    `0x${(0xb1 + index).toString(16).padStart(40, "0")}`
  );
  const custodyHolders = Array.from({ length: 4 }, (_, index) =>
    `0x${(0xc1 + index).toString(16).padStart(40, "0")}`
  );
  vi.mocked(fetchOnchainMulticall3).mockImplementation(async ({ calls }) => {
    if (calls.every((call) => call.label.startsWith("branch-"))) return null;
    return calls.map((call) => {
      const index = Number(call.label.split(":").pop());
      let returnData: string;
      if (call.label === "honey:honey") returnData = abiWords(addressWord(HONEY_TOKEN));
      else if (call.label === "honey:asset-count") returnData = abiWords(4n);
      else if (call.label.startsWith("honey:asset:")) returnData = abiWords(addressWord(assets[index]));
      else if (call.label === "honey:weights") returnData = uintArrayResult([WAD, WAD, WAD, WAD]);
      else if (call.label === "honey:global-cap") returnData = abiWords(WAD);
      else if (
        call.label === "honey:factory-paused"
        || call.label === "honey:forced-basket-mode"
        || call.label === "honey:basket-mode"
      ) returnData = abiWords(0n);
      else if (call.label.startsWith("honey:vault:")) returnData = abiWords(addressWord(vaults[index]));
      else if (call.label.startsWith("honey:collected-fees:")) returnData = abiWords(0n);
      else if (call.label.startsWith("honey:redeem-rate:")) returnData = abiWords(999_500_000_000_000_000n);
      else if (call.label.startsWith("honey:is-pegged:")) returnData = abiWords(1n);
      else if (call.label.startsWith("honey:relative-cap:")) returnData = abiWords(WAD);
      else if (call.label.startsWith("honey:vault-asset:")) returnData = abiWords(addressWord(assets[index]));
      else if (call.label.startsWith("honey:vault-paused:")) returnData = abiWords(0n);
      else if (call.label.startsWith("honey:custody-info:")) {
        returnData = abiWords(custody ? 1n : 0n, custody ? addressWord(custodyHolders[index]) : 0n);
      } else if (call.label.startsWith("honey:factory-shares:")) returnData = abiWords(10n * WAD);
      else if (call.label.startsWith("honey:asset-decimals:")) returnData = abiWords(6n);
      else if (call.label.startsWith("honey:converted-assets:")) returnData = abiWords(10_000_000n);
      else if (call.label.startsWith("honey:holder-balance:")) returnData = abiWords(8_000_000n);
      else if (call.label.startsWith("honey:custody-allowance:")) returnData = abiWords(7_000_000n);
      else return { label: call.label, success: false, returnData: "0x" as const };
      return { label: call.label, success: true, returnData: returnData as `0x${string}` };
    });
  });
  return { assets, vaults };
}

function mockHoneyCustodyOnchain(options: { failConvertToAssets?: boolean } = {}) {
  // Live-captured USDC.e vault state (2026-09-09): custodyInfo() is true, the
  // vault idle balance is zero, and the factory-owned net shares (shares minus
  // collected fees) convert to 29141 raw USDC units.
  vi.mocked(fetchOnchainUint256).mockReset();
  vi.mocked(fetchOnchainRawCall).mockReset();
  vi.mocked(fetchOnchainUint256).mockImplementation(async ({ contract, data }) => {
    const normalizedContract = contract.toLowerCase();
    const selector = data.slice(0, 10);
    if (normalizedContract === HONEY_FACTORY) {
      if (selector === "0x36b2c4b2") return addressWord(HONEY_TOKEN);
      if (selector === "0xbb85d15b") return 1n;
      if (selector === "0xa083bd3c") return addressWord(HONEY_ASSET);
      if (selector === "0xa622ee7c") return addressWord(HONEY_VAULT);
      if (selector === "0x5c975abb" || selector === "0x7b34b5d8" || selector === "0xde4bc640") return 0n;
      if (selector === "0x99a2af75" || selector === "0xbdb912f3") return WAD;
      if (selector === "0x64f76eaa") return 155_489_553_000_000_000n;
      if (selector === "0x2cfb0e10") return 999_500_000_000_000_000n;
      if (selector === "0xbc7c2902") return 1n;
    }
    if (normalizedContract === HONEY_VAULT) {
      if (selector === "0x38d52e0f") return addressWord(HONEY_ASSET);
      if (selector === "0x5c975abb") return 0n;
      if (selector === "0x70a08231") return 184_630_645_591_044_543n;
      if (selector === "0x07a2d13a") return options.failConvertToAssets ? null : 29_141n;
    }
    if (normalizedContract === HONEY_ASSET) {
      // The configured branch holder is the custody vault, which holds no idle
      // USDC; the custody wallet holds the tokens the vault has a claim on.
      if (selector === "0x70a08231") {
        return data.toLowerCase().endsWith(HONEY_VAULT.slice(2)) ? 0n : 274_114n;
      }
      if (selector === "0x313ce567") return 6n;
      if (selector === "0xdd62ed3e") return 274_114n;
    }
    return null;
  });
  vi.mocked(fetchOnchainRawCall).mockImplementation(async ({ contract, data }) => {
    const normalizedContract = contract.toLowerCase();
    if (normalizedContract === HONEY_FACTORY && data === "0x22acb867") {
      return uintArrayResult([WAD]);
    }
    if (normalizedContract === HONEY_VAULT && data === "0x72d4b21a") {
      return abiWords(1n, addressWord(HONEY_CUSTODY));
    }
    return null;
  });
  vi.mocked(fetchOnchainMulticall3).mockImplementation(async ({ calls }) => {
    return Promise.all(calls.map(async (call) => {
      const raw = call.data === "0x22acb867" || call.data === "0x72d4b21a"
        ? await fetchOnchainRawCall({ contract: call.contract, data: call.data } as never)
        : await fetchOnchainUint256({ contract: call.contract, data: call.data } as never);
      return raw == null
        ? { label: call.label, success: false, returnData: "0x" as const }
        : {
            label: call.label,
            success: true,
            returnData: (typeof raw === "bigint" ? abiWords(raw) : raw) as `0x${string}`,
          };
    }));
  });
}

function wstEthBranch(overrides: Record<string, unknown> = {}) {
  return {
    name: "wstETH",
    holder: "0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
    token: { chain: "ethereum", address: "0xbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb", decimals: 18 },
    risk: "low",
    ...overrides,
  };
}

function wbtcBranch(overrides: Record<string, unknown> = {}) {
  return {
    name: "WBTC",
    holder: "0xcccccccccccccccccccccccccccccccccccccccc",
    token: { chain: "ethereum", address: "0xdddddddddddddddddddddddddddddddddddddddd", decimals: 8 },
    risk: "medium",
    ...overrides,
  };
}

function honeyBranch(overrides: Record<string, unknown> = {}) {
  return {
    name: "USDC.e",
    holder: HONEY_VAULT,
    token: { chain: "berachain", address: HONEY_ASSET, decimals: 6 },
    risk: "low",
    priceUsd: 1,
    ...overrides,
  };
}

function usdcBranch(overrides: Record<string, unknown> = {}) {
  return {
    name: "USDC branch",
    holder: "0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
    token: { chain: "ethereum", address: "0xbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb", decimals: 6 },
    risk: "low",
    coinId: "usdc-circle",
    ...overrides,
  };
}

function makeBranchConfig(
  branches?: unknown[],
  options: { chain?: string; params?: Record<string, unknown> } = {},
): LiveReservesConfig {
  const chain = options.chain ?? "ethereum";
  return {
    adapter: "evm-branch-balances",
    version: 1,
    semantics: "collateral-mix",
    inputs: {
      primary: { kind: "onchain-evm", chain, rpcMode: "public-rpc" },
    },
    params: {
      ...(branches === undefined ? {} : { branches }),
      ...options.params,
    },
  } as LiveReservesConfig;
}

beforeEach(() => {
  signal = new AbortController().signal;
  vi.clearAllMocks();
  vi.mocked(fetchOnchainMulticall3).mockReset().mockResolvedValue(null);
});

describe("fetchEvmBranchBalancesReserves", () => {
  it("preserves the legacy reserve result without redemption opt-in", async () => {
    vi.mocked(fetchErc20Balance).mockResolvedValueOnce(1_000_000_000_000_000_000n);
    vi.mocked(fetchDefiLlamaPrices).mockResolvedValue(new Map([["wstETH", 2000]]));

    const result = await fetchEvmBranchBalancesReserves(
      coin,
      makeBranchConfig([wstEthBranch()]),
      signal,
    );

    expect(result.slices).toMatchObject([{ sourceKey: "evm-branch-balances:ethereum:0xbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb", name: "wstETH", pct: 100, risk: "low" }]);
    expect(result.metadata).not.toHaveProperty("redemption");
    expect(fetchOnchainRawCall).not.toHaveBeenCalled();
  });

  it("emits HoneyFactory live direct capacity without changing reserve slices", async () => {
    vi.mocked(fetchErc20Balance).mockResolvedValueOnce(12_000_000n);
    vi.mocked(fetchDefiLlamaPrices).mockResolvedValue(new Map([["USDC.e", 1]]));
    mockHoneyOnchain();
    const config = makeBranchConfig([honeyBranch()], {
      chain: "berachain",
      params: { redemptionCapacity: honeyRedemptionCapacity() },
    });

    const result = await fetchEvmBranchBalancesReserves(coin, config, signal);

    expect(result.slices).toMatchObject([{ sourceKey: "evm-branch-balances:berachain:0x549943e04f40284185054145c6e4e9568c1d3241", name: "USDC.e", pct: 100, risk: "low" }]);
    expect(result.metadata?.redemption).toEqual(expect.objectContaining({
      capacityUsd: 8,
      capacityKind: "live-direct",
      freshnessKind: "same-run-onchain",
      routeStatus: "open",
      routeStatusSource: "onchain",
      feeBps: 5,
    }));
    expect(result.metadata).not.toHaveProperty("redemptionFeeBps");
    expect(validateAdapterOutput(result, {
      adapter: {
        key: "evm-branch-balances",
        redemptionTelemetry: { capacity: "direct", fee: "current-bps" },
      } as never,
    })).toEqual({ valid: true, warnings: [] });
  });

  it.each([
    { custody: false, expectedStageSizes: [2, 9, 20, 20, 8], expectedCapacity: 32 },
    { custody: true, expectedStageSizes: [2, 9, 20, 20, 12], expectedCapacity: 28 },
  ])(
    "batches the configured four Honey assets into five dependency waves (custody=$custody)",
    async ({ custody, expectedStageSizes, expectedCapacity }) => {
      vi.mocked(fetchErc20Balance).mockResolvedValue(12_000_000n);
      const { assets } = mockFourAssetHoneyBatches(custody);
      const config = makeBranchConfig([honeyBranch()], {
        chain: "berachain",
        params: {
          redemptionCapacity: {
            ...honeyRedemptionCapacity(),
            stableAssets: assets.map((address) => ({ address, decimals: 6 })),
          },
        },
      });

      const result = await fetchEvmBranchBalancesReserves(coin, config, signal);

      expect(result.metadata?.redemption).toMatchObject({ capacityUsd: expectedCapacity });
      const honeyBatches = vi.mocked(fetchOnchainMulticall3).mock.calls
        .map(([options]) => options.calls)
        .filter((calls) => calls[0]?.label.startsWith("honey:"));
      expect(honeyBatches.map((calls) => calls.length)).toEqual(expectedStageSizes);
      expect(honeyBatches).toHaveLength(5);
    },
  );

  it("batches four same-chain branch balances and decimals reads into one Multicall3 wave", async () => {
    const branches = Array.from({ length: 4 }, (_, index) => ({
      name: `branch-${index}`,
      holder: `0x${(0xd1 + index).toString(16).padStart(40, "0")}`,
      token: {
        chain: "ethereum",
        address: `0x${(0xe1 + index).toString(16).padStart(40, "0")}`,
        decimals: 6,
      },
      risk: "low",
      priceUsd: 1,
    }));
    vi.mocked(fetchOnchainMulticall3).mockImplementation(async ({ calls }) =>
      calls.map((call) => {
        const index = Number(call.label.split(":").pop());
        const isDecimals = call.label.startsWith("branch-decimals:");
        return {
          label: call.label,
          success: true,
          returnData: abiWords(isDecimals ? 6n : BigInt(index + 1) * 1_000_000n) as `0x${string}`,
        };
      }),
    );

    const result = await fetchEvmBranchBalancesReserves(
      coin,
      makeBranchConfig(branches),
      signal,
    );

    expect(result.slices).toHaveLength(4);
    expect(fetchOnchainMulticall3).toHaveBeenCalledTimes(1);
    expect(vi.mocked(fetchOnchainMulticall3).mock.calls[0]?.[0].calls).toHaveLength(8);
    expect(fetchErc20Balance).not.toHaveBeenCalled();
  });

  it("values a mixed-decimals basket correctly when on-chain decimals match config", async () => {
    vi.mocked(fetchOnchainMulticall3).mockImplementation(async ({ calls }) =>
      calls.map((call) => {
        const index = Number(call.label.split(":").pop());
        if (call.label.startsWith("branch-decimals:")) {
          return {
            label: call.label,
            success: true,
            returnData: abiWords(index === 0 ? 6n : 18n) as `0x${string}`,
          };
        }
        return {
          label: call.label,
          success: true,
          returnData: abiWords(index === 0 ? 3_000_000n : 2_000_000_000_000_000_000n) as `0x${string}`,
        };
      }),
    );

    const result = await fetchEvmBranchBalancesReserves(
      coin,
      makeBranchConfig([
        {
          name: "Six-decimals stable",
          holder: "0x00000000000000000000000000000000000000a1",
          token: { chain: "ethereum", address: "0x00000000000000000000000000000000000000b1", decimals: 6 },
          risk: "low",
          priceUsd: 1,
        },
        {
          name: "Eighteen-decimals stable",
          holder: "0x00000000000000000000000000000000000000a2",
          token: { chain: "ethereum", address: "0x00000000000000000000000000000000000000b2", decimals: 18 },
          risk: "low",
          priceUsd: 1,
        },
      ]),
      signal,
    );

    // 3 six-decimals tokens ($3) vs 2 eighteen-decimals tokens ($2): 60/40.
    expect(result.warnings).toBeUndefined();
    expect(result.slices).toMatchObject([
      { sourceKey: "evm-branch-balances:ethereum:0x00000000000000000000000000000000000000b1", name: "Six-decimals stable", pct: 60, risk: "low" },
      { sourceKey: "evm-branch-balances:ethereum:0x00000000000000000000000000000000000000b2", name: "Eighteen-decimals stable", pct: 40, risk: "low" },
    ]);
  });

  it("emits a fatal warning when a branch token's on-chain decimals differ from config", async () => {
    vi.mocked(fetchOnchainMulticall3).mockImplementation(async ({ calls }) =>
      calls.map((call) => {
        if (call.label.startsWith("branch-decimals:")) {
          // Configured 18, but the token reports 6 — a 10^12 valuation error.
          return { label: call.label, success: true, returnData: abiWords(6n) as `0x${string}` };
        }
        return { label: call.label, success: true, returnData: abiWords(50_000_000n) as `0x${string}` };
      }),
    );

    const result = await fetchEvmBranchBalancesReserves(
      coin,
      makeBranchConfig([{
        name: "M by M^0 (via UsualM wrapper)",
        holder: "0x00000000000000000000000000000000000000a1",
        token: { chain: "ethereum", address: "0x00000000000000000000000000000000000000b1", decimals: 18 },
        risk: "low",
        priceUsd: 1,
      }]),
      signal,
    );

    expect(result.warnings).toEqual([
      expect.objectContaining({
        code: "branch-token-decimals-mismatch",
        effect: "fatal",
        message: expect.stringContaining("0x00000000000000000000000000000000000000b1"),
      }),
    ]);
    expect(hasFatalWarnings(result.warnings)).toBe(true);
  });

  it("keeps the configured scale with an info warning when decimals() reverts", async () => {
    vi.mocked(fetchOnchainMulticall3).mockImplementation(async ({ calls }) =>
      calls.map((call) => {
        if (call.label.startsWith("branch-decimals:")) {
          return { label: call.label, success: false, returnData: "0x" as const };
        }
        return { label: call.label, success: true, returnData: abiWords(1_000_000n) as `0x${string}` };
      }),
    );

    const result = await fetchEvmBranchBalancesReserves(
      coin,
      makeBranchConfig([{
        name: "Non-ERC20 branch",
        holder: "0x00000000000000000000000000000000000000a1",
        token: { chain: "ethereum", address: "0x00000000000000000000000000000000000000b1", decimals: 6 },
        risk: "low",
        priceUsd: 1,
      }]),
      signal,
    );

    expect(result.slices).toMatchObject([{ sourceKey: "evm-branch-balances:ethereum:0x00000000000000000000000000000000000000b1", name: "Non-ERC20 branch", pct: 100, risk: "low" }]);
    expect(result.warnings).toEqual([
      expect.objectContaining({
        code: "branch-token-decimals-unavailable",
        effect: "info",
      }),
    ]);
  });

  it.each([
    {
      name: "enumeration exceeds the configured bound",
      honeyOptions: { assetCount: 2n },
      maxAssets: 1,
    },
    {
      name: "any required vault read fails",
      honeyOptions: { failVaultAsset: true },
      maxAssets: 4,
    },
  ])("fails closed when $name", async ({ honeyOptions, maxAssets }) => {
    vi.mocked(fetchErc20Balance).mockResolvedValueOnce(12_000_000n);
    mockHoneyOnchain(honeyOptions);
    const config = makeBranchConfig([honeyBranch()], {
      chain: "berachain",
      params: { redemptionCapacity: honeyRedemptionCapacity(maxAssets) },
    });

    await expect(fetchEvmBranchBalancesReserves(coin, config, signal)).rejects.toThrow(
      /HoneyFactory vault state unavailable; cannot derive custody-mode branch composition/,
    );
  });

  it("derives custody-mode branch composition from factory-owned net shares", async () => {
    // The USDC.e vault holds zero idle USDC; custodyInfo() is true and the net
    // factory shares (184630645591044543 - 155489553000000000) convert to
    // 29141 raw USDC units, which is the branch's real backing.
    mockHoneyCustodyOnchain();
    const config = makeBranchConfig([honeyBranch()], {
      chain: "berachain",
      params: { redemptionCapacity: honeyRedemptionCapacity() },
    });

    const result = await fetchEvmBranchBalancesReserves(coin, config, signal);

    expect(result.slices).toMatchObject([{ sourceKey: "evm-branch-balances:berachain:0x549943e04f40284185054145c6e4e9568c1d3241", name: "USDC.e", pct: 100, risk: "low" }]);
    expect(result.warnings).toBeUndefined();
    expect(result.metadata).toMatchObject({ branchCount: 1 });
    expect(result.metadata?.redemption).toMatchObject({
      capacityUsd: 0.029141,
      routeStatus: "open",
    });
  });

  it("fails closed when custody vault share conversion is unreadable", async () => {
    mockHoneyCustodyOnchain({ failConvertToAssets: true });
    const config = makeBranchConfig([honeyBranch()], {
      chain: "berachain",
      params: { redemptionCapacity: honeyRedemptionCapacity() },
    });

    await expect(fetchEvmBranchBalancesReserves(coin, config, signal)).rejects.toThrow(
      /HoneyFactory vault state unavailable; cannot derive custody-mode branch composition/,
    );
  });

  it("computes percentage slices from branch balances and prices", async () => {
    vi.mocked(fetchErc20Balance)
      .mockResolvedValueOnce(1_000_000_000_000_000_000n) // 1 wstETH (18 dec)
      .mockResolvedValueOnce(100_000_000n); // 1 WBTC (8 dec)

    vi.mocked(fetchDefiLlamaPrices).mockResolvedValue(
      new Map([
        ["wstETH", 2000],
        ["WBTC", 60000],
      ]),
    );

    const config = makeBranchConfig([wstEthBranch(), wbtcBranch()]);

    const result = await fetchEvmBranchBalancesReserves(coin, config, signal);
    expect(result.slices).toHaveLength(2);

    const sum = Math.round(result.slices.reduce((s, r) => s + r.pct, 0) * 10) / 10;
    expect(sum).toBe(100);

    expect(result.slices[0].name).toBe("WBTC");
    expect(result.slices[0].risk).toBe("medium");
    expect(result.slices[1].name).toBe("wstETH");
    expect(result.slices[1].risk).toBe("low");

    // WBTC value = 60000 (96.8%), wstETH = 2000 (3.2%)
    expect(result.slices[0].pct).toBeCloseTo(96.8, 0);
    expect(result.slices[1].pct).toBeCloseTo(3.2, 0);

    expect(result.metadata).toMatchObject({
      branchCount: 2,
      freshnessMode: "not-applicable",
      details: {
        proofKind: "onchain-branch-balances",
      },
    });
  });

  it.each([
    {
      name: "retains a measured sub-tenth-percent tracked branch",
      secondBalance: 428n,
      expected: [
        { name: "Sovryn Zero ZUSD", pct: 99.957, risk: "medium" },
        { name: "Dollar on Chain DOC", pct: 0.043, risk: "medium", coinId: "doc-money-on-chain", depType: "collateral" },
      ],
    },
    {
      name: "retains a measured branch below the three-decimal rounding threshold",
      secondBalance: 4n,
      expected: [
        { name: "Sovryn Zero ZUSD", pct: 99.9996, risk: "medium" },
        { name: "Dollar on Chain DOC", pct: 0.0004, risk: "medium", coinId: "doc-money-on-chain", depType: "collateral" },
      ],
    },
  ])("$name", async ({ secondBalance, expected }) => {
    vi.mocked(fetchErc20Balance)
      .mockResolvedValueOnce(1_000_000n)
      .mockResolvedValueOnce(secondBalance);
    vi.mocked(fetchDefiLlamaPrices).mockResolvedValue(
      new Map([
        ["Sovryn Zero ZUSD", 1],
        ["Dollar on Chain DOC", 1],
      ]),
    );

    const config = makeBranchConfig([
      {
        name: "Sovryn Zero ZUSD",
        holder: "0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
        token: { chain: "rootstock", address: "0xbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb", decimals: 0 },
        risk: "medium",
        priceUsd: 1,
      },
      {
        name: "Dollar on Chain DOC",
        holder: "0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
        token: { chain: "rootstock", address: "0xcccccccccccccccccccccccccccccccccccccccc", decimals: 0 },
        risk: "medium",
        coinId: "doc-money-on-chain",
        depType: "collateral",
        priceUsd: 1,
      },
    ], { chain: "rootstock" });

    const result = await fetchEvmBranchBalancesReserves(coin, config, signal);

    expect(result.slices).toMatchObject(expected);
  });

  it("uses an explicit branch price token for DefiLlama price lookup", async () => {
    vi.mocked(fetchErc20Balance).mockResolvedValue(1_000_000_000_000_000_000n);
    vi.mocked(fetchDefiLlamaPrices).mockImplementation(async (assets) => new Map(
      assets.filter((asset) => asset.chain === "berachain" && asset.address === "0xffffffffffffffffffffffffffffffffffffffff")
        .map((asset) => [asset.key, 75_000]),
    ));

    const config = makeBranchConfig(
      [
        {
          name: "Receipt token",
          holder: "0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
          token: { chain: "berachain", address: "0xeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee", decimals: 18 },
          priceToken: { chain: "berachain", address: "0xffffffffffffffffffffffffffffffffffffffff" },
          risk: "high",
        },
      ],
      { chain: "berachain" },
    );

    const result = await fetchEvmBranchBalancesReserves(coin, config, signal);

    expect(result.slices).toMatchObject([{ name: "Receipt token", pct: 100, risk: "high" }]);

  });

  it("includes live redemption fee metadata when a probe is configured", async () => {
    vi.mocked(fetchErc20Balance).mockResolvedValue(1_000_000_000_000_000_000n);
    vi.mocked(fetchDefiLlamaPrices).mockResolvedValue(new Map([["wstETH", 2000]]));
    vi.mocked(probeOptionalRedemptionRateBps).mockResolvedValue(50);

    const config = makeBranchConfig([wstEthBranch()], {
      params: {
        redemptionRateProbe: {
          contract: "0xf949982b91c8c61e952b3ba942cbbfaef5386684",
          selector: "0xc52861f2",
          decimals: 18,
        },
      },
    });

    const result = await fetchEvmBranchBalancesReserves(coin, config, signal);
    expect(result.metadata).toMatchObject({
      branchCount: 1,
      freshnessMode: "not-applicable",
      redemption: { feeBps: 50 },
      details: {
        proofKind: "onchain-branch-balances",
      },
    });
  });

  it("fails when any branch balance cannot be read", async () => {
    vi.mocked(fetchErc20Balance)
      .mockResolvedValueOnce(null) // first branch returns null
      .mockResolvedValueOnce(500_000_000n); // 5 WBTC (8 dec)

    vi.mocked(fetchDefiLlamaPrices).mockResolvedValue(new Map([["WBTC", 60000]]));

    const config = makeBranchConfig([wstEthBranch(), wbtcBranch()]);

    await expect(fetchEvmBranchBalancesReserves(coin, config, signal)).rejects.toThrow(
      "could not read balances for: wstETH",
    );
  });

  it("filters out branches with zero balances", async () => {
    vi.mocked(fetchErc20Balance)
      .mockResolvedValueOnce(0n) // zero balance
      .mockResolvedValueOnce(100_000_000n); // 1 WBTC (8 dec)

    vi.mocked(fetchDefiLlamaPrices).mockResolvedValue(new Map([["WBTC", 60000]]));

    const config = makeBranchConfig([wstEthBranch(), wbtcBranch()]);

    const result = await fetchEvmBranchBalancesReserves(coin, config, signal);
    expect(result.slices).toHaveLength(1);
    expect(result.slices[0].name).toBe("WBTC");
    expect(result.slices[0].pct).toBe(100);
  });

  it.each([
    { name: "all balances are zero", balance: 0n, expected: "no non-zero balances" },
    { name: "all balances are null", balance: null, expected: "could not read balances for: wstETH" },
  ])("throws when $name", async ({ balance, expected }) => {
    vi.mocked(fetchErc20Balance).mockResolvedValue(balance);
    const config = makeBranchConfig([wstEthBranch()]);

    await expect(fetchEvmBranchBalancesReserves(coin, config, signal)).rejects.toThrow(expected);
  });

  it("propagates optional coinId and depType to slices", async () => {
    vi.mocked(fetchErc20Balance).mockResolvedValue(1_000_000_000_000_000_000n);

    vi.mocked(fetchDefiLlamaPrices).mockResolvedValue(new Map([["wstETH", 2000]]));

    const config = makeBranchConfig([
      {
        ...wstEthBranch(),
        coinId: "wsteth",
        depType: "wrapper",
      },
    ]);

    const result = await fetchEvmBranchBalancesReserves(coin, config, signal);
    expect(result.slices).toHaveLength(1);
    expect(result.slices[0].coinId).toBe("wsteth");
    expect(result.slices[0].depType).toBe("wrapper");
  });

  it("uses fixed price overrides for branches without DefiLlama pricing", async () => {
    vi.mocked(fetchErc20Balance)
      .mockResolvedValueOnce(1_000_000n) // 1 USYC (6 dec)
      .mockResolvedValueOnce(2_000_000_000_000_000_000n); // 2 wrapper tokens (18 dec)

    vi.mocked(fetchDefiLlamaPrices).mockResolvedValue(new Map([["USYC", 1.12]]));

    const config = makeBranchConfig([
      {
        name: "USYC",
        holder: "0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
        token: { chain: "ethereum", address: "0xbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb", decimals: 6 },
        risk: "low",
      },
      {
        name: "Wrapped stable",
        holder: "0xcccccccccccccccccccccccccccccccccccccccc",
        token: { chain: "ethereum", address: "0xdddddddddddddddddddddddddddddddddddddddd", decimals: 18 },
        risk: "low",
        priceUsd: 1,
      },
    ]);

    const result = await fetchEvmBranchBalancesReserves(coin, config, signal);
    expect(result.slices).toMatchObject([
      { name: "Wrapped stable", pct: 64.1, risk: "low" },
      { name: "USYC", pct: 35.9, risk: "low" },
    ]);

  });

  it("falls through to the underlying coin price when the wrapper address lookup is missing", async () => {
    vi.mocked(fetchErc20Balance).mockResolvedValue(50_000_000n);
    // First DefiLlama call (wrapper) returns empty; second call (underlying
    // usdc-circle contract) returns a live price near peg.
    vi.mocked(fetchDefiLlamaPrices)
      .mockResolvedValueOnce(new Map())
      .mockResolvedValueOnce(new Map([["USDC branch", 1.0]]));

    const config = makeBranchConfig([{ ...usdcBranch(), underlyingPrice1to1: true }]);

    const result = await fetchEvmBranchBalancesReserves(coin, config, signal);
    expect(result.slices).toMatchObject([{ name: "USDC branch", pct: 100, risk: "low", coinId: "usdc-circle" }]);
    expect(result.warnings).toBeUndefined();
  });

  it("fails closed when an underlying price substitution has not been reviewed", async () => {
    vi.mocked(fetchErc20Balance).mockResolvedValue(50_000_000n);
    vi.mocked(fetchDefiLlamaPrices).mockResolvedValue(new Map());
    const config = makeBranchConfig([usdcBranch()]);
    await expect(fetchEvmBranchBalancesReserves(coin, config, signal)).rejects.toThrow(/Missing DefiLlama price/);
  });

  it("falls back to the stablecoins cache price for tracked branches missing DefiLlama address prices", async () => {
    vi.mocked(fetchErc20Balance).mockResolvedValue(1_000_000n);
    vi.mocked(fetchDefiLlamaPrices).mockResolvedValueOnce(new Map()).mockResolvedValueOnce(new Map());
    const now = 1_700_000_000;
    const db = mockD1([
      {
        match: "SELECT value, updated_at FROM cache WHERE key = ?",
        matchBinds: ["stablecoins"],
        rows: [
          {
            key: "stablecoins",
            value: JSON.stringify({
              peggedAssets: [
                {
                  id: "usyc-hashnote",
                  name: "Hashnote USYC",
                  symbol: "USYC",
                  price: 1.1245,
                },
              ],
            }),
            updated_at: now - 60,
          },
        ],
      },
    ]);

    const config = makeBranchConfig([{
      ...usdcBranch(),
      name: "Hashnote USYC",
      coinId: "usyc-hashnote",
      underlyingPrice1to1: true,
    }]);

    const result = await fetchEvmBranchBalancesReserves(coin, config, signal, { db, nowSec: now });
    expect(result.slices).toMatchObject([{ name: "Hashnote USYC", pct: 100, risk: "low", coinId: "usyc-hashnote" }]);
    expect(fetchDefiLlamaPrices).toHaveBeenCalledTimes(2);
  });

  it("emits degraded warning when a USD-pegged wrapper price is outside 5% but within 20% of peg", async () => {
    vi.mocked(fetchErc20Balance).mockResolvedValue(50_000_000n);
    vi.mocked(fetchDefiLlamaPrices).mockResolvedValue(new Map([["USDC branch", 0.9]]));

    const config = makeBranchConfig([usdcBranch()]);

    const result = await fetchEvmBranchBalancesReserves(coin, config, signal);
    expect(result.warnings).toEqual([expect.objectContaining({ code: "wrapper-depeg-detected", severity: "warning" })]);
  });

  it("does not emit USD peg warnings for explicit wrapper dependencies", async () => {
    vi.mocked(fetchErc20Balance).mockResolvedValue(50_000_000_000_000_000_000n);
    vi.mocked(fetchDefiLlamaPrices).mockResolvedValue(new Map([["sUSDe branch", 1.23]]));

    const config = makeBranchConfig([{
      ...usdcBranch(),
      name: "sUSDe branch",
      token: { chain: "ethereum", address: "0xbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb", decimals: 18 },
      risk: "medium",
      coinId: "usde-ethena",
      depType: "wrapper",
    }]);

    const result = await fetchEvmBranchBalancesReserves(coin, config, signal);
    expect(result.warnings).toBeUndefined();
    expect(result.slices).toMatchObject([
      {
        name: "sUSDe branch",
        pct: 100,
        risk: "medium",
        coinId: "usde-ethena",
        depType: "wrapper",
      },
    ]);
  });

  it("throws when a USD-pegged wrapper price is outside the 0.5-1.5 fatal band", async () => {
    vi.mocked(fetchErc20Balance).mockResolvedValue(50_000_000n);
    vi.mocked(fetchDefiLlamaPrices).mockResolvedValue(new Map([["USDC branch", 0.4]]));

    const config = makeBranchConfig([usdcBranch()]);

    await expect(fetchEvmBranchBalancesReserves(coin, config, signal)).rejects.toThrow(/extreme depeg/);
  });

  it("does not warn when a USD-pegged wrapper trades within 5% of peg", async () => {
    vi.mocked(fetchErc20Balance).mockResolvedValue(50_000_000n);
    vi.mocked(fetchDefiLlamaPrices).mockResolvedValue(new Map([["USDC branch", 1.02]]));

    const config = makeBranchConfig([usdcBranch()]);

    const result = await fetchEvmBranchBalancesReserves(coin, config, signal);
    expect(result.warnings).toBeUndefined();
  });

  it.each([
    { name: "params.branches is missing", branches: undefined },
    { name: "params.branches is empty", branches: [] },
    {
      name: "invalid fixed price overrides",
      branches: [{
        name: "USYC",
        holder: "0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
        token: { chain: "ethereum", address: "0xbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb", decimals: 6 },
        risk: "low",
        priceUsd: 0,
      }],
    },
  ])("throws when $name", async ({ branches }) => {
    const config = makeBranchConfig(branches);

    await expect(fetchEvmBranchBalancesReserves(coin, config, signal)).rejects.toThrow(
      "evm-branch-balances adapter params invalid",
    );
  });

  it("emits collateralizationRatio metadata when a debtSelector is configured", async () => {
    // 1 WBTC at $60k = $60,000 collateral; debt = 50000 USD
    vi.mocked(fetchErc20Balance).mockResolvedValueOnce(100_000_000n);
    vi.mocked(fetchDefiLlamaPrices).mockResolvedValue(new Map([["WBTC", 60000]]));
    vi.mocked(fetchOnchainUint256).mockResolvedValueOnce(50_000n * 10n ** 18n);

    const config = makeBranchConfig([
      wbtcBranch({ holder: "0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa", token: { chain: "ethereum", address: "0xbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb", decimals: 8 } }),
    ], {
      params: {
        debtSelector: "0x18160ddd", // totalSupply() as example
        debtDecimals: 18,
      },
    });

    const result = await fetchEvmBranchBalancesReserves(coin, config, signal);
    expect(result.metadata?.totalDebtUsd).toBe(50000);
    expect(result.metadata?.collateralizationRatio).toBeCloseTo(1.2, 2);
    // Healthy ratio → no undercollateralized warning.
    expect(result.warnings?.some((w) => w.code === "undercollateralized") ?? false).toBe(false);
  });

  it("supports the USDN wstETH holder balance plus token supply debt shape", async () => {
    vi.mocked(fetchErc20Balance).mockResolvedValueOnce(729_665_660_446_827_366_025n);
    vi.mocked(fetchDefiLlamaPrices).mockResolvedValue(new Map([["wstETH-backed USDN vault", 2879.58]]));
    vi.mocked(fetchOnchainUint256).mockResolvedValueOnce(1_256_625_428_863_930_548_011_778n);

    const config = makeBranchConfig([{
      name: "wstETH-backed USDN vault",
      holder: "0x656cb8c6d154aad29d8771384089be5b5141f01a",
      token: {
        chain: "ethereum",
        address: "0x7f39c581f595b53c5cb19bd0b3f8da6c935e2ca0",
        decimals: 18,
      },
      risk: "medium",
    }], {
      params: {
        debtSelector: "0x18160ddd",
        debtContract: "0xde17a000ba631c5d7c2bd9fb692efea52d90dee2",
        debtDecimals: 18,
      },
    });

    const result = await fetchEvmBranchBalancesReserves(coin, config, signal);



    expect(result.slices).toMatchObject([
      {
        name: "wstETH-backed USDN vault",
        pct: 100,
        risk: "medium",
      },
    ]);
    expect(result.metadata?.totalDebtUsd).toBeCloseTo(1_256_625.43, 2);
    expect(result.metadata?.collateralizationRatio).toBeGreaterThan(1);
    expect(result.warnings?.some((w) => w.code === "undercollateralized") ?? false).toBe(false);
  });

  it("emits an undercollateralized warning when collateralizationRatio < 1.0", async () => {
    // 1 WBTC at $60k = $60,000 collateral; debt = $80,000
    vi.mocked(fetchErc20Balance).mockResolvedValueOnce(100_000_000n);
    vi.mocked(fetchDefiLlamaPrices).mockResolvedValue(new Map([["WBTC", 60000]]));
    vi.mocked(fetchOnchainUint256).mockResolvedValueOnce(80_000n * 10n ** 18n);

    const config = makeBranchConfig([
      wbtcBranch({ holder: "0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa", token: { chain: "ethereum", address: "0xbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb", decimals: 8 } }),
    ], {
      params: {
        debtSelector: "0x18160ddd",
        debtDecimals: 18,
      },
    });

    const result = await fetchEvmBranchBalancesReserves(coin, config, signal);
    expect(result.metadata?.collateralizationRatio).toBeCloseTo(0.75, 2);
    const warning = result.warnings?.find((w) => w.code === "undercollateralized");
    expect(warning).toBeDefined();
    expect(warning?.severity).toBe("warning");
  });

  it("preserves wrapper depeg warnings when debt reconciliation also warns", async () => {
    vi.mocked(fetchErc20Balance).mockResolvedValueOnce(100_000_000n);
    vi.mocked(fetchDefiLlamaPrices).mockResolvedValue(new Map([["USDC branch", 0.9]]));
    vi.mocked(fetchOnchainUint256).mockResolvedValueOnce(100n * 10n ** 18n);

    const config = makeBranchConfig([usdcBranch()], {
      params: {
        debtSelector: "0x18160ddd",
        debtDecimals: 18,
      },
    });

    const result = await fetchEvmBranchBalancesReserves(coin, config, signal);
    expect(result.warnings?.map((warning) => warning.code)).toEqual(["wrapper-depeg-detected", "undercollateralized"]);
  });

  it("skips debt reconciliation when debtSelector is omitted", async () => {
    vi.mocked(fetchErc20Balance).mockResolvedValueOnce(1_000_000_000_000_000_000n);
    vi.mocked(fetchDefiLlamaPrices).mockResolvedValue(new Map([["wstETH", 2000]]));

    const config = makeBranchConfig([wstEthBranch({ holder: "0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa", token: { chain: "ethereum", address: "0xbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb", decimals: 18 } })]);

    const result = await fetchEvmBranchBalancesReserves(coin, config, signal);
    expect(result.metadata?.collateralizationRatio).toBeUndefined();
    expect(result.metadata?.totalDebtUsd).toBeUndefined();
    // No debt call should have been made.
    expect(fetchOnchainUint256).not.toHaveBeenCalled();
  });
});
