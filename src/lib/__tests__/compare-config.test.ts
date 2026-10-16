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
  getPresetCoins,
  parseIdList,
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
});

describe("getPresetCoins", () => {
  beforeEach(() => {
    vi.mocked(readWatchlistSnapshot).mockReset();
    vi.mocked(readWatchlistSnapshot).mockReturnValue([]);
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
});
