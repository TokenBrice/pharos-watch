import { describe, expect, it } from "vitest";
import {
  LIVE_RESERVE_ADAPTER_DEFINITIONS,
  LiveReservesConfigSchema,
  parseLiveReserveAdapterParams,
  computeLiveReserveConfigFingerprint,
  isReserveSupplyAdmissionBootstrapAuthorized,
} from "../live-reserve-adapters";
import { getReserveDisplayBadgeKindForAdapter } from "../live-reserve-display";
import {
  LATE_MONTHLY_DISCLOSURE_SOURCE_MAX_AGE_SEC,
  baseLiveReserveConfigSchema,
} from "../live-reserve-adapters";

describe("baseLiveReserveConfigSchema", () => {
  it("accepts a non-empty breakerScope", () => {
    const result = baseLiveReserveConfigSchema.safeParse({
      version: 1,
      semantics: "collateral-mix",
      breakerScope: "my-scope",
    });
    expect(result.success).toBe(true);
  });

  it("accepts an omitted breakerScope", () => {
    const result = baseLiveReserveConfigSchema.safeParse({
      version: 1,
      semantics: "collateral-mix",
    });
    expect(result.success).toBe(true);
  });

  it("rejects an empty-string breakerScope", () => {
    const result = baseLiveReserveConfigSchema.safeParse({
      version: 1,
      semantics: "collateral-mix",
      breakerScope: "",
    });
    expect(result.success).toBe(false);
  });

  it("rejects non-absolute display URLs", () => {
    const result = baseLiveReserveConfigSchema.safeParse({
      version: 1,
      semantics: "collateral-mix",
      display: {
        url: "/reserve-dashboard",
      },
    });
    expect(result.success).toBe(false);
  });

  it("accepts an operator suspension with ISO dates and rejects malformed ones", () => {
    const base = { version: 1, semantics: "collateral-mix" };
    expect(
      baseLiveReserveConfigSchema.safeParse({
        ...base,
        suspended: { reason: "upstream moved to keyed access", since: "2026-08-19", reviewBy: "2026-09-19" },
      }).success,
    ).toBe(true);
    expect(
      baseLiveReserveConfigSchema.safeParse({
        ...base,
        suspended: { reason: "", since: "2026-08-19" },
      }).success,
    ).toBe(false);
    expect(
      baseLiveReserveConfigSchema.safeParse({
        ...base,
        suspended: { reason: "x", since: "next week" },
      }).success,
    ).toBe(false);
  });

  it("accepts the late-monthly disclosure source-age policy", () => {
    const result = baseLiveReserveConfigSchema.safeParse({
      version: 1,
      semantics: "attestation-mix",
      scoring: {
        maxSourceAgeSec: LATE_MONTHLY_DISCLOSURE_SOURCE_MAX_AGE_SEC,
      },
    });

    expect(result.success).toBe(true);
  });
});

describe("reserve-only supply bootstrap authorization", () => {
  const config = {
    adapter: "jpmorgan-nav" as const, version: 1, semantics: "single-asset" as const,
    inputs: { primary: { kind: "http-html" as const, url: "https://example.com/nav" } },
  };
  it("validates actual calendar dates and rejects unknown authorization fields", () => {
    for (const reviewBy of ["2026-02-30", "2026-13-01", "next week"]) {
      expect(LiveReservesConfigSchema.safeParse({ ...config, bootstrapForSupplyAdmission: { reviewBy } }).success).toBe(false);
    }
    expect(LiveReservesConfigSchema.safeParse({
      ...config, bootstrapForSupplyAdmission: { reviewBy: "2026-10-10", retry: true },
    }).success).toBe(false);
    expect(LiveReservesConfigSchema.safeParse({
      ...config, bootstrapForSupplyAdmission: { reviewBy: "2028-02-29" },
    }).success).toBe(true);
  });
  it("expires at UTC start and cannot reset consumed input identity", () => {
    const authorized = { ...config, bootstrapForSupplyAdmission: { reviewBy: "2026-10-10" } };
    expect(isReserveSupplyAdmissionBootstrapAuthorized(authorized, Date.parse("2026-10-09T23:59:59Z"))).toBe(true);
    expect(isReserveSupplyAdmissionBootstrapAuthorized(authorized, Date.parse("2026-10-10T00:00:00Z"))).toBe(false);
    expect(isReserveSupplyAdmissionBootstrapAuthorized(config, Date.parse("2026-10-08T00:00:00Z"))).toBe(false);
    expect(computeLiveReserveConfigFingerprint(authorized)).toBe(computeLiveReserveConfigFingerprint({
      ...authorized, bootstrapForSupplyAdmission: { reviewBy: "2026-11-10" },
    }));
  });
});

