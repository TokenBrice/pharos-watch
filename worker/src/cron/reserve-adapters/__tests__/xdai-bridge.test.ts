import { describe, expect, it } from "vitest";
import { installAdapterNetwork, runAdapter, type AdapterNetwork } from "./reserve-adapter.test-support";

const ADDRESSES = {
  foreign: "0x4aa42145Aa6Ebf72e164C9bBC74fbD3788045016",
  home: "0x7301CFA0e1756B71869E93d4E4Dca5C7d0Eb0AA6",
  blockReward: "0x481c034c6d9441db23Ea48De68BCAe812C5d39bA",
  deposit: "0x5C183C8A49aBA6e31049997a56D75600E27FF8c9",
  usds: "0xdC035D45d973E3EC169d2276DDab16f1e407384F",
  susds: "0xa3931d71877C0E7a3148CB7Eb4463524FEc27fbD",
  dai: "0x6B175474E89094C44Da98b954EedeAC495271d0F",
  sdai: "0x83F20F44975D03b1b09e64809B757c47f942BEeA",
} as const;

const NOW_SEC = 1_800_000_000;
const ETHEREUM_RPC = "https://ethereum-rpc.publicnode.com";
const GNOSIS_RPC = "https://gnosis-rpc.publicnode.com";
const FOREIGN_BRIDGE_OTHER_SIDE_STORAGE_SLOT =
  "0x21ffdf150a5d180f96d98d16f50e7b4dd63e2a067adc8386cf5af55dcecd8dd9";
