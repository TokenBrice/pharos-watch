import { describe, expect, it } from "vitest";
import { installAdapterNetwork, runAdapter, type AdapterNetwork } from "./reserve-adapter.test-support";
import { adaptYouvesTezosState, type YouvesTezosState } from "../youves-tezos";

const TZKT_ORIGIN = "https://api.tzkt.io";
const LEVEL = 14873956;
const HEAD_TIME_ISO = "2026-09-09T19:13:46Z";
const HEAD_TIME_SEC = Math.floor(Date.parse(HEAD_TIME_ISO) / 1000);

const UUSD_TOKEN = "KT1XRPEPXbZK25r3Htzp2o1x7xdMMmfocKNW";
const USDT_TOKEN = "KT1XnTn74bUtxHfDtBmm2bGZAQfhPbvKWR8o";
const TZBTC_TOKEN = "KT1PWx2mnDueood7fEmfbBDKx1D9BAnnXitn";

// Captured 2026-09-09 from api.tzkt.io at the pinned level (vault sums
// reconciled against the engines' physical FA2 balances and per-vault KT1
// XTZ balances).
const ENGINES = [
  { address: "KT1DHndgk8ah1MLfciDnCV2zPJrVbnnAH9fd", vaults: 287297, balance: "630686217756", minted: "66073930427138008" },
  { address: "KT1FFE2LC5JpVakVjHm5mM36QVp2p3ZzH4hH", vaults: 7711, balance: "31859332915", minted: "2302624586144428" },
  { address: "KT1V9Rsc4ES3eeQTr4gEfJmNhVbeHrAZmMgC", vaults: 280575, balance: "161999584", minted: "34760119343917666" },
  { address: "KT1HxgqnVjGy7KsSUTEsQ6LgpD5iKSGu7QpA", vaults: 162771, balance: "1080190", minted: "78735584016815" },
  { address: "KT1XH5rKSd6Ae3DAMYi26gEZP1gxAoQRYRfS", vaults: 361056, balance: "69433", minted: "372183829" },
  { address: "KT1F1JMgh6SfqBCK6T6o7ggRTdeTLw91KKks", vaults: 303307, balance: "10486199", minted: "271188589690215833" },
  { address: "KT1FzcHaNhmpdYPNTgfb8frYXx7B5pvVyowu", vaults: 75205, balance: "624746", minted: "9336429618949925" },
  { address: "KT1JmfujyCYTw5krfu9bSn7YbLYuz2VbNaje", vaults: 251389, balance: "13408639257002", minted: "594949419807311242" },
];

const SUPPLY_RAW = "1089426064492673845";
const SIRS_ORACLE = "KT1GqQqgLji2T5QMfzoAXgDt9T7ur1LhqfpD";

const PRICES = {
  xtz: 0.26451934257566284,
  tzbtc: 78594.36340735995,
  usdt: 0.9998506038138302,
  uusd: 0.998109515196378,
};

function buildPayloadMap(): Map<string, unknown> {
  const map = new Map<string, unknown>();
  map.set(`${TZKT_ORIGIN}/v1/head`, { level: LEVEL, timestamp: HEAD_TIME_ISO });
  map.set(`${TZKT_ORIGIN}/v1/contracts/${UUSD_TOKEN}/storage?level=${LEVEL}`, { total_supply: 7709 });
  map.set(`${TZKT_ORIGIN}/v1/bigmaps/7709/keys?key=0&active=true&level=${LEVEL}`, [{ key: "0", value: SUPPLY_RAW }]);
  for (const engine of ENGINES) {
    map.set(`${TZKT_ORIGIN}/v1/contracts/${engine.address}/storage?level=${LEVEL}`, {
      token_contract: UUSD_TOKEN,
      total_supply: engine.minted,
      vault_contexts: engine.vaults,
    });
    map.set(
      `${TZKT_ORIGIN}/v1/bigmaps/${engine.vaults}/keys?active=true&level=${LEVEL}&limit=10000&offset=0`,
      [{ key: "tz1VwoDxLBarwvM7KZXJRem1DZmefdYKpstk", value: { balance: engine.balance, minted: engine.minted } }],
    );
  }
  map.set(`${TZKT_ORIGIN}/v1/contracts/${SIRS_ORACLE}/storage?level=${LEVEL}`, {
    lp_address: "KT1TxqZ8QtKvLu3V3JH7Gx58n7Co8pgtpQU5",
    last_update: HEAD_TIME_ISO,
    lp_token_address: "KT1AafHA1C1vk959wvHWBispY9Y2f3fxBUUo",
    lpt_total_supply: "25773660",
    value_token_address: "KT1PWx2mnDueood7fEmfbBDKx1D9BAnnXitn",
    value_token_balance_of: "1313504496",
  });
  return map;
}

