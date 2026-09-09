import { describe, expect, it } from "vitest";
import { adaptIcpGldtState, type IcpGldtState } from "../icp-gldt";

const SWAP = "6f6ua-hqaaa-aaaar-qairq-cai";
const LEDGER = "6c7su-kiaaa-aaaar-qaira-cai";

const PARAMS = {
  swapCanisterId: SWAP,
  ledgerCanisterId: LEDGER,
  label: "Locked GLD NFTs representing physical gold bars in Swiss vaults",
  risk: "low" as const,
};

// The four GLD NFT denominations recorded by the census: 1g (85), 10g (26),
// 100g (6), 1000g (5) = 5,945 g locked, with each `division` expressed in
// 8-dp GLDT base units (100 GLDT per gram -> 10^10 base units per gram).
const SWAP_CONFIGS = [
  { canisterId: "io7gn-vyaaa-aaaak-qcbiq-cai", divisionBaseUnits: 10n ** 10n, swapFeeBaseUnits: 0n, ledgerId: LEDGER },
  { canisterId: "sy3ra-iqaaa-aaaao-aixda-cai", divisionBaseUnits: 10n ** 11n, swapFeeBaseUnits: 0n, ledgerId: LEDGER },
  { canisterId: "zhfjc-liaaa-aaaal-acgja-cai", divisionBaseUnits: 10n ** 12n, swapFeeBaseUnits: 0n, ledgerId: LEDGER },
  { canisterId: "7i7jl-6qaaa-aaaam-abjma-cai", divisionBaseUnits: 10n ** 13n, swapFeeBaseUnits: 0n, ledgerId: LEDGER },
];

const BALANCES = [85n, 26n, 6n, 5n];
// Recorded census supply: 594,499.7 GLDT in 8-dp base units.
const SUPPLY = 59_449_970_000_000n;

function state(overrides: Partial<IcpGldtState> = {}): IcpGldtState {
  return {
    swapConfigs: SWAP_CONFIGS,
    balances: BALANCES,
    supplyBaseUnits: SUPPLY,
    certifiedTimeNanos: 1_752_600_000_000_000_000n,
    ...overrides,
  };
}

describe("adaptIcpGldtState", () => {
  it("measures the recorded census of 5,945 locked grams against 594,499.7 GLDT", () => {
    const result = adaptIcpGldtState(state(), PARAMS);

    expect(result.slices).toEqual([
      { sourceKey: "icp-gldt:locked-gld-nft", name: PARAMS.label, pct: 100, risk: "low" },
    ]);
    expect(result.metadata?.freshnessMode).toBe("not-applicable");
    expect(result.metadata?.totalReserveQuantity).toBeCloseTo(5945, 6);
    expect(result.metadata?.supplyTokens).toBeCloseTo(594_499.7, 6);
    expect(result.metadata?.collateralizationRatio).toBeCloseTo(1.0000005, 6);
    expect(result.metadata?.details?.lockedGrams).toBeCloseTo(5945, 6);
    expect(result.metadata?.details?.supplyGrams).toBeCloseTo(5944.997, 6);
    expect(result.metadata?.details?.certifiedStateTimeSec).toBe(1_752_600_000);
    expect(result.warnings).toBeUndefined();
  });

  it("fails closed when a swap config targets a different ledger than the pinned one", () => {
    const mismatched = SWAP_CONFIGS.map((config, index) =>
      index === 2 ? { ...config, ledgerId: "tyyy3-4aaaa-aaaaq-aab7a-cai" } : config,
    );
    expect(() => adaptIcpGldtState(state({ swapConfigs: mismatched }), PARAMS)).toThrow(
      "targets ledger tyyy3-4aaaa-aaaaq-aab7a-cai",
    );
  });

  it("degrades when locked gold falls below the GLDT supply in gram terms", () => {
    const result = adaptIcpGldtState(
      state({ balances: [85n, 26n, 6n, 4n] }),
      PARAMS,
    );

    expect(result.warnings?.some((warning) => warning.code === "reserve-undercollateralized")).toBe(true);
    expect(result.metadata?.collateralizationRatio).toBeLessThan(0.995);
  });

  it("throws when no NFT canisters are reported", () => {
    expect(() => adaptIcpGldtState(state({ swapConfigs: [] }), PARAMS)).toThrow("no canister configs");
  });
});
