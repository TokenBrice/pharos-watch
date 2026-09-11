import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ACTIVE_META_BY_ID } from "@shared/lib/stablecoins/registry";
import { parseLiveReserveAdapterParams } from "@shared/lib/live-reserve-adapters";
import { fetchDefiLlamaPrices } from "../defillama";
import { runAdapter, installAdapterNetwork, type AdapterNetworkSpec } from "./reserve-adapter.test-support";

const coin = ACTIVE_META_BY_ID.get("hyusd-hylo")!;
const config = coin.liveReservesConfig!;
const p = parseLiveReserveAdapterParams("hylo-solana", config.params);
const TOKEN = "TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA";
const SOLANA_RPC_URL = "https://api.mainnet-beta.solana.com";
const NOW_SEC = 1_788_981_644;
// Captured 2026-09-09 by the verified Hylo exchange v2.0.5 census.
const recorded: Record<string, { owner: string; data: string }> = {
  "9cd2sAfbBvKs4SX9YKo4dcjwP3TgTVQ8dT5koshGcDND": {
    "owner": "HYEXCHtHkBagdStcJCp3xbbb9B7sdMdWXFNj6mdsG4hn",
    "data": "cqGp0syvla4AT1UHmALpfRGhuYtazRZ0YjHoUV5EmPnFh2dIq4otnwtQMCbSihAp/YD+P3jebEnurh5uk75mv4DfO/YHBKLEfCOU/86i2TyODRztHJWZ1Cw0Bj1d/6RpcxPo6rnUhZJDdzccdPhuoYvxf7FgM4RSqmP63KzVox+zrPVLpS6IrTmDTe+d0IP2jD/aTO2kACtvMlis10qT4iosQWntnRAi7zmk374DxOESGgHjNC0W5hVRxXU05puCnM+mTfQZgkb//v7//wAKAAAAAAAAAAoAAAAAAAAA/B4AAAAAAAAA/DIAAAAAAAAA/B4AAAAAAAAA/GQAAAAAAAAA/GQAAAAAAAAA/DIAAAAAAAAA/JABAAAAAAAA/AAAAAAAAAAA/CADAAAAAAAA/AcEAAAAAAAAMc4IMxTmAAD3BwQAAAAAAADXQFUuswwAAPocg6cyAQAAAPoQJwAAAAAAAPz0AQAAAAAAAPwAL2hZAAAAAPeCAAAAAAAAAP6AlpgAAAAAAPdbsRWwDdII6qyfKmvtWLaGyH3c9S5trfFYcCJDMhaezQoAAAAAAAAA/FmHGUDNDQAA+kBCDwAAAAAA90BCDwAAAAAA94CEHgAAAAAA90BCDwAAAAAA9wAAAAAAAAAAAAAAAAAAAAAAAAD6AAAAAAAAAAAAAAAAAA=="
  },
  "CMNPACEDebyvNJDgBxRc5fbScF8kmx52ZPBY4Cu4wuwS": {
    "owner": "HYEXCHtHkBagdStcJCp3xbbb9B7sdMdWXFNj6mdsG4hn",
    "data": "gmHCThb+iWv7/wAAAAAAAAAA/DwAAAAAAAAAQEIPAAAAAAD3cQkDAAAAAAD6AEBCDwAAAAAA9xQAAAAAAAAA/AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA="
  },
  "8Ri52tZXZehgAHKbx1MQiXhWXXkVsvAL9op6C5HytDKF": {
    "owner": "HYEXCHtHkBagdStcJCp3xbbb9B7sdMdWXFNj6mdsG4hn",
    "data": "fYfZl3rKijv80UHpgyyvEK2RdJXKDycbWyk81HAn6nNwB+1A6zmgvRbPd4gkDIWh2ASP/56KqzYAp1vdAnn6TLe4CoakezFkBIo+CMO0lb4X9FQn2JvsW4DH4mlcGGTXZ0PbOb7TRtYAekppTQAAAAD3BgQAAAAAAAAZXW1NAAAAAPcHBAAAAAAAAAcEAAAAAAAANwAAAAAAAAD7AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=="
  },
  "GMC2Q4ukPjiMjnhmxpZHDThQ4znC8oBAdveL62Tcu9rK": {
    "owner": "HYEXCHtHkBagdStcJCp3xbbb9B7sdMdWXFNj6mdsG4hn",
    "data": "fYfZl3rKijsKfpFBWJjH1BBj2zDYPTdpgClprYuV9PKWz5TQbMELUmBqVOxsL+/vwx1WdwlxYAOmt19tIpEX82by80+QdCVaCn6ROow9qEPTKpydY5mq/Jl4TGbdJ5BTL8kp6bbuT9MCHeP9PwAAAAD3BgQAAAAAAADjvgFAAAAAAPcHBAAAAAAAAAcEAAAAAAAANwAAAAAAAAD7AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=="
  },
  "8mgw2TsNxTMndWPyswLELw3V2tPrPvtqS7Ex9RyiGhML": {
    "owner": "HYEXCHtHkBagdStcJCp3xbbb9B7sdMdWXFNj6mdsG4hn",
    "data": "+/RItSh36DAJHnPRelUm1Ejlia6lr+fCLNYcW2aoakJ6smIwlRTlXPz//v+LiS02AgCwuDlL+x55st2kIkwZoNpG0wx4jSTIcTEc/OYt9si0qF/hpn20TcEt5dszD3rGa3LcZYr+3w9KQVtDCgAAAAAAAACAlpgAAAAAAPcAL2hZAAAAAPc8o1gxHwEAAPpwkwwAAAAAAPf0AQAAAAAAAPwHBAAAAAAAAOUV0QizDAAA+vIqhCUAAAAA+mQAAAAAAAAA/GQAAAAAAAAA/DIAAAAAAAAA/GQAAAAAAAAA/AAAAAAAAAAA/CADAAAAAAAA/ICEHgAAAAAA90BCDwAAAAAA90BCDwAAAAAA90BCDwAAAAAA9wAAAAAAAAAAAAAAgFPue6gKAPcAAAAAAAAAAPo5nwwAAAAAAPoAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA"
  },
  "42GzNWvZ1H1hwXaBZ8mbeVZaSEgh6zMm8BABdS3v1BEB": {
    "owner": "HYEXCHtHkBagdStcJCp3xbbb9B7sdMdWXFNj6mdsG4hn",
    "data": "+/RItSh36DB44X/5z57yixXj1YMnQezngE4H1cl/Qu8z7V8FnHSSX//9//+AIXzLk8y/ST8Kh93b6md8NwjaxnPKP20MvrzFvEAkzkJ54xzDabvML68CKzgrCA4yqOaJ/yD7xTDSpgPrbNmLCgAAAAAAAACAlpgAAAAAAPcAL2hZAAAAAPfwyttnuQAAAPpwkwwAAAAAAPf0AQAAAAAAAPwHBAAAAAAAAFo3BPWyDAAA+ovezBMAAAAA+mQAAAAAAAAA/GQAAAAAAAAA/DIAAAAAAAAA/GQAAAAAAAAA/AAAAAAAAAAA/CADAAAAAAAA/ICEHgAAAAAA90BCDwAAAAAA90BCDwAAAAAA90BCDwAAAAAA9wAAAAAAAAAAAAAAgMakfo0DAPcAAAAAAAAAAPpkgQEAAAAAAPoAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA"
  },
  "9Mb2Mt76AN7eNY3BBA4LgfTicARXhcEEokTBfsN47noK": {
    "owner": "AddressLookupTab1e1111111111111111111111111",
    "data": "AQAAAP//////////WU+dFgAAAAAUAWnNiMB0FQtklMaVOT9hGR98to0GEgjGFH5wkPphaCTxAAANBDFljpP/apwY8gaUU2ekGoC27LoRUQcy0DLwph5vlmUmk2/DtzpwFYES5EY5Np9gROoWxqoGOfba5fcpg9dsBoFO1Mr2ihdGcv2shgMaY+hOoV76HUS3IpP229sAFlDMnF+N5+EgkpirpvMKaO4vm5wcLf3TyXtSRlz+jUpjSg0IgERy3BXXOpxD7acpi/ZLbS3lt1ckqg+u2c8cQAZ4aNMDzpIbyxrlY3LMPVMqhKZ6NEFgcd9Jb3iFI7YqdJoGgGV2lsuN5uUx3Bj92Wd5XxoemQsw5hWYXIPPAXMiM678+Ajk+CVnlOhpwuu6Kks73yYQxpjb0B9ZJEB4GyM2DQhx9J0PlR6ssQXqGSZ1GGqm1a9G+Hx9Hk/OizLrBXLLj8UENvXZ54OizRjxb4E6e0UoXw2X3jsOXx48CM4YqQaAyg+ZgX3GhgjErFucpSKjOlkp8WvagkSkHAMWuQjt+93BmYN0cd2CoOqJ4u0brhV+SyXEEmexvknh4tyAigQLa9YmETQ6o3CIdbNtUsaqsT3yL3P6Ebt8UqzGVi3FytVKN71cAbirntajkERR+5VVGuAKU2Q2Q7YyB+IdD2dPBUXjZb7yca11NQNnVl2kDaM23ByHm7FUinr8xVqpOR4yUCjYdb0y7/GwkcY92xuOXqReqBAMECyBho9BTq8ZPm5WL3QM98oqt6jTukS2RARmqzuyUAA2ewCue0/61OzK/NFB6YMsrxCtkXSVyg8nG1spPNRwJ+pzcAftQOs5oL0Wz3eIJAyFodgEj/+eiqs2AKdb3QJ5+ky3uAqGpHsxZASKPgjDtJW+F/RUJ9ib7FuAx+JpXBhk12dD2zm+00bW5Atik5nrlbevCWIBmi8ZzukARwceQ9/A9zzw26a305wKfpFBWJjH1BBj2zDYPTdpgClprYuV9PKWz5TQbMELUmBqVOxsL+/vwx1WdwlxYAOmt19tIpEX82by80+QdCVaCn6ROow9qEPTKpydY5mq/Jl4TGbdJ5BTL8kp6bbuT9M="
  }
};
let accounts: Record<string, { owner: string; data: string }>;
function mutate(address: string, offset: number, byte: number) {
  const data = Buffer.from(accounts[address].data, "base64"); data[offset] = byte;
  accounts[address].data = data.toString("base64");
}
function spl(mint: string, vault: string, mintBytes: Uint8Array, amount: bigint, decimals: number) {
  const m = Buffer.alloc(82); m[44] = decimals; m[45] = 1;
  const v = Buffer.alloc(165); v.set(mintBytes); v.writeBigUInt64LE(amount, 64); v[108] = 1;
  accounts[mint] = { owner: TOKEN, data: m.toString("base64") };
  accounts[vault] = { owner: TOKEN, data: v.toString("base64") };
}
beforeEach(() => {
  accounts = structuredClone(recorded);
  const lut = Buffer.from(accounts[p.registry].data, "base64");
  spl(p.lsts[0].mint, "2Y3TLkdGoJwbdizxqrZmQwNLYJyGKTgzC4tbetbkvQ43", lut.subarray(600, 632), 181108150424626n, 9);
  spl(p.lsts[1].mint, "7VNBQCDKt4cxLWW51suV8a6VAYC4R66CfyySiYJek7Rj", lut.subarray(728, 760), 16500853647186n, 9);
  p.exoPairs.forEach((pair, i) => spl(pair.mint, pair.vault, Buffer.from(accounts[pair.pair].data, "base64").subarray(8, 40), [2747796223n, 14220170633907n][i], [8, 9][i]));
  const usdcBytes = Buffer.from("c6fa7af3bedbad3a3d65f36aabc97431b1bbe4c2d2f6e0e47ca60203452f5d61", "hex");
  spl(p.usdcMint, p.usdcVault, usdcBytes, 199025n, 6);
  const supply = Buffer.alloc(82); supply[44] = 6; supply[45] = 1; supply.writeBigUInt64LE(17204989688892n, 36);
  accounts[p.hyusdMint] = { owner: TOKEN, data: supply.toString("base64") };
});

