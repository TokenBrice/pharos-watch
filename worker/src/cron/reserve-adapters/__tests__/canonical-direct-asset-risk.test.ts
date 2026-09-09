import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import {
  CANONICAL_RESERVE_ASSET_RISK_BY_SYMBOL,
  getCanonicalReserveAssetRisk,
} from "@shared/lib/reserve-asset-risk";
import type { ReserveRisk } from "@shared/types/reserves";
import { adaptBtcfi } from "../btcfi";
import { adaptCollateralPositions } from "../collateral-positions-api";
import { adaptFraxBalanceSheet, type FraxBalanceSheetResponse } from "../frax";
import { adaptMentoReserveComposition } from "../mento";
import { adaptUsdtbTransparency } from "../usdtb-transparency";
import type { AdapterResult } from "../types";
import {
  BTCFI_HANDLER_ROWS,
  BTCFI_MARKET_ROWS,
  COLLATERAL_POSITION_MIN_SLICE_PCT,
  COLLATERAL_POSITION_PRICES,
  COLLATERAL_POSITIONS_BY_ASSET,
  MENTO_RESERVE_COMPOSITION_PAYLOAD,
  USDTB_BACKING_AND_SUPPLY_PAYLOAD,
} from "./reserve-adapter-payloads.test-support";

/**
 * Direct-asset risk parity across reserve adapters.
 *
 * `shared/lib/reserve-asset-risk.ts` is the single registry for what a bare
 * reserve asset is worth risk-wise; every adapter below emits a slice for a
 * bare asset held in reserve. This suite runs the real adapters over their own
 * recorded payloads and checks each of those slices against the expectation
 * table, so an adapter that hardcodes a tier the registry no longer agrees
 * with (or silently stops emitting the asset) fails here.
 *
 * The table is literal on purpose: the registry-admission case below binds it
 * to the registry, so a registry retiering fails one obvious test instead of
 * quietly rewriting every adapter expectation.
 *
 * This file owns the adapter side of that parity, replacing the deleted
 * `shared/lib/__tests__/reserve-risk-consistency.test.ts`, which inferred
 * assets from curated slice prose through a keyword list and invoked no
 * adapter. The registry table itself stays owned by
 * `shared/lib/__tests__/reserve-asset-risk.test.ts`.
 */
const EXPECTED_DIRECT_ASSET_RISK = {
  ETH: "very-low",
  WETH: "very-low",
  AUSD: "low",
  BUIDL: "low",
  STETH: "low",
  USDC: "low",
  USDT: "low",
  USTB: "low",
  BTCB: "medium",
  CBBTC: "medium",
  WBTC: "medium",
  CELO: "high",
  // `Partial` keeps the table a subset of the registry's symbols while still
  // rejecting a symbol the registry does not carry.
} as const satisfies Partial<Record<keyof typeof CANONICAL_RESERVE_ASSET_RISK_BY_SYMBOL, ReserveRisk>>;

type CanonicalDirectAsset = keyof typeof EXPECTED_DIRECT_ASSET_RISK;

const FIXTURES_DIR = join(dirname(fileURLToPath(import.meta.url)), "fixtures");
const FRAX_BALANCE_SHEET_FIXTURE = JSON.parse(
  readFileSync(join(FIXTURES_DIR, "frax-balance-sheet.json"), "utf8"),
) as FraxBalanceSheetResponse;

/**
 * Slice label -> direct asset the label reports. Adapters label a reserve row
 * for a human, so the asset behind a row cannot be recovered from the label by
 * pattern matching (`ezETH (Renzo ETH LRT)` is not ETH); the mapping is stated
 * per adapter instead of guessed.
 */
function expectDirectAssetRiskParity(
  result: AdapterResult,
  sliceAssets: Readonly<Record<string, CanonicalDirectAsset>>,
): void {
  const riskBySliceName = new Map(result.slices.map((slice) => [slice.name, slice.risk]));
  const observed = Object.entries(sliceAssets).map(([sliceName, asset]) => ({
    asset,
    sliceName,
    // null instead of undefined: a dropped slice must fail as a missing risk,
    // never pass as an absent-key match.
    risk: riskBySliceName.get(sliceName) ?? null,
  }));

  expect(observed).toEqual(
    Object.entries(sliceAssets).map(([sliceName, asset]) => ({
      asset,
      sliceName,
      risk: EXPECTED_DIRECT_ASSET_RISK[asset],
    })),
  );
}

describe("reserve adapter direct-asset risk parity", () => {
  it("sources every expected direct-asset risk from the canonical registry", () => {
    const admitted = Object.fromEntries(
      Object.keys(EXPECTED_DIRECT_ASSET_RISK).map((symbol) => [
        symbol,
        getCanonicalReserveAssetRisk(symbol),
      ]),
    );

    expect(admitted).toEqual(EXPECTED_DIRECT_ASSET_RISK);
  });

  it("classifies the recorded frxUSD balance-sheet reserve assets canonically", () => {
    const result = adaptFraxBalanceSheet(FRAX_BALANCE_SHEET_FIXTURE);

    expectDirectAssetRiskParity(result, {
      "USTB (Superstate tokenized T-bills)": "USTB",
      "BUIDL (BlackRock tokenized T-bills)": "BUIDL",
      "USDC (Circle)": "USDC",
    });
  });

  it("classifies the Mento reserve mix canonically across every tier it holds", () => {
    const result = adaptMentoReserveComposition(MENTO_RESERVE_COMPOSITION_PAYLOAD);

    expectDirectAssetRiskParity(result, {
      CELO: "CELO",
      USDT: "USDT",
      USDC: "USDC",
      "AUSD (Agora Dollar)": "AUSD",
      "stETH (Lido staked ETH)": "STETH",
      // The payload holds WETH; the adapter reports it as ETH, which the
      // registry prices identically.
      ETH: "ETH",
    });
  });

  it("classifies the recorded USDtb backing report canonically", () => {
    const result = adaptUsdtbTransparency(USDTB_BACKING_AND_SUPPLY_PAYLOAD);

    expectDirectAssetRiskParity(result, {
      "BlackRock BUIDL (U.S. T-Bills, cash, repos)": "BUIDL",
    });
  });

  it("classifies each BTCFi wrapped-BTC handler canonically", () => {
    const result = adaptBtcfi(BTCFI_MARKET_ROWS, BTCFI_HANDLER_ROWS);

    expectDirectAssetRiskParity(result, {
      WBTC: "WBTC",
      BTCB: "BTCB",
      CBBTC: "CBBTC",
    });
  });

  it("infers canonical risk for collateral positions reported by symbol", () => {
    const result = adaptCollateralPositions(
      COLLATERAL_POSITIONS_BY_ASSET,
      COLLATERAL_POSITION_PRICES,
      COLLATERAL_POSITION_MIN_SLICE_PCT,
    );

    expectDirectAssetRiskParity(result, {
      "WBTC (Wrapped BTC)": "WBTC",
      "WETH (Wrapped Ether)": "WETH",
    });
  });
});
