import { describe, expect, it } from "vitest";
import {
  BUSINESS_DAILY_FX_PEGS,
  CALENDAR_DAILY_FX_PEGS,
  getNaturalFxCadence,
  inferFxSourceCadence,
} from "../fx-cadence";

const BUSINESS_DAILY_PEGS = [
  "peggedEUR",
  "peggedGBP",
  "peggedCHF",
  "peggedREAL",
  "peggedJPY",
  "peggedIDR",
  "peggedSGD",
  "peggedTRY",
  "peggedAUD",
  "peggedZAR",
  "peggedCAD",
  "peggedCNY",
  "peggedPHP",
  "peggedMXN",
  "peggedMYR",
  "peggedKRW",
  "peggedHKD",
  "peggedINR",
];

const CALENDAR_DAILY_PEGS = [
  "peggedCNH",
  "peggedRUB",
  "peggedUAH",
  "peggedARS",
  "peggedKGS",
  "peggedNGN",
  "peggedXOF",
  "peggedVND",
  "peggedKES",
  "peggedGHS",
  "peggedCOP",
  "peggedCLP",
  "peggedPEN",
];

describe("fx cadence classification", () => {
  it("keeps the canonical business-daily and calendar-daily peg sets in parity", () => {
    expect([...BUSINESS_DAILY_FX_PEGS]).toEqual(BUSINESS_DAILY_PEGS);
    expect([...CALENDAR_DAILY_FX_PEGS]).toEqual(CALENDAR_DAILY_PEGS);
    expect(BUSINESS_DAILY_PEGS.filter((pegKey) => CALENDAR_DAILY_FX_PEGS.has(pegKey))).toEqual([]);
  });

  it.each(BUSINESS_DAILY_PEGS)("classifies %s as business-daily", (pegKey) => {
    expect(getNaturalFxCadence(pegKey)).toBe("business-daily");
    expect(inferFxSourceCadence(pegKey, "live")).toBe("business-daily");
    expect(inferFxSourceCadence(pegKey, "cached")).toBe("business-daily");
  });

  it.each(CALENDAR_DAILY_PEGS)("classifies %s as calendar-daily", (pegKey) => {
    expect(getNaturalFxCadence(pegKey)).toBe("calendar-daily");
    expect(inferFxSourceCadence(pegKey, "live")).toBe("calendar-daily");
    expect(inferFxSourceCadence(pegKey, "cached")).toBe("calendar-daily");
  });

  it.each(["peggedUSD", "peggedGOLD", "peggedSILVER", "peggedUNKNOWN"])(
    "classifies %s as intraday by default",
    (pegKey) => {
      expect(getNaturalFxCadence(pegKey)).toBeNull();
      expect(inferFxSourceCadence(pegKey, "live")).toBe("intraday");
      expect(inferFxSourceCadence(pegKey, "cached")).toBe("intraday");
    },
  );

  it("preserves explicit cadence before natural or hardcoded defaults", () => {
    expect(inferFxSourceCadence("peggedEUR", "live", "calendar-daily")).toBe("calendar-daily");
    expect(inferFxSourceCadence("peggedEUR", "hardcoded")).toBe("intraday");
    expect(inferFxSourceCadence("peggedEUR", "hardcoded", "business-daily")).toBe("business-daily");
  });
});
