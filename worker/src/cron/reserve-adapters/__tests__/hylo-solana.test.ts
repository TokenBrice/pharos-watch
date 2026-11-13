import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ACTIVE_META_BY_ID } from "@shared/lib/stablecoins/registry";
import { parseLiveReserveAdapterParams } from "@shared/lib/live-reserve-adapters";
import { buildReviewedReserveClassifications, dependencyReserveSlices } from "../../../lib/safety-score-v9/extension-reserves";
import { fetchDefiLlamaPrices } from "../defillama";
import { classifyFailure } from "../../sync-live-reserves-shared";
import capture from "./fixtures/hylo-solana-account-census.json";
import { runAdapter, runAdapterWithFakeTimers, installAdapterNetwork, evaluateAdapterSnapshotAdmission, type AdapterNetworkSpec } from "./reserve-adapter.test-support";

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
let accounts: typeof recorded;
function edit(address: string, update: (data: Buffer) => void) {
  const data = Buffer.from(accounts[address].data, "base64");
  update(data);
  accounts[address].data = data.toString("base64");
}
function mutatePinned(address: string, identityHex: string, identityOffset: number, byte: number) {
  edit(address, data => {
    const identity = Buffer.from(identityHex, "hex");
    const start = data.indexOf(identity);
    if (start < 0 || data.indexOf(identity, start + 1) >= 0) {
      throw new Error(`pinned identity is missing or duplicated for ${address}`);
    }
    data[start + identityOffset] = byte;
  });
}
beforeEach(() => {
  accounts = structuredClone(recorded);
});

afterEach(() => vi.unstubAllGlobals());

