import { describe, expect, it } from "vitest";
import xmdReserves from "@shared/data/stablecoins/domains/reserves/xmd-metal-dollar.json";
import { buildReviewedReserveClassifications, type V9ExtensionRegistryMeta } from "../../../lib/safety-score-v9/extension";
import {
  expectWarnings,
  installAdapterNetwork,
  runAdapter,
  resolveAdapterCoin,
  type AdapterNetworkSpec,
} from "./reserve-adapter.test-support";

const ADAPTER = "xpr-account-balances";
const COIN = "xmd-metal-dollar";
const PRIMARY = "https://proton.greymass.com";
const FALLBACK = "https://proton.eosusa.io";
const CHAIN_ID = "384da888112027f0321850a169f737c33e53b388aad48b5adace4bab97f437e0";
const HEAD_ID = "17fe903fa43705791a284d80ef039e7e4a740a27971ee66d4b0fdaf2bf8b7503";

interface InstallOptions {
  supply?: string;
  balances?: string[];
  headBlockNum?: number;
  headBlockId?: string;
  omitHeadBlockId?: boolean;
  status?: number;
}

function xprNetwork(
  baseUrl: string,
  {
    supply = "3070109.941917 XMD",
    balances = ["0.000005 XPAX", "2966476.041224 XUSDC", "0.000000 XBUSD",
      "0.000000 XTUSD", "0.000000 XUSDT", "3635.920021 XPYUSD"],
    headBlockNum = 402_559_039,
    headBlockId = HEAD_ID,
    omitHeadBlockId = false,
    status,
  }: InstallOptions = {},
): AdapterNetworkSpec {
  if (status !== undefined) {
    const failure = { status, body: "upstream unavailable" };
    return { json: {
      [`${baseUrl}/v1/chain/get_info`]: failure,
      [`${baseUrl}/v1/chain/get_currency_stats`]: failure,
      [`${baseUrl}/v1/chain/get_currency_balance`]: failure,
    } };
  }
  return {
    json: {
      [`${baseUrl}/v1/chain/get_info`]: {
        chain_id: CHAIN_ID,
        head_block_num: headBlockNum,
        ...(omitHeadBlockId ? {} : { head_block_id: headBlockId }),
        head_block_time: "2026-09-09T15:59:18.500",
      },
      [`${baseUrl}/v1/chain/get_currency_stats`]: {
        XMD: { supply, max_supply: "0.000000 XMD", issuer: "xmd.treasury" },
      },
      [`${baseUrl}/v1/chain/get_currency_balance`]: balances,
    },
  };
}

const TWO_NODE_INPUTS = {
  primary: { kind: "http-json" as const, url: PRIMARY },
  fallbacks: [{ kind: "http-json" as const, url: FALLBACK }],
};

