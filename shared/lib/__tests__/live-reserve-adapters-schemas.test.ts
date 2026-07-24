/* eslint-disable security/detect-non-literal-fs-filename -- tests read checked-in stablecoin JSON from the repository root only. */
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { ACTIVE_STABLECOINS } from "../stablecoins/registry";
import {
  LIVE_RESERVE_ADAPTER_DESCRIPTORS,
  LIVE_RESERVE_ADAPTER_PROVENANCE,
  LIVE_RESERVE_ADAPTER_SOURCE_ORIGIN_CLASSES,
  LiveReservesConfigSchema,
  parseLiveReserveAdapterParams,
} from "../live-reserve-adapters";
import { getReserveDisplayBadgeKindForAdapter } from "../live-reserve-display";
import { LIVE_RESERVE_ADAPTER_KEYS } from "../../types/live-reserves";
import { LIVE_RESERVE_ADAPTER_DEFINITIONS } from "../live-reserve-adapters-definitions";
import { ReserveEvidenceSourceOriginClassSchema } from "../report-card-evidence-journal";
import {
  LATE_MONTHLY_DISCLOSURE_SOURCE_MAX_AGE_SEC,
  LIVE_RESERVE_ADAPTER_PRIMARY_INPUT_KINDS,
  adapterParamsSchemas,
  baseLiveReserveConfigSchema,
  liveReserveAdapterSchemaMetadata,
} from "../live-reserve-adapters-schemas";

const LATE_MONTHLY_SOURCE_AGE_IDS = [
  "audm-mento",
  "bib01-backed",
  "brlm-mento",
  "btcusd-btcfi",
  "cadm-mento",
  "ceur-celo",
  "chfm-mento",
  "copm-mento",
  "cusd-celo",
  "deuro-deuro",
  "fdusd-first-digital",
  "gbpm-mento",
  "ghsm-mento",
  "iusd-infinifi",
  "jpym-mento",
  "kesm-mento",
  "srusd-reservoir",
  "usdy-ondo-finance",
  "uty-xsy",
  "wsrusd-reservoir",
  "xsgd-straitsx",
  "zarm-mento",
  "zchf-frankencoin",
] as const;

const COIN_SOURCE_DIR = join(process.cwd(), "shared/data/stablecoins/coins");

function readCoinSource(id: string): {
  liveReservesConfig?: {
    scoring?: {
      maxSourceAgeSec?: number;
    };
  };
} {
  return JSON.parse(readFileSync(join(COIN_SOURCE_DIR, `${id}.json`), "utf8")) as {
    liveReservesConfig?: {
      scoring?: {
        maxSourceAgeSec?: number;
      };
    };
  };
}

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

describe("LiveReservesConfigSchema URL validation", () => {
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
        cdpStablecoin: "XOFm",
      }),
    ).toEqual({ cdpStablecoin: "XOFm" });
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

  it("accepts configured live reserve URLs", () => {
    const failures: string[] = [];

    for (const coin of ACTIVE_STABLECOINS) {
      if (!coin.liveReservesConfig) continue;
      const parsed = LiveReservesConfigSchema.safeParse(coin.liveReservesConfig);
      if (!parsed.success) {
        failures.push(
          `${coin.id}: ${parsed.error.issues[0]?.path.join(".") ?? "config"} ${parsed.error.issues[0]?.message ?? "invalid"}`,
        );
      }
    }

    expect(failures).toEqual([]);
  });
});

