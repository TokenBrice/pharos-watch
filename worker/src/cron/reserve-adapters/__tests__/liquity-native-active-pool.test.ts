import type { StablecoinMeta } from "@shared/types/core";
import type { LiveReservesConfig } from "@shared/types/live-reserves";
import { afterEach, describe, expect, it, vi } from "vitest";
import { fetchLiquityNativeActivePoolReserves } from "../liquity-native-active-pool";
import { fetchOnchainRateBps, fetchOnchainUint256 } from "../helpers";

vi.mock("../helpers", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../helpers")>();
  const { makeOnchainCallersMock } = await import("./helpers/onchain-callers-mock");
  const fetchOnchainUint256 = vi.fn();
  return {
    ...actual,
    fetchOnchainRateBps: vi.fn(),
    fetchOnchainUint256,
    makeOnchainCallers: makeOnchainCallersMock({ uint256: fetchOnchainUint256 }),
  };
});

const ACTIVE_POOL = "0x3012C2fE1240e3754E5C200A0946bb0E07474876";
const PRICE_FEED = "0xc5aC5A8892230E0A3e1c473881A2de7353fFcA88";
const TROVE_MANAGER = "0x94AfB503dBca74aC3E4929BACEeDfCe19B93c193";
const BORROWER_OPERATIONS = "0x44b1bac67dDA612a41a58AAf779143B181dEe031";

const config: LiveReservesConfig = {
  adapter: "liquity-native-active-pool",
  version: 1,
  semantics: "collateral-mix",
  inputs: {
    primary: { kind: "onchain-evm", chain: "mezo", rpcMode: "public-rpc" },
  },
  params: {
    rpcUrl: "https://mainnet.mezo.public.validationcloud.io",
    activePoolAddress: ACTIVE_POOL,
    collateralLabel: "BTC collateral in Mezo ActivePool",
    collateralRisk: "medium",
    collateralDecimals: 18,
    debtSelector: "0x14a6bf0f",
    collateralBalanceSelector: "0x1529a639",
    priceFeedAddress: PRICE_FEED,
    priceSelector: "0x0fdb11cf",
    troveManagerAddress: TROVE_MANAGER,
    tcrSelector: "0xb82f263d",
    mcrSelector: "0x794e5724",
    borrowerOperationsAddress: BORROWER_OPERATIONS,
    redemptionRateSelector: "0x540385a3",
  },
};

afterEach(() => {
  vi.clearAllMocks();
});

describe("fetchLiquityNativeActivePoolReserves", () => {
  it("emits native active-pool collateral slices and bounded direct capacity", async () => {
    vi.mocked(fetchOnchainUint256).mockImplementation(async ({ contract, data }) => {
      if (contract === ACTIVE_POOL && data === "0x14a6bf0f") return 3_500_000n * 10n ** 18n;
      if (contract === ACTIVE_POOL && data === "0x1529a639") return 90n * 10n ** 18n;
      if (contract === PRICE_FEED && data === "0x0fdb11cf") return 65_000n * 10n ** 18n;
      if (contract === TROVE_MANAGER && data === "0x794e5724") return 110n * 10n ** 16n;
      if (contract === TROVE_MANAGER && data.startsWith("0xb82f263d")) return 167n * 10n ** 16n;
      return null;
    });
    vi.mocked(fetchOnchainRateBps).mockResolvedValue(75);

    const result = await fetchLiquityNativeActivePoolReserves(
      { id: "meusd-mezo" } as StablecoinMeta,
      config,
      AbortSignal.timeout(5_000),
    );

    expect(result.slices).toEqual([
      { name: "BTC collateral in Mezo ActivePool", pct: 100, risk: "medium" },
    ]);
    expect(result.warnings).toBeUndefined();
    expect(result.metadata).toMatchObject({
      totalDebtUsd: 3_500_000,
      totalReserveUsd: 5_850_000,
      immediateRedeemableUsd: 3_500_000,
      collateralizationRatio: 5_850_000 / 3_500_000,
      collateralPriceUsd: 65_000,
      totalCollateralRatio: 1.67,
      minimumCollateralRatio: 1.1,
      redemptionFeeBps: 75,
      redemption: {
        capacityUsd: 3_500_000,
        capacityKind: "live-direct-bounded",
        freshnessKind: "same-run-onchain",
        routeStatus: "open",
        routeStatusSource: "onchain",
        holderEligibility: "any-holder",
        settlementDelaySec: 0,
        feeBps: 75,
      },
      details: {
        debtRaw: "3500000000000000000000000",
        collateralRaw: "90000000000000000000",
      },
    });
    expect(fetchOnchainRateBps).toHaveBeenCalledWith(
      expect.objectContaining({ chain: "mezo" }),
      expect.objectContaining({ contract: BORROWER_OPERATIONS, selector: "0x540385a3", decimals: 18 }),
      expect.any(AbortSignal),
      undefined,
      "https://mainnet.mezo.public.validationcloud.io",
      undefined,
    );
  });
});
