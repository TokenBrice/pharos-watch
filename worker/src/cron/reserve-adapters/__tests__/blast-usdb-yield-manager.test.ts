import { describe, expect, it } from "vitest";
import type { StablecoinMeta } from "@shared/types/stablecoin-meta-schemas";
import { runAdapter, expectWarnings } from "./reserve-adapter.test-support";

const YIELD_MANAGER = "0xa230285d5683c74935ad14c446e137c8c8828438";
const USDB = "0x4300000000000000000000000000000000000003";
const TOTAL_VALUE_SELECTOR = "0xd4c3eea0";
const TOTAL_SUPPLY_SELECTOR = "0x18160ddd";
const DECIMALS_SELECTOR = "0x313ce567";
const NOW_SEC = 1_788_912_032;

// usdb-blast is frozen, so replay the adapter against its archived config.
const USDB_COIN = {
  id: "usdb-blast",
  name: "USDB Blast",
  symbol: "USDB",
  liveReservesConfig: {
    adapter: "blast-usdb-yield-manager",
    version: 1,
    semantics: "single-asset",
    breakerScope: "usdb-blast",
    inputs: { primary: { kind: "onchain-evm", chain: "ethereum", rpcMode: "public-rpc" } },
    params: {
      yieldManagerAddress: YIELD_MANAGER,
      supplyChain: "blast",
      supplyTokenAddress: USDB,
      rpcUrl: "https://ethereum-rpc.publicnode.com",
      supplyRpcUrl: "https://rpc.blast.io",
    },
  },
} as unknown as StablecoinMeta;

describe("fetchBlastUsdbYieldManagerReserves", () => {
  it("publishes the share price without a coverage claim when manager value falls below supply", async () => {
    const { result } = await runAdapter("blast-usdb-yield-manager", USDB_COIN, {
      network: {
        rpc: {
          [`ethereum:${YIELD_MANAGER}:${TOTAL_VALUE_SELECTOR}`]: 98n * 10n ** 18n,
          [`${USDB}:${TOTAL_SUPPLY_SELECTOR}`]: 100n * 10n ** 18n,
          [`${USDB}:${DECIMALS_SELECTOR}`]: 18n,
        },
      },
      nowSec: NOW_SEC,
    });

    expectWarnings(result, []);
    expect(result.metadata).not.toHaveProperty("collateralizationRatio");
    expect(result.metadata?.details?.sharePrice).toBeCloseTo(0.98, 6);
  });

  it("fails closed when supply decimals drift", async () => {
    await expect(runAdapter("blast-usdb-yield-manager", USDB_COIN, {
      network: {
        rpc: {
          [`ethereum:${YIELD_MANAGER}:${TOTAL_VALUE_SELECTOR}`]: 120n * 10n ** 18n,
          [`${USDB}:${TOTAL_SUPPLY_SELECTOR}`]: 100n * 10n ** 18n,
          [`${USDB}:${DECIMALS_SELECTOR}`]: 6n,
        },
      },
      nowSec: NOW_SEC,
    })).rejects.toThrow(/unexpected supply decimals/);
  });
});