function makeState(overrides: Partial<YouvesTezosState> = {}): YouvesTezosState {
  return {
    head: { level: LEVEL, timestamp: HEAD_TIME_ISO },
    supplyTokens: Number(BigInt(SUPPLY_RAW)) / 10 ** 12,
    engineMintedTokens: ENGINES.reduce((sum, engine) => sum + Number(BigInt(engine.minted)), 0) / 10 ** 12,
    engineRows: ENGINES.map((engine) => ({
      address: engine.address,
      generation: engine.address === "KT1JmfujyCYTw5krfu9bSn7YbLYuz2VbNaje" ? "current" as const : "legacy" as const,
      vaultCount: 1,
      collateralRaw: engine.balance,
      mintedRaw: engine.minted,
    })),
    collateralTokens: {
      xtz: Number(BigInt("630686217756") + BigInt("31859332915")) / 10 ** 6,
      tzbtc: Number(BigInt("161999584") + BigInt("1080190") + BigInt("69433")) / 10 ** 8,
      sirs: Number(BigInt("10486199") + BigInt("624746")),
      usdt: Number(BigInt("13408639257002")) / 10 ** 6,
    },
    sirsTzbtcRatio: 1313504496 / 25773660,
    prices: { ...PRICES },
    ...overrides,
  };
}
const DEFILLAMA_ASSETS = [
  "tezos:tezos",
  `tezos:${UUSD_TOKEN.toLowerCase()}`,
  `tezos:${TZBTC_TOKEN.toLowerCase()}`,
  `tezos:${USDT_TOKEN.toLowerCase()}`,
].sort();
const DEFILLAMA_ENDPOINT = `https://coins.llama.fi/prices/current/${DEFILLAMA_ASSETS.join(",")}`;

function installYouvesNetwork(
  payloads = buildPayloadMap(),
  prices: Partial<typeof PRICES> = PRICES,
): AdapterNetwork {
  const json: Record<string, unknown> = Object.fromEntries(payloads);
  const priceKeys: Record<keyof typeof PRICES, string> = {
    xtz: "tezos:tezos",
    tzbtc: `tezos:${TZBTC_TOKEN.toLowerCase()}`,
    usdt: `tezos:${USDT_TOKEN.toLowerCase()}`,
    uusd: `tezos:${UUSD_TOKEN.toLowerCase()}`,
  };
  json[DEFILLAMA_ENDPOINT] = {
    coins: Object.fromEntries(
      (Object.keys(priceKeys) as (keyof typeof PRICES)[])
        .filter((key) => prices[key] != null)
        .map((key) => [priceKeys[key], {
          price: prices[key],
          timestamp: HEAD_TIME_SEC,
          confidence: 1,
        }]),
    ),
  };
  return installAdapterNetwork({ json });
}


function expectedValues() {
  const xtzUsd = (662545550671 / 1e6) * PRICES.xtz;
  const tzbtcUsd = (163149207 / 1e8) * PRICES.tzbtc;
  const usdtUsd = 13408639.257002 * PRICES.usdt;
  const sirsUsd = 11110945 * (1313504496 / 25773660 / 1e8) * PRICES.tzbtc;
  const total = xtzUsd + tzbtcUsd + usdtUsd + sirsUsd;
  const supply = Number(BigInt(SUPPLY_RAW)) / 1e12;
  return { xtzUsd, tzbtcUsd, usdtUsd, sirsUsd, total, supply, liabilities: supply * PRICES.uusd };
}
describe("adaptYouvesTezosState", () => {
  it("publishes the four reviewed collateral slices with pinned-level metadata", () => {
    const result = adaptYouvesTezosState(makeState());
    const expected = expectedValues();

    expect(result.slices).toHaveLength(4);
    const bySourceKey = new Map(result.slices.map((slice) => [slice.sourceKey, slice]));
    expect(bySourceKey.get("youves-tezos:usdt")).toMatchObject({ name: "USDt (Tether on Tezos)", risk: "low" });
    expect(bySourceKey.get("youves-tezos:sirs")).toMatchObject({ name: "SIRS (XTZ/tzBTC LP tokens)", risk: "high" });
    expect(bySourceKey.get("youves-tezos:xtz")).toMatchObject({ name: "XTZ (Tezos)", risk: "high" });
    expect(bySourceKey.get("youves-tezos:tzbtc")).toMatchObject({ name: "tzBTC (wrapped Bitcoin)", risk: "medium" });
    expect(bySourceKey.get("youves-tezos:usdt")!.pct).toBeCloseTo((expected.usdtUsd / expected.total) * 100, 1);
    expect(bySourceKey.get("youves-tezos:xtz")!.pct).toBeCloseTo((expected.xtzUsd / expected.total) * 100, 1);
    expect(bySourceKey.get("youves-tezos:tzbtc")!.pct).toBeCloseTo((expected.tzbtcUsd / expected.total) * 100, 1);
    expect(bySourceKey.get("youves-tezos:sirs")!.pct).toBeCloseTo((expected.sirsUsd / expected.total) * 100, 1);
    expect(result.slices.reduce((sum, slice) => sum + slice.pct, 0)).toBeCloseTo(100, 6);

    expect(result.metadata).toMatchObject({
      freshnessMode: "not-applicable",
      observedBlock: { chain: "tezos", number: LEVEL, timestamp: HEAD_TIME_SEC },
      totalReserveUsd: expect.closeTo(expected.total, 2),
      totalLiabilitiesUsd: expect.closeTo(expected.liabilities, 2),
      supplyTokens: expect.closeTo(expected.supply, 6),
      supplyUsd: expect.closeTo(expected.liabilities, 2),
      collateralizationRatio: expect.closeTo(expected.total / expected.liabilities, 6),
      details: expect.objectContaining({
        proofKind: "youves-tezos-vault-census",
        chainId: "tezos",
        level: LEVEL,
        levelTimestampIso: HEAD_TIME_ISO,
      }),
    });
    const warnings = result.warnings ?? [];
    expect(warnings.find((warning) => warning.code === "xtz-vault-contract-custody")).toMatchObject({
      severity: "info",
      effect: "info",
    });
    expect(warnings.filter((warning) => warning.effect === "degraded")).toEqual([]);
  });

  it("degrades when the market-valued liability exceeds collateral", () => {
    const result = adaptYouvesTezosState(makeState({
      prices: { xtz: 0.0001, tzbtc: 0.001, usdt: 0.001, uusd: PRICES.uusd },
    }));

    const warning = result.warnings!.find((entry) => entry.code === "reserve-undercollateralized");
    expect(warning).toMatchObject({ severity: "warning", effect: "degraded" });
  });
});

