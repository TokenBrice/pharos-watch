import { describe, it, expect } from "vitest";
import { PAUSE_SENTINEL_TS } from "@shared/lib/telegram-delivery-policy";
import { coinCoverage, familyCoverage, formatAgo, formatClock, formatSnoozeUntil, formatTimeZoneCity, hasAnyCoverage } from "./format";
import { coinSummary, sortCoinsByRank } from "./components/HomeScreen";
import { largestBaseCoins, searchCatalog } from "./components/AddCoinsScreen";
import { makeMiniAppState, makeSubscribedCoin as makeCoin } from "@shared/test-utils/telegram-mini-app-state";
import type { CatalogCoin, FollowedPreset, TelegramMiniAppState } from "./types";

type GlobalAlerts = TelegramMiniAppState["subscriber"]["globalAlerts"];

const NO_GLOBAL: GlobalAlerts = { dews: false, depeg: false, safety: false, launch: false, reserve: false, freeze: false, depegStepBps: null };

function makePreset(alertTypes: Partial<FollowedPreset["alertTypes"]>, memberIds: string[] | null = ["usdc-circle"]): FollowedPreset {
  return {
    id: "usd-top25",
    label: "USD Top 25",
    alertTypes: { dews: false, depeg: false, safety: false, ...alertTypes },
    depegStepBps: null,
    memberIds,
  };
}

describe("familyCoverage", () => {
  it("reports this coin's own enabled family as on, winning over inherited sources", () => {
    expect(familyCoverage("usdc-circle", makeCoin({ dews: true }), "dews", { ...NO_GLOBAL, dews: true }, [makePreset({ dews: true })])).toEqual({ kind: "on" });
  });

  it("names the group a coin currently belongs to, preferring it over All stablecoins", () => {
    expect(familyCoverage("usdc-circle", null, "depeg", { ...NO_GLOBAL, depeg: true }, [makePreset({ depeg: true })]))
      .toEqual({ kind: "via", source: "USD Top 25" });
    expect(familyCoverage("usdt-tether", null, "depeg", { ...NO_GLOBAL, depeg: true }, [makePreset({ depeg: true })]))
      .toEqual({ kind: "via", source: "All stablecoins" });
  });

  it("does not claim group coverage for a non-member", () => {
    expect(familyCoverage("usdt-tether", null, "depeg", NO_GLOBAL, [makePreset({ depeg: true })])).toEqual({ kind: "off" });
  });

  it("distinguishes an explicit mute from an unmarked off flag", () => {
    const preset = [makePreset({ depeg: true })];
    expect(familyCoverage("usdc-circle", makeCoin({}, { depeg: true }), "depeg", NO_GLOBAL, preset)).toEqual({ kind: "muted", source: "USD Top 25" });
    expect(familyCoverage("usdc-circle", makeCoin({}, { depeg: true }), "depeg", { ...NO_GLOBAL, depeg: true }, [])).toEqual({ kind: "muted", source: "All stablecoins" });
    expect(familyCoverage("usdc-circle", makeCoin({}), "depeg", NO_GLOBAL, preset)).toEqual({ kind: "via", source: "USD Top 25" });
    // A mute with nothing to suppress is simply off.
    expect(familyCoverage("usdc-circle", makeCoin({}, { safety: true }), "safety", NO_GLOBAL, preset)).toEqual({ kind: "off" });
  });

  it("reports unknown, never off or on, when group membership could not be read", () => {
    expect(familyCoverage("usdc-circle", null, "dews", NO_GLOBAL, [makePreset({ dews: true }, null)])).toEqual({ kind: "unknown", source: "USD Top 25" });
    expect(familyCoverage("usdc-circle", null, "dews", { ...NO_GLOBAL, dews: true }, [makePreset({ dews: true }, null)]))
      .toEqual({ kind: "via", source: "All stablecoins" });
    // A per-coin mute over unreadable membership stays unknown: it can't claim to suppress anything.
    expect(familyCoverage("usdc-circle", makeCoin({}, { dews: true }), "dews", NO_GLOBAL, [makePreset({ dews: true }, null)]))
      .toEqual({ kind: "unknown", source: "USD Top 25" });
  });

  it("never inherits reserve or freeze from groups", () => {
    const preset = [makePreset({ dews: true })];
    expect(familyCoverage("usdc-circle", null, "reserve", NO_GLOBAL, preset)).toEqual({ kind: "off" });
    expect(familyCoverage("usdc-circle", null, "freeze", { ...NO_GLOBAL, freeze: true }, preset)).toEqual({ kind: "via", source: "All stablecoins" });
  });

  it("covers only live families in coinCoverage", () => {
    const coverage = coinCoverage("usdc-circle", makeCoin({ launch: true }), makeMiniAppState({ subscriber: { globalAlerts: NO_GLOBAL } }));
    expect(Object.keys(coverage)).not.toContain("launch");
  });
});

