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
  // MINT_BURN_PUBLIC_FRESHNESS_MAX_AGE_SEC = 40 * 60 = 2400
  const MAX_AGE = 2400;

  it("returns fresh when age ratio <= 1.0", () => {
    expect(computeMintBurnSyncFreshnessStatus(10000, 10000 - 1200)).toBe("fresh");
    expect(computeMintBurnSyncFreshnessStatus(10000, 10000 - MAX_AGE)).toBe("fresh");
  });

  it("returns degraded when age ratio <= 1.5", () => {
    expect(computeMintBurnSyncFreshnessStatus(10000, 10000 - 2880)).toBe("degraded");
    expect(computeMintBurnSyncFreshnessStatus(10000, 10000 - 3600)).toBe("degraded");
  });

  it("returns stale when age ratio > 1.5", () => {
    expect(computeMintBurnSyncFreshnessStatus(10000, 10000 - 4800)).toBe("stale");
  });

  it("returns stale when lastSuccessfulSyncAt is null", () => {
    expect(computeMintBurnSyncFreshnessStatus(10000, null)).toBe("stale");
  });
});
