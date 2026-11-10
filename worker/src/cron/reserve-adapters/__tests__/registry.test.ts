import { describe, expect, it } from "vitest";
import { LIVE_RESERVE_ADAPTER_KEYS } from "@shared/types/live-reserves";
import {
  LiveReservesConfigSchema,
  parseLiveReserveAdapterParams,
} from "@shared/lib/live-reserve-adapters";
import { ACTIVE_STABLECOINS, TRACKED_SOURCE_COINS } from "@shared/lib/stablecoins/registry";
import { LIVE_RESERVE_ADAPTER_FETCHERS } from "../index";

describe("adapter registry completeness", () => {

  it.each(LIVE_RESERVE_ADAPTER_KEYS)(
    "%s validates params through its registered schema",
    (key) => {
      const configs = ACTIVE_STABLECOINS.flatMap((coin) =>
        coin.liveReservesConfig?.adapter === key ? [coin.liveReservesConfig] : [],
      );
      for (const config of configs) {
        expect(parseLiveReserveAdapterParams(key, config.params)).toEqual(expect.any(Object));
      }
      // An array is invalid even for no-params adapters; missing schemas and
      // unrelated TypeErrors must not masquerade as schema validation, so the
      // message must open with "<key> adapter params invalid" followed by "."
      // or ":" — not merely contain the adapter name somewhere.
      let message: string | undefined;
      try {
        parseLiveReserveAdapterParams(key, [] as never);
      } catch (error) {
        message = error instanceof Error ? error.message : String(error);
      }
      const prefix = `${key} adapter params invalid`;
      expect(
        message !== undefined && message.startsWith(prefix) && /^[.:]/.test(message.slice(prefix.length)),
        `expected "${key} adapter params invalid." (or ": …") error, got: ${message}`,
      ).toBe(true);
    },
  );

  it("registers a callable fetcher for every adapter", () => {
    for (const [key, fetcher] of Object.entries(LIVE_RESERVE_ADAPTER_FETCHERS)) {
      expect(typeof fetcher, `${key} has no callable fetcher`).toBe("function");
    }
  });

  it("retires C17 executable keys without removing archives or static research", () => {
    for (const key of ["solomon-protocol", "usdh-native-markets", "abracadabra", "stoneyield-router-pool", "openeden-usdo", "usdy-holdings-report"]) {
      expect(Object.keys(LIVE_RESERVE_ADAPTER_FETCHERS)).not.toContain(key);
      expect([...LIVE_RESERVE_ADAPTER_KEYS]).not.toContain(key);
      expect(LiveReservesConfigSchema.safeParse({
        adapter: key, version: 1, semantics: "collateral-mix",
        inputs: { primary: { kind: "http-json", url: "https://example.com/reserves" } },
      }).success).toBe(false);
    }
    const coins = new Map(TRACKED_SOURCE_COINS.map((coin) => [coin.id, coin]));
    for (const id of ["usdv-solomon", "usdh-native-markets", "mim-abracadabra", "stusd-stoneyield", "usdo-openeden"]) {
      expect(coins.get(id)).toBeDefined();
      expect(coins.get(id)?.liveReservesConfig).toBeUndefined();
    }
  });

  it("LiveReservesConfigSchema rejects unsupported primary input kinds", () => {
    const parsed = LiveReservesConfigSchema.safeParse({
      adapter: "ethena",
      version: 1,
      semantics: "collateral-mix",
      inputs: {
        primary: { kind: "onchain-solana" },
      },
    });

    expect(parsed.success).toBe(false);
  });

  it("LiveReservesConfigSchema rejects unsupported fallback input kinds", () => {
    const parsed = LiveReservesConfigSchema.safeParse({
      adapter: "accountable",
      version: 1,
      semantics: "protocol-reserve",
      inputs: {
        primary: { kind: "http-json", url: "https://example.com/dashboard" },
        fallbacks: [{ kind: "http-html", url: "https://example.com/dashboard" }],
      },
    });

    expect(parsed.success).toBe(false);
  });

  it("rejects an address that is not a 20-byte EVM address", () => {
    expect(() =>
      parseLiveReserveAdapterParams("chainlink-nav", {
        navScope: "native-fund-share",
        oracleAddress: "0x123",
        tokenAddress: "0x6B175474E89094C44Da98b954EedeAC495271d0F",
        assetLabel: "USDC",
        assetRisk: "low",
      }),
    ).toThrow(/oracleAddress/);
  });

});
