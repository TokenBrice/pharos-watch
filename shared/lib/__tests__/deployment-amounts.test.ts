import { describe, expect, it } from "vitest";
import { compareXrplIssuedCurrencyAmounts, isFixedDecimalDeployment, parseXrplIssuedCurrencyAmount } from "../deployment-amounts";
import { ContractDeploymentSchema } from "../../types/stablecoin-meta-schemas";
import { resolveTrackedContractConfigCore } from "../stablecoins/tracked-contract-selection";
const issuer = "rMkEuRii9w9uBMQDnWV5AA43gvYZR9JxVK";
const parse = (value: string) => parseXrplIssuedCurrencyAmount({ value, issuer, currency: "EUR" });
describe("native XRPL issued-currency exact amounts", () => {
  it("normalizes equivalent spellings without a floating point round trip", () => {
    expect(parse("9007199254740993")).toMatchObject({ coefficient: "9007199254740993", exponent: 0 });
    expect(parse("1.2300e-4")).toMatchObject({ coefficient: "1230000000000000", exponent: -19 });
    expect(compareXrplIssuedCurrencyAmounts(parse("0.000123"), parse("1.23e-4"))).toBe(0);
    expect(parse("-0e99999")).toMatchObject({ coefficient: "0", exponent: 0 });
    expect(compareXrplIssuedCurrencyAmounts(parse("-0.000001"), parse("0"))).toBe(-1);
    expect(compareXrplIssuedCurrencyAmounts(parse("+1"), parse("0.9999999999999999"))).toBe(1);
  });
  it("admits normalized wire exponent boundaries and rejects overprecision or unrepresentable values", () => {
    expect(parse("1000000000000000e-96").exponent).toBe(-96);
    expect(parse("9999999999999999e80").exponent).toBe(80);
    for (const value of ["1e-82", "1e96", "1.2345678901234567", "NaN", "1e99999999999999999999", "1".repeat(257)]) expect(() => parse(value)).toThrow();
    expect(() => parseXrplIssuedCurrencyAmount({ value: "1", issuer, currency: "EUR" }, { issuer, currency: "USD" })).toThrow("xrpl-issued-identity-mismatch");
    expect(() => parseXrplIssuedCurrencyAmount({ value: "1", issuer: issuer.toLowerCase(), currency: "EUR" }, { issuer, currency: "EUR" })).toThrow();
    expect(() => parseXrplIssuedCurrencyAmount({ value: "1", issuer, currency: "EUROP" })).toThrow();
  });
  it("makes issued decimals explicit and refuses fixed-unit overrides without changing EVM/Solana semantics", () => {
    const issued = ContractDeploymentSchema.parse({ chain: "xrpl", address: issuer, decimals: null, amountEncoding: { kind: "xrpl-issued-currency" } });
    expect(isFixedDecimalDeployment(issued)).toBe(false);
    expect(resolveTrackedContractConfigCore({ contracts: [issued] }, "xrpl", { addressOverride: issuer, decimalsOverride: 18 })).toBeNull();
    expect(ContractDeploymentSchema.safeParse({ ...issued, chain: "ethereum" }).success).toBe(false);
    expect(ContractDeploymentSchema.safeParse({ chain: "ethereum", address: "0xtoken", decimals: null }).success).toBe(false);
    for (const [chain, decimals] of [["ethereum", 18], ["solana", 6]] as const) {
      const fixed = ContractDeploymentSchema.parse({ chain, address: "token", decimals });
      expect(isFixedDecimalDeployment(fixed)).toBe(true);
      expect(resolveTrackedContractConfigCore({ contracts: [fixed] }, chain)).toEqual({ contractAddress: "token", decimals });
    }
  });
});
