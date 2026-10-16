import { describe, expect, it } from "vitest";
import { LIVE_RESERVE_ADAPTER_KEYS } from "@shared/types/live-reserves";
import {
  LIVE_RESERVE_ADAPTER_DEFINITIONS,
  LiveReservesConfigSchema,
  parseLiveReserveAdapterParams,
} from "@shared/lib/live-reserve-adapters";
import { ACTIVE_STABLECOINS, TRACKED_SOURCE_COINS } from "@shared/lib/stablecoins/registry";
import { getReserveAdapter, LIVE_RESERVE_ADAPTER_FETCHERS } from "../index";

describe("adapter registry completeness", () => {

  it.each(LIVE_RESERVE_ADAPTER_KEYS)("%s has a worker adapter function registered", (key) => {
    const adapter = getReserveAdapter(key);
    expect(
      adapter,
      `getReserveAdapter("${key}") returned null — adapter not registered in worker/src/cron/reserve-adapters/index.ts`,
    ).not.toBeNull();
    expect(typeof adapter!.fetch).toBe("function");
    expect(adapter!.key).toBe(key);
  });

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

  it("worker fetcher keys match the shared adapter definitions exactly", () => {
    expect(Object.keys(LIVE_RESERVE_ADAPTER_FETCHERS).sort()).toEqual(
      Object.keys(LIVE_RESERVE_ADAPTER_DEFINITIONS).sort(),
    );
  });

  it("LIVE_RESERVE_ADAPTER_DEFINITIONS keys match LIVE_RESERVE_ADAPTER_KEYS exactly", () => {
    const definitionKeys = Object.keys(LIVE_RESERVE_ADAPTER_DEFINITIONS).sort();
    const canonicalKeys = [...LIVE_RESERVE_ADAPTER_KEYS].sort();
    expect(definitionKeys).toEqual(canonicalKeys);
  });

  it("retires C17 executable keys without removing archives, static research or replacement bindings", () => {
    for (const key of ["solomon-protocol", "usdh-native-markets", "abracadabra", "stoneyield-router-pool", "openeden-usdo", "usdy-holdings-report"]) {
      expect(Object.keys(LIVE_RESERVE_ADAPTER_FETCHERS)).not.toContain(key);
      expect([...LIVE_RESERVE_ADAPTER_KEYS]).not.toContain(key);
      expect(LiveReservesConfigSchema.safeParse({
        adapter: key, version: 1, semantics: "collateral-mix",
        inputs: { primary: { kind: "http-json", url: "https://example.com/reserves" } },
      }).success).toBe(false);
    }
    const coins = new Map(TRACKED_SOURCE_COINS.map((coin) => [coin.id, coin]));
    for (const id of ["usdv-solomon", "usdh-native-markets", "mim-abracadabra", "stusd-stoneyield", "usdo-openeden", "usdy-ondo-finance"]) {
      expect(coins.get(id)).toBeDefined();
      expect(coins.get(id)?.liveReservesConfig).toBeUndefined();
    }
    expect(coins.get("usdv-solomon-v2")?.liveReservesConfig?.adapter).toBe("solomon-chancery");
    expect(coins.get("cusdo-openeden")?.liveReservesConfig?.adapter).toBe("erc4626-single-asset");
    expect(coins.get("tbill-openeden")?.liveReservesConfig?.adapter).toBe("chainlink-nav");
    expect(coins.get("usdh-native-markets")?.status).toBe("frozen");
    expect(coins.get("mim-abracadabra")?.status).toBe("frozen");
  });

  it.each([
    ["attestation-pdf-index", "static-validated"],
    ["audd-independent-assurance", "static-validated"],
    ["issuer-attested-report", "static-validated"],
    ["zephyr-scanner", "weak-live-probe"],
    ["afi-proof", "weak-live-probe"],
    ["coinbase-oned-por", "weak-live-probe"],
    ["blackrock-brsrv-holdings", "weak-live-probe"],
  ] as const)("keeps permanent %s evidence in the non-independent %s tier", (key, evidenceClass) => {
    expect(LIVE_RESERVE_ADAPTER_DEFINITIONS[key].evidenceClass).toBe(evidenceClass);
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

  it("validates suspended live-reserve configs that the registry strips before every consumer", () => {
    const suspended = TRACKED_SOURCE_COINS.filter((coin) => coin.liveReservesConfig?.suspended);
    expect(
      suspended.length,
      "no suspended liveReservesConfig found; keep this test pointed at the pre-strip source catalog",
    ).toBeGreaterThan(0);

    for (const coin of suspended) {
      const parsed = LiveReservesConfigSchema.safeParse(coin.liveReservesConfig);
      expect(
        parsed.success,
        `${coin.id} is suspended but its liveReservesConfig no longer parses: ${
          parsed.success ? "" : JSON.stringify(parsed.error.issues[0])
        }`,
      ).toBe(true);
    }
  });

});
