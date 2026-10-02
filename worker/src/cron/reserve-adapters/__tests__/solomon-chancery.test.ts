import { describe, expect, it } from "vitest";
import { adaptSolomonChanceryBacking } from "../solomon-chancery";

function backing() {
  return {
    status: "available",
    sourceAt: "2026-10-02T07:33:01.604Z",
    data: {
      mint: "USDvUSpnhCr9yBgj3UyVrD239HRUv4RsHwH2FxsWuMk",
      reserveAuthority: "8anxfyoftY9hPwxdvReet2beFS2HXjcXraPEamo4nGyB",
      asOf: "2026-10-02T07:33:01.604Z",
      totalUsd: "7359399.9394",
      valuation: "Known stablecoins valued at USD 1 per token",
      holdings: [
        { mint: "2u1tszSeqZ3qBWF3uNGPFc8TzMk2tdiwknnRMWGWjGWH", symbol: "USDG", vaultAddress: "6gXnsjMkrgC7zKsniUFPasEnPRVSecH3AwoKWjUTdXHg", decimals: 6, amount: "7008499.81", amountRaw: "7008499810000", amountUsd: "7008499.81" },
        { mint: "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v", symbol: "USDC", vaultAddress: "DsqFVh7MTDpj5P7pv95zyBMihVhctUh7o76E46M3bsr2", decimals: 6, amount: "350900.1294", amountRaw: "350900129400", amountUsd: "350900.1294" },
        { mint: "2b1kV6DkPAnxd5ixfnxCpjxmKwqjjaYmCZfHsFu24GXo", symbol: "PYUSD", vaultAddress: "BPjKgsrV45B2QXgarVHc7oEE39oBqTcdYU8BK2EFNMde", decimals: null, amount: "0", amountRaw: "0", amountUsd: "0" },
        { mint: "Es9vMFrzaCERmJfrF4H2FYD4KCoNkY11McCe8BenwNYB", symbol: "USDT", vaultAddress: "7Dv22TUWgaeTJcXtW8KNhrXkSBVaT8Cvrg3yr2cb1kRC", decimals: null, amount: "0", amountRaw: "0", amountUsd: "0" },
      ],
    },
  };
}

describe("replacement USDv selected reserve account probe", () => {
  it("reports nominal selected-account composition without whole-token coverage or redemption claims", () => {
    const result = adaptSolomonChanceryBacking(backing());
    expect(result.slices.find((slice) => slice.coinId === "usdg-paxos")?.pct).toBeCloseTo(95.23195, 4);
    expect(result.slices.find((slice) => slice.coinId === "usdc-circle")?.pct).toBeCloseTo(4.76805, 4);
    expect(result.metadata?.supplyUsd).toBeUndefined();
    expect(result.metadata?.collateralizationRatio).toBeUndefined();
    expect(result.metadata?.redemption).toBeUndefined();
    expect(result.metadata?.details).toMatchObject({ scope: "selected-reserve-authority-accounts", financialAssurance: false });
    expect(result.warnings).toContainEqual(expect.objectContaining({ code: "selected-reserve-scope", effect: "info" }));
  });

  it.each(["legacy-mint", "duplicate", "changed-vault", "unavailable", "stale-serving-clock", "negative", "raw-mismatch", "unreconciled-total"])("rejects %s instead of silently publishing a favorable composition", (failure) => {
    const payload = backing();
    if (failure === "legacy-mint") payload.data.mint = "Ex5DaKYMCN6QWFA4n67TmMwsH8MJV68RX6YXTmVM532C";
    if (failure === "duplicate") payload.data.holdings[1] = { ...payload.data.holdings[0] };
    if (failure === "changed-vault") payload.data.holdings[0].vaultAddress = "other-account";
    if (failure === "unavailable") payload.status = "unavailable";
    if (failure === "stale-serving-clock") payload.sourceAt = "2026-10-01T07:33:01.604Z";
    if (failure === "negative") payload.data.holdings[0].amountUsd = "-1";
    if (failure === "raw-mismatch") payload.data.holdings[0].amountRaw = "1";
    if (failure === "unreconciled-total") payload.data.totalUsd = "8000000";
    expect(() => adaptSolomonChanceryBacking(payload)).toThrow(/solomon-chancery/);
  });
});
