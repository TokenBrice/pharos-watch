import { describe, expect, it } from "vitest";
import {
  expectWarnings,
  installAdapterNetwork,
  runAdapter,
  resolveAdapterCoin,
  type AdapterNetworkSpec,
} from "./reserve-adapter.test-support";

const PRIMARY = "https://proton.greymass.com";
const FALLBACK = "https://proton.eosusa.io";

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
    balances = [
      "0.000005 XPAX",
      "2966476.041224 XUSDC",
      "0.000000 XBUSD",
      "0.000000 XTUSD",
      "0.000000 XUSDT",
      "3635.920021 XPYUSD",
    ],
    headBlockNum = 402_559_039,
    headBlockId = "17fe903fa43705791a284d80ef039e7e4a740a27971ee66d4b0fdaf2bf8b7503",
    omitHeadBlockId = false,
    status,
  }: InstallOptions = {},
): AdapterNetworkSpec {
  if (status !== undefined) {
    const failure = { status, body: "upstream unavailable" };
    return {
      json: {
        [`${baseUrl}/v1/chain/get_info`]: failure,
        [`${baseUrl}/v1/chain/get_currency_stats`]: failure,
        [`${baseUrl}/v1/chain/get_currency_balance`]: failure,
      },
    };
  }
  return {
    json: {
      [`${baseUrl}/v1/chain/get_info`]: {
        chain_id: "384da888112027f0321850a169f737c33e53b388aad48b5adace4bab97f437e0",
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
  it("publishes measured slices plus an explicit unknown remainder against supply", async () => {
    const { result } = await runAdapter("xpr-account-balances", "xmd-metal-dollar", {
      network: xprNetwork(PRIMARY),
    });

    expect(result.slices).toHaveLength(3);
    expect(result.slices[0]).toMatchObject({
      name: "XUSDC (bridge-wrapped USDC) held by the xmd.treasury contract",
      risk: "low",
      pct: expect.closeTo(96.62, 0.01),
    });
    expect(result.slices[1]).toMatchObject({
      name: expect.stringContaining("Unmeasured xmd.treasury holdings"),
      risk: "high",
      pct: expect.closeTo(3.26, 0.01),
    });
    expect(result.slices[2]).toMatchObject({
      name: "XPYUSD (bridge-wrapped PayPal USD) held by the xmd.treasury contract",
      risk: "low",
      pct: expect.closeTo(0.12, 0.01),
    });
    for (const slice of result.slices) {
      expect(slice.coinId).toBeUndefined();
    }

    expect(result.metadata?.freshnessMode).toBe("not-applicable");
    expect(result.metadata?.supplyTokens).toBeCloseTo(3_070_109.941917, 4);
    expect(result.metadata?.totalReserveUsd).toBeCloseTo(2_970_111.961245, 4);
    expect(result.metadata?.collateralizationRatio).toBeCloseTo(0.9674, 4);
    expect(result.metadata?.unknownExposurePct).toBeCloseTo(3.26, 2);
    expect(result.metadata?.details).toMatchObject({
      headBlockNum: 402_559_039,
      headBlockId: "17fe903fa43705791a284d80ef039e7e4a740a27971ee66d4b0fdaf2bf8b7503",
      headBlockTime: "2026-09-09T15:59:18.500",
      treasuryAccount: "xmd.treasury",
    });
    expectWarnings(result, ["bridge-wrapper-unverified", "xpr-unmeasured-treasury"]);
  });

  it("omits the unknown slice and exposure when measured holdings cover the full supply", async () => {
    const { result } = await runAdapter("xpr-account-balances", "xmd-metal-dollar", {
      network: xprNetwork(PRIMARY, {
        supply: "3000000.000000 XMD",
        balances: ["2990000.000000 XUSDC", "20000.000000 XPYUSD", "0.000005 XPAX"],
      }),
    });

    expect(result.slices).toHaveLength(2);
    expect(result.slices.every((slice) => !slice.name.startsWith("Unmeasured xmd.treasury holdings"))).toBe(true);
    expect(result.metadata?.unknownExposurePct).toBeUndefined();
    expect(result.metadata?.collateralizationRatio).toBeCloseTo(1.0033, 4);
    expectWarnings(result, ["bridge-wrapper-unverified"]);
  });

  it("fails closed when the provider drops the head block identity", async () => {
    const { config } = resolveAdapterCoin("xpr-account-balances", "xmd-metal-dollar");
    const nodes = [config.inputs.primary, ...(config.inputs.fallbacks ?? [])]
      .filter((input) => input.kind === "http-json")
      .map((input) => input.url);
    await expect(runAdapter("xpr-account-balances", "xmd-metal-dollar", {
      network: {
        json: Object.fromEntries(
          nodes.flatMap((url) => Object.entries(xprNetwork(url, { omitHeadBlockId: true }).json ?? {})),
        ),
      },
      validate: false,
    })).rejects.toThrow("head_block_id");
  });

  it("fails over to the next configured node and rethrows the last error when every node fails", async () => {
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
    const { result } = await runAdapter("xpr-account-balances", "xmd-metal-dollar", {
      network,
      config: { inputs: TWO_NODE_INPUTS },
    });
    expect(result.metadata?.details).toMatchObject({ headBlockNum: 402_559_846 });
    expect(result.slices).toHaveLength(3);

    await expect(runAdapter("xpr-account-balances", "xmd-metal-dollar", {
      network: installAdapterNetwork({
        json: {
          ...xprNetwork(PRIMARY, { status: 503 }).json!,
          ...xprNetwork(FALLBACK, { status: 503 }).json!,
        },
      }),
      config: { inputs: TWO_NODE_INPUTS },
    })).rejects.toThrow("503");
  });
});
