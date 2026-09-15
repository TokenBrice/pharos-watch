import { describe, expect, it } from "vitest";
import { parseBackedRawUnits } from "../chainlink-por";
import { encodeBalanceOfCallData } from "../../../lib/evm-selectors";
import { runAdapter, type AdapterNetworkSpec } from "./reserve-adapter.test-support";
import { makePorCoin } from "./chainlink-por.test-support";

const NOW = 1_789_440_000;
const TOKEN = "0x2f123cf3f37ce3328cc9b5b8415f9ec5109b45e7";
const FEED = "0x648e0ff6a36d58f6fce5927cb77601b73cadc2af";
const OWNERS = ["0x5f7a4c11bde4f218f0025ef444c369d838ffa2ad", "0x43624c744a4af40754ab19b00b6f681ca56f1e5b"];
const CHAINS = ["ethereum", "polygon", "gnosis", "bsc", "avalanche", "fantom", "base", "arbitrum"];
const IDS = [1, 137, 100, 56, 43114, 250, 8453, 42161];
const word = (n: bigint) => n.toString(16).padStart(64, "0");
function fixture() {
  const coin = makePorCoin({ id: "bc3m-backed", symbol: "bC3M",
    contracts: CHAINS.map((chain) => ({ chain, address: TOKEN, decimals: 18 })),
    liveReservesConfig: { adapter: "chainlink-por", version: 1, semantics: "attestation-mix",
      inputs: { primary: { kind: "onchain-evm", chain: "polygon", rpcMode: "public-rpc" } },
      params: { porFeedAddress: FEED, assetLabel: "Fund shares", assetRisk: "very-low", reserveUnit: "SHARES",
        issuerCirculationProbe: { kind: "backed-graphql", url: "https://api.backed.fi/graphql", reserveSymbol: "C3M.MI" } } },
  });
  const deployments = IDS.map((chainId, index) => ({ chainId: String(chainId), address: TOKEN,
    totalSupply: index === 0 ? "6e+22" : "0", circulatingSupply: index === 0 ? "700000000002299947" : "0" }));
  const payload = { data: { assetReserves: [{ symbol: "C3M.MI", token: [{ symbol: "bC3M", deployments }] }] } };
  const network: AdapterNetworkSpec = { block: { number: 123456, timestamp: NOW - 10 },
    json: { "https://api.backed.fi/graphql": payload }, rpc: {
      [`${FEED}:0x313ce567`]: 18n,
      [`${FEED}:0xfeaf968c`]: `0x${word(1n)}${word(700000000000000000n)}${word(0n)}${word(BigInt(NOW - 60))}${word(1n)}`,
      "0x18160ddd": (call) => call.chain === "ethereum" ? 60000n * 10n ** 18n : 0n,
      [encodeBalanceOfCallData(OWNERS[0])]: (call) => call.chain === "ethereum" ? 50000n * 10n ** 18n : 0n,
      [encodeBalanceOfCallData(OWNERS[1])]: (call) => call.chain === "ethereum" ? 10000n * 10n ** 18n - 700000000002299947n : 0n,
    } };
  return { coin, network, payload, deployments };
}