describe("LiveReservesConfigSchema URL validation", () => {
  it("allows source-age tightening but rejects widening the adapter cap", () => {
    const cap = LIVE_RESERVE_ADAPTER_DEFINITIONS.ethena.validation.maxSourceAgeSec;
    const config = {
      adapter: "ethena",
      version: 1,
      semantics: "collateral-mix",
      inputs: { primary: { kind: "http-json", url: "https://example.com/reserves" } },
    };
    expect(LiveReservesConfigSchema.safeParse(config).success).toBe(true);
    for (const maxSourceAgeSec of [cap - 1, cap]) {
      expect(LiveReservesConfigSchema.safeParse({
        ...config, scoring: { maxSourceAgeSec },
      }).success).toBe(true);
    }
    expect(LiveReservesConfigSchema.safeParse({
      ...config, scoring: { maxSourceAgeSec: cap + 1 },
    }).success).toBe(false);
  });

  it("rejects non-absolute input URLs", () => {
    const result = LiveReservesConfigSchema.safeParse({
      adapter: "accountable",
      version: 1,
      semantics: "protocol-reserve",
      inputs: {
        primary: { kind: "http-json", url: "/api/reserves" },
      },
    });

    expect(result.success).toBe(false);
  });

  it("rejects non-absolute URL params", () => {
    expect(() =>
      parseLiveReserveAdapterParams("btcfi", {
        handlersUrl: "/api/reserve-handlers",
      }),
    ).toThrow(/Invalid URL/);
  });

  it("accepts deliberate Mento CDP stablecoin params without widening to arbitrary strings", () => {
    expect(
      parseLiveReserveAdapterParams("mento", {
        cdpStablecoin: "GBPm",
      }),
    ).toEqual({ cdpStablecoin: "GBPm" });
    expect(() =>
      parseLiveReserveAdapterParams("mento", {
        cdpStablecoin: "XOFm",
      }),
    ).toThrow(/Invalid option/);
    expect(() =>
      parseLiveReserveAdapterParams("mento", {
        cdpStablecoin: "NOTm",
      }),
    ).toThrow(/Invalid option/);
  });

  it("accepts m0-wrapper-underlying additionalDeployments and rejects malformed entries", () => {
    const baseParams = {
      mode: "m-extension" as const,
      slice: { name: "M token", risk: "very-low" as const },
    };

    expect(
      parseLiveReserveAdapterParams("m0-wrapper-underlying", {
        ...baseParams,
        additionalDeployments: [{ chain: "fluent" }],
      }),
    ).toMatchObject({ additionalDeployments: [{ chain: "fluent" }] });

    expect(() =>
      parseLiveReserveAdapterParams("m0-wrapper-underlying", {
        ...baseParams,
        additionalDeployments: [],
      }),
    ).toThrow();

    expect(() =>
      parseLiveReserveAdapterParams("m0-wrapper-underlying", {
        ...baseParams,
        additionalDeployments: [{ chain: "fluent", rpcUrl: "/not-absolute" }],
      }),
    ).toThrow(/Invalid/);
  });

  it("validates the pinned FPI controller route configuration", () => {
    const valid = {
      controllerAddress: "0x2397321b301B80A1C0911d6f9ED4B6033d43cF51",
      fpiTokenAddress: "0x5ca135cb8527d76e932f34b5145575f9d8cbe08e",
      fraxTokenAddress: "0x853d955aCEf822Db058eb8505911ED77F175b99e",
      expectedControllerCodeHash: "0x8f8968ffbb928926343d4217667f094cc938f359e253ef25ff33ee7b85ec1132",
      expectedFraxPriceFeedAddress: "0xb9e1e3a9feff48998e45fa90847ed4d467e8bcfd",
      expectedFraxPriceFeedCodeHash: "0xbd6f524cdc4268b6bd1bb6f77a8821faeea9c52ee9e0afa0b6d948ce82c966c2",
      expectedFraxPriceFeedDecimals: 8,
      expectedFpiPriceFeedAddress: "0x59985d79e1e69f659f4ab97db07a35ce73d9174b",
      expectedFpiPriceFeedCodeHash: "0x2b165ff401e6d9ee29c0ef100b238ecb2fb7c89715104dde46b95547cea302fb",
      expectedFpiPriceFeedDecimals: 18,
      expectedCpiTrackerAddress: "0x66b7dff2ac66dc4d6fbb3db1cb627bbb01ff3146",
      expectedCpiTrackerCodeHash: "0xb989d68e59e9df4ef6d1782d56efe24f44bbb1d9e015c523c6e30adde9a7821d",
      maxPriceFeedAgeSec: 7_200,
      fullConfidenceCpiTrackerAgeSec: 62 * 86_400,
      maxCpiTrackerAgeSec: 366 * 86_400,
      expectedRedeemFeeE6: 3_000,
      outputTrackedAssetId: "frax-frax" as const,
      minOutputPriceUsd: 0.98,
      maxOutputPriceUsd: 1.02,
      sourceUrls: ["https://docs.frax.finance/frax-price-index/fpi-controller-pool"],
    };

    expect(parseLiveReserveAdapterParams("frax-fpi-collateral", valid)).toEqual(valid);
    expect(() =>
      parseLiveReserveAdapterParams("frax-fpi-collateral", {
        ...valid,
        controllerAddress: "not-an-address",
      }),
    ).toThrow();
    expect(() =>
      parseLiveReserveAdapterParams("frax-fpi-collateral", {
        ...valid,
        expectedControllerCodeHash: "0x1234",
      }),
    ).toThrow();
    expect(() =>
      parseLiveReserveAdapterParams("frax-fpi-collateral", {
        ...valid,
        minOutputPriceUsd: 1.03,
      }),
    ).toThrow(/minOutputPriceUsd/);
    expect(() =>
      parseLiveReserveAdapterParams("frax-fpi-collateral", {
        ...valid,
        fullConfidenceCpiTrackerAgeSec: valid.maxCpiTrackerAgeSec + 1,
      }),
    ).toThrow(/fullConfidenceCpiTrackerAgeSec/);
  });
});

