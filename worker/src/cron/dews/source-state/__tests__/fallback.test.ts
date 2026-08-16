import { describe, expect, it } from "vitest";
import {
  isBootstrapAllowedMissingTableSource,
  resolveBootstrapAllowed,
} from "../../../../lib/dews/source-state/fallback";

const ALLOWLISTED_SOURCES = [
  "dex-prices",
  "dex-liquidity-history",
  "blacklist-events",
  "mint-burn-hourly",
  "yield-data",
  "stability-index-samples",
];

const missingTableError = new Error("D1_ERROR: no such table: dex_prices");
const networkError = new Error("fetch failed: network unreachable");

describe("resolveBootstrapAllowed", () => {
  it("returns false when bootstrap is not pending, even with a matching table error", () => {
    expect(resolveBootstrapAllowed("dex-prices", missingTableError, false)).toBe(false);
  });

  it("returns false for non-table errors while bootstrap is pending", () => {
    expect(resolveBootstrapAllowed("dex-prices", networkError, true)).toBe(false);
  });

  it("returns false for sources outside the bootstrap allowlist", () => {
    expect(resolveBootstrapAllowed("custom-table", missingTableError, true)).toBe(false);
  });

  it("returns true when all three conditions hold for each allowlisted source", () => {
    for (const source of ALLOWLISTED_SOURCES) {
      expect(resolveBootstrapAllowed(source, missingTableError, true)).toBe(true);
    }
  });
});

describe("isBootstrapAllowedMissingTableSource", () => {
  it("recognizes every allowlisted source", () => {
    for (const source of ALLOWLISTED_SOURCES) {
      expect(isBootstrapAllowedMissingTableSource(source)).toBe(true);
    }
  });

  it("rejects sources not on the allowlist", () => {
    expect(isBootstrapAllowedMissingTableSource("custom-table")).toBe(false);
  });
});
