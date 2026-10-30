import { describe, expect, it } from "vitest";
import { isObservedPrice } from "@shared/lib/pricing-source-policy";
import { PegSummaryCoinSchema, type PegSummaryCoin } from "@shared/types/peg";
import type { StablecoinMeta } from "@shared/types/core";
import { inheritPureWrapperPegObservations } from "../safety-score-v9/capture";

const CHILD = "usdn-noble";
const PARENT = "m-m0";

type TestMeta = Pick<StablecoinMeta, "variantOf" | "variantKind" | "pegReferenceId" | "flags">;

const OBSERVED_REFERENCE = { valueUsd: 1, source: "median" as const, contributorCount: 294, asOf: 1_793_294_137 };

function row(overrides: Partial<PegSummaryCoin> = {}): PegSummaryCoin {
  return PegSummaryCoinSchema.parse({
    id: CHILD,
    symbol: "USDN",
    name: "Noble Dollar",
    pegType: "peggedUSD",
    pegCurrency: "USD",
    governance: "centralized",
    currentDeviationBps: null,
    currentPriceUnavailable: true,
    priceSource: "protocol-par",
    priceObservedAtMode: "nominal_reference",
    nominalPriceReference: { price: 1, source: "protocol-par", mode: "nominal_reference" },
    pegScore: 100,
    pegPct: 99.99,
    severityScore: 99.9,
    spreadPenalty: 0,
    eventCount: 2,
    worstDeviationBps: -189,
    activeDepeg: false,
    lastEventAt: 1_774_651_713,
    trackingSpanDays: 603,
    methodologyVersion: "10.36",
    ...overrides,
  });
}

function wrapperMeta(overrides: Partial<TestMeta> = {}): TestMeta {
  return {
    variantOf: PARENT,
    variantKind: "pure-wrapper",
    pegReferenceId: PARENT,
    flags: { backing: "rwa-backed", pegCurrency: "USD", governance: "centralized", yieldBearing: false, rwa: true, navToken: false },
    ...overrides,
  };
}

function observedParent(overrides: Partial<PegSummaryCoin> = {}): PegSummaryCoin {
  return row({
    id: PARENT,
    symbol: "M",
    currentDeviationBps: -5,
    currentPriceUnavailable: undefined,
    priceSource: undefined,
    priceObservedAtMode: undefined,
    nominalPriceReference: undefined,
    pegReference: OBSERVED_REFERENCE,
    eventCount: 1,
    ...overrides,
  });
}

function run(rows: PegSummaryCoin[], meta: Record<string, TestMeta> = { [CHILD]: wrapperMeta() }) {
  return inheritPureWrapperPegObservations(new Map(rows.map((entry) => [entry.id, entry])), new Map(Object.entries(meta)));
}

describe("Safety Score V9 capture — reviewed 1:1 wrapper peg observation inheritance", () => {
  it("publishes the parent's admitted observation for a nominal pure-wrapper row", () => {
    const result = run([row(), observedParent()]);
    const child = result.get(CHILD)!;
    expect(child.currentDeviationBps).toBe(-5);
    expect(child.pegReference).toEqual(OBSERVED_REFERENCE);
    expect(child.priceSource).toBe("protocol-redeem");
    expect(child.priceObservedAtMode).toBe("upstream");
    expect(child).not.toHaveProperty("currentPriceUnavailable");
    expect(child).not.toHaveProperty("nominalPriceReference");
    // The fact-set admission gate (`isObservedPrice`) now admits the row, so a
    // current peg fact exists instead of the cause-A nominal rejection.
    expect(isObservedPrice(child)).toBe(true);
    // The wrapper's own adverse history is retained, never overwritten.
    expect(child.eventCount).toBe(2);
    expect(child.worstDeviationBps).toBe(-189);
  });

  it("leaves the row nominal when the tracked parent has no admitted observation", () => {
    const nominalParent = observedParent({
      currentDeviationBps: null,
      currentPriceUnavailable: true,
      pegReference: null,
      priceSource: "protocol-par",
      priceObservedAtMode: "nominal_reference",
    });
    const child = run([row(), nominalParent]).get(CHILD)!;
    expect(child.currentDeviationBps).toBeNull();
    expect(child.currentPriceUnavailable).toBe(true);
    expect(child.priceSource).toBe("protocol-par");
    expect(isObservedPrice(child)).toBe(false);
  });

  it("does not inherit across an unobserved intermediate wrapper (one hop only)", () => {
    const bridgeNominal = observedParent({ id: "wm-m0", currentDeviationBps: null, currentPriceUnavailable: true, pegReference: null });
    const result = run(
      [row(), bridgeNominal, observedParent({ id: "grandparent" })],
      { [CHILD]: wrapperMeta({ variantOf: "wm-m0", pegReferenceId: "wm-m0" }) },
    );
    expect(result.get(CHILD)!.currentDeviationBps).toBeNull();
    expect(result.get(CHILD)!.currentPriceUnavailable).toBe(true);
  });

  it.each([
    ["an asset without a reviewed wrapper relationship", { [CHILD]: wrapperMeta({ variantOf: undefined, pegReferenceId: undefined }) }],
    ["a non-pure wrapper", { [CHILD]: wrapperMeta({ variantKind: "savings-passthrough" }) }],
    ["a self-referencing parent", { [CHILD]: wrapperMeta({ variantOf: CHILD, pegReferenceId: CHILD }) }],
    ["a mismatched variantOf", { [CHILD]: wrapperMeta({ variantOf: "other-parent" }) }],
  ])("leaves a nominal row untouched for %s", (_label, meta) => {
    const child = run([row(), observedParent()], meta as Record<string, TestMeta>).get(CHILD)!;
    expect(child.currentDeviationBps).toBeNull();
    expect(child.currentPriceUnavailable).toBe(true);
    expect(child.priceSource).toBe("protocol-par");
  });

  it("requires the same non-blank peg type and currency", () => {
    const child = run([row({ pegType: "peggedPHP", pegCurrency: "PHP" }), observedParent()]).get(CHILD)!;
    expect(child.currentDeviationBps).toBeNull();
    expect(child.currentPriceUnavailable).toBe(true);
  });

  it("keeps an already observed child row as published", () => {
    const observedChild = row({
      currentDeviationBps: -12,
      currentPriceUnavailable: undefined,
      priceSource: "coingecko",
      priceObservedAtMode: "upstream",
      nominalPriceReference: undefined,
    });
    const child = run([observedChild, observedParent()]).get(CHILD)!;
    expect(child).toEqual(observedChild);
  });

  it("does not rewrite pure-NAV rows", () => {
    const child = run([row(), observedParent()], {
      [CHILD]: wrapperMeta({
        flags: { backing: "rwa-backed", pegCurrency: "USD", governance: "centralized", yieldBearing: false, rwa: true, navToken: true },
      }),
    }).get(CHILD)!;
    expect(child.currentPriceUnavailable).toBe(true);
  });
});
