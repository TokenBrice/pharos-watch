import { describe, it, expect } from "vitest";
import {
  PEG_METADATA,
} from "@shared/lib/classification/pegs";
import type { PegCurrency } from "../../types";
import { ACTIVE_META_BY_ID } from "@shared/lib/stablecoins/registry";

describe("classification-pegs", () => {
  it("every active coin's pegCurrency maps to a known PEG_METADATA key", () => {
    const knownPegs = new Set(Object.keys(PEG_METADATA) as PegCurrency[]);
    const offending: string[] = [];

    for (const [id, coin] of ACTIVE_META_BY_ID) {
      const peg = coin.flags.pegCurrency;
      if (!knownPegs.has(peg as PegCurrency)) {
        offending.push(`${id}: unknown pegCurrency "${peg}"`);
      }
    }

    expect(
      offending,
      `Coins with unknown pegCurrency:\n${offending.join("\n")}`,
    ).toHaveLength(0);
  });

});
