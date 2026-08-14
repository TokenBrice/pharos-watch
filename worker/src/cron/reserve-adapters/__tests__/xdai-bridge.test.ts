import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  fetchXdaiBridgeReserves,
  type XdaiBridgeParams,
} from "../xdai-bridge";

const rpc = vi.hoisted(() => ({
  fetchEvmBlockHeader: vi.fn(),
  fetchEvmBlockHeaderAtTag: vi.fn(),
  fetchEvmCodeAtBlock: vi.fn(),
  fetchEvmMulticall3Aggregate3AtBlock: vi.fn(),
  fetchEvmStorageAtBlock: vi.fn(),
}));

vi.mock("../../../lib/evm-rpc", () => rpc);

const ADDRESSES = {
  foreign: "0x4aa42145Aa6Ebf72e164C9bBC74fbD3788045016",
  home: "0x7301CFA0e1756B71869E93d4e4Dca5c7d0eb0AA6",
  blockReward: "0x481c034c6d9441db23Ea48De68BCAe812C5d39bA",
  deposit: "0x5C183C8A49aBA6e31049997a56D75600E27FF8c9",
  usds: "0xdC035D45d973E3EC169d2276DDab16f1e407384F",
  susds: "0xa3931d71877C0E7a3148CB7Eb4463524FEc27fbD",
  dai: "0x6B175474E89094C44Da98b954EedeAC495271d0F",
  sdai: "0x83F20F44975D03b1b09e64809B757c47f942BEeA",
} as const;

const NOW_SEC = 1_800_000_000;
const ETHEREUM_BLOCK = {
  number: 20_000_000,
  timestamp: NOW_SEC - 30,
  hash: "0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
};
const GNOSIS_BLOCK = {
  number: 40_000_000,
  timestamp: NOW_SEC - 20,
  hash: "0xbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb",
};

function word(value: bigint): `0x${string}` {
  return `0x${value.toString(16).padStart(64, "0")}`;
}

function bytes4Word(value: string): `0x${string}` {
  return `0x${value.slice(2).padEnd(64, "0")}`;
}

function addressWord(address: string): `0x${string}` {
  return `0x${address.slice(2).toLowerCase().padStart(64, "0")}`;
}

function result(label: string, returnData: `0x${string}`) {
  return { label, success: true, returnData };
}

const DEFAULTS = {
  liquidUsds: 870_465n * 10n ** 18n,
  susdsShares: 58_007_593n * 10n ** 18n,
  susdsAssets: 64_165_985n * 10n ** 18n,
  maxWithdraw: 64_165_985n * 10n ** 18n,
  investedUsds: 64_165_329n * 10n ** 18n,
};

// Keep the fixture values readable while still exercising 18-decimal bigint arithmetic.
const MINTED = 133_089_330n * 10n ** 18n;
const OUTSTANDING = 64_623_307n * 10n ** 18n;
const BURNT = MINTED - OUTSTANDING;

function baseParams(): XdaiBridgeParams {
  return {
    foreignBridgeAddress: ADDRESSES.foreign,
    homeBridgeAddress: ADDRESSES.home,
    blockRewardAddress: ADDRESSES.blockReward,
    usdsDepositContractAddress: ADDRESSES.deposit,
    usdsAddress: ADDRESSES.usds,
    susdsAddress: ADDRESSES.susds,
    daiAddress: ADDRESSES.dai,
    sdaiAddress: ADDRESSES.sdai,
    ethereumRpcUrl: "https://ethereum-rpc.publicnode.com",
    gnosisRpcUrl: "https://gnosis-rpc.publicnode.com",
    finalityTag: "finalized",
    maxBlockAgeSec: 1_800,
    maxFutureBlockSkewSec: 60,
    crossChainSkewWarningSec: 30,
    maxCrossChainSkewSec: 60,
    coverageShortfallWarningRatio: 0.995,
    surplusWarningRatio: 1.05,
    maxSurplusRatio: 1.2,
    legacyWarningPct: 0.01,
    legacyMaterialityPct: 0.1,
    maxWithdrawDivergencePct: 1,
    sourceUrls: ["https://docs.gnosischain.com/bridges/About%20Token%20Bridges/xdai-bridge"],
  };
}

