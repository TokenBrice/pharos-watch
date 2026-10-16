import { describe, expect, it, vi } from "vitest";

vi.mock("@shared/lib/stablecoins/registry", async (importOriginal) => ({
  ...await importOriginal<typeof import("@shared/lib/stablecoins/registry")>(),
  TRACKED_META_BY_ID: new Map([
    ["susn-noon", { id: "susn-noon", symbol: "sUSN", flags: { pegCurrency: "USD", navToken: true } }],
    ["usn-noon", { id: "usn-noon", symbol: "USN", flags: { pegCurrency: "USD", navToken: false } }],
  ]),
}));

import { buildUniV3DirectMeasuredExecutionTargets } from "../../measured-execution/inventory";
import type { DexApiPool } from "../../../lib/dex-api-types";

// Uniswap v3 USN/sUSN 0.01% (Ethereum) shape: the tracked sUSN side is a
// navToken whose only market print is an untrusted single-source CoinGecko
// row, so the input leg must price from the guarded ERC-4626 NAV reference
// carried in the trusted map — or fail closed with no NAV (P5).
const SUSN_VAULT = "0xe24a3dc889621612422a64e6388927901608b91d";
const USN_TOKEN = "0x1c4a7a58b3e4d5f6a7b8c9d0e1f2a3b4c5d6e7f8";
const POOL = "0x5cba2738c4df481db7228e1545f29532ed0a2dee";
const NAV_PRICE = 1.2241;

const usnSusnPool: DexApiPool = {
  source: "uniswap-v3-shadow",
  chain: "ethereum",
  poolAddress: POOL,
  poolType: "concentrated",
  tokens: [
    { address: SUSN_VAULT, symbol: "sUSN", decimals: 18 },
    { address: USN_TOKEN, symbol: "USN", decimals: 18 },
  ],
  // pool.price feeds token1Price (token0Price = 1/price); 1.2199 keeps the
  // spot-implied output near the USN leg value.
  price: 1.2199,
  tvlUsd: 1_334_144,
  volume24hUsd: 11.74,
  feeRate: 0.0001,
  balances: null,
  tokenVolumes24h: [5, 5],
};

function chainAddressToId(): Map<string, string> {
  return new Map([
    [`ethereum:${SUSN_VAULT}`, "susn-noon"],
    [`ethereum:${USN_TOKEN}`, "usn-noon"],
  ]);
}

describe("navToken measured-execution input legs", () => {
  it("prices the sUSN input leg from the guarded NAV reference", () => {
    const targets = buildUniV3DirectMeasuredExecutionTargets({
      pools: [usnSusnPool],
      chainAddressToId: chainAddressToId(),
      symbolToChainScopedIds: new Map(),
      stablecoinPriceById: new Map([["susn-noon", NAV_PRICE]]),
      capturedAt: 1_790_140_597,
    });

    const susnTarget = [...targets.values()].find((target) => target.stablecoinId === "susn-noon");
    expect(susnTarget).toBeDefined();
    expect(susnTarget!.tokenIn.referencePriceUsd).toBe(NAV_PRICE);
    expect(susnTarget!.tokenIn.trackedAssetId).toBe("susn-noon");
    // The tracked USN output leg prices from its own peg-reference context
    // (1 for a USD peg); the pool-spot implied lane is only the fallback for
    // legs with no reference price at all.
    expect(susnTarget!.tokenOut.referencePriceUsd).toBe(1);
  });

  it("keeps the sUSN input leg unpriced when the guarded NAV is absent", () => {
    const targets = buildUniV3DirectMeasuredExecutionTargets({
      pools: [usnSusnPool],
      chainAddressToId: chainAddressToId(),
      symbolToChainScopedIds: new Map(),
      stablecoinPriceById: new Map(),
      capturedAt: 1_790_140_597,
    });

    expect([...targets.values()].find((target) => target.stablecoinId === "susn-noon")).toBeUndefined();
  });
});
