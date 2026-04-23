import { describe, expect, it } from "vitest";
import { adaptMentoReserveComposition, parseMentoReserveComposition } from "../mento";
import { getReserveAdapter } from "../index";
import { validateAdapterOutput } from "../validate";

const SAMPLE_PAYLOAD = {
  collateral: {
    assets: [
      { symbol: "sUSDS", percentage: 50 },
      { symbol: "EURC", percentage: 10 },
      { symbol: "axlEUROC", percentage: 5 },
      { symbol: "CELO", percentage: 15 },
      { symbol: "USDGLO", percentage: 5 },
      { symbol: "stETH", percentage: 3 },
      { symbol: "USDT", percentage: 4 },
      { symbol: "USDC", percentage: 2 },
      { symbol: "axlUSDC", percentage: 1 },
      { symbol: "AUSD", percentage: 4 },
      { symbol: "WETH", percentage: 1 },
    ],
  },
};

describe("mento adapter", () => {
  it("parses reserve entries from the analytics API payload", () => {
    const entries = parseMentoReserveComposition(SAMPLE_PAYLOAD);
    expect(entries).toEqual([
      { symbol: "sUSDS", percent: 50 },
      { symbol: "EURC", percent: 10 },
      { symbol: "axlEUROC", percent: 5 },
      { symbol: "CELO", percent: 15 },
      { symbol: "USDGLO", percent: 5 },
      { symbol: "stETH", percent: 3 },
      { symbol: "USDT", percent: 4 },
      { symbol: "USDC", percent: 2 },
      { symbol: "axlUSDC", percent: 1 },
      { symbol: "AUSD", percent: 4 },
      { symbol: "WETH", percent: 1 },
    ]);
  });

  it("maps the analytics payload into Pharos reserve slices", () => {
    const result = adaptMentoReserveComposition(SAMPLE_PAYLOAD);
    expect(result.slices).toEqual([
      { name: "sUSDS (Sky savings USDS)", pct: 50, risk: "low", coinId: "usds-sky" },
      { name: "EURC (Circle euro stablecoin)", pct: 15, risk: "low", coinId: "eurc-circle" },
      { name: "CELO", pct: 15, risk: "high" },
      { name: "USDGLO (Glo Dollar)", pct: 5, risk: "low" },
      { name: "USDT", pct: 4, risk: "low", coinId: "usdt-tether" },
      { name: "AUSD (Agora Dollar)", pct: 4, risk: "low", coinId: "ausd-agora" },
      { name: "stETH (Lido staked ETH)", pct: 3, risk: "low" },
      { name: "USDC", pct: 3, risk: "low", coinId: "usdc-circle" },
      { name: "ETH", pct: 1, risk: "very-low" },
    ]);
    expect(result.warnings).toBeUndefined();
  });

  it("emits a structural integrity warning when fewer than 3 reserve entries are parsed", () => {
    const twoEntryPayload = {
      collateral: {
        assets: [
          { symbol: "USDC", percentage: 80 },
          { symbol: "WETH", percentage: 20 },
        ],
      },
    };

    const result = adaptMentoReserveComposition(twoEntryPayload);
    expect(result.warnings).toBeDefined();
    expect(result.warnings!.some((warning) => warning.code === "mento-low-entry-count")).toBe(true);
  });

  it("rejects reserve payloads whose percentages do not cover the full reserve mix", () => {
    const lowPctPayload = {
      collateral: {
        assets: [
          { symbol: "USDC", percentage: 10 },
          { symbol: "WETH", percentage: 5 },
          { symbol: "CELO", percentage: 3 },
        ],
      },
    };

    expect(() => adaptMentoReserveComposition(lowPctPayload)).toThrow("sum to 18.0%");
  });

  it("throws on missing collateral assets", () => {
    expect(() => parseMentoReserveComposition({})).toThrow("layout-changed");
  });

  it("throws when collateral assets contain no usable entries", () => {
    expect(() => parseMentoReserveComposition({
      collateral: {
        assets: [{ symbol: 123, percentage: "40" }],
      },
    })).toThrow("layout-changed");
  });

  it("annotates freshness as explicitly unverified with reason metadata", () => {
    const result = adaptMentoReserveComposition(SAMPLE_PAYLOAD);
    expect(result.metadata).toMatchObject({
      freshnessMode: "unverified",
      details: {
        freshnessSource: "mento-analytics-api",
      },
      stableReservePct: 81,
    });
  });

  it("emits an unknown-asset warning for symbols not in TOKEN_CONFIG", () => {
    const unknownTokenPayload = {
      collateral: {
        assets: [
          { symbol: "USDC", percentage: 50 },
          { symbol: "WETH", percentage: 30 },
          { symbol: "NEW_TOKEN", percentage: 10 },
          { symbol: "CELO", percentage: 10 },
        ],
      },
    };
    const result = adaptMentoReserveComposition(unknownTokenPayload);
    expect(result.warnings).toBeDefined();
    expect(result.warnings!.some((warning) => warning.code === "unknown-asset" && warning.message.includes("NEW_TOKEN"))).toBe(true);
  });

  it("produces reserve output that passes adapter validation", () => {
    const result = adaptMentoReserveComposition(SAMPLE_PAYLOAD);
    expect(validateAdapterOutput(result, { adapter: getReserveAdapter("mento") ?? undefined }).valid).toBe(true);
  });
});