const ETHEREUM_BLOCK = {
  number: 20_000_000,
  timestamp: NOW_SEC - 30,
  hash: "0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
};
const GNOSIS_BLOCK = {
  number: 40_000_000,
  timestamp: NOW_SEC - 20,
  hash: `0x${"b".repeat(64)}`,
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

type XdaiResponse = `0x${string}` | null;
type XdaiBlock = { number: number; timestamp: number; hash: string };
type BlockPlan = {
  anchors: { ethereum: XdaiBlock; gnosis: XdaiBlock };
  numeric: { ethereum: XdaiBlock; gnosis: XdaiBlock };
};
type NetworkOptions = {
  ethereum?: Record<string, XdaiResponse>;
  gnosis?: Record<string, XdaiResponse>;
  convertedAssets?: bigint;
  blockPlan?: BlockPlan;
};

function rpcTable(options: NetworkOptions): Record<string, XdaiResponse | ((call: { selector: string }) => XdaiResponse)> {
  const ethereum = {
    "foreign-daiToken": addressWord(ADDRESSES.usds),
    "foreign-sDaiToken": addressWord(ADDRESSES.susds),
    "foreign-erc20token": addressWord(ADDRESSES.usds),
    "foreign-interestEnabled": word(1n),
    "foreign-investedAmount": word(DEFAULTS.investedUsds),
    "foreign-bridgeMode": bytes4Word("0x18762d46"),
    "usds-balance": word(DEFAULTS.liquidUsds),
    "usds-decimals": word(18n),
    "susds-balance": word(DEFAULTS.susdsShares),
    "susds-asset": addressWord(ADDRESSES.usds),
    "susds-decimals": word(18n),
    "susds-maxWithdraw": word(DEFAULTS.maxWithdraw),
    "dai-balance": word(0n),
    "dai-decimals": word(18n),
    "sdai-balance": word(0n),
    "sdai-decimals": word(18n),
    ...(options.ethereum ?? {}),
  };
  const gnosis = {
    "home-blockReward": addressWord(ADDRESSES.blockReward),
    "home-usdsDeposit": addressWord(ADDRESSES.deposit),
    "home-bridgeMode": bytes4Word("0x18762d46"),
    mintedTotallyByBridge: word(MINTED),
    totalBurntCoins: word(BURNT),
    ...(options.gnosis ?? {}),
  };
  const entries: Record<string, XdaiResponse | ((call: { selector: string }) => XdaiResponse)> = {
    [`ethereum:${ADDRESSES.foreign}:0xbe22f546`]: ethereum["foreign-daiToken"],
    [`ethereum:${ADDRESSES.foreign}:0x3853b7a1`]: ethereum["foreign-sDaiToken"],
    [`ethereum:${ADDRESSES.foreign}:0x1dcea427`]: ethereum["foreign-erc20token"],
    [`ethereum:${ADDRESSES.foreign}:0xd2ef8660`]: ethereum["foreign-interestEnabled"],
    [`ethereum:${ADDRESSES.foreign}:0xcff77444`]: ethereum["foreign-investedAmount"],
    [`ethereum:${ADDRESSES.foreign}:0x437764df`]: ethereum["foreign-bridgeMode"],
    [`ethereum:${ADDRESSES.usds}:0x70a08231`]: ethereum["usds-balance"],
    [`ethereum:${ADDRESSES.usds}:0x313ce567`]: ethereum["usds-decimals"],
    [`ethereum:${ADDRESSES.susds}:0x70a08231`]: ethereum["susds-balance"],
    [`ethereum:${ADDRESSES.susds}:0x38d52e0f`]: ethereum["susds-asset"],
    [`ethereum:${ADDRESSES.susds}:0x313ce567`]: ethereum["susds-decimals"],
    [`ethereum:${ADDRESSES.susds}:0xce96cb77`]: ethereum["susds-maxWithdraw"],
    [`ethereum:${ADDRESSES.susds}:0x07a2d13a`]: word(options.convertedAssets ?? DEFAULTS.susdsAssets),
    [`ethereum:${ADDRESSES.dai}:0x70a08231`]: ethereum["dai-balance"],
    [`ethereum:${ADDRESSES.dai}:0x313ce567`]: ethereum["dai-decimals"],
    [`ethereum:${ADDRESSES.sdai}:0x70a08231`]: ethereum["sdai-balance"],
    [`ethereum:${ADDRESSES.sdai}:0x313ce567`]: ethereum["sdai-decimals"],
    [`gnosis:${ADDRESSES.home}:0x56b54bae`]: gnosis["home-blockReward"],
    [`gnosis:${ADDRESSES.home}:0xd7ef34bc`]: gnosis["home-usdsDeposit"],
    [`gnosis:${ADDRESSES.home}:0x437764df`]: gnosis["home-bridgeMode"],
    [`gnosis:${ADDRESSES.blockReward}:0xb4a523e8`]: gnosis.mintedTotallyByBridge,
    [`gnosis:${ADDRESSES.home}:0x0e8162ba`]: gnosis.totalBurntCoins,
    [`ethereum:eth_getStorageAt:${ADDRESSES.foreign}:${FOREIGN_BRIDGE_OTHER_SIDE_STORAGE_SLOT}`]:
      addressWord(ADDRESSES.home),
  };
  return entries;
}

function installBlockPlan(network: AdapterNetwork, plan: BlockPlan): void {
  const base = network.fetchSpy.getMockImplementation();
  if (!base) throw new Error("xDAI test network has no fetch implementation");
  network.fetchSpy.mockImplementation(async (input, init) => {
    const request = input instanceof Request ? input : new Request(input, init);
    const requestUrl = request.url.replace(/\/$/, "");
    if (request.method === "POST" && (requestUrl === ETHEREUM_RPC || requestUrl === GNOSIS_RPC)) {
      const body = JSON.parse(await request.clone().text()) as {
        id?: number;
        method?: string;
        params?: unknown[];
      };
      if (body.method === "eth_getBlockByNumber") {
        const chain = requestUrl === ETHEREUM_RPC ? "ethereum" : "gnosis";
        const tag = body.params?.[0];
        const isNumericTag = typeof tag === "string" && tag.startsWith("0x");
        const configuredBlock = isNumericTag ? plan.numeric[chain] : plan.anchors[chain];
        const block = isNumericTag
          ? { ...configuredBlock, number: Number.parseInt((tag as string).slice(2), 16) }
          : configuredBlock;
        return Response.json({
          jsonrpc: "2.0",
          id: body.id ?? 1,
          result: {
            number: `0x${block.number.toString(16)}`,
            timestamp: `0x${block.timestamp.toString(16)}`,
            hash: block.hash,
          },
        });
      }
    }
    return base(input, init);
  });
}

function installXdaiNetwork(options: NetworkOptions = {}): AdapterNetwork {
  const network = installAdapterNetwork({
    chains: { ethereum: ETHEREUM_RPC, gnosis: GNOSIS_RPC },
    block: ETHEREUM_BLOCK,
    rpc: rpcTable(options),
  });
  if (options.blockPlan) installBlockPlan(network, options.blockPlan);
  return network;
}

async function fetchFixture(
  network = installXdaiNetwork(),
  params: Record<string, unknown> = {},
) {
  const { result } = await runAdapter("xdai-bridge", "xdai-gnosis", {
    network,
    nowSec: NOW_SEC,
    params,
  });
  return result;
}

describe("xdai-bridge adapter", () => {
  it("publishes the two reviewed collateral slices and bridge coverage", async () => {
    const output = await fetchFixture();

    expect(output.slices).toEqual([
      expect.objectContaining({ name: "sUSDS held by the Ethereum xDAI Foreign Bridge", coinId: "susds-sky", depType: "collateral" }),
      expect.objectContaining({ name: "Liquid USDS held by the Ethereum xDAI Foreign Bridge", coinId: "usds-sky", depType: "collateral" }),
    ]);
    expect(output.slices.reduce((sum, slice) => sum + slice.pct, 0)).toBe(100);
    expect(output.metadata).toMatchObject({ freshnessMode: "not-applicable", supplyUsd: 64_623_307, totalReserveUsd: 65_036_450 });
    expect(output.metadata?.collateralizationRatio).toBeCloseTo(65_036_450 / 64_623_307, 9);
    expect(output.metadata?.redemption).toBeUndefined();
    expect(output.metadata?.details).toMatchObject({ finalityTag: "safe", crossChainTimestampSkewSec: 0 });
  });

  it("fails closed when a bridge identity getter drifts", async () => {
    const network = installXdaiNetwork({
      ethereum: { "foreign-erc20token": addressWord(ADDRESSES.dai) },
    });

    await expect(fetchFixture(network)).rejects.toThrow("foreign.erc20token() identity mismatch");
  });

  it("fails closed on malformed ABI payloads", async () => {
    const network = installXdaiNetwork({
      ethereum: { "susds-asset": ("0x" + "1".repeat(64)) as `0x${string}` },
    });

    await expect(fetchFixture(network)).rejects.toThrow("susds-asset returned malformed address payload");
  });

  it("rejects invalid mint-minus-burn arithmetic", async () => {
    const network = installXdaiNetwork({
      gnosis: { totalBurntCoins: word(MINTED + 1n) },
    });

    await expect(fetchFixture(network)).rejects.toThrow("burnt xDAI exceeds minted xDAI");
  });

  it("keeps the observed coverage ratio and degrades on a material shortfall", async () => {
    const network = installXdaiNetwork({
      ethereum: { "usds-balance": word(0n) },
      convertedAssets: 60_000_000n * 10n ** 18n,
    });

    const output = await fetchFixture(network);

    expect(output.metadata?.collateralizationRatio).toBeLessThan(1);
    expect(output.warnings).toContainEqual(expect.objectContaining({ code: "xdai-reserve-undercollateralized", effect: "degraded" }));
  });

  it("rejects excessive cross-chain timestamp skew", async () => {
    const network = installXdaiNetwork({
      blockPlan: {
        anchors: {
          ethereum: ETHEREUM_BLOCK,
          gnosis: { ...GNOSIS_BLOCK, timestamp: NOW_SEC - 200 },
        },
        numeric: {
          ethereum: { ...ETHEREUM_BLOCK, timestamp: NOW_SEC - 300 },
          gnosis: { ...GNOSIS_BLOCK, timestamp: NOW_SEC - 200 },
        },
      },
    });

    await expect(fetchFixture(network, { maxCrossChainSkewSec: 60 })).rejects.toThrow(
      "cross-chain finalized block timestamp skew 100s exceeds 60s",
    );
  });

  it("reads balances at the historical block selected to align finalized anchors", async () => {
    const aligned = { ...ETHEREUM_BLOCK, number: ETHEREUM_BLOCK.number - 15, timestamp: NOW_SEC - 200 };
    const olderGnosis = { ...GNOSIS_BLOCK, timestamp: NOW_SEC - 200 };
    const network = installXdaiNetwork({
      blockPlan: {
        anchors: { ethereum: ETHEREUM_BLOCK, gnosis: olderGnosis },
        numeric: { ethereum: aligned, gnosis: olderGnosis },
      },
    });

    const output = await fetchFixture(network, { maxCrossChainSkewSec: 60 });

    expect(output.metadata?.details).toMatchObject({
      ethereumBlock: { number: aligned.number },
      crossChainTimestampSkewSec: 0,
    });
    expect(output.metadata?.totalReserveUsd).toBe(65_036_450);
  });

  it("rejects a closing block hash that changed during observation", async () => {
    const network = installXdaiNetwork({
      blockPlan: {
        anchors: { ethereum: ETHEREUM_BLOCK, gnosis: GNOSIS_BLOCK },
        numeric: {
          ethereum: { ...ETHEREUM_BLOCK, hash: GNOSIS_BLOCK.hash },
          gnosis: GNOSIS_BLOCK,
        },
      },
    });

    await expect(fetchFixture(network)).rejects.toThrow("ethereum finalized block changed during the read");
  });

  it("fails closed when legacy DAI/sDAI exposure becomes material", async () => {
    const network = installXdaiNetwork({
      ethereum: { "dai-balance": word(100_000n * 10n ** 18n) },
    });

    await expect(fetchFixture(network)).rejects.toThrow("material legacy DAI/sDAI balance");
  });
});
