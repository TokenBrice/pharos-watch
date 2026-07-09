/* eslint-disable security/detect-non-literal-fs-filename -- tests read checked-in stablecoin JSON from the repository root only. */
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { ACTIVE_STABLECOINS } from "../stablecoins/registry";
import {
  LIVE_RESERVE_ADAPTER_DESCRIPTORS,
  LIVE_RESERVE_ADAPTER_PROVENANCE,
  LiveReservesConfigSchema,
  parseLiveReserveAdapterParams,
} from "../live-reserve-adapters";
import { getReserveDisplayBadgeKindForAdapter } from "../live-reserve-display";
import { LIVE_RESERVE_ADAPTER_KEYS } from "../../types/live-reserves";
import { LIVE_RESERVE_ADAPTER_DEFINITIONS } from "../live-reserve-adapters-definitions";
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
  "phpm-mento",
  "srusd-reservoir",
  "usdh-native-markets",
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
      expect(getReserveDisplayBadgeKindForAdapter(adapterKey)).toBe(descriptor.displayBadgeKind);
    }
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
