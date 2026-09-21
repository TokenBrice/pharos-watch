import { describe, expect, it } from "vitest";
import type { ChainSummary } from "@shared/types/chains";
import { sortChains } from "./chain-model";

function chain(id: string, overrides: Partial<ChainSummary>): ChainSummary {
  return { chainId: id, name: id, totalUsd: 0, stablecoinCount: 0, ...overrides } as ChainSummary;
}

describe("sortChains", () => {
  const rows = [
    chain("unknown", { healthScore: null }),
    chain("weak", { healthScore: 10 }),
    chain("strong", { healthScore: 90 }),
  ];

  it("keeps an unscored chain last when sorting descending", () => {
    expect(sortChains(rows, "healthScore", "desc").map((row) => row.chainId)).toEqual([
      "strong",
      "weak",
      "unknown",
    ]);
  });

  it("keeps an unscored chain last when sorting ascending", () => {
    // `?? -Infinity` used to rank the unmeasured chain as the unhealthiest one.
    expect(sortChains(rows, "healthScore", "asc").map((row) => row.chainId)).toEqual([
      "weak",
      "strong",
      "unknown",
    ]);
  });
});
