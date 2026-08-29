import { afterEach, describe, expect, it, vi } from "vitest";
import type { ContractDeployment } from "@shared/types/core";
import { mockFetch } from "@shared/test-utils/mock-fetch";
import {
  AQUARIUS_TICKERS_URL,
  canonicalSorobanTokenId,
  crawlSorobanPoolsStage,
  isAquariusSorobanDeployment,
} from "../crawl-soroban-pools";
import { createCrawlStageContext } from "../staged-pool";
import type { StagedPool } from "../types";

const EURSAFO_TOKEN = "CBOOCGZSVRSZFRE4U2NWR2B4RXYVJWRCBTGOUD2JPI2TDJPWMTJX7FZP";
const EUTBL_TOKEN = "CBGV2QFQBBGEQRUKUMCPO3SZOHDDYO6SCP5CH6TW7EALKVHCXTMWDDOF";
const EUTBL_IDENTITY = `EUTBL-${EUTBL_TOKEN}`;
const QUOTE_TOKEN = "CAS3J7GYLGXMF6TDJBBYYSE3HQ6BBSMLNUQ34T6TZMYMW2EVH34XOWMA";
const POOL_ID = "CCY2PXGMKNQHO7WNYXEWX76L2C5BH3JUW3RCATGUYKY7QQTRILBZIFWV";

function target(address: string): ContractDeployment {
  return { chain: "stellar", address, decimals: 7 };
}

function makeContext(stablecoinId = "eutbl-spiko") {
  const pools: StagedPool[] = [];
  return {
    pools,
    value: createCrawlStageContext({
      stablecoinId,
      knownPoolIds: new Set(),
      nowSec: 1_800_000_000,
      pools,
      priceObs: [],
      references: { type: "fresh", updatedAt: 1_800_000_000, rates: {} },
    }),
  };
}

