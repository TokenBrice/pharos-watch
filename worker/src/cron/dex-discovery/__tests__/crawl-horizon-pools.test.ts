import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ContractDeployment } from "@shared/types/core";
import {
  crawlHorizonPoolsStage,
  resetHorizonDiscoveryStateForTests,
} from "../crawl-horizon-pools";
import { createCrawlStageContext } from "../staged-pool";
import type { StagedPool } from "../types";
import { mockFetch } from "../../../test-helpers/__shared/mock-fetch";

const EURC_ADDRESS = "EURC-GDHU6WRG4IEQXM5NZ4BMPKOXHW76MZM4Y2IEMFDVXBSDP6SJY4ITNPP2";
const USDC_ADDRESS = "USDC-GA5ZSEJYB37JRC5AVCIA5MOP4RHTM335X2KGX3IHOJAPP5RE34K4KZVN";
const POOL_ID = "328306d8d623aa358415f29fca051afbbe8f0c591c28bbcb78e80907deffb2a7";

function target(chain = "stellar", address = EURC_ADDRESS): ContractDeployment {
  return { chain, address, decimals: 7 };
}

function payload(records: unknown[]) {
  return { _embedded: { records } };
}

function poolRow() {
  return {
    id: POOL_ID,
    fee_bp: 30,
    type: "constant_product",
    reserves: [
      {
        asset: "EURC:GDHU6WRG4IEQXM5NZ4BMPKOXHW76MZM4Y2IEMFDVXBSDP6SJY4ITNPP2",
        amount: "100.0000000",
      },
      {
        asset: "USDC:GA5ZSEJYB37JRC5AVCIA5MOP4RHTM335X2KGX3IHOJAPP5RE34K4KZVN",
        amount: "110.0000000",
      },
    ],
  };
}

function context(options?: { deadlineMs?: number; stablecoinId?: string }) {
  const pools: StagedPool[] = [];
  return {
    pools,
    value: createCrawlStageContext({
      stablecoinId: options?.stablecoinId ?? "eurc-circle",
      knownPoolIds: new Set(),
      nowSec: 1_800_000_000,
      pools,
      priceObs: [],
      deadlineMs: options?.deadlineMs,
      references: {
        rates: { peggedEUR: 1.1 },
        type: "fresh",
        updatedAt: 1_800_000_000,
      },
    }),
  };
}

describe("Horizon pool discovery", () => {
  beforeEach(() => {
    resetHorizonDiscoveryStateForTests();
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it("queries the canonical CODE:ISSUER filter and preserves Stellar identities", async () => {
    const expectedUrl = "https://horizon.stellar.org/liquidity_pools?reserves=EURC%3AGDHU6WRG4IEQXM5NZ4BMPKOXHW76MZM4Y2IEMFDVXBSDP6SJY4ITNPP2&limit=200";
    const fetchMock = mockFetch([{
      match: expectedUrl,
      body: payload([poolRow()]),
    }], { requireMatch: true, strictUrl: true });
    const stageContext = context();

    const result = await crawlHorizonPoolsStage({
      coinTargets: [target()],
      context: stageContext.value,
    });

    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(fetchMock.getHistory()[0]?.url).toBe(expectedUrl);
    expect(result).toEqual({
      providerChecks: [
        {
          chain: "stellar",
          address: EURC_ADDRESS,
          provider: "horizon",
          status: "success",
          observedPoolCount: 1,
        },
      ],
    });
    expect(stageContext.pools).toHaveLength(1);
    expect(stageContext.pools[0]).toMatchObject({
      poolId: `stellar:${POOL_ID}`,
      stablecoinId: "eurc-circle",
      source: "horizon",
      chain: "stellar",
      protocol: "stellar-sdex",
      dexId: "stellar-sdex",
      symbol: "EURC / USDC",
      tvlUsd: 220,
      priceUsd: 1.1,
      poolType: "stellar-constant-product",
      feeTier: 30,
      baseToken: EURC_ADDRESS,
      quoteToken: USDC_ADDRESS,
      quoteSymbol: "USDC",
    });
  });

  it("fails every queried target closed when Horizon returns a malformed payload", async () => {
    mockFetch([{
      match: "horizon.stellar.org/liquidity_pools",
      body: { _embedded: { records: null } },
    }], { requireMatch: true });
    const stageContext = context();

    const result = await crawlHorizonPoolsStage({
      coinTargets: [target()],
      context: stageContext.value,
    });

    expect(result.providerChecks).toEqual([
      {
        chain: "stellar",
        address: EURC_ADDRESS,
        provider: "horizon",
        status: "failure",
      },
    ]);
    expect(stageContext.pools).toEqual([]);
  });

  it("contains the stage timeout as a provider failure", async () => {
    vi.spyOn(console, "warn").mockImplementation(() => {});
    mockFetch([{
      match: "horizon.stellar.org/liquidity_pools",
      outcomes: [{ stall: true }],
    }], { requireMatch: true });
    const stageContext = context({ deadlineMs: Date.now() + 10 });

    const result = await crawlHorizonPoolsStage({
      coinTargets: [target()],
      context: stageContext.value,
    });

    expect(result.providerChecks).toEqual([
      {
        chain: "stellar",
        address: EURC_ADDRESS,
        provider: "horizon",
        status: "failure",
      },
    ]);
  });

  it("keeps contract-token ids explicit and outside invalid Horizon queries", async () => {
    const fetchMock = mockFetch([], { requireMatch: true });
    const stageContext = context();
    const contractToken = "CDWOB6T7SVSMMQN5V3P2OPTBAXOP7DAZHGVW3PYTZIKHVFKN6TBSXR6A";

    const result = await crawlHorizonPoolsStage({
      coinTargets: [target("stellar", contractToken), target("ethereum", "0xabc")],
      context: stageContext.value,
    });

    expect(fetchMock).not.toHaveBeenCalled();
    expect(result.providerChecks).toEqual([
      {
        chain: "stellar",
        address: contractToken,
        provider: "horizon",
        status: "degraded",
      },
    ]);
  });

  it("combines a bare issuer deployment with the tracked Stellar asset symbol", async () => {
    const stageContext = context({ stablecoinId: "eurcv-societe-generale-forge" });
    const issuer = "GCEYGIVOLAVBF2TG2RUSGTUJCIN75KEX3NGLMY4VPL4GFE5L355AXW3G";
    const fetchMock = mockFetch([{
      match: `reserves=EURCV%3A${issuer}`,
      body: payload([]),
    }], { requireMatch: true });

    const result = await crawlHorizonPoolsStage({
      coinTargets: [target("stellar", issuer)],
      context: stageContext.value,
    });

    expect(fetchMock.getHistory()[0]?.url).toContain(
      "reserves=EURCV%3AGCEYGIVOLAVBF2TG2RUSGTUJCIN75KEX3NGLMY4VPL4GFE5L355AXW3G",
    );
    expect(result.providerChecks).toEqual([
      {
        chain: "stellar",
        address: issuer,
        provider: "horizon",
        status: "success",
        observedPoolCount: 0,
      },
    ]);
  });
});
