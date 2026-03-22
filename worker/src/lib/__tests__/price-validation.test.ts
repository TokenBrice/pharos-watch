import { describe, expect, it, vi, beforeEach, afterEach } from "vitest";
import { mockD1 } from "../../api/__tests__/helpers/mock-d1";

vi.mock("@shared/lib/stablecoins", () => ({
  TRACKED_META_BY_ID: new Map([
    ["brz-transfero", { flags: { pegCurrency: "BRL", navToken: false } }],
    ["ggbr-goldfish-gold", { flags: { pegCurrency: "GOLD", navToken: false }, commodityOunces: 0.001 }],
    ["ousg-ondo-finance", { flags: { pegCurrency: "USD", navToken: true } }],
    ["fpi-frax", { flags: { pegCurrency: "VAR", navToken: true } }],
  ]),
}));

import {
  buildPriceValidationContext,
  isSevereFixedPegDownside,
  loadPriceValidationReferences,
  normalizePegTypeFromCurrency,
  validatePriceCandidate,
  type PriceValidationReferences,
} from "../price-validation";

describe("normalizePegTypeFromCurrency", () => {
  it("normalizes BRL to peggedREAL and drops VAR", () => {
    expect(normalizePegTypeFromCurrency("BRL")).toBe("peggedREAL");
    expect(normalizePegTypeFromCurrency("JPY")).toBe("peggedJPY");
    expect(normalizePegTypeFromCurrency("VAR")).toBeUndefined();
  });
});

describe("buildPriceValidationContext", () => {
  it("prefers tracked metadata for peg normalization and commodity scaling", () => {
    expect(buildPriceValidationContext({ stablecoinId: "brz-transfero", pegType: "peggedBRL" })).toMatchObject({
      pegType: "peggedREAL",
      pegClass: "fiat_fx",
      navToken: false,
      tracked: true,
    });

    expect(buildPriceValidationContext({ stablecoinId: "ggbr-goldfish-gold" })).toMatchObject({
      pegType: "peggedGOLD",
      pegClass: "commodity",
      commodityOunces: 0.001,
      tracked: true,
    });
  });

  it("keeps NAV and VAR classifications from tracked metadata", () => {
    expect(buildPriceValidationContext({ stablecoinId: "ousg-ondo-finance" })).toMatchObject({
      pegClass: "nav",
      navToken: true,
    });

    expect(buildPriceValidationContext({ stablecoinId: "fpi-frax" })).toMatchObject({
      pegClass: "nav",
      navToken: true,
    });
  });

  it("falls back to raw inputs for untracked assets", () => {
    expect(buildPriceValidationContext({ pegType: "peggedJPY", pegCurrency: "JPY" })).toMatchObject({
      pegType: "peggedJPY",
      pegClass: "fiat_fx",
      tracked: false,
    });
  });
});

describe("loadPriceValidationReferences", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-03-11T08:00:00Z"));
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("returns fresh cached references within the freshness window", async () => {
    const nowSec = Math.floor(Date.now() / 1000);
    const db = mockD1([
      {
        match: "SELECT value, updated_at FROM cache WHERE key = ?",
        matchBinds: ["fx-rates"],
        rows: [],
        first: {
          value: JSON.stringify({ peggedEUR: 1.08, bad: "nope", peggedJPY: 0.0067 }),
          updated_at: nowSec - 300,
        },
      },
    ]);

    const result = await loadPriceValidationReferences(db);

    expect(result.type).toBe("fresh");
    expect(result.rates).toEqual({ peggedEUR: 1.08, peggedJPY: 0.0067 });
    expect(result.typeByPeg).toMatchObject({ peggedEUR: "fresh", peggedJPY: "fresh" });
  });

  it("returns stale cached references after the freshness window", async () => {
    const nowSec = Math.floor(Date.now() / 1000);
    const db = mockD1([
      {
        match: "SELECT value, updated_at FROM cache WHERE key = ?",
        matchBinds: ["fx-rates"],
        rows: [],
        first: {
          value: JSON.stringify({ peggedEUR: 1.08 }),
          updated_at: nowSec - (8 * 3600),
        },
      },
    ]);

    const result = await loadPriceValidationReferences(db);

    expect(result.type).toBe("stale");
    expect(result.rates).toEqual({ peggedEUR: 1.08 });
    expect(result.typeByPeg).toMatchObject({ peggedEUR: "stale" });
  });

  it("falls back to provided static references when cache is missing", async () => {
    const db = mockD1([
      {
        match: "SELECT value, updated_at FROM cache WHERE key = ?",
        matchBinds: ["fx-rates"],
        rows: [],
        first: null,
      },
    ]);

    const result = await loadPriceValidationReferences(db, {
      staticRates: { peggedEUR: 1.09, bad: Number.NaN },
    });

    expect(result.type).toBe("static");
    expect(result.rates).toEqual({ peggedEUR: 1.09 });
  });

  it("keeps cached-fallback references stale when source timestamps are old", async () => {
    const nowSec = Math.floor(Date.now() / 1000);
    const db = mockD1([
      {
        match: "SELECT value, updated_at FROM cache WHERE key = ?",
        matchBinds: ["fx-rates"],
        rows: [],
        first: {
          value: JSON.stringify({ peggedEUR: 1.08 }),
          updated_at: nowSec - 60,
        },
      },
      {
        match: "SELECT value, updated_at FROM cache WHERE key = ?",
        matchBinds: ["fx-rates-meta"],
        rows: [],
        first: {
          value: JSON.stringify({
            usableSyncAt: nowSec - 60,
            mode: "cached-fallback",
            sourceUpdatedAtByPeg: { peggedEUR: nowSec - (8 * 3600) },
            sourceModeByPeg: { peggedEUR: "cached" },
            sourceCadenceByPeg: { peggedEUR: "intraday" },
            consecutiveFallbackRuns: 2,
          }),
          updated_at: nowSec - 60,
        },
      },
    ]);

    const result = await loadPriceValidationReferences(db);

    expect(result.type).toBe("stale");
    expect(result.updatedAtByPeg).toEqual({ peggedEUR: nowSec - (8 * 3600) });
    expect(result.typeByPeg).toEqual({ peggedEUR: "stale" });
  });

  it("keeps business-daily FX references fresh before the next publish window", async () => {
    const nowSec = Math.floor(Date.now() / 1000);
    const db = mockD1([
      {
        match: "SELECT value, updated_at FROM cache WHERE key = ?",
        matchBinds: ["fx-rates"],
        rows: [],
        first: {
          value: JSON.stringify({ peggedEUR: 1.08 }),
          updated_at: nowSec - 60,
        },
      },
      {
        match: "SELECT value, updated_at FROM cache WHERE key = ?",
        matchBinds: ["fx-rates-meta"],
        rows: [],
        first: {
          value: JSON.stringify({
            usableSyncAt: nowSec - 60,
            mode: "live",
            sourceUpdatedAtByPeg: { peggedEUR: nowSec - (16 * 3600) },
            sourceModeByPeg: { peggedEUR: "live" },
            sourceCadenceByPeg: { peggedEUR: "business-daily" },
            sourceDateByPeg: { peggedEUR: "2026-03-10" },
            consecutiveFallbackRuns: 0,
          }),
          updated_at: nowSec - 60,
        },
      },
    ]);

    const result = await loadPriceValidationReferences(db);

    expect(result.type).toBe("fresh");
    expect(result.typeByPeg).toEqual({ peggedEUR: "fresh" });
  });
});