const PRICE_URL = capture.quotes.url;
const quote = (address: string) => Object.entries(capture.quotes.result.coins).find(([key]) => key.endsWith(`:${address}`))![1].price;
const sourceKey = (pool: string) => `hylo-solana:${pool}-pool`;

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
    const total = amounts.reduce((sum, row, index) => sum + row.amount * quote(
      index < p.lsts.length ? p.lsts[index].priceAddress : p.exoPairs[index - p.lsts.length].priceAddress,
    ), 0) + capture.verification.usdcAmount * quote("usd-coin");
    expect(result.metadata?.totalCollateralUsd).toBeCloseTo(total, 5);
    expect(result.metadata?.collateralizationRatio).toBeCloseTo(total / capture.verification.hyusdSupply, 8);
    expect(result.metadata?.observedBlock).toEqual({ chain: "solana", number: capture.response.result.context.slot, timestamp: NOW_SEC });
    expect(result.metadata?.freshnessMode).toBe("not-applicable");
    expect(result.slices.map((slice) => slice.sourceKey)).toEqual(expect.arrayContaining(["lst", "cbbtc", "hype", "zec", "onyc"].map(sourceKey)));
    expect(result.slices.find((slice) => slice.sourceKey === "hylo-solana:usdc-pool")?.pct).toBeCloseTo((capture.verification.usdcAmount * quote("usd-coin") / total) * 100, 10);
    expect(result.metadata?.details?.usdcDustExcludedUsd).toBe(0);
    expect(result.warnings).toEqual([]);
    expect(result.metadata?.details?.liabilityReconciliationDelta).toBeCloseTo(22.212266, 6);
    expect(dependencyReserveSlices(result.slices, coin, NOW_SEC).slices).toContainEqual(expect.objectContaining({
      sourceKey: sourceKey("onyc"), name: "ONYC pool collateral", risk: "high", coinId: "onyc-onre", depType: "collateral",
    }));
  });

  it("quotes hyloSOL under its own on-chain mint identity", async () => {
    const hyloSol = p.lsts.find((lst) => lst.priceChain === "solana")!;
    const { result, network } = await run();
    expect(network.requests.some((request) => request.url.includes(`solana:${hyloSol.mint}`))).toBe(true);
    const breakdown = result.metadata?.details?.lstBreakdown as Array<{ mint: string; valueUsd: number }>;
    expect(breakdown.find((row) => row.mint === hyloSol.mint)?.valueUsd).toBeCloseTo(capture.verification.lsts[1].amount * quote(hyloSol.mint), 5);
  });

  it.each([true, false])("reviews inventory with ZEC paused=%s", async paused => {
    expect(p.exoPairs.map((pair) => pair.pool)).toEqual(["cbbtc", "hype", "zec", "onyc"].map(pool => `${pool}-pool`));
    expect(p.inactiveExoPairs).toEqual(capture.verification.inactive.map((pair) => pair.pair));
    edit(p.exoPairs[2].pair, data => {
      data[286] = 1;
      expect(data[286]).toBe(1);
      data[286] = paused ? 1 : 0;
    });
    const runResult = await run();
    const zec = runResult.result.slices.find((slice) => slice.sourceKey === "hylo-solana:zec-pool")!;
    expect(zec.pct).toBeGreaterThan(0);
    const admission = evaluateAdapterSnapshotAdmission(runResult, NOW_SEC);
    if (paused) expect(admission.reasons).toContain("degraded-snapshot");
    else {
      expect(runResult.result.warnings).toEqual([]);
      expect(admission.eligible).toBe(true);
    }
    const classification = buildReviewedReserveClassifications([zec], coin, NOW_SEC)[0];
    expect(classification.assetClass).toBe("cryptoasset");
    expect(classification.issuerOrObligorKey).toContain("Near One Omni Bridge");
    expect(coin.reserves?.map((slice) => slice.pct)).toEqual(capture.verification.rows.map((row) => row.pct));
  });

  it.each([
    [...p.exoPairs, p.exoPairs[0]],
    p.exoPairs.map((pair, i) => i === 2 ? { ...pair, pool: "unknown-pool" } : pair),
    p.exoPairs.map((pair, i) => i === 2 ? p.exoPairs[0] : pair),
  ].map(exoPairs => [exoPairs]))("rejects extra, unknown or duplicate pools", exoPairs => {
    expect(() => parseLiveReserveAdapterParams("hylo-solana", { ...p, exoPairs })).toThrow();
  });

  it.each([22.2, 50.01])("bounds liability excess %s", async gap => {
    edit(p.hyusdMint, data => data.writeBigUInt64LE(BigInt(Math.round((capture.verification.poolLiabilities - gap) * 1e6)), 36));
    if (gap > 50) await expect(run()).rejects.toThrow(/liabilities do not reconcile/);
    else await expect(run()).resolves.toBeDefined();
  });

  it("fails closed when a reviewed collateral quote is absent", async () => {
    await expect(run(hyloNetwork(false))).rejects.toThrow(/missing collateral price/);
  });

  it("retains composition but degrades paused state", async () => {
    mutatePinned(p.state, "420f0000000000f7000000000000000000", 8, 1);
    const { result } = await run();
    expect(result.metadata?.collateralizationRatio).toBeGreaterThan(1);
    expect(result.warnings).toContainEqual(expect.objectContaining({ code: "route-paused", effect: "degraded" }));
  });

  it.each([
    ["unknown LST", p.registry, "00ae7b4ffad4eccafcd141e9832caf10ad", 8, /unknown LST/],
    ["owner", p.state, "", 0, /owner mismatch|discriminator/],
    ["discriminator", p.state, "72a1a9d2ccaf95ae00", 0, /owner mismatch|discriminator/],
    ["oracle feed", p.exoPairs[0].pair, "788d24c871311cfce62df6c8b4a85fe1a6", 8, /oracle identity/],
  ] as const)("rejects %s mismatches", async (_kind, address, hex, offset, error) => {
    if (hex) mutatePinned(address, hex, offset, 0);
    else accounts[address].owner = TOKEN;
    await expect(run()).rejects.toThrow(error);
  });

  it("fails closed when an inactive exogenous pool becomes registered", async () => {
    accounts[p.inactiveExoPairs[0]] = accounts[p.exoPairs[0].pair];
    await expect(run()).rejects.toThrow(`Hylo unreviewed exogenous pair activated: ${p.inactiveExoPairs[0]}`);
  });

  it("rejects a registry changed between discovery and the atomic census", async () => {
    const network = hyloNetwork(true, (_rpc, requestIndex) => {
      if (requestIndex === 2) mutatePinned(p.registry, "4f9d1600000000140169cd88c074150b64", 8, 0);
    });
    await expect(run(network)).rejects.toThrow(/registry changed/);
  });

  it.each([403, "transport"])("names every census hop with final failure %s and no keys", async final => {
    const keyed = "https://solana-mainnet.g.alchemy.com/v2/private-key";
    const urls = [keyed, SOLANA_RPC_URL, "https://api.mainnet.solana.com", "https://solana-rpc.publicnode.com"];
    const error = await runAdapterWithFakeTimers(() => run({
      chains: { solana: keyed },
      json: Object.fromEntries(urls.map((url, i) => [url, i === 3 && final === "transport"
        ? () => { throw new Error("fetch failed"); } : { status: 403, body: "" }])),
    })).catch((error: Error) => error);
    expect(error).toBeInstanceOf(Error);
    const message = (error as Error).message;
    expect(message).toContain(`[${urls.map((url, i) => `${new URL(url).hostname}=${i === 3 ? final : 403}`).join(", ")}]`);
    expect(message).not.toContain("private-key");
    expect(classifyFailure("adapter-exception", message)).toBe(final === 403 ? "upstream-http" : "network");
  });

  it("preserves case-sensitive Solana price identity at the quote boundary", async () => {
    const address = p.lsts[1].priceAddress;
    const key = `solana:${address}`;
    const network = installAdapterNetwork({ json: {
      [`https://coins.llama.fi/prices/current/${key}`]: { coins: { [key]: { price: 111.21, timestamp: NOW_SEC, confidence: 1 } } },
    } });
    const { prices, warnings } = await fetchDefiLlamaPrices(
      [{ key: "hyloSOL", chain: "solana", address }], new AbortController().signal,
      { chainRpcs: network.chainRpcs, requestCache: new Map(), nowSec: NOW_SEC },
    );
    expect(prices.get("hyloSOL")).toBe(111.21);
    expect(warnings).toEqual([]);
  });
});