describe("LiveReservesConfigSchema adapter policy validation", () => {

  it("classifies reviewed issuer feeds without changing their score-bearing evidence class", () => {
    const issuerAdapters = [
      "frax-balance-sheet",
      "frax-fpi-collateral",
      "makina-strategy",
      "tether-transparency",
      "usdai-proof-of-reserves",
    ] as const;

    for (const adapterKey of issuerAdapters) {
      expect(LIVE_RESERVE_ADAPTER_DEFINITIONS[adapterKey].sourceOriginClass).toBe("issuer-attested");
      expect(LIVE_RESERVE_ADAPTER_DEFINITIONS[adapterKey].evidenceClass).toBe("independent");
      expect(getReserveDisplayBadgeKindForAdapter(adapterKey)).toBe("proof");
    }
    expect(LIVE_RESERVE_ADAPTER_DEFINITIONS["3jane-usd3"].sourceOriginClass).toBe("unknown");
  });

  it("rejects unsupported adapter semantics", () => {
    const result = LiveReservesConfigSchema.safeParse({
      adapter: "chainlink-por",
      version: 3,
      semantics: "collateral-mix",
      inputs: {
        primary: { kind: "onchain-evm", chain: "ethereum", rpcMode: "public-rpc" },
      },
    });

    expect(result.success).toBe(false);
  });

  it("rejects unsupported adapter config versions", () => {
    const result = LiveReservesConfigSchema.safeParse({
      adapter: "accountable",
      version: 99,
      semantics: "protocol-reserve",
      inputs: {
        primary: { kind: "http-json", url: "https://example.com/reserves" },
      },
    });

    expect(result.success).toBe(false);
  });
});

