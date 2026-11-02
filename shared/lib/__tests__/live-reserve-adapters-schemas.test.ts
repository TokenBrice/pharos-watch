import { describe, expect, expectTypeOf, it } from "vitest";
import {
  LIVE_RESERVE_ADAPTER_DEFINITIONS,
  LiveReservesConfigSchema,
  parseLiveReserveAdapterParams,
  computeLiveReserveConfigFingerprint,
  isReserveSupplyAdmissionBootstrapAuthorized,
} from "../live-reserve-adapters";
import { getReserveDisplayBadgeKindForAdapter } from "../live-reserve-display";
import {
  baseLiveReserveConfigSchema,
  type BaseLiveReserveConfig,
  type LiveReserveInput,
} from "../../types/live-reserve-core";
import mxnt from "../../data/stablecoins/coins/mxnt-tether.json";
import usdfc from "../../data/stablecoins/coins/usdfc-secured-finance.json";
import meusd from "../../data/stablecoins/coins/meusd-mezo.json";
import frnt from "../../data/stablecoins/coins/frnt-wyoming.json";
import hchf from "../../data/stablecoins/coins/hchf-hedera-swiss-franc.json";
import { ReserveSyncStatusSchema, ReserveSyncStateViewSchema, type LiveReservesConfig } from "../../types/live-reserves";
import { AcceptedReserveGenerationSchema } from "../../types/accepted-reserve-generation";

expectTypeOf<Pick<LiveReservesConfig, keyof BaseLiveReserveConfig>>().toEqualTypeOf<BaseLiveReserveConfig>();
expectTypeOf<Extract<LiveReserveInput, { kind: "onchain-evm" }>>()
  .toEqualTypeOf<{ kind: "onchain-evm"; chain: string; rpcMode: "etherscan-proxy" | "alchemy" | "public-rpc" }>();

describe("reserve sync status admission", () => {
  it.each(["ok", "degraded", "error", "skipped", null, "running", "skipped_locked", "", 0])(
    "preserves wire admission for %j without accepting scheduler statuses", (status) => {
      const valid = status === "ok" || status === "degraded" || status === "error" || status === "skipped";
      expect(ReserveSyncStatusSchema.safeParse(status).success).toBe(valid);
      expect(ReserveSyncStateViewSchema.safeParse({ enabled: true, status, stale: false, bootstrap: false }).success).toBe(valid);
      const generation = {
        schemaVersion: 2, generationId: "reserve:1:queue",
        root: { scheduleKey: "fourHourlyReserveSync", slotStartedAt: 1, queueHash: "queue" },
        sealedBy: { attemptNo: 1, executionGeneration: 1, invocationId: "invocation" },
        producerCompletedAtSec: 2, contentSha256: "a".repeat(64),
        members: [{ stablecoinId: "coin", snapshot: null, latestAttempt: { attemptId: null, attemptedAt: null, status } }],
      };
      const parsed = AcceptedReserveGenerationSchema.safeParse(generation);
      expect(parsed.success).toBe(valid || status === null);
      if (parsed.success) expect(JSON.stringify(parsed.data)).toBe(JSON.stringify(generation));
    },
  );
});

