import { describe, expect, it } from "vitest";
import { LIVE_RESERVE_ADAPTER_KEYS } from "@shared/types/live-reserves";
import { toErrorMessage } from "../../../lib/error-utils";
import {
  LIVE_RESERVE_ADAPTER_DESCRIPTORS,
  LIVE_RESERVE_ADAPTER_DEFINITIONS,
  LIVE_RESERVE_ADAPTER_PRIMARY_INPUT_KINDS,
  LIVE_RESERVE_ADAPTER_PROVENANCE,
  LIVE_RESERVE_ADAPTER_STATUS_VALUES,
  LiveReservesConfigSchema,
  parseLiveReserveAdapterParams,
} from "@shared/lib/live-reserve-adapters";
import { ACTIVE_STABLECOINS } from "@shared/lib/stablecoins/registry";
import { getReserveAdapter, LIVE_RESERVE_ADAPTER_FETCHERS } from "../index";

const VALID_INPUT_KINDS = new Set(["http-json", "http-html", "indexer", "onchain-solana", "onchain-evm"]);

function canonicalStringify(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map((item) => canonicalStringify(item)).join(",")}]`;
  return `{${Object.keys(value as Record<string, unknown>)
    .sort()
    .map((key) => `${JSON.stringify(key)}:${canonicalStringify((value as Record<string, unknown>)[key])}`)
    .join(",")}}`;
}

function liveReserveSourceFingerprint(
  config: NonNullable<(typeof ACTIVE_STABLECOINS)[number]["liveReservesConfig"]>,
): string {
  return canonicalStringify({
    adapter: config.adapter,
    version: config.version,
    semantics: config.semantics,
    inputs: {
      primary: config.inputs.primary,
      fallbacks: config.inputs.fallbacks ?? null,
    },
    params: config.params ?? null,
  });
}

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

  it.each(LIVE_RESERVE_ADAPTER_KEYS)("%s has a matching definition in LIVE_RESERVE_ADAPTER_DEFINITIONS", (key) => {
    const definition = LIVE_RESERVE_ADAPTER_DEFINITIONS[key];
    expect(definition, `Missing definition for "${key}" in shared/lib/live-reserve-adapters.ts`).toBeDefined();
    expect(definition.sourceModel).toBeDefined();
    expect(definition.evidenceClass).toBeDefined();
    expect(definition.sharedSourceMode).toBeDefined();
  });

  it.each(LIVE_RESERVE_ADAPTER_KEYS)(
    "%s has a registered params schema (parseLiveReserveAdapterParams does not throw 'unknown adapter')",
    (key) => {
      // parseLiveReserveAdapterParams may throw for invalid params shape,
      // but it should never throw for an unregistered adapter key.
      // Adapters with noParamsSchema will succeed with {}; others may throw
      // a validation error — that's fine, we only care it doesn't throw
      // "unknown adapter".
      try {
        parseLiveReserveAdapterParams(key, {});
      } catch (error) {
        const message = toErrorMessage(error);
        expect(message).not.toContain("unknown adapter");
      }
    },
  );

  it("worker fetcher keys match the shared descriptor registry exactly", () => {
    expect(Object.keys(LIVE_RESERVE_ADAPTER_FETCHERS).sort()).toEqual(
      Object.keys(LIVE_RESERVE_ADAPTER_DESCRIPTORS).sort(),
    );
  });

  it("LIVE_RESERVE_ADAPTER_DEFINITIONS keys match LIVE_RESERVE_ADAPTER_KEYS exactly", () => {
    const definitionKeys = Object.keys(LIVE_RESERVE_ADAPTER_DEFINITIONS).sort();
    const canonicalKeys = [...LIVE_RESERVE_ADAPTER_KEYS].sort();
    expect(definitionKeys).toEqual(canonicalKeys);
  });

  it("adapter provenance covers every canonical key with an explicit status and rationale", () => {
    const provenanceKeys = Object.keys(LIVE_RESERVE_ADAPTER_PROVENANCE).sort();
    const canonicalKeys = [...LIVE_RESERVE_ADAPTER_KEYS].sort();
    const validStatuses = new Set(LIVE_RESERVE_ADAPTER_STATUS_VALUES);
    expect(provenanceKeys).toEqual(canonicalKeys);

    for (const key of LIVE_RESERVE_ADAPTER_KEYS) {
      const provenance = LIVE_RESERVE_ADAPTER_PROVENANCE[key];
      expect(validStatuses.has(provenance.status)).toBe(true);
      expect(provenance.rationale.trim().length).toBeGreaterThan(0);
    }
  });

  it("parked and retired adapter entries declare parkedSince and nextReview", () => {
    const isoDatePattern = /^\d{4}-\d{2}-\d{2}$/;
    for (const key of LIVE_RESERVE_ADAPTER_KEYS) {
      const provenance = LIVE_RESERVE_ADAPTER_PROVENANCE[key] as {
        status: string;
        parkedSince?: string;
        nextReview?: string;
      };
      if (provenance.status !== "parked" && provenance.status !== "retired") continue;
      expect(
        provenance.parkedSince,
        `${key} is ${provenance.status}; set parkedSince to the YYYY-MM-DD it left active status.`,
      ).toMatch(isoDatePattern);
      expect(
        provenance.nextReview,
        `${key} is ${provenance.status}; set nextReview to the YYYY-MM-DD by which to re-evaluate.`,
      ).toMatch(isoDatePattern);
    }
  });

  it("active adapter provenance matches live-reserve metadata usage", () => {
    const configuredKeys = new Set(
      ACTIVE_STABLECOINS.map((coin) => coin.liveReservesConfig?.adapter).filter(
        (key): key is (typeof LIVE_RESERVE_ADAPTER_KEYS)[number] => !!key,
      ),
    );

    for (const key of LIVE_RESERVE_ADAPTER_KEYS) {
      const provenance = LIVE_RESERVE_ADAPTER_PROVENANCE[key];
      if (configuredKeys.has(key)) {
        expect(provenance.status, `${key} is configured and should be marked active`).toBe("active");
      } else {
        expect(provenance.status, `${key} is unbound and must be staged, parked, or retired`).not.toBe("active");
      }
    }
  });

  it("LiveReservesConfigSchema accepts a representative config", () => {
    const parsed = LiveReservesConfigSchema.safeParse({
      adapter: "curated-validated",
      version: 1,
      semantics: "single-asset",
      inputs: {
        primary: { kind: "onchain-solana" },
      },
    });

    expect(parsed.success).toBe(true);
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

  it.each(LIVE_RESERVE_ADAPTER_KEYS)("%s declares a non-empty set of valid primary input kinds", (key) => {
    const kinds = LIVE_RESERVE_ADAPTER_PRIMARY_INPUT_KINDS[key];
    expect(
      kinds,
      `Missing primary input-kinds entry for "${key}" in LIVE_RESERVE_ADAPTER_PRIMARY_INPUT_KINDS`,
    ).toBeDefined();
    expect(Array.isArray(kinds)).toBe(true);
    expect(kinds.length).toBeGreaterThan(0);
    for (const kind of kinds) {
      expect(
        VALID_INPUT_KINDS.has(kind),
        `Adapter "${key}" declares unknown input kind "${kind}" — valid kinds are ${[...VALID_INPUT_KINDS].join(", ")}`,
      ).toBe(true);
    }
    // No duplicates.
    expect(new Set(kinds).size).toBe(kinds.length);
  });

  it("parseLiveReserveAdapterParams accepts a structured adapter payload", () => {
    const parsed = parseLiveReserveAdapterParams("chainlink-nav", {
      oracleAddress: "0x123",
      tokenAddress: "0x456",
      assetLabel: "USDC",
      assetRisk: "low",
    });

    expect(parsed).toEqual({
      oracleAddress: "0x123",
      tokenAddress: "0x456",
      assetLabel: "USDC",
      assetRisk: "low",
    });
  });

  it("documents safe source-invariant flip candidates without relying on coin-specific parser params", () => {
    const expectedDuplicateGroups: Record<string, string[][]> = {
      "frax-balance-sheet": [],
      reservoir: [["rusd-reservoir", "srusd-reservoir", "wsrusd-reservoir"]],
    };

    for (const adapterKey of Object.keys(expectedDuplicateGroups)) {
      const groups = new Map<string, string[]>();
      for (const coin of ACTIVE_STABLECOINS) {
        const config = coin.liveReservesConfig;
        if (config?.adapter !== adapterKey) continue;
        expect(
          config.inputs.primary.kind === "http-json" || config.inputs.primary.kind === "http-html",
          `${coin.id} uses ${adapterKey} but its primary input cannot participate in HTTP source sharing`,
        ).toBe(true);
        expect(
          config.params ?? null,
          `${coin.id} uses ${adapterKey} with parser params; do not flip source-invariant until params are in the cache key`,
        ).toBeNull();
        const fingerprint = liveReserveSourceFingerprint(config);
        groups.set(fingerprint, [...(groups.get(fingerprint) ?? []), coin.id]);
      }

      const duplicateGroups = Array.from(groups.values())
        .map((ids) => ids.sort())
        .filter((ids) => ids.length > 1)
        .sort((a, b) => a[0]!.localeCompare(b[0]!));

      expect(duplicateGroups).toEqual(expectedDuplicateGroups[adapterKey]);
    }
  });
});
