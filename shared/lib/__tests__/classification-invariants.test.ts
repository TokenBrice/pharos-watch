import { describe, it, expect } from "vitest";
import { TRACKED_STABLECOINS } from "@shared/lib/stablecoins";
import { computeCentralizedCustodyFraction } from "@shared/lib/centralized-custody";

const MAJORITY_THRESHOLD = 0.50;
const EXPECTED_CENTRALIZED_CUSTODY_MAJORITIES = new Set([
  "zchf-frankencoin",
  "deuro-deuro",
  "usdp-parallel",
]);

describe("classification invariants", () => {
  it("only allows known decentralized coins with >50% centralized-custody exposure", () => {
    const warnings: string[] = [];

    const defiCoins = TRACKED_STABLECOINS.filter(
      (c) => c.flags.governance === "decentralized",
    );

    for (const coin of defiCoins) {
      const fraction = computeCentralizedCustodyFraction(
        coin.id, TRACKED_STABLECOINS,
      );
      if (fraction > MAJORITY_THRESHOLD) {
        warnings.push(
          `${coin.id}: classified "decentralized" but ${(fraction * 100).toFixed(1)}% ` +
          `centralized-custody exposure (threshold: ${MAJORITY_THRESHOLD * 100}%)`,
        );
      }
    }

    expect(warnings).toHaveLength(EXPECTED_CENTRALIZED_CUSTODY_MAJORITIES.size);
    for (const id of EXPECTED_CENTRALIZED_CUSTODY_MAJORITIES) {
      expect(
        warnings.some((warning) => warning.startsWith(`${id}: classified "decentralized"`)),
      ).toBe(true);
    }
  });
});