function ticker(overrides: Record<string, unknown> = {}) {
  return {
    pool_id: POOL_ID,
    base_currency: EUTBL_TOKEN,
    target_currency: QUOTE_TOKEN,
    ticker_id: `${EUTBL_TOKEN}_${QUOTE_TOKEN}`,
    base_volume: 10,
    target_volume: 20,
    last_price: 1.01,
    liquidity_in_usd: 12_345.67,
    ...overrides,
  };
}

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("Soroban Aquarius pool discovery", () => {
  it("canonicalizes raw and code-prefixed contract identities without accepting classic assets", () => {
    expect(canonicalSorobanTokenId(` ${EURSAFO_TOKEN} `)).toBe(EURSAFO_TOKEN);
    expect(canonicalSorobanTokenId(EUTBL_IDENTITY)).toBe(EUTBL_TOKEN);
    expect(canonicalSorobanTokenId("EUTBL-GAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAWHF")).toBeNull();
    expect(canonicalSorobanTokenId("EUTBL-CNOT-A-CONTRACT")).toBeNull();
    expect(isAquariusSorobanDeployment("stellar", EURSAFO_TOKEN)).toBe(true);
    expect(isAquariusSorobanDeployment("stellar", EUTBL_IDENTITY)).toBe(true);
    expect(isAquariusSorobanDeployment("ethereum", EURSAFO_TOKEN)).toBe(false);
    expect(
      isAquariusSorobanDeployment(
        "stellar",
        "CDE57N6XTUPBKYYDGQMXX7E7SLNOLFY3JEQB4MULSMR2AKTSAENGX2HC",
      ),
    ).toBe(false);
  });

  it("does not query unrelated Soroban contracts", async () => {
    const fetchMock = mockFetch([], { requireMatch: true, strictUrl: true });
    const stageContext = makeContext();

    const result = await crawlSorobanPoolsStage({
      coinTargets: [
        target("CDE57N6XTUPBKYYDGQMXX7E7SLNOLFY3JEQB4MULSMR2AKTSAENGX2HC"),
      ],
      context: stageContext.value,
    });

    expect(fetchMock).not.toHaveBeenCalled();
    expect(result).toEqual({ providerChecks: [] });
  });

  it("emits a successful empty census so the deployment can become verified_no_pools", async () => {
    const fetchMock = mockFetch(
      [{ match: AQUARIUS_TICKERS_URL, body: [] }],
      { requireMatch: true, strictUrl: true },
    );
    const stageContext = makeContext();

    const result = await crawlSorobanPoolsStage({
      coinTargets: [target(EUTBL_IDENTITY)],
      context: stageContext.value,
    });

    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(fetchMock.getHistory()[0]?.url).toBe(AQUARIUS_TICKERS_URL);
    expect(result).toEqual({
      providerChecks: [
        {
          chain: "stellar",
          address: EUTBL_IDENTITY,
          provider: "aquarius",
          status: "success",
          observedPoolCount: 0,
        },
      ],
    });
    expect(stageContext.pools).toEqual([]);
  });

  it("uses one bounded ticker fetch for all targets and preserves code-prefixed deployment identity", async () => {
    const fetchMock = mockFetch(
      [{ match: AQUARIUS_TICKERS_URL, body: [ticker()] }],
      { requireMatch: true, strictUrl: true },
    );
    const stageContext = makeContext();

    const result = await crawlSorobanPoolsStage({
      coinTargets: [target(EUTBL_IDENTITY), target(EURSAFO_TOKEN)],
      context: stageContext.value,
    });

    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(result.providerChecks).toEqual([
      {
        chain: "stellar",
        address: EUTBL_IDENTITY,
        provider: "aquarius",
        status: "success",
        observedPoolCount: 1,
      },
      {
        chain: "stellar",
        address: EURSAFO_TOKEN,
        provider: "aquarius",
        status: "success",
        observedPoolCount: 0,
      },
    ]);
    expect(stageContext.pools).toHaveLength(1);
    expect(stageContext.pools[0]).toMatchObject({
      poolId: `stellar:${POOL_ID}`,
      stablecoinId: "eutbl-spiko",
      source: "aquarius",
      chain: "stellar",
      protocol: "aquarius",
      dexId: "aquarius",
      symbol: `${EUTBL_TOKEN} / ${QUOTE_TOKEN}`,
      tvlUsd: 12_345.67,
      volume24h: null,
      qualityMultiplier: null,
      poolType: "soroban-amm-unclassified",
      feeTier: null,
      balanceRatio: null,
      isStable: null,
      baseToken: EUTBL_IDENTITY,
      quoteToken: QUOTE_TOKEN,
      quoteSymbol: null,
      priceUsd: null,
      lockedLiqPct: null,
      rawJson: JSON.stringify(ticker()),
    });
  });

  it("does not certify a verified-empty result when the index response is malformed", async () => {
    mockFetch(
      [{ match: AQUARIUS_TICKERS_URL, body: { results: [] } }],
      { requireMatch: true, strictUrl: true },
    );
    const stageContext = makeContext();

    const result = await crawlSorobanPoolsStage({
      coinTargets: [target(EUTBL_IDENTITY)],
      context: stageContext.value,
    });

    expect(result.providerChecks).toEqual([
      {
        chain: "stellar",
        address: EUTBL_IDENTITY,
        provider: "aquarius",
        status: "degraded",
      },
    ]);
    expect(stageContext.pools).toEqual([]);
  });

  it("marks an unavailable public index as retryable", async () => {
    mockFetch(
      [{ match: AQUARIUS_TICKERS_URL, outcomes: [new TypeError("network failed")] }],
      { requireMatch: true, strictUrl: true },
    );
    const stageContext = makeContext();

    const result = await crawlSorobanPoolsStage({
      coinTargets: [target(EUTBL_IDENTITY)],
      context: stageContext.value,
    });

    expect(result.providerChecks).toEqual([
      {
        chain: "stellar",
        address: EUTBL_IDENTITY,
        provider: "aquarius",
        status: "failure",
        retryable: true,
      },
    ]);
  });
});