function baseConfig() {
  return {
    adapter: "xdai-bridge" as const,
    version: 1,
    semantics: "collateral-mix" as const,
    inputs: {
      primary: { kind: "onchain-evm" as const, chain: "ethereum", rpcMode: "public-rpc" as const },
    },
    params: baseParams(),
  };
}

function ethereumResults(overrides: Record<string, `0x${string}`> = {}) {
  const params = baseParams();
  const values: Record<string, `0x${string}`> = {
    "foreign-daiToken": addressWord(params.usdsAddress),
    "foreign-sDaiToken": addressWord(params.susdsAddress),
    "foreign-erc20token": addressWord(params.usdsAddress),
    "foreign-interestEnabled": word(1n),
    "foreign-investedAmount": word(DEFAULTS.investedUsds),
    "foreign-bridgeMode": bytes4Word("0x18762d46"),
    "usds-balance": word(DEFAULTS.liquidUsds),
    "usds-decimals": word(18n),
    "susds-balance": word(DEFAULTS.susdsShares),
    "susds-asset": addressWord(params.usdsAddress),
    "susds-decimals": word(18n),
    "susds-maxWithdraw": word(DEFAULTS.maxWithdraw),
    "dai-balance": word(0n),
    "dai-decimals": word(18n),
    "sdai-balance": word(0n),
    "sdai-decimals": word(18n),
    ...overrides,
  };
  return Object.entries(values).map(([label, returnData]) => result(label, returnData));
}

function gnosisResults(overrides: Record<string, `0x${string}`> = {}) {
  const params = baseParams();
  const values: Record<string, `0x${string}`> = {
    "home-blockReward": addressWord(params.blockRewardAddress),
    "home-usdsDeposit": addressWord(params.usdsDepositContractAddress),
    "home-bridgeMode": bytes4Word("0x18762d46"),
    mintedTotallyByBridge: word(MINTED),
    totalBurntCoins: word(BURNT),
    ...overrides,
  };
  return Object.entries(values).map(([label, returnData]) => result(label, returnData));
}

function installRpcFixtures(options: {
  ethereum?: ReturnType<typeof ethereumResults>;
  gnosis?: ReturnType<typeof gnosisResults>;
  ethereumBlock?: typeof ETHEREUM_BLOCK;
  gnosisBlock?: typeof GNOSIS_BLOCK;
} = {}) {
  const ethereumBlock = options.ethereumBlock ?? ETHEREUM_BLOCK;
  const gnosisBlock = options.gnosisBlock ?? GNOSIS_BLOCK;
  const blockHeader = async (chain: string) => chain === "ethereum" ? ethereumBlock : gnosisBlock;
  rpc.fetchEvmBlockHeader.mockImplementation(blockHeader);
  rpc.fetchEvmBlockHeaderAtTag.mockImplementation(blockHeader);
  rpc.fetchEvmCodeAtBlock.mockResolvedValue("0x6000");
  rpc.fetchEvmStorageAtBlock.mockResolvedValue(addressWord(ADDRESSES.home));
  rpc.fetchEvmMulticall3Aggregate3AtBlock.mockImplementation(async (chain: string, calls: Array<{ label: string }>) => {
    if (calls.some((entry) => entry.label === "susds-convertToAssets")) {
      return [result("susds-convertToAssets", word(DEFAULTS.susdsAssets))];
    }
    return chain === "ethereum"
      ? (options.ethereum ?? ethereumResults())
      : (options.gnosis ?? gnosisResults());
  });
}

async function fetchFixture(config = baseConfig()) {
  return fetchXdaiBridgeReserves(
    {} as never,
    config as never,
    new AbortController().signal,
    { nowSec: NOW_SEC },
  );
}