describe("LiveReservesConfigSchema adapter policy validation", () => {
  it("derives every compatibility projection from the descriptor registry", () => {
    const keys = [...LIVE_RESERVE_ADAPTER_KEYS].sort();
    expect(Object.keys(LIVE_RESERVE_ADAPTER_DESCRIPTORS).sort()).toEqual(keys);
    expect(Object.keys(liveReserveAdapterSchemaMetadata).sort()).toEqual(keys);
    expect(Object.keys(adapterParamsSchemas).sort()).toEqual(keys);
    expect(Object.keys(LIVE_RESERVE_ADAPTER_PRIMARY_INPUT_KINDS).sort()).toEqual(keys);
    expect(Object.keys(LIVE_RESERVE_ADAPTER_SOURCE_ORIGIN_CLASSES).sort()).toEqual(keys);
    expect(Object.keys(LIVE_RESERVE_ADAPTER_DEFINITIONS).sort()).toEqual(keys);
    expect(LIVE_RESERVE_ADAPTER_DEFINITIONS).toBe(LIVE_RESERVE_ADAPTER_DESCRIPTORS);

    for (const adapterKey of LIVE_RESERVE_ADAPTER_KEYS) {
      const descriptor = LIVE_RESERVE_ADAPTER_DESCRIPTORS[adapterKey];
      expect(descriptor.key).toBe(adapterKey);
      expect(descriptor.params).toBe(liveReserveAdapterSchemaMetadata[adapterKey].params);
      expect(descriptor.primaryInputKinds).toBe(liveReserveAdapterSchemaMetadata[adapterKey].primaryInputKinds);
      expect(adapterParamsSchemas[adapterKey]).toBe(liveReserveAdapterSchemaMetadata[adapterKey].params);
      expect(LIVE_RESERVE_ADAPTER_PRIMARY_INPUT_KINDS[adapterKey]).toBe(
        liveReserveAdapterSchemaMetadata[adapterKey].primaryInputKinds,
      );
      expect(LIVE_RESERVE_ADAPTER_PROVENANCE[adapterKey]).toBe(descriptor.provenance);
      expect(LIVE_RESERVE_ADAPTER_SOURCE_ORIGIN_CLASSES[adapterKey]).toBe(
        descriptor.sourceOriginClass,
      );
      expect(ReserveEvidenceSourceOriginClassSchema.safeParse(descriptor.sourceOriginClass).success).toBe(
        true,
      );
      expect(getReserveDisplayBadgeKindForAdapter(adapterKey)).toBe(descriptor.displayBadgeKind);
    }
  });

  it("classifies reviewed issuer feeds without changing their score-bearing evidence class", () => {
    const issuerAdapters = [
      "frax-balance-sheet",
      "frax-fpi-collateral",
      "tether-transparency",
      "usdai-proof-of-reserves",
    ] as const;

    for (const adapterKey of issuerAdapters) {
      expect(LIVE_RESERVE_ADAPTER_SOURCE_ORIGIN_CLASSES[adapterKey]).toBe("issuer-attested");
      expect(LIVE_RESERVE_ADAPTER_DEFINITIONS[adapterKey].evidenceClass).toBe("independent");
    }
    expect(LIVE_RESERVE_ADAPTER_SOURCE_ORIGIN_CLASSES["3jane-usd3"]).toBe("unknown");
  });

  it("rejects unsupported adapter semantics", () => {
    const result = LiveReservesConfigSchema.safeParse({
      adapter: "chainlink-por",
      version: 1,
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

describe("late-monthly disclosure source-age policy", () => {
  it("keeps reviewed late-monthly source-age overrides tied to the named policy", () => {
    const failures = LATE_MONTHLY_SOURCE_AGE_IDS.flatMap((id) => {
      const maxSourceAgeSec = readCoinSource(id).liveReservesConfig?.scoring?.maxSourceAgeSec;
      return maxSourceAgeSec === LATE_MONTHLY_DISCLOSURE_SOURCE_MAX_AGE_SEC
        ? []
        : [`${id}: expected ${LATE_MONTHLY_DISCLOSURE_SOURCE_MAX_AGE_SEC}, got ${String(maxSourceAgeSec)}`];
    });

    expect(failures).toEqual([]);
  });

  it("does not leave late-monthly-ish caps outside the named policy value", () => {
    const adHocCaps = readdirSync(COIN_SOURCE_DIR)
      .filter((fileName) => fileName.endsWith(".json"))
      .flatMap((fileName) => {
        const source = JSON.parse(readFileSync(join(COIN_SOURCE_DIR, fileName), "utf8")) as {
          liveReservesConfig?: { scoring?: { maxSourceAgeSec?: number } };
        };
        const maxSourceAgeSec = source.liveReservesConfig?.scoring?.maxSourceAgeSec;
        const isLateMonthlyRange =
          maxSourceAgeSec != null && maxSourceAgeSec >= 3_900_000 && maxSourceAgeSec <= 4_100_000;
        return isLateMonthlyRange && maxSourceAgeSec !== LATE_MONTHLY_DISCLOSURE_SOURCE_MAX_AGE_SEC
          ? [`${fileName}: ${maxSourceAgeSec}`]
          : [];
      });

    expect(adHocCaps).toEqual([]);
  });
});
