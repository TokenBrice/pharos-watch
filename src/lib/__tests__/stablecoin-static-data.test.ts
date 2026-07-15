import { describe, expect, it } from "vitest";
import { DEAD_STABLECOINS } from "@shared/lib/dead-stablecoins";
import {
  ACTIVE_STABLECOINS,
  FROZEN_STABLECOINS,
  PRE_LAUNCH_STABLECOINS,
  TRACKED_STABLECOINS,
} from "@shared/lib/stablecoins/registry";
import {
  ACTIVE_STABLE_VALUE_INVESTMENTS,
  ACTIVE_VARIANT_STABLECOINS,
  CORE_AGGREGATE_ACTIVE_STABLECOINS,
} from "@shared/lib/stablecoins/aggregate-registry";
import { COMMAND_PALETTE_STABLECOINS } from "@/lib/command-palette-search-data";
import {
  ACTIVE_PEG_CURRENCIES,
  ACTIVE_PEG_CURRENCY_COUNT,
  ACTIVE_PEG_CURRENCY_COUNTS,
  ACTIVE_STABLECOIN_IDS,
  ACTIVE_STABLECOIN_COUNT,
  ACTIVE_STABLE_VALUE_INVESTMENT_COUNT,
  ACTIVE_VARIANT_STABLECOIN_COUNT,
  CORE_AGGREGATE_STABLECOIN_COUNT,
  DEAD_STABLECOIN_COUNT,
  FROZEN_STABLECOIN_COUNT,
  HOMEPAGE_TOP_ACTIVE_STABLECOINS,
  HOMEPAGE_TOP_CORE_STABLECOINS,
  PRE_LAUNCH_STABLECOIN_COUNT,
  TRACKED_STABLECOIN_COUNT,
  TRACKED_STABLECOIN_IDS,
} from "@/lib/stablecoin-static-data";

const PEG_ORDER = [
  "USD",
  "EUR",
  "GBP",
  "CHF",
  "BRL",
  "JPY",
  "KRW",
  "SGD",
  "MYR",
  "TRY",
  "AUD",
  "ZAR",
  "CAD",
  "PHP",
  "RUB",
  "CNY",
  "CNH",
  "MXN",
  "VND",
  "UAH",
  "ARS",
  "KGS",
  "NGN",
  "XOF",
  "IDR",
  "INR",
  "HKD",
  "GOLD",
  "SILVER",
  "VAR",
  "OTHER",
] as const;

describe("static stablecoin projections", () => {
  it("keeps count constants synced with the validated registries", () => {
    expect(TRACKED_STABLECOIN_COUNT).toBe(TRACKED_STABLECOINS.length);
    expect(ACTIVE_STABLECOIN_COUNT).toBe(ACTIVE_STABLECOINS.length);
    expect(CORE_AGGREGATE_STABLECOIN_COUNT).toBe(CORE_AGGREGATE_ACTIVE_STABLECOINS.length);
    expect(ACTIVE_VARIANT_STABLECOIN_COUNT).toBe(ACTIVE_VARIANT_STABLECOINS.length);
    expect(ACTIVE_STABLE_VALUE_INVESTMENT_COUNT).toBe(ACTIVE_STABLE_VALUE_INVESTMENTS.length);
    expect(PRE_LAUNCH_STABLECOIN_COUNT).toBe(PRE_LAUNCH_STABLECOINS.length);
    expect(FROZEN_STABLECOIN_COUNT).toBe(FROZEN_STABLECOINS.length);
    expect(DEAD_STABLECOIN_COUNT).toBe(DEAD_STABLECOINS.length);
  });

  it("keeps active peg counts synced with the active registry", () => {
    const pegCounts: Record<string, number> = {};

    for (const coin of ACTIVE_STABLECOINS) {
      pegCounts[coin.flags.pegCurrency] = (pegCounts[coin.flags.pegCurrency] ?? 0) + 1;
    }

    expect(ACTIVE_PEG_CURRENCIES).toEqual(PEG_ORDER.filter((peg) => pegCounts[peg] != null));
    expect(ACTIVE_PEG_CURRENCY_COUNT).toBe(ACTIVE_PEG_CURRENCIES.length);
    expect(ACTIVE_PEG_CURRENCY_COUNTS).toEqual(pegCounts);
  });

  it("keeps homepage IDs and top active schema rows in canonical order", () => {
    expect(TRACKED_STABLECOIN_IDS).toEqual(TRACKED_STABLECOINS.map((coin) => coin.id));
    expect(ACTIVE_STABLECOIN_IDS).toEqual(ACTIVE_STABLECOINS.map((coin) => coin.id));
    expect(HOMEPAGE_TOP_ACTIVE_STABLECOINS).toEqual(
      ACTIVE_STABLECOINS.slice(0, 20).map((coin) => ({
        id: coin.id,
        name: coin.name,
        symbol: coin.symbol,
      })),
    );
    expect(HOMEPAGE_TOP_CORE_STABLECOINS).toEqual(
      CORE_AGGREGATE_ACTIVE_STABLECOINS.slice(0, 20).map((coin) => ({
        id: coin.id,
        name: coin.name,
        symbol: coin.symbol,
      })),
    );
  });

  it("keeps command-palette search rows synced with tracked metadata", () => {
    const expected = TRACKED_STABLECOINS.map((coin) => {
      const row = [coin.id, coin.name, coin.symbol];
      if (coin.status != null && coin.status !== "active") {
        row.push(coin.status);
      }
      if (coin.status === "frozen" && coin.frozenAt) {
        row.push(coin.frozenAt);
      }
      return row;
    });

    expect(COMMAND_PALETTE_STABLECOINS).toEqual(expected);
  });
});
