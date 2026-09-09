import { beforeEach, describe, expect, it, vi } from "vitest";
import type { StablecoinMeta } from "@shared/types/core";
import type { LiveReservesConfig } from "@shared/types/live-reserves";

vi.mock("../request", () => ({
  fetchJsonPostWithRetry: vi.fn(),
  fetchJsonWithRetry: vi.fn(),
}));

import { fetchJsonPostWithRetry } from "../request";
import { fetchXprAccountBalancesReserves } from "../xpr-account-balances";

const mockPost = vi.mocked(fetchJsonPostWithRetry);

const PRIMARY = "https://proton.greymass.com";
const FALLBACK = "https://proton.eosusa.io";

const coin: StablecoinMeta = {
  id: "xmd-metal-dollar",
  name: "Metal Dollar",
  symbol: "XMD",
  flags: {},
} as unknown as StablecoinMeta;

function config(overrides?: { fallbacks?: string[] }): LiveReservesConfig {
  return {
    adapter: "xpr-account-balances",
    version: 1,
    semantics: "collateral-mix",
    inputs: {
      primary: { kind: "http-json", url: PRIMARY },
      ...(overrides?.fallbacks
        ? { fallbacks: overrides.fallbacks.map((url) => ({ kind: "http-json" as const, url })) }
        : {}),
    },
    params: {
      treasuryAccount: "xmd.treasury",
      balanceCode: "xtokens",
      supplyCode: "xmd.token",
      supplySymbol: "XMD",
      slices: [
        { symbol: "XUSDC", name: "XUSDC (bridge-wrapped USDC) held by the xmd.treasury contract", risk: "low" },
        { symbol: "XPYUSD", name: "XPYUSD (bridge-wrapped PayPal USD) held by the xmd.treasury contract", risk: "low" },
      ],
      unknownSlice: { name: "Unmeasured xmd.treasury holdings", risk: "high" },
    },
  } as unknown as LiveReservesConfig;
}

interface InstallOptions {
  supply?: string;
  balances?: string[];
  headBlockNum?: number;
}

function installNodeReads(
  baseUrl: string,
  { supply = "3070109.941917 XMD", balances, headBlockNum = 402_559_039 }: InstallOptions = {},
): void {
  mockPost.mockImplementation(async (url: string, body: unknown) => {
    if (!url.startsWith(`${baseUrl}/v1/chain/`)) {
      throw new Error(`unexpected URL ${url}`);
    }
    const action = url.slice(`${baseUrl}/v1/chain/`.length);
    if (action === "get_info") {
      return {
        chain_id: "384da888112027f0321850a169f737c33e53b388aad48b5adace4bab97f437e0",
        head_block_num: headBlockNum,
        head_block_id: "17fe903fa43705791a284d80ef039e7e4a740a27971ee66d4b0fdaf2bf8b7503",
        head_block_time: "2026-09-09T15:59:18.500",
      };
    }
    if (action === "get_currency_stats") {
      return { XMD: { supply, max_supply: "0.000000 XMD", issuer: "xmd.treasury" } };
    }
    if (action === "get_currency_balance") {
      return balances ?? [
        "0.000005 XPAX",
        "2966476.041224 XUSDC",
        "0.000000 XBUSD",
        "0.000000 XTUSD",
        "0.000000 XUSDT",
        "3635.920021 XPYUSD",
      ];
    }
    throw new Error(`unexpected action ${action} with body ${JSON.stringify(body)}`);
  });
}

beforeEach(() => {
  vi.resetAllMocks();
});

describe("fetchXprAccountBalancesReserves", () => {
  it("publishes measured slices plus an explicit unknown remainder against supply", async () => {
    installNodeReads(PRIMARY);
    const result = await fetchXprAccountBalancesReserves(coin, config(), new AbortController().signal);

    expect(result.slices).toHaveLength(3);
    expect(result.slices[0]).toMatchObject({
      name: "XUSDC (bridge-wrapped USDC) held by the xmd.treasury contract",
      risk: "low",
      pct: expect.closeTo(96.62, 0.01),
    });
    expect(result.slices[1]).toMatchObject({
      name: "Unmeasured xmd.treasury holdings",
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

    expect(result.warnings).toEqual(expect.arrayContaining([
      expect.objectContaining({ code: "bridge-wrapper-unverified", effect: "info" }),
      expect.objectContaining({ code: "xpr-unmeasured-treasury", effect: "info" }),
    ]));
  });

  it("omits the unknown slice and exposure when measured holdings cover the full supply", async () => {
    installNodeReads(PRIMARY, {
      supply: "3000000.000000 XMD",
      balances: ["2990000.000000 XUSDC", "20000.000000 XPYUSD", "0.000005 XPAX"],
    });
    const result = await fetchXprAccountBalancesReserves(coin, config(), new AbortController().signal);

    expect(result.slices).toHaveLength(2);
    expect(result.slices.every((slice) => slice.name !== "Unmeasured xmd.treasury holdings")).toBe(true);
    expect(result.metadata?.unknownExposurePct).toBeUndefined();
    expect(result.metadata?.collateralizationRatio).toBeCloseTo(1.0033, 4);
    expect(result.warnings?.some((warning) => warning.code === "xpr-unmeasured-treasury")).toBe(false);
  });

  it("fails over to the next configured node and rethrows the last error when every node fails", async () => {
    mockPost.mockImplementation(async (url: string, body: unknown) => {
      if (url.startsWith(`${PRIMARY}/v1/chain/`)) throw new Error("HTTP 503 for POST");
      if (url.startsWith(`${FALLBACK}/v1/chain/`)) {
        if (url.endsWith("get_info")) {
          return {
            chain_id: "384da888112027f0321850a169f737c33e53b388aad48b5adace4bab97f437e0",
            head_block_num: 402_559_846,
            head_block_id: "17fe921dc85be25c",
            head_block_time: "2026-09-09T16:01:01.000",
          };
        }
        if (url.endsWith("get_currency_stats")) {
          return { XMD: { supply: "3070109.941917 XMD", max_supply: "0.000000 XMD", issuer: "xmd.treasury" } };
        }
        if (url.endsWith("get_currency_balance")) {
          return ["2966476.041224 XUSDC", "3635.920021 XPYUSD"];
        }
      }
      throw new Error(`unexpected URL ${url} body ${JSON.stringify(body)}`);
    });

    const result = await fetchXprAccountBalancesReserves(
      coin,
      config({ fallbacks: [FALLBACK] }),
      new AbortController().signal,
    );
    expect(result.metadata?.details).toMatchObject({ headBlockNum: 402_559_846 });
    expect(result.slices).toHaveLength(3);

    mockPost.mockRejectedValue(new Error("connection refused"));
    await expect(
      fetchXprAccountBalancesReserves(
        coin,
        config({ fallbacks: [FALLBACK] }),
        new AbortController().signal,
      ),
    ).rejects.toThrow("connection refused");
  });
});