describe("baseLiveReserveConfigSchema", () => {
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

  it("preserves legacy format-only suspension dates and strict nested fields", () => {
    const base = { version: 1, semantics: "collateral-mix" };
    const suspended = { reason: "legacy suspension", since: "2026-02-30", reviewBy: "2026-13-01" };
    expect(baseLiveReserveConfigSchema.parse({ ...base, suspended })).toEqual({ ...base, suspended });
    expect(baseLiveReserveConfigSchema.safeParse({ ...base, suspended: { ...suspended, extra: true } }).success).toBe(false);
    expect(baseLiveReserveConfigSchema.safeParse({ ...base, display: { url: "/relative" } }).success).toBe(false);
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
  it("classifies MXNT Tether telemetry as detail-only", () => {
    expect(LIVE_RESERVE_ADAPTER_DEFINITIONS["tether-transparency-mxnt"]).toMatchObject({
      sourceModel: "validated-static",
      evidenceClass: "static-validated",
      sourceOriginClass: "issuer-attested",
    });
    expect(getReserveDisplayBadgeKindForAdapter("tether-transparency-mxnt")).toBe("curated-validated");
    expect(LiveReservesConfigSchema.safeParse(mxnt.liveReservesConfig).success).toBe(true);
    const config = LiveReservesConfigSchema.parse(mxnt.liveReservesConfig);
    expect(computeLiveReserveConfigFingerprint(config)).not.toBe(
      computeLiveReserveConfigFingerprint({ ...config, adapter: "tether-transparency" }),
    );
    expect(() => parseLiveReserveAdapterParams("tether-transparency-mxnt", {
      currencyIso: "usdt", slices: [{ name: "Cash", pct: 100, risk: "very-low" }],
    })).toThrow();
  });

  it("declares native ActivePool fee telemetry without unsupported direct capacity", () => {
    expect(LIVE_RESERVE_ADAPTER_DEFINITIONS["liquity-native-active-pool"].redemptionTelemetry).toEqual({
      capacity: "none",
      fee: "current-bps",
    });
  });

  // Post-correctness baseline: compare whole effective descriptors, not a
  // nearest profile or partial capability match. Schema behavior also retains
  // the catalog-backed registry cases; params and paramsSchema must be aliases.
  const noTelemetry = { capacity: "none", fee: "none" };
  const directTelemetry = { capacity: "direct", fee: "none" };
  const latestState = { allowedFreshnessModes: ["not-applicable"] };
  const verified = { allowedFreshnessModes: ["verified"] };
  const dashboard = { maxSourceAgeSec: 259200, allowedFreshnessModes: ["verified", "unverified"] };
  const unknownLatest = { maxUnknownExposurePct: 5, ...latestState };
  const unknownDashboard = { ...dashboard, maxUnknownExposurePct: 5 };
  const onchain = { primaryInputKinds: ["onchain-evm"] };
  const singleBucket = { ...onchain, sourceModel: "single-bucket" };
  const config = (semantics: string, ...versions: number[]) => ({
    allowedSemantics: [semantics], allowedVersions: versions,
  });
  const issuerDashboard = {
    sourceOriginClass: "issuer-attested", preferredFreshnessMode: "verified", validation: dashboard,
  };
  const cdp = {
    sourceOriginClass: "onchain-observation", preferredFreshnessMode: "not-applicable", validation: unknownLatest,
  };
  const weakProbe = {
    sourceModel: "single-bucket", evidenceClass: "weak-live-probe", sourceOriginClass: "issuer-attested",
    displayBadgeKind: "proof", configValidation: config("single-asset", 1),
  };
  const descriptorBaseline = {
    "leverup-lvusd": {
      ...onchain, sourceOriginClass: "onchain-observation", preferredFreshnessMode: "not-applicable",
      provenance: {
        status: "active",
        rationale: "Bound to lvusd-leverup: reviewed LVUSD-only Monad vault census and pinned supply reconciliation exclude LVMON and MON staking, fail closed on registry or identity drift, and retain measured undercollateralization without allowlisting the deficit or inferring redemption capacity.",
      },
    },
    accountable: {
      preferredFreshnessMode: "verified",
      configValidation: { allowedSemantics: ["collateral-mix", "protocol-reserve"], allowedVersions: [1] },
      validation: { ...dashboard, maxSourceAgeSec: 1209600 },
    },
    "moc-v3-buckets": { ...onchain, sourceOriginClass: "onchain-observation", configValidation: config("collateral-mix", 2) },
    "bridge-transparency": issuerDashboard,
    "chronicle-nav": {
      ...singleBucket, sourceOriginClass: "independent-assurance",
      configValidation: config("single-asset", 1), validation: verified,
    },
    "chainlink-por": { ...singleBucket, configValidation: config("attestation-mix", 3), validation: verified },
    "ethena-whitelabel": {
      ...issuerDashboard, displayBadgeKind: "proof",
      configValidation: config("collateral-mix", 2), validation: unknownDashboard,
    },
    "parallelizer-balances": {
      ...onchain, configValidation: config("collateral-mix", 2),
      redemptionTelemetry: directTelemetry, validation: unknownLatest,
    },
    "xpr-account-balances": cdp,
    "kava-cdp": { ...cdp, configValidation: config("collateral-mix", 2) },
    "krwq-custodian": {
      sourceOriginClass: "onchain-observation", preferredFreshnessMode: "verified", validation: unknownDashboard,
    },
    "megausd-custody": {
      ...issuerDashboard,
      provenance: {
        status: "staged",
        rationale: "Issuer transparency JSON is geo-gated from Worker egress; it is retained only as MegaUSD roster discovery inside megausd-custody-onchain and no catalog coin binds this adapter.",
      },
    },
    "reserve-protocol-dtf": { ...onchain, preferredFreshnessMode: "not-applicable", redemptionTelemetry: directTelemetry },
    "superstate-liquidity": {
      ...singleBucket, preferredFreshnessMode: "verified", configValidation: config("single-asset", 1),
      redemptionTelemetry: directTelemetry, validation: { allowedFreshnessModes: ["verified", "unverified"] },
    },
    "tether-transparency": {
      ...issuerDashboard, displayBadgeKind: "proof", sharedSourceMode: "source-invariant",
      configValidation: config("attestation-mix", 1, 2), validation: { ...dashboard, maxSourceAgeSec: 604800 },
    },
    "usdai-proof-of-reserves": {
      sourceOriginClass: "issuer-attested", preferredFreshnessMode: "not-applicable", displayBadgeKind: "proof",
      configValidation: config("collateral-mix", 2),
      validation: { maxUnknownExposurePct: 5, maxSourceAgeSec: 604800, allowedFreshnessModes: ["not-applicable", "unverified"] },
    },
    "usd1-bundle-oracle": {
      ...singleBucket, configValidation: config("single-asset", 3), validation: { ...verified, maxSourceAgeSec: 604800 },
    },
    "usdtb-transparency": { preferredFreshnessMode: "verified", validation: dashboard },
    "youves-tezos": cdp,
    "dgld-gold-mapper": { ...weakProbe, validation: { ...verified, maxSourceAgeSec: 259200, maxUnknownExposurePct: 0 } },
    "afi-proof": {
      ...weakProbe, validation: { maxUnknownExposurePct: 100, allowedFreshnessModes: ["unverified"] },
      freshnessLimitation: "The AFI proof carries a generation timestamp, but proof generation does not establish the as-of dates of the underlying assets; ratio telemetry publishes as unverified.",
    },
    "coinbase-oned-por": {
      ...weakProbe, preferredFreshnessMode: "verified", validation: { ...verified, maxSourceAgeSec: 259200 },
      provenance: {
        status: "active",
        rationale: "Ordinary public persisted GraphQL GET verified200 on 2026-10-03; exact Base ONED stock and complete published USDC wallets reconcile. Source-controlled query hash/schema drift fail closed with stable machine reasons, without HTML/stale/partial fallback. This remains issuer-attested telemetry, not independent financial assurance or funded redemption capacity.",
      },
    },
  };
  it.each(Object.keys(descriptorBaseline) as (keyof typeof descriptorBaseline)[])(
    "preserves the complete resolved %s descriptor", (key) => {
      const { params, paramsSchema, ...descriptor } = LIVE_RESERVE_ADAPTER_DEFINITIONS[key];
      expect(params).toBe(paramsSchema);
      expect(paramsSchema.safeParse([]).success).toBe(false);
      expect(descriptor).toEqual({
        key, primaryInputKinds: ["http-json"], sourceModel: "dynamic-mix", evidenceClass: "independent",
        sourceOriginClass: "unknown", sharedSourceMode: "none", displayBadgeKind: "live",
        configValidation: config("collateral-mix", 1), redemptionTelemetry: noTelemetry, validation: latestState,
        provenance: { status: "active", rationale: "Bound by at least one active stablecoin liveReservesConfig." },
        ...descriptorBaseline[key],
      });
    },
  );

  it("keeps params-gated capacity explicit rather than inheriting ungated telemetry", () => {
    const definition = LIVE_RESERVE_ADAPTER_DEFINITIONS["chainlink-nav"];
    expect(definition.redemptionTelemetry).toEqual({ capacity: "direct", capacityParamsGated: true, fee: "none" });
    expect(LIVE_RESERVE_ADAPTER_DEFINITIONS["superstate-liquidity"].redemptionTelemetry).toEqual(directTelemetry);
    const address = "0x0000000000000000000000000000000000000001";
    const params = { navScope: "native-fund-share", oracleAddress: address, tokenAddress: address, assetLabel: "Fund", assetRisk: "low" };
    expect(parseLiveReserveAdapterParams("chainlink-nav", params)).not.toHaveProperty("redemptionCapacity");
    const redemptionCapacity = { managerAddress: address, usdcAddress: address, routerAddress: address, sourceAddress: address };
    expect(parseLiveReserveAdapterParams("chainlink-nav", { ...params, redemptionCapacity })).toEqual({ ...params, redemptionCapacity });
    expect(() => parseLiveReserveAdapterParams("chainlink-nav", { ...params, redemptionCapacity: {} })).toThrow();
  });

  it("admits both ERC-4626 config generations for the measured exposure cutover", () => {
    expect(LIVE_RESERVE_ADAPTER_DEFINITIONS["erc4626-single-asset"].configValidation.allowedVersions).toEqual([1, 2]);
  });

  it.each(["spark-usdc-v1-inventory", "forest-road-reserve-manager", "hliquity-hedera"] as const)(
    "requires a new config fingerprint for corrected %s reserve accounting",
    (adapterKey) => {
      expect(LIVE_RESERVE_ADAPTER_DEFINITIONS[adapterKey].configValidation.allowedVersions).toEqual([2]);
    },
  );

  it.each([usdfc, meusd, frnt, hchf])("invalidates retained pre-correction snapshots for $id", (coin) => {
    const config = LiveReservesConfigSchema.parse(coin.liveReservesConfig);
    expect(config.version).toBe(2);
    const previous = { ...config, version: 1 };
    expect(LiveReservesConfigSchema.safeParse(previous).success).toBe(false);
    expect(computeLiveReserveConfigFingerprint(config)).not.toBe(computeLiveReserveConfigFingerprint(previous));
  });

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
    const config = { adapter: "spark-usdc-v1-inventory", version: 2, semantics: "collateral-mix", inputs: input };
    expect(LiveReservesConfigSchema.safeParse(config).success).toBe(true);
    expect(LiveReservesConfigSchema.safeParse({ ...config, params: { rpcUrl: "https://example.com" } }).success).toBe(false);
    expect(LiveReservesConfigSchema.safeParse({ ...config, semantics: "single-asset" }).success).toBe(false);
  });
  it("requires the complete exact Forest controller/accounting identity", () => {
    const config = { adapter: "forest-road-reserve-manager", version: 2, semantics: "collateral-mix", inputs: input, params: forestParams };
    expect(LiveReservesConfigSchema.safeParse(config).success).toBe(true);
    for (const field of Object.keys(forestParams)) {
      expect(LiveReservesConfigSchema.safeParse({ ...config, params: { ...forestParams, [field]: "0x1111111111111111111111111111111111111111" } }).success).toBe(false);
      expect(LiveReservesConfigSchema.safeParse({ ...config, params: Object.fromEntries(Object.entries(forestParams).filter(([key]) => key !== field)) }).success).toBe(false);
    }
  });
  it.each(["rpcUrl", "fallbackRpcUrl"])("requires HTTPS for Forest %s without changing other adapter policies", (field) => {
    const config = { adapter: "forest-road-reserve-manager", version: 2, semantics: "collateral-mix", inputs: input };
    expect(LiveReservesConfigSchema.safeParse({ ...config, params: { ...forestParams, [field]: "http://rpc.example.com" } }).success).toBe(false);
    expect(LiveReservesConfigSchema.safeParse({ ...config, params: { ...forestParams, [field]: "https://rpc.example.com" } }).success).toBe(true);
  });
});