describe("fetchYouvesTezosReserves", () => {
  it("reads head, storages, bigmaps and the SIRS oracle through the shared network boundary", async () => {
    const payloads = buildPayloadMap();
    const network = installYouvesNetwork(payloads);
    const { result } = await runAdapter("youves-tezos", "uusd-youves", {
      network,
      nowSec: HEAD_TIME_SEC,
    });

    expect(result.metadata).toMatchObject({ freshnessMode: "not-applicable" });
    expect(result.slices).toHaveLength(4);
    expect(network.requests.filter(({ url }) => url.startsWith(TZKT_ORIGIN)).length).toBe(20);
    expect(network.requests.some(({ url }) => url.startsWith("https://coins.llama.fi/prices/current/"))).toBe(true);
  });

  it("fails closed when an engine's token contract is not the uUSD token", async () => {
    const payloads = buildPayloadMap();
    const firstEngineUrl = `${TZKT_ORIGIN}/v1/contracts/${ENGINES[0]!.address}/storage?level=${LEVEL}`;
    payloads.set(firstEngineUrl, { token_contract: "KT1other", total_supply: ENGINES[0]!.minted, vault_contexts: ENGINES[0]!.vaults });

    await expect(runAdapter("youves-tezos", "uusd-youves", {
      network: installYouvesNetwork(payloads),
      nowSec: HEAD_TIME_SEC,
    })).rejects.toThrow("token_contract is KT1other");
  });

  it("fails closed when a material collateral price is missing", async () => {
    await expect(runAdapter("youves-tezos", "uusd-youves", {
      network: installYouvesNetwork(buildPayloadMap(), {
        tzbtc: PRICES.tzbtc,
        usdt: PRICES.usdt,
        uusd: PRICES.uusd,
      }),
      nowSec: HEAD_TIME_SEC,
    })).rejects.toThrow("no qualified DefiLlama price for xtz");
  });

  it("fails closed when token supply is below the engine minted sum", async () => {
    const payloads = buildPayloadMap();
    payloads.set(`${TZKT_ORIGIN}/v1/bigmaps/7709/keys?key=0&active=true&level=${LEVEL}`, [{ key: "0", value: "1" }]);

    await expect(runAdapter("youves-tezos", "uusd-youves", {
      network: installYouvesNetwork(payloads),
      nowSec: HEAD_TIME_SEC,
    })).rejects.toThrow("below the sum of engine total_supply");
  });

  it("fails closed when the SIRS LP oracle token pair does not match the reviewed pair", async () => {
    const payloads = buildPayloadMap();
    payloads.set(`${TZKT_ORIGIN}/v1/contracts/${SIRS_ORACLE}/storage?level=${LEVEL}`, {
      lp_token_address: "KT1otherA",
      value_token_address: "KT1otherB",
      value_token_balance_of: "1",
      lpt_total_supply: "1",
    });

    await expect(runAdapter("youves-tezos", "uusd-youves", {
      network: installYouvesNetwork(payloads),
      nowSec: HEAD_TIME_SEC,
    })).rejects.toThrow("SIRS LP oracle token addresses do not match");
  });

  it("propagates a TzKT failure", async () => {
    await expect(runAdapter("youves-tezos", "uusd-youves", {
      network: {
        json: {
          [`${TZKT_ORIGIN}/v1/head`]: { status: 503, body: "upstream unavailable" },
        },
      },
      nowSec: HEAD_TIME_SEC,
    })).rejects.toThrow("503");
  });
});
