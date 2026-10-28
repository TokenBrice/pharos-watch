import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ACTIVE_META_BY_ID } from "@shared/lib/stablecoins/registry";
import { parseLiveReserveAdapterParams } from "@shared/lib/live-reserve-adapters";
import { fetchDefiLlamaPrices } from "../defillama";
import { buildReviewedReserveClassifications } from "../../../lib/safety-score-v9/extension-reserves";
import capture from "./fixtures/hylo-solana-account-census.json";
import { runAdapter, installAdapterNetwork, evaluateAdapterSnapshotAdmission, type AdapterNetworkSpec } from "./reserve-adapter.test-support";

const coin = ACTIVE_META_BY_ID.get("hyusd-hylo")!;
const config = coin.liveReservesConfig!;
const p = parseLiveReserveAdapterParams("hylo-solana", config.params);
const TOKEN = "TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA";
const SOLANA_RPC_URL = "https://api.mainnet-beta.solana.com";
const NOW_SEC = capture.block.response.result.blockTime;
const recorded: Record<string, { owner: string; data: string }> = Object.fromEntries(
  (capture.request.params[0] as string[]).flatMap((address, index) => {
    const value = capture.response.result.value[index];
    return value ? [[address, { owner: value.owner, data: value.data[0] }]] : [];
  }),
);
let accounts: Record<string, { owner: string; data: string }>;
function mutatePinned(address: string, identityHex: string, identityOffset: number, byte: number) {
  const data = Buffer.from(accounts[address].data, "base64");
  const identity = Buffer.from(identityHex, "hex");
  const start = data.indexOf(identity);
  if (start < 0 || data.indexOf(identity, start + 1) >= 0) {
    throw new Error(`pinned identity is missing or duplicated for ${address}`);
  }
  data[start + identityOffset] = byte;
  accounts[address].data = data.toString("base64");
}
beforeEach(() => {
  accounts = structuredClone(recorded);
});

afterEach(() => vi.unstubAllGlobals());

// DefiLlama's `solana:` namespace is keyed by mint address, case-sensitively: a
// case variant is a different key with no quote. Retaining the captured key
// makes a mis-keyed Solana price identity fail here instead of only in prod.
const priceEntries = Object.entries(capture.quotes.result.coins).map(([key, quote]) => {
  const [chain, address] = key.split(":");
  return { chain, address, price: quote.price };
});
const PRICE_URL = capture.quotes.url;

function hyloNetwork(
  includePrices = true,
  onAccounts?: (rpc: { method: string; params: unknown[] }, requestIndex: number) => void,
): AdapterNetworkSpec {
  const coins = capture.quotes.result.coins;
  let accountRequests = 0;
  return {
    json: {
      [SOLANA_RPC_URL]: async (request: Request) => {
        const rpc = await request.clone().json() as { method: string; params: unknown[] };
        if (rpc.method === "getBlockTime") return { result: NOW_SEC };
        accountRequests += 1;
        onAccounts?.(rpc, accountRequests);
        const addresses = rpc.params[0] as string[];
        return {
          result: {
            context: { slot: capture.response.result.context.slot },
            value: addresses.map((address) => accounts[address]
              ? { ...accounts[address], executable: false, data: [accounts[address].data, "base64"] }
              : null),
          },
        };
      },
      [PRICE_URL]: includePrices ? { coins } : { coins: {} },
    },
  };
}