describe("reviewed Backed inventory circulation", () => {
  it("compares exact current net units, retaining gross supply and the older oracle timestamp", async () => {
    const f = fixture();
    const { result, network } = await runAdapter("chainlink-por", f.coin, { network: f.network, nowSec: NOW });
    expect(result.metadata?.liabilityBasis, JSON.stringify(result.metadata?.circulationProbeFailure)).toBe("onchain-verified-issuer-circulation");
    expect(result.metadata?.supplyTokens).toBe(60000);
    expect(result.metadata?.circulatingSupplyTokens).toBeCloseTo(0.700000000002299947);
    expect(result.metadata?.collateralizationRatio).toBeCloseTo(1);
    expect(result.metadata?.sourceTimestamp).toBe(NOW - 60);
    expect(result.metadata?.circulationVerifiedAt).toBe(NOW - 10);
    expect(result.warnings?.some((w) => w.code === "por-circulation-freshness-unverified")).not.toBe(true);
    const supplyCalls = network.rpcCalls.filter((call) => call.contract === TOKEN);
    expect(supplyCalls).toHaveLength(24);
    expect(supplyCalls.every((call) => call.block === "0x1e240" && call.viaMulticall)).toBe(true);
  });
  it("allows absent API deployments only when independent gross and net are both zero", async () => {
    const f = fixture();
    f.deployments.splice(5, 1);
    const { result } = await runAdapter("chainlink-por", f.coin, { network: f.network, nowSec: NOW });
    expect(result.metadata?.liabilityBasis, JSON.stringify(result.metadata?.circulationProbeFailure)).toBe("onchain-verified-issuer-circulation");
    expect(result.metadata?.circulationObservations).toHaveLength(8);
  });
  for (const scenario of ["one-wei-net", "one-wei-gross", "missing-funded", "duplicate", "wrong-address", "extra-zero", "wrong-token", "missing-chain", "stale-block", "inventory-overflow", "partial-read", "wrong-reserve-unit", "wrong-feed", "wrong-feed-chain"] as const) {
    it(`withholds coverage for ${scenario}`, async () => {
      const f = fixture();
      if (scenario === "one-wei-net") f.deployments[0].circulatingSupply = "700000000002299948";
      if (scenario === "one-wei-gross") f.deployments[0].totalSupply = "60000000000000000000001";
      if (scenario === "missing-funded") f.deployments.shift();
      if (scenario === "duplicate") f.deployments.push({ ...f.deployments[0] });
      if (scenario === "wrong-address") f.deployments[1].address = "0x0000000000000000000000000000000000000001";
      if (scenario === "extra-zero") f.deployments.push({ chainId: "10", address: TOKEN, totalSupply: "0", circulatingSupply: "0" });
      if (scenario === "wrong-token") f.payload.data.assetReserves[0].token[0].symbol = "bIB01";
      if (scenario === "missing-chain") f.coin.contracts!.pop();
      if (scenario === "stale-block") f.network.block!.timestamp = NOW - 301;
      if (scenario === "inventory-overflow") f.network.rpc![encodeBalanceOfCallData(OWNERS[0])] = 60001n * 10n ** 18n;
      if (scenario === "partial-read") f.network.rpc![encodeBalanceOfCallData(OWNERS[0])] = (call) => call.chain === "fantom" ? null : call.chain === "ethereum" ? 50000n * 10n ** 18n : 0n;
      if (scenario === "wrong-reserve-unit") f.coin.liveReservesConfig!.params!.reserveUnit = "USD";
      if (scenario === "wrong-feed-chain") f.coin.liveReservesConfig!.inputs!.primary = { kind: "onchain-evm", chain: "ethereum", rpcMode: "public-rpc" };
      if (scenario === "wrong-feed") {
        const wrongFeed = "0x0000000000000000000000000000000000000001";
        f.coin.liveReservesConfig!.params!.porFeedAddress = wrongFeed;
        f.network.rpc![`${wrongFeed}:0x313ce567`] = f.network.rpc![`${FEED}:0x313ce567`];
        f.network.rpc![`${wrongFeed}:0xfeaf968c`] = f.network.rpc![`${FEED}:0xfeaf968c`];
      }
      const { result } = await runAdapter("chainlink-por", f.coin, { network: f.network, nowSec: NOW });
      expect(result.metadata?.collateralizationRatio).toBeUndefined();
      expect(result.metadata?.liabilityBasis).toBeUndefined();
      if (scenario === "one-wei-net") {
        expect(result.metadata?.supplyTokens).toBe(60000);
        expect(result.metadata?.supplyReadComplete).toBe(true);
      }
      expect(result.warnings?.some((w) => w.code === "por-circulation-probe-failed")).toBe(true);
    });
  }
});

describe("Backed exact raw quantity parsing", () => {
  it.each([["6e+22", 60000000000000000000000n], ["4.442000000000002098529e+21", 4442000000000002098529n], ["700000000002299947", 700000000002299947n], ["1.000", 1n], [0, 0n]])("reads %s exactly", (value, expected) => {
    expect(parseBackedRawUnits(value)).toBe(expected);
  });
  it.each(["1.01", "-1", "1e999", "NaN", 9007199254740992, (2n ** 256n).toString(), null])("rejects %s", (value) => {
    expect(parseBackedRawUnits(value)).toBeNull();
  });
});
