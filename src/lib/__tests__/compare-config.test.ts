import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  ACTIVE_IDS,
  DELISTED_IDS,
  FROZEN_IDS,
  QUARANTINED_IDS,
} from "@shared/lib/stablecoins/registry";
import { readWatchlistSnapshot } from "@/lib/watchlist-storage";
import {
  COMPARE_COIN_OPTIONS,
  COMPARISON_PRESETS,
  MAX_COMPARE_COINS,
  getPresetCoins,
  parseIdList,
  resolveCompareSelectedIds,
} from "../compare-config";

vi.mock("@/lib/watchlist-storage", () => ({
  readWatchlistSnapshot: vi.fn<() => readonly string[]>(() => []),
}));

const watchlistPreset = COMPARISON_PRESETS.find((preset) => preset.getCoinsAtRuntime);
if (!watchlistPreset) throw new Error("expected a runtime-resolved watchlist preset");

describe("parseIdList", () => {
  it("trims, deduplicates, and caps generic id lists", () => {
    expect(parseIdList(" a, a, , b, c ", { max: 2 })).toEqual(["a", "b"]);
  });

  it("deduplicates normalized values, not raw segments", () => {
    expect(
      parseIdList(" AA , AB , B ", { max: 5, normalize: (value) => (value.length === 2 ? "pair" : value) }),
    ).toEqual(["pair", "B"]);
  });

  it("does not spend cap slots on rejected segments", () => {
    expect(
      parseIdList("a,rejected,b", { max: 2, normalize: (value) => (value === "rejected" ? null : value) }),
    ).toEqual(["a", "b"]);
  });
});

describe("resolveCompareSelectedIds", () => {
  it("keeps canonical ids only", () => {
    expect(resolveCompareSelectedIds("usdc-circle,usdt-tether")).toEqual([
      "usdc-circle",
      "usdt-tether",
    ]);
  });

  it("drops non-canonical selections", () => {
    expect(resolveCompareSelectedIds("usdt,1,usdc-circle")).toEqual([
      "usdc-circle",
    ]);
  });
});

describe("COMPARE_COIN_OPTIONS", () => {
  it("offers exactly the active and frozen ids, each once", () => {
    const ids = COMPARE_COIN_OPTIONS.map((option) => option.id);

    expect(new Set(ids).size).toBe(ids.length);
    expect(new Set(ids)).toEqual(new Set([...ACTIVE_IDS, ...FROZEN_IDS]));
  });

  it("excludes withheld records", () => {
    expect(COMPARE_COIN_OPTIONS.some((option) => QUARANTINED_IDS.has(option.id))).toBe(false);
    expect(COMPARE_COIN_OPTIONS.some((option) => DELISTED_IDS.has(option.id))).toBe(false);
  });

  it("flags frozen entries and only those", () => {
    const flaggedFrozen = COMPARE_COIN_OPTIONS.filter((option) => option.frozen === true).map(
      (option) => option.id,
    );

    expect(flaggedFrozen.length).toBeGreaterThan(0);
    expect(new Set(flaggedFrozen)).toEqual(new Set(FROZEN_IDS));
  });
});

describe("COMPARISON_PRESETS", () => {
  it("references only active or frozen comparable ids", () => {
    const staticPresetCoins = COMPARISON_PRESETS.flatMap((preset) => preset.coins);

    expect(staticPresetCoins.length).toBeGreaterThan(0);
    for (const id of staticPresetCoins) {
      expect(ACTIVE_IDS.has(id) || FROZEN_IDS.has(id), id).toBe(true);
    }
  });
});

describe("getPresetCoins", () => {
  beforeEach(() => {
    vi.mocked(readWatchlistSnapshot).mockReset();
    vi.mocked(readWatchlistSnapshot).mockReturnValue([]);
  });

  it("resolves static presets without consulting the watchlist", () => {
    const staticPreset = COMPARISON_PRESETS.find((preset) => !preset.getCoinsAtRuntime);
    if (!staticPreset) throw new Error("expected a static preset");

    expect(getPresetCoins(staticPreset)).toEqual(staticPreset.coins);
    expect(readWatchlistSnapshot).not.toHaveBeenCalled();
  });

  it("re-reads the watchlist snapshot on every resolution", () => {
    vi.mocked(readWatchlistSnapshot).mockReturnValueOnce(["usdc-circle", "usdt-tether"]);
    expect(getPresetCoins(watchlistPreset)).toEqual(["usdc-circle", "usdt-tether"]);

    vi.mocked(readWatchlistSnapshot).mockReturnValueOnce(["dai-makerdao"]);
    expect(getPresetCoins(watchlistPreset)).toEqual(["dai-makerdao"]);
  });

  it("keeps frozen coins while dropping unknown and withheld ids", () => {
    const [withheldId] = [...DELISTED_IDS];
    vi.mocked(readWatchlistSnapshot).mockReturnValue([
      "usdc-circle",
      "usr-resolv",
      "not-a-stablecoin",
      withheldId,
    ]);

    expect(FROZEN_IDS.has("usr-resolv")).toBe(true);
    expect(getPresetCoins(watchlistPreset)).toEqual(["usdc-circle", "usr-resolv"]);
  });

  it("caps the watchlist preset at the compare maximum", () => {
    const starred = [
      "usdc-circle",
      "usdt-tether",
      "dai-makerdao",
      "lusd-liquity",
      "eure-monerium",
      "usde-ethena",
    ];
    vi.mocked(readWatchlistSnapshot).mockReturnValue(starred);

    expect(starred.length).toBeGreaterThan(MAX_COMPARE_COINS);
    expect(getPresetCoins(watchlistPreset)).toEqual(starred.slice(0, MAX_COMPARE_COINS));
  });
});