describe("validatePriceCandidate", () => {
  const freshRefs: PriceValidationReferences = {
    rates: {
      peggedUSD: 1,
      peggedEUR: 1.08,
      peggedJPY: 0.0067,
      peggedGOLD: 2_915,
      peggedSILVER: 32,
      peggedREAL: 0.2,
    },
    type: "fresh",
    updatedAt: Math.floor(Date.now() / 1000),
  };

  it("accepts fixed-peg prices inside the reference band", () => {
    const context = buildPriceValidationContext({ pegType: "peggedEUR", pegCurrency: "EUR" });
    const result = validatePriceCandidate(1.08, context, "fallback_enrichment", freshRefs);

    expect(result.accepted).toBe(true);
    expect(result.reasonCode).toBe("within_reference_band");
  });

  it("rejects low-nominal FX noise in strict modes", () => {
    const context = buildPriceValidationContext({ pegType: "peggedJPY", pegCurrency: "JPY" });
    const result = validatePriceCandidate(1.0, context, "dex_observation", freshRefs);

    expect(result.accepted).toBe(false);
    expect(result.reasonCode).toBe("reference_upper_bound_exceeded");
  });

  it("allows catastrophic downside in authoritative mode while keeping strict fallback behavior", () => {
    const context = buildPriceValidationContext({ pegType: "peggedUSD", pegCurrency: "USD" });

    const authoritative = validatePriceCandidate(0.0001, context, "primary_authoritative", freshRefs);
    const fallback = validatePriceCandidate(0.0001, context, "fallback_enrichment", freshRefs);

    expect(authoritative.accepted).toBe(true);
    expect(fallback.accepted).toBe(false);
  });

  it("flags severe fixed-peg downside against tracked references", () => {
    const usd = buildPriceValidationContext({ pegType: "peggedUSD", pegCurrency: "USD" });
    const eur = buildPriceValidationContext({ pegType: "peggedEUR", pegCurrency: "EUR" });
    const nav = buildPriceValidationContext({ stablecoinId: "ousg-ondo-finance" });

    expect(isSevereFixedPegDownside(0.49, usd, freshRefs)).toBe(true);
    expect(isSevereFixedPegDownside(0.7, usd, freshRefs)).toBe(false);
    expect(isSevereFixedPegDownside(0.5, eur, freshRefs)).toBe(true);
    expect(isSevereFixedPegDownside(50, nav, freshRefs)).toBe(false);
  });

  it("scales commodity references by unit size", () => {
    const fullOunce = buildPriceValidationContext({ pegType: "peggedGOLD", pegCurrency: "GOLD" });
    const fractional = buildPriceValidationContext({ stablecoinId: "ggbr-goldfish-gold" });

    expect(validatePriceCandidate(2_915, fullOunce, "fallback_enrichment", freshRefs).accepted).toBe(true);
    expect(validatePriceCandidate(5.15, fractional, "fallback_enrichment", freshRefs).accepted).toBe(true);
    expect(validatePriceCandidate(50, fractional, "fallback_enrichment", freshRefs).accepted).toBe(false);
  });

  it("keeps broad-positive behavior for NAV and variable assets", () => {
    const nav = buildPriceValidationContext({ stablecoinId: "ousg-ondo-finance" });
    const variable = buildPriceValidationContext({ pegCurrency: "VAR" });

    expect(validatePriceCandidate(110, nav, "dex_observation", freshRefs).accepted).toBe(true);
    expect(validatePriceCandidate(3.5, variable, "dex_observation", freshRefs).accepted).toBe(true);
    expect(validatePriceCandidate(0, variable, "dex_observation", freshRefs).accepted).toBe(false);
  });
});