describe("single-asset probe authoring boundaries", () => {
  const base = {
    adapter: "single-asset", version: 2, semantics: "single-asset",
    inputs: { primary: { kind: "onchain-evm", chain: "ethereum", rpcMode: "public-rpc" } },
    params: { label: "Configured reserve label", risk: "low" },
  };
  const probes = {
    reserveProbe: { kind: "json-path", path: ["reserves"] },
    supplyProbe: { kind: "json-path", path: ["supply"] },
    timestampProbe: { kind: "json-path", path: ["updatedAt"] },
    liabilityTimestampComponents: { path: ["chains"], identityField: "chain", timestampField: "lastSyncedAt", quantityField: "totalSupply" },
    reserveUnit: "CAD",
  };

  it("accepts a configured-chain v2 liveness label without HTTP probes and rejects v1", () => {
    expect(LiveReservesConfigSchema.safeParse(base).success).toBe(true);
    expect(LiveReservesConfigSchema.safeParse({ ...base, version: 1 }).success).toBe(false);
  });

  it.each(Array.from({ length: 31 }, (_, index) => index + 1))("rejects ignored onchain probe mask %s", (mask) => {
    const ignored = Object.fromEntries(Object.entries(probes).filter((_, index) => (mask & (1 << index)) !== 0));
    expect(LiveReservesConfigSchema.safeParse({ ...base, params: { ...base.params, ...ignored } }).success).toBe(false);
  });

  it("admits generic HTTP probes only under v2 and keeps the paired CAD lane diagnostic-only", () => {
    const http = { ...base, inputs: { primary: { kind: "http-json", url: "https://example.com/reserves" } } };
    const generic = { ...http, params: { ...base.params, reserveProbe: probes.reserveProbe } };
    expect(LiveReservesConfigSchema.safeParse(generic).success).toBe(true);
    expect(LiveReservesConfigSchema.safeParse({ ...generic, version: 1 }).success).toBe(false);
    const native = Object.fromEntries(Object.entries(probes).filter(([field]) => field !== "timestampProbe"));
    const config = { ...http, version: 2, params: { ...base.params, ...native } };
    expect(LiveReservesConfigSchema.safeParse(config).success).toBe(true);
    expect(LiveReservesConfigSchema.safeParse({ ...config, version: 1 }).success).toBe(false);
    expect(LiveReservesConfigSchema.safeParse({ ...config, params: { ...config.params, timestampProbe: probes.timestampProbe } }).success).toBe(false);
    expect(LiveReservesConfigSchema.safeParse({ ...config, params: { ...config.params, reserveUnit: "USD" } }).success).toBe(false);
    for (const field of Object.keys(native)) {
      const params = Object.fromEntries(Object.entries(config.params).filter(([key]) => key !== field));
      expect(LiveReservesConfigSchema.safeParse({ ...config, params }).success).toBe(false);
    }
  });
});

describe("identity-bound reserve reader configuration", () => {
  const input = { primary: { kind: "onchain-evm", chain: "ethereum", rpcMode: "public-rpc" } };
  const forestParams = {
    managerAddress: "0x8317736611b542ddb4a820fe344b621a904bdd48",
    managerImplementation: "0x99b4dfa4e1344273d5335bd90de1dea3a02b9c3a",
    usdcAddress: "0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48",
    tokenAddress: "0xcc07e7c4e5e35affd47b351e420a22c667d7f83d",
  };
  it("rejects legacy Spark RPC params and non-collateral semantics", () => {
    const config = { adapter: "spark-usdc-v1-inventory", version: 1, semantics: "collateral-mix", inputs: input };
    expect(LiveReservesConfigSchema.safeParse(config).success).toBe(true);
    expect(LiveReservesConfigSchema.safeParse({ ...config, params: { rpcUrl: "https://example.com" } }).success).toBe(false);
    expect(LiveReservesConfigSchema.safeParse({ ...config, semantics: "single-asset" }).success).toBe(false);
  });
  it("requires the complete exact Forest controller/accounting identity", () => {
    const config = { adapter: "forest-road-reserve-manager", version: 1, semantics: "collateral-mix", inputs: input, params: forestParams };
    expect(LiveReservesConfigSchema.safeParse(config).success).toBe(true);
    for (const field of Object.keys(forestParams)) {
      expect(LiveReservesConfigSchema.safeParse({ ...config, params: { ...forestParams, [field]: "0x1111111111111111111111111111111111111111" } }).success).toBe(false);
      expect(LiveReservesConfigSchema.safeParse({ ...config, params: Object.fromEntries(Object.entries(forestParams).filter(([key]) => key !== field)) }).success).toBe(false);
    }
  });
  it.each(["rpcUrl", "fallbackRpcUrl"])("requires HTTPS for Forest %s without changing other adapter policies", (field) => {
    const config = { adapter: "forest-road-reserve-manager", version: 1, semantics: "collateral-mix", inputs: input };
    expect(LiveReservesConfigSchema.safeParse({ ...config, params: { ...forestParams, [field]: "http://rpc.example.com" } }).success).toBe(false);
    expect(LiveReservesConfigSchema.safeParse({ ...config, params: { ...forestParams, [field]: "https://rpc.example.com" } }).success).toBe(true);
  });
});