function run(network: AdapterNetworkSpec = hyloNetwork()) {
  return runAdapter("hylo-solana", "hyusd-hylo", {
    network,
    nowSec: NOW_SEC,
  });
}
describe("hylo-solana", () => {
  it("values the recorded complete census against hyUSD supply at one observed slot", async () => {
    const { result } = await run();
    const amounts = [...capture.verification.lsts, ...capture.verification.active];
    const quote = (address: string) => priceEntries.find((row) => row.address === address)!.price;
    const total = amounts.reduce((sum, row, index) => sum + row.amount * quote(
      index < p.lsts.length ? p.lsts[index].priceAddress : p.exoPairs[index - p.lsts.length].priceAddress,
    ), 0) + capture.verification.usdcAmount * quote("usd-coin");
    expect(result.metadata?.totalCollateralUsd).toBeCloseTo(total, 5);
    expect(result.metadata?.collateralizationRatio).toBeCloseTo(total / 24202914.594102, 8);
    expect(result.metadata?.observedBlock).toEqual({ chain: "solana", number: capture.response.result.context.slot, timestamp: NOW_SEC });
    expect(result.metadata?.freshnessMode).toBe("not-applicable");
    expect(result.slices.map((slice) => slice.sourceKey)).toEqual(expect.arrayContaining(["hylo-solana:lst-pool", "hylo-solana:cbbtc-pool", "hylo-solana:hype-pool", "hylo-solana:zec-pool"]));
    // Both small positive vaults retain their measured shares.
    expect(result.slices.find((slice) => slice.sourceKey === "hylo-solana:usdc-pool")?.pct).toBeCloseTo((capture.verification.usdcAmount * quote("usd-coin") / total) * 100, 10);
    expect(result.metadata?.details?.usdcDustExcludedUsd).toBe(0);
    expect(result.warnings).toContainEqual(expect.objectContaining({ code: "route-paused", effect: "degraded" }));
    expect(result.metadata?.details?.liabilityReconciliationDelta).toBeCloseTo(21.674895, 6);
  });

  it("quotes hyloSOL under its own on-chain mint identity", async () => {
    const hyloSol = p.lsts.find((lst) => lst.priceChain === "solana")!;
    const { result, network } = await run();
    // DefiLlama's `solana:` namespace is case-sensitive, so quoting a case
    // variant (the 2026-09-09 config) resolves no price and errors every run.
    expect(network.requests.some((request) => request.url.includes(`solana:${hyloSol.mint}`))).toBe(true);
    const breakdown = result.metadata?.details?.lstBreakdown as Array<{ mint: string; valueUsd: number }>;
    expect(breakdown.find((row) => row.mint === hyloSol.mint)?.valueUsd).toBeCloseTo(capture.verification.lsts[1].amount * priceEntries.find((row) => row.address === hyloSol.mint)!.price, 5);
  });

  it("admits only the reviewed ZEC inventory and keeps its paused state adverse", async () => {
    expect(p.exoPairs.map((pair) => pair.pool)).toEqual(["cbbtc-pool", "hype-pool", "zec-pool"]);
    expect(p.inactiveExoPairs).toEqual(capture.verification.inactive.map((pair) => pair.pair));
    const runResult = await run();
    const zec = runResult.result.slices.find((slice) => slice.sourceKey === "hylo-solana:zec-pool")!;
    expect(zec.pct).toBeGreaterThan(0);
    expect(evaluateAdapterSnapshotAdmission(runResult, NOW_SEC).reasons).toContain("degraded-snapshot");
    const classification = buildReviewedReserveClassifications([zec], coin, NOW_SEC)[0];
    expect(classification.assetClass).toBe("cryptoasset");
    expect(classification.issuerOrObligorKey).toBeNull();
    expect(coin.reserves?.map((slice) => slice.pct)).toEqual(capture.verification.rows.map((row) => row.pct));
  });

  it("clears the degraded state only when the reviewed ZEC pool is unpaused", async () => {
    const zec = p.exoPairs.find((pair) => pair.pool === "zec-pool")!;
    const data = Buffer.from(accounts[zec.pair].data, "base64");
    expect(data[286]).toBe(1);
    data[286] = 0;
    accounts[zec.pair].data = data.toString("base64");
    const runResult = await run();
    expect(runResult.result.warnings).toEqual([]);
    expect(evaluateAdapterSnapshotAdmission(runResult, NOW_SEC).eligible).toBe(true);
  });

  it("rejects a fourth pair and any unreviewed pool identity", () => {
    expect(() => parseLiveReserveAdapterParams("hylo-solana", { ...p, exoPairs: [...p.exoPairs, p.exoPairs[0]] })).toThrow();
    expect(() => parseLiveReserveAdapterParams("hylo-solana", { ...p, exoPairs: p.exoPairs.map((pair, index) => index === 2 ? { ...pair, pool: "unknown-pool" } : pair) })).toThrow();
    expect(() => parseLiveReserveAdapterParams("hylo-solana", { ...p, exoPairs: [p.exoPairs[0], p.exoPairs[1], p.exoPairs[0]] })).toThrow();
  });

  it("fails closed when a reviewed collateral quote is absent", async () => {
    await expect(run(hyloNetwork(false))).rejects.toThrow(/missing collateral price/);
  });

  it("fails closed on an unknown registry LST", async () => {
    mutatePinned(p.registry, "00ae7b4ffad4eccafcd141e9832caf10ad", 8, 0);
    await expect(run()).rejects.toThrow(/unknown LST/);
  });

  it("retains composition but degrades paused state", async () => {
    mutatePinned(p.state, "420f0000000000f7000000000000000000", 8, 1);
    const { result } = await run();
    expect(result.metadata?.collateralizationRatio).toBeGreaterThan(1);
    expect(result.warnings).toContainEqual(expect.objectContaining({ code: "route-paused", effect: "degraded" }));
  });

  it.each(["owner", "discriminator"])("rejects %s mismatches", async (kind) => {
    if (kind === "owner") accounts[p.state].owner = TOKEN;
    else mutatePinned(p.state, "72a1a9d2ccaf95ae00", 0, 0);
    await expect(run()).rejects.toThrow(/owner mismatch|discriminator/);
  });

  it("fails closed when an inactive exogenous pool becomes registered", async () => {
    accounts[p.inactiveExoPairs[0]] = accounts[p.exoPairs[0].pair];
    await expect(run()).rejects.toThrow(/unreviewed exogenous/);
  });

  it("rejects substitution of an exogenous oracle feed", async () => {
    mutatePinned(p.exoPairs[0].pair, "788d24c871311cfce62df6c8b4a85fe1a6", 8, 0);
    await expect(run()).rejects.toThrow(/oracle identity/);
  });

  it("rejects a registry changed between discovery and the atomic census", async () => {
    const network = hyloNetwork(true, (_rpc, requestIndex) => {
      if (requestIndex === 2) mutatePinned(p.registry, "4f9d1600000000140169cd88c074150b64", 8, 0);
    });
    await expect(run(network)).rejects.toThrow(/registry changed/);
  });

  it("preserves case-sensitive Solana price identities at the real quote boundary", async () => {
    const address = p.lsts[1].priceAddress;
    const url = `https://coins.llama.fi/prices/current/solana:${address}`;
    const network = installAdapterNetwork({
      json: {
        [url]: {
          coins: {
            [`solana:${address}`]: { price: 111.21, timestamp: NOW_SEC, confidence: 1 },
          },
        },
      },
    });
    const { prices, warnings } = await fetchDefiLlamaPrices(
      [{ key: "hyloSOL", chain: "solana", address }],
      new AbortController().signal,
      { chainRpcs: network.chainRpcs, requestCache: new Map(), nowSec: NOW_SEC },
    );
    expect(prices.get("hyloSOL")).toBe(111.21);
    expect(warnings).toEqual([]);
  });
});
