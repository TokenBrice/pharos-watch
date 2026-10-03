import { describe, expect, it } from "vitest";
import {
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
  "peggedCZK",
  "peggedPLN",
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
  "peggedAED",
];

describe("fx cadence classification", () => {

  it.each(BUSINESS_DAILY_PEGS)("classifies %s as business-daily", (pegKey) => {
    expect(getNaturalFxCadence(pegKey)).toBe("business-daily");
    expect(inferFxSourceCadence(pegKey)).toBe("business-daily");
  });

  it.each(CALENDAR_DAILY_PEGS)("classifies %s as calendar-daily", (pegKey) => {
    expect(getNaturalFxCadence(pegKey)).toBe("calendar-daily");
    expect(inferFxSourceCadence(pegKey)).toBe("calendar-daily");
  });

  it.each(["peggedUSD", "peggedGOLD", "peggedSILVER", "peggedUNKNOWN"])(
    "classifies %s as intraday by default",
    (pegKey) => {
      expect(getNaturalFxCadence(pegKey)).toBeNull();
      expect(inferFxSourceCadence(pegKey)).toBe("intraday");
    },
  );

  it("preserves explicit cadence before the natural default", () => {
    expect(inferFxSourceCadence("peggedEUR", "calendar-daily")).toBe("calendar-daily");
    expect(inferFxSourceCadence("peggedEUR", "business-daily")).toBe("business-daily");
  });
});
