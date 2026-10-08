import { describe, expect, it } from "vitest";
import { createEmptyGtProbeStats } from "../geckoterminal-price-probe-stats";

describe("GeckoTerminal probe run statistics", () => {
  it("starts each run with no observations and independent transport budgets", () => {
    const previous = createEmptyGtProbeStats();
    previous.probed = 3;
    previous.pricesObtained = 1;
    previous.budgetExhausted = true;
    previous.budgetSkipped = 2;
    previous.transports.coingeckoOnchain.attempted = 3;
    previous.transports.coingeckoOnchain.upstreamErrors = 2;
    previous.transports.geckoTerminalPublic.priced = 1;

    const next = createEmptyGtProbeStats();
    expect(next.probed).toBe(0);
    expect(next.pricesObtained).toBe(0);
    expect(next.budgetExhausted).toBe(false);
    expect(next.budgetSkipped).toBe(0);
    expect(next.transports.coingeckoOnchain.attempted).toBe(0);
    expect(next.transports.coingeckoOnchain.upstreamErrors).toBe(0);
    expect(next.transports.geckoTerminalPublic.priced).toBe(0);
    next.transports.coingeckoOnchain.lookupMisses++;
    expect(next.transports.geckoTerminalPublic.lookupMisses).toBe(0);
    expect(previous.transports.coingeckoOnchain.lookupMisses).toBe(0);
    expect(previous.budgetExhausted).toBe(true);
    expect(previous.pricesObtained).toBe(1);
  });
});