describe("hasAnyCoverage", () => {
  it("ignores retained subscriber rows with nothing enabled", () => {
    expect(hasAnyCoverage(makeMiniAppState({ subscriber: { globalAlerts: NO_GLOBAL }, subscriptions: [] }))).toBe(false);
    expect(hasAnyCoverage(makeMiniAppState({ subscriber: { exists: false } }))).toBe(false);
    expect(hasAnyCoverage(makeMiniAppState({ subscriber: { globalAlerts: NO_GLOBAL }, subscriptions: [], presets: [makePreset({ dews: true })] }))).toBe(true);
  });
});

describe("coinSummary", () => {
  const state = makeMiniAppState({ subscriber: { globalAlerts: NO_GLOBAL }, presets: [makePreset({ dews: true, depeg: true })] });

  it("summarizes active, inherited and muted families", () => {
    expect(coinSummary(makeCoin({ dews: true, safety: true }), state)).toBe("DEWS · Depeg · Safety");
    expect(coinSummary(makeCoin({ launch: true }), state)).toBe("DEWS · Depeg via USD Top 25");
    expect(coinSummary(makeCoin({ dews: true }, { depeg: true }), state)).toBe("DEWS · Depeg muted");
    expect(coinSummary({ ...makeCoin({}), stablecoinId: "usdt-tether" }, state)).toBe("No alerts");
  });

  it("names families whose preset membership can't be read instead of saying No alerts", () => {
    const unknownState = makeMiniAppState({ subscriber: { globalAlerts: NO_GLOBAL }, presets: [makePreset({ dews: true, depeg: true }, null)] });
    expect(coinSummary(makeCoin({}), unknownState)).toBe("DEWS · Depeg can't be checked");
    expect(coinSummary(makeCoin({ safety: true }, { dews: true }), unknownState)).toBe("Safety · DEWS · Depeg can't be checked");
  });
});

describe("ranking", () => {
  const coin = (stablecoinId: string, symbol: string, name: string, rank?: number): CatalogCoin => ({ stablecoinId, symbol, name, peg: "USD", ...(rank ? { rank } : {}) });
  const catalog = [coin("usd0-usual", "USD0", "Usual USD", 70), coin("usdc-circle", "USDC", "USD Coin", 6), coin("usdt-tether", "USDT", "Tether", 1), coin("ausd", "AUSD", "Agora USD", 90)];

  it("ranks exact symbol, then prefix, then name/substring matches, ties by market cap", () => {
    expect(searchCatalog(catalog, "usd").map((entry) => entry.symbol)).toEqual(["USDT", "USDC", "USD0", "AUSD"]);
    expect(searchCatalog(catalog, "USDC").map((entry) => entry.symbol)).toEqual(["USDC"]);
    expect(searchCatalog(catalog, " ")).toEqual([]);
  });

  it("leads the default list with base stablecoins while search still finds variants", () => {
    const withVariants = [
      { ...coin("usdt-tether", "USDT", "Tether", 1), variant: false },
      { ...coin("susdt-spark", "spUSDT", "Spark Savings USDT", 2), variant: true },
      { ...coin("usdc-circle", "USDC", "USD Coin", 6), variant: false },
    ];
    expect(largestBaseCoins(withVariants, new Set(["usdc-circle"])).map((entry) => entry.symbol)).toEqual(["USDT"]);
    expect(searchCatalog(withVariants, "spusdt").map((entry) => entry.symbol)).toEqual(["spUSDT"]);
  });

  it("sorts followed coins by rank with unranked coins last", () => {
    const rankById = new Map([["usdt-tether", 1], ["usdc-circle", 6]]);
    expect(sortCoinsByRank([
      { stablecoinId: "zzz", symbol: "ZZZ" },
      { stablecoinId: "usdc-circle", symbol: "USDC" },
      { stablecoinId: "usdt-tether", symbol: "USDT" },
    ], rankById).map((entry) => entry.symbol)).toEqual(["USDT", "USDC", "ZZZ"]);
  });
});

describe("time formatting", () => {
  const now = Date.UTC(2026, 9, 21, 10, 0) / 1000;

  it("formats clocks in the user's timezone and adds the weekday on other days", () => {
    expect(formatClock(now + 3600, "Europe/Paris", now)).toBe("13:00");
    expect(formatClock(now + 3600, "America/New_York", now)).toBe("07:00");
    expect(formatClock(now + 2 * 86_400, "UTC", now)).toBe("Fri 10:00");
  });

  it("labels snooze and pause, relative ages and city names", () => {
    expect(formatSnoozeUntil(now + 3600, "UTC", now)).toBe("Snoozed until 11:00");
    expect(formatSnoozeUntil(PAUSE_SENTINEL_TS, "UTC", now)).toBe("Paused until you resume");
    expect(formatAgo(null, now)).toBe("Not yet");
    expect(formatAgo(now - 3 * 3600, now)).toBe("3 h ago");
    expect(formatAgo(now - 86_400, now)).toBe("Yesterday");
    expect(formatTimeZoneCity("America/Los_Angeles")).toBe("Los Angeles");
    expect(formatTimeZoneCity(null)).toBe("UTC");
  });
});