afterEach(() => vi.unstubAllGlobals());

// DefiLlama's `solana:` namespace is keyed by mint address, case-sensitively: a
// case variant is a different key with no quote. Deriving each Solana fixture
// key from the on-chain mint keeps this mock honest, so a mis-keyed Solana
// price identity fails here instead of only in prod.
const lstPricesUsd = [134.27, 111.21];
const priceEntries = [
  ...p.lsts.map((lst, index) => ({
    chain: lst.priceChain,
    address: lst.priceChain === "solana" ? lst.mint : lst.priceAddress,
    price: lstPricesUsd[index],
  })),
  { chain: "coingecko", address: p.exoPairs[0].priceAddress, price: 78432.46 },
  { chain: "coingecko", address: p.exoPairs[1].priceAddress, price: 85.89 },
  { chain: "coingecko", address: "usd-coin", price: 1 },
];
const priceKey = ({ chain, address }: { chain: string; address: string }) =>
  `${chain}:${chain === "solana" ? address : address.toLowerCase()}`;
const PRICE_URL = `https://coins.llama.fi/prices/current/${priceEntries.map(priceKey).sort().join(",")}`;

function hyloNetwork(
  includePrices = true,
  onAccounts?: (rpc: { method: string; params: unknown[] }, requestIndex: number) => void,
): AdapterNetworkSpec {
  const coins = Object.fromEntries(priceEntries.map((entry) => [
    priceKey(entry),
    { price: entry.price, timestamp: NOW_SEC, confidence: 1 },
  ]));
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
            context: { slot: 445689101 },
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
    const total = 181108.150424626 * 134.27 + 16500.853647186 * 111.21 + 27.47796223 * 78432.46 + 14220.170633907 * 85.89 + 0.199025;
    expect(result.metadata?.totalCollateralUsd).toBeCloseTo(total, 5);
    expect(result.metadata?.collateralizationRatio).toBeCloseTo(total / 17204989.688892, 8);
    expect(result.metadata?.observedBlock).toEqual({ chain: "solana", number: 445689101, timestamp: NOW_SEC });
    expect(result.metadata?.freshnessMode).toBe("not-applicable");
    expect(result.slices.map((slice) => slice.sourceKey)).toEqual(expect.arrayContaining(["hylo-solana:lst-pool", "hylo-solana:cbbtc-pool", "hylo-solana:hype-pool"]));
    expect(result.slices.some((slice) => slice.sourceKey === "hylo-solana:usdc-pool")).toBe(false);
    expect(result.metadata?.details?.usdcDustExcludedUsd).toBe(0.199025);
    expect(result.warnings).toEqual([]);
  });

  it("quotes hyloSOL under its own on-chain mint identity", async () => {
    const hyloSol = p.lsts.find((lst) => lst.priceChain === "solana")!;
    const { result, network } = await run();
    // DefiLlama's `solana:` namespace is case-sensitive, so quoting a case
    // variant (the 2026-09-09 config) resolves no price and errors every run.
    expect(network.requests.some((request) => request.url.includes(`solana:${hyloSol.mint}`))).toBe(true);
    const breakdown = result.metadata?.details?.lstBreakdown as Array<{ mint: string; valueUsd: number }>;
    expect(breakdown.find((row) => row.mint === hyloSol.mint)?.valueUsd).toBeCloseTo(16500.853647186 * 111.21, 5);
  });

  it("fails closed when a reviewed collateral quote is absent", async () => {
    await expect(run(hyloNetwork(false))).rejects.toThrow(/missing collateral price/);
  });

  it("fails closed on an unknown registry LST", async () => {
    mutate(p.registry, 600, 0);
    await expect(run()).rejects.toThrow(/unknown LST/);
  });

  it("retains composition but degrades paused state", async () => {
    mutate(p.state, 478, 1);
    const { result } = await run();
    expect(result.metadata?.collateralizationRatio).toBeGreaterThan(1);
    expect(result.warnings).toContainEqual(expect.objectContaining({ code: "route-paused", effect: "degraded" }));
  });

  it.each(["owner", "discriminator"])("rejects %s mismatches", async (kind) => {
    if (kind === "owner") accounts[p.state].owner = TOKEN;
    else mutate(p.state, 0, 0);
    await expect(run()).rejects.toThrow(/owner mismatch|discriminator/);
  });

  it("fails closed when an inactive exogenous pool becomes registered", async () => {
    accounts[p.inactiveExoPairs[0]] = accounts[p.exoPairs[0].pair];
    await expect(run()).rejects.toThrow(/unreviewed exogenous/);
  });

  it("rejects substitution of an exogenous oracle feed", async () => {
    mutate(p.exoPairs[0].pair, 76, 0);
    await expect(run()).rejects.toThrow(/oracle identity/);
  });

  it("rejects a registry changed between discovery and the atomic census", async () => {
    const network = hyloNetwork(true, (_rpc, requestIndex) => {
      if (requestIndex === 2) mutate(p.registry, 21, 0);
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
    const prices = await fetchDefiLlamaPrices(
      [{ key: "hyloSOL", chain: "solana", address }],
      new AbortController().signal,
      { chainRpcs: network.chainRpcs, requestCache: new Map(), nowSec: NOW_SEC },
    );
    expect(prices.get("hyloSOL")).toBe(111.21);
  });
});
