import { describe, expect, it } from "vitest";
import {
  computeMintBurnSyncFreshnessStatus,
  resolveMintBurnFreshnessConfig,
} from "../mint-burn-health-config";

describe("resolveMintBurnFreshnessConfig", () => {
  it("returns defaults with no env overrides", () => {
    const config = resolveMintBurnFreshnessConfig({});
    expect(config.majorSymbols).toContain("USDT");
    expect(config.majorSymbols).toContain("USDC");
    expect(config.staleWarnSec).toBeGreaterThan(0);
    expect(config.staleCritSec).toBeGreaterThan(config.staleWarnSec);
  });

  it("overrides major symbols from env", () => {
    const config = resolveMintBurnFreshnessConfig({
      MINT_BURN_MAJOR_SYMBOLS: "USDC,DAI",
    });
    expect(config.majorSymbols).toEqual(["USDC", "DAI"]);
  });
});

describe("computeMintBurnSyncFreshnessStatus", () => {
  it.each([
    [1800, "fresh"], [3600, "fresh"], [4200, "degraded"],
    [5400, "degraded"], [7200, "stale"], [null, "stale"],
  ] as const)("returns %s-age freshness %s", (age, expected) => {
    expect(computeMintBurnSyncFreshnessStatus(10000, age === null ? null : 10000 - age)).toBe(expected);
  });

  it("rejects clocks beyond the inclusive future allowance", () => {
    expect(computeMintBurnSyncFreshnessStatus(10000, 10060)).toBe("fresh");
    expect(computeMintBurnSyncFreshnessStatus(10000, 10061)).toBe("stale");
    expect(computeMintBurnSyncFreshnessStatus(10000, Infinity)).toBe("stale");
  });
});
