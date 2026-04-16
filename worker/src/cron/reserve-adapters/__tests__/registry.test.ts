import { describe, expect, it } from "vitest";
import { LIVE_RESERVE_ADAPTER_KEYS } from "@shared/types/live-reserves";
import {
  LIVE_RESERVE_ADAPTER_DEFINITIONS,
  LIVE_RESERVE_ADAPTER_PRIMARY_INPUT_KINDS,
  LiveReservesConfigSchema,
  parseLiveReserveAdapterParams,
} from "@shared/lib/live-reserve-adapters";
import { getReserveAdapter } from "../index";

const VALID_INPUT_KINDS = new Set([
  "http-json",
  "http-html",
  "indexer",
  "onchain-solana",
  "onchain-evm",
]);

describe("adapter registry completeness", () => {
  it.each(LIVE_RESERVE_ADAPTER_KEYS)(
    "%s has a worker adapter function registered",
    (key) => {
      const adapter = getReserveAdapter(key);
      expect(adapter, `getReserveAdapter("${key}") returned null — adapter not registered in worker/src/cron/reserve-adapters/index.ts`).not.toBeNull();
      expect(typeof adapter!.fetch).toBe("function");
      expect(adapter!.key).toBe(key);
    },
  );

  it.each(LIVE_RESERVE_ADAPTER_KEYS)(
    "%s has a matching definition in LIVE_RESERVE_ADAPTER_DEFINITIONS",
    (key) => {
      const definition = LIVE_RESERVE_ADAPTER_DEFINITIONS[key];
      expect(definition, `Missing definition for "${key}" in shared/lib/live-reserve-adapters.ts`).toBeDefined();
      expect(definition.sourceModel).toBeDefined();
      expect(definition.evidenceClass).toBeDefined();
      expect(definition.sharedSourceMode).toBeDefined();
    },
  );

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
        const message = error instanceof Error ? error.message : String(error);
        expect(message).not.toContain("unknown adapter");
      }
    },
  );

  it("worker ADAPTER_FNS keys match LIVE_RESERVE_ADAPTER_KEYS exactly", () => {
    // Every key in the canonical list must resolve to an adapter
    const missing = LIVE_RESERVE_ADAPTER_KEYS.filter((key) => getReserveAdapter(key) === null);
    expect(missing, `Keys present in LIVE_RESERVE_ADAPTER_KEYS but missing from worker adapter registry: ${missing.join(", ")}`).toEqual([]);
  });

  it("LIVE_RESERVE_ADAPTER_DEFINITIONS keys match LIVE_RESERVE_ADAPTER_KEYS exactly", () => {
    const definitionKeys = Object.keys(LIVE_RESERVE_ADAPTER_DEFINITIONS).sort();
    const canonicalKeys = [...LIVE_RESERVE_ADAPTER_KEYS].sort();
    expect(definitionKeys).toEqual(canonicalKeys);
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
      adapter: "tether",
      version: 1,
      semantics: "single-asset",
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

  it.each(LIVE_RESERVE_ADAPTER_KEYS)(
    "%s declares a non-empty set of valid primary input kinds",
    (key) => {
      const kinds = LIVE_RESERVE_ADAPTER_PRIMARY_INPUT_KINDS[key];
      expect(kinds, `Missing primary input-kinds entry for "${key}" in LIVE_RESERVE_ADAPTER_PRIMARY_INPUT_KINDS`).toBeDefined();
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
    },
  );

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
});
