import { describe, it, expect } from "vitest";
import { hasValidStagedPoolTvl, isValidStagedPoolId } from "../persistence";
import { STAGED_POOL_MAX_TVL_USD } from "../types";

describe("isValidStagedPoolId", () => {
  it("accepts EVM chain:address lowercased form", () => {
    expect(isValidStagedPoolId("ethereum:0x1234567890abcdef1234567890abcdef12345678")).toBe(true);
    expect(isValidStagedPoolId("base:0xabcdef")).toBe(true);
  });

  it("accepts Solana mixed-case base58 addresses", () => {
    expect(isValidStagedPoolId("solana:HTvjzsfX3yU6BUodCjZ5vZkUrAxMDTrBs3CJaq43ashR")).toBe(true);
  });

  it("accepts orderbook synthetic form with extra coin segment", () => {
    expect(isValidStagedPoolId("orderbook:kinesis:usdc-circle")).toBe(true);
  });

  it("rejects poolIds missing the colon separator", () => {
    expect(isValidStagedPoolId("eth0x1234")).toBe(false);
  });

  it("rejects uppercase chain slug", () => {
    expect(isValidStagedPoolId("ETHEREUM:0x123")).toBe(false);
  });

  it("rejects empty string", () => {
    expect(isValidStagedPoolId("")).toBe(false);
  });
});

describe("hasValidStagedPoolTvl", () => {
  it("accepts null and finite TVL values inside the staging cap", () => {
    expect(hasValidStagedPoolTvl({ tvlUsd: null })).toBe(true);
    expect(hasValidStagedPoolTvl({ tvlUsd: 0 })).toBe(true);
    expect(hasValidStagedPoolTvl({ tvlUsd: STAGED_POOL_MAX_TVL_USD })).toBe(true);
  });

  it("rejects non-finite, negative, and over-cap TVL values", () => {
    expect(hasValidStagedPoolTvl({ tvlUsd: Number.NaN })).toBe(false);
    expect(hasValidStagedPoolTvl({ tvlUsd: Number.POSITIVE_INFINITY })).toBe(false);
    expect(hasValidStagedPoolTvl({ tvlUsd: -1 })).toBe(false);
    expect(hasValidStagedPoolTvl({ tvlUsd: STAGED_POOL_MAX_TVL_USD + 1 })).toBe(false);
  });
});
