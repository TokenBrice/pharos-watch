import { describe, expect, it } from "vitest";

import {
  isAuthoritativeDepegPegReference,
  type PegReferenceTrustInput,
} from "../peg-reference-trust";

describe("peg reference trust", () => {
  const cases: Array<{
    label: string;
    input: PegReferenceTrustInput;
    expected: boolean;
  }> = [
    {
      label: "USD pegs anchor directly",
      input: { pegCurrency: "USD", pegType: "peggedUSD" },
      expected: true,
    },
    {
      label: "missing peg type stays trusted",
      input: { pegCurrency: "USD", pegType: null },
      expected: true,
    },
    {
      label: "commodity pegs stay trusted without peer-count gating",
      input: { pegCurrency: "GOLD", pegType: "peggedGOLD", pegRateSource: "median", pegRateContributorCount: 1 },
      expected: true,
    },
    {
      label: "variable pegs stay trusted without peer-count gating",
      input: { pegCurrency: "VAR", pegType: "peggedVAR" },
      expected: true,
    },
    {
      label: "non-USD fiat fallback is trusted",
      input: { pegCurrency: "EUR", pegType: "peggedEUR", pegRateSource: "fallback", pegRateContributorCount: 0 },
      expected: true,
    },
    {
      label: "non-USD fiat median with three contributors is trusted",
      input: { pegCurrency: "CHF", pegType: "peggedCHF", pegRateSource: "median", pegRateContributorCount: 3 },
      expected: true,
    },
    {
      label: "non-USD fiat median with two contributors is not trusted",
      input: { pegCurrency: "EUR", pegType: "peggedEUR", pegRateSource: "median", pegRateContributorCount: 2 },
      expected: false,
    },
    {
      label: "non-USD fiat without source or count is not trusted",
      input: { pegCurrency: "CHF", pegType: "peggedCHF" },
      expected: false,
    },
  ];

  for (const entry of cases) {
    it(entry.label, () => {
      expect(isAuthoritativeDepegPegReference(entry.input)).toBe(entry.expected);
    });
  }
});