describe("xdai-bridge adapter", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    installRpcFixtures();
  });

  it("publishes the two reviewed collateral slices and bridge coverage", async () => {
    const output = await fetchFixture();

    expect(output.slices).toEqual([
      expect.objectContaining({ name: "sUSDS held by the Ethereum xDAI Foreign Bridge", coinId: "susds-sky", depType: "collateral" }),
      expect.objectContaining({ name: "Liquid USDS held by the Ethereum xDAI Foreign Bridge", coinId: "usds-sky", depType: "collateral" }),
    ]);
    expect(output.slices.reduce((sum, slice) => sum + slice.pct, 0)).toBe(100);
    expect(output.metadata).toMatchObject({ freshnessMode: "not-applicable", supplyUsd: expect.any(Number), totalReserveUsd: expect.any(Number) });
    expect(output.metadata?.collateralizationRatio).toBeGreaterThan(1);
    expect(output.metadata?.redemption).toBeUndefined();
    expect(output.metadata?.details).toMatchObject({ finalityTag: "finalized", crossChainTimestampSkewSec: 10 });
  });

  it("fails closed when a bridge identity getter drifts", async () => {
    installRpcFixtures({ ethereum: ethereumResults({ "foreign-erc20token": addressWord(ADDRESSES.dai) }) });

    await expect(fetchFixture()).rejects.toThrow("foreign.erc20token() identity mismatch");
  });

  it("fails closed on malformed ABI payloads", async () => {
    installRpcFixtures({ ethereum: ethereumResults({ "susds-asset": "0x1234" as `0x${string}` }) });

    await expect(fetchFixture()).rejects.toThrow("susds-asset returned malformed address payload");
  });

  it("rejects invalid mint-minus-burn arithmetic", async () => {
    installRpcFixtures({ gnosis: gnosisResults({ totalBurntCoins: word(MINTED + 1n) }) });

    await expect(fetchFixture()).rejects.toThrow("burnt xDAI exceeds minted xDAI");
  });

  it("keeps the observed coverage ratio and degrades on a material shortfall", async () => {
    installRpcFixtures({
      ethereum: ethereumResults({ "usds-balance": word(0n) }),
    });
    rpc.fetchEvmMulticall3Aggregate3AtBlock.mockImplementation(async (chain: string, calls: Array<{ label: string }>) => {
      if (calls.some((entry) => entry.label === "susds-convertToAssets")) return [result("susds-convertToAssets", word(60_000_000n * 10n ** 18n))];
      return chain === "ethereum" ? ethereumResults({ "usds-balance": word(0n) }) : gnosisResults();
    });

    const output = await fetchFixture();

    expect(output.metadata?.collateralizationRatio).toBeLessThan(1);
    expect(output.warnings).toContainEqual(expect.objectContaining({ code: "xdai-reserve-undercollateralized", effect: "degraded" }));
  });

  it("rejects excessive cross-chain timestamp skew", async () => {
    installRpcFixtures({
      gnosisBlock: { ...GNOSIS_BLOCK, timestamp: NOW_SEC - 200 },
    });
    const skewedBlockHeader = async (chain: string, blockTag: number | "finalized") => {
      if (chain === "ethereum" && blockTag !== "finalized") {
        return { ...ETHEREUM_BLOCK, number: blockTag, timestamp: NOW_SEC - 300 };
      }
      return chain === "ethereum" ? ETHEREUM_BLOCK : { ...GNOSIS_BLOCK, timestamp: NOW_SEC - 200 };
    };
    rpc.fetchEvmBlockHeader.mockImplementation(skewedBlockHeader);
    rpc.fetchEvmBlockHeaderAtTag.mockImplementation(skewedBlockHeader);

    await expect(fetchFixture()).rejects.toThrow("cross-chain finalized block timestamp skew 100s exceeds 60s");
  });

  it("fails closed when legacy DAI/sDAI exposure becomes material", async () => {
    installRpcFixtures({
      ethereum: ethereumResults({ "dai-balance": word(100_000n * 10n ** 18n) }),
    });

    await expect(fetchFixture()).rejects.toThrow("material legacy DAI/sDAI balance");
  });
});