describe("fetchXprAccountBalancesReserves", () => {
  it("keeps measured weights, keyed metadata and unknown remainder", async () => {
    const { result } = await runAdapter(ADAPTER, COIN, { network: xprNetwork(PRIMARY) });

    expect(result.slices).toMatchObject([
      { name: xmdReserves.reserves[0]!.name, sourceKey: `xpr:${CHAIN_ID}:xtokens:xusdc`, risk: "low", pct: expect.closeTo(96.62, 0.01) },
      { name: expect.stringContaining("Unmeasured xmd.treasury holdings"), risk: "high", pct: expect.closeTo(3.26, 0.01) },
      { name: xmdReserves.reserves[2]!.name, sourceKey: `xpr:${CHAIN_ID}:xtokens:xpyusd`, risk: "low", pct: expect.closeTo(0.12, 0.01) },
    ]);
    const live = result.slices[2]!;
    const meta = xmdReserves as V9ExtensionRegistryMeta;
    const clock = Date.UTC(2026, 10, 6) / 1000;
    const classify = (row = live) => buildReviewedReserveClassifications([row], meta, clock)[0]!;
    expect(classify()).toMatchObject({
      issuerOrObligorKey: xmdReserves.reserves[2]!.issuerOrObligor,
      trackedAssetId: null, liquidityHorizon: "unknown",
    });
    expect(classify({ ...live, sourceKey: "xpr:other:xtokens:xpyusd" }).issuerOrObligorKey).toBeNull();
    expect(result.slices.every(row => !row.coinId)).toBe(true);
    expect(xmdReserves.reserves.map(row => row.pct)).toEqual([96.220617, 3.779383, 0]);

    expect(result.metadata).toMatchObject({
      freshnessMode: "not-applicable", supplyTokens: expect.closeTo(3_070_109.941917, 4),
      totalReserveUsd: expect.closeTo(2_970_111.961245, 4),
      collateralizationRatio: expect.closeTo(0.9674, 4), unknownExposurePct: expect.closeTo(3.26, 2),
      details: { headBlockNum: 402_559_039, headBlockId: HEAD_ID,
        headBlockTime: "2026-09-09T15:59:18.500", treasuryAccount: "xmd.treasury" },
    });
    expectWarnings(result, ["bridge-wrapper-unverified", "xpr-unmeasured-treasury"]);
  });

  it("omits unknowns when holdings cover supply", async () => {
    const { result } = await runAdapter(ADAPTER, COIN, {
      network: xprNetwork(PRIMARY, {
        supply: "3000000.000000 XMD",
        balances: ["2990000.000000 XUSDC", "20000.000000 XPYUSD", "0.000005 XPAX"],
      }),
    });

    expect(result.slices).toHaveLength(2);
    expect(result.slices.every(slice => !slice.name.startsWith("Unmeasured"))).toBe(true);
    expect(result.metadata?.unknownExposurePct).toBeUndefined();
    expect(result.metadata?.collateralizationRatio).toBeCloseTo(1.0033, 4);
    expectWarnings(result, ["bridge-wrapper-unverified"]);
  });

  it("rejects missing head block identity", async () => {
    const { config } = resolveAdapterCoin(ADAPTER, COIN);
    const nodes = [config.inputs.primary, ...(config.inputs.fallbacks ?? [])]
      .filter((input) => input.kind === "http-json")
      .map((input) => input.url);
    await expect(runAdapter(ADAPTER, COIN, {
      network: {
        json: Object.fromEntries(
          nodes.flatMap((url) => Object.entries(xprNetwork(url, { omitHeadBlockId: true }).json ?? {})),
        ),
      },
      validate: false,
    })).rejects.toThrow("head_block_id");
  });

  it("fails over and rethrows the last error when all nodes fail", async () => {
    const network = installAdapterNetwork({
      json: {
        ...xprNetwork(PRIMARY, { status: 503 }).json!,
        ...xprNetwork(FALLBACK, {
          headBlockNum: 402_559_846,
          headBlockId: "17fe921dc85be25c",
          balances: ["2966476.041224 XUSDC", "3635.920021 XPYUSD"],
        }).json!,
      },
    });
    const { result } = await runAdapter(ADAPTER, COIN, {
      network,
      config: { inputs: TWO_NODE_INPUTS },
    });
    expect(result.metadata?.details).toMatchObject({ headBlockNum: 402_559_846 });
    expect(result.slices).toHaveLength(3);

    await expect(runAdapter(ADAPTER, COIN, {
      network: { json: {
        ...xprNetwork(PRIMARY, { status: 503 }).json!,
        ...xprNetwork(FALLBACK, { status: 503 }).json!,
      } },
      config: { inputs: TWO_NODE_INPUTS },
    })).rejects.toThrow("503");
  });

  it("cancels without probing fallbacks", async () => {
    const controller = new AbortController();
    controller.abort(new Error("xpr adapter cancelled"));
    const network = installAdapterNetwork({
      json: {
        ...xprNetwork(PRIMARY).json!,
        ...xprNetwork(FALLBACK).json!,
      },
    });

    await expect(runAdapter(ADAPTER, COIN, {
      network,
      signal: controller.signal,
      config: { inputs: TWO_NODE_INPUTS },
    })).rejects.toThrow("xpr adapter cancelled");
    expect(network.requests.every((request) => !request.url.startsWith(FALLBACK))).toBe(true);
  });
});
