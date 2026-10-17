import { afterEach, describe, expect, it, vi } from "vitest";
import { FROZEN_IDS } from "@shared/lib/stablecoins/registry";
import * as comparePages from "../../src/lib/compare-pages";

const pairs = comparePages.STATIC_COMPARE_PAIRS as unknown as [string, string][];
const originalPairs = [...pairs];

afterEach(() => {
  pairs.splice(0, pairs.length, ...originalPairs);
  vi.restoreAllMocks();
});

describe("frozen comparison invariants", () => {
  it("accepts the production static pairs", () => {
    expect(() => comparePages.assertStaticComparePairs()).not.toThrow();
  });

  it.each(["left", "right"])("rejects a frozen %s member through the production assertion", (side) => {
    const frozenId = [...FROZEN_IDS][0];
    expect(frozenId).toBeDefined();
    pairs.splice(0, pairs.length, side === "left"
      ? [frozenId!, "usdt-tether"]
      : ["usdt-tether", frozenId!]);
    expect(() => comparePages.assertStaticComparePairs()).toThrow("includes frozen stablecoin");
  });

  it.each([
    { pairs: [["usdt-tether", "usdt-tether"]], error: "cannot compare a coin with itself" },
    { pairs: [["usdt-tether", "usdc-circle"], ["usdt-tether", "usdc-circle"]], error: "Duplicate static comparison slug" },
    { pairs: [["usdt-tether", "usdc-circle"], ["usdc-circle", "usdt-tether"]], error: "Duplicate static comparison pair" },
  ])("retains the shared pair validation: $error", (fixture) => {
    pairs.splice(0, pairs.length, ...fixture.pairs as [string, string][]);
    expect(() => comparePages.assertStaticComparePairs()).toThrow(fixture.error);
  });

  it("calls the comparison assertion explicitly from the lifecycle checker", async () => {
    const assertion = vi.spyOn(comparePages, "assertStaticComparePairs");
    vi.spyOn(console, "log").mockImplementation(() => {});
    // Exercise module evaluation after installing the spy; a static import would run the checker too early.
    await import("../ci/check-frozen-invariants");
    expect(assertion).toHaveBeenCalledOnce();
  });
});
