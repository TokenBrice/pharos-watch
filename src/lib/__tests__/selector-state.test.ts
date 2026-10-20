import { describe, expect, it } from "vitest";
import {
  DEPEG_TOLERANCE_VALUES,
  EXIT_SPEED_VALUES,
  HORIZON_VALUES,
  SELECTOR_ELIGIBLE_PEG_CURRENCIES,
  SELECTOR_PROFILES,
} from "@shared/lib/selector/types";
import { decodeSelectorState, encodeSelectorState } from "@/lib/selector-state";
import { VENUE_OPTIONS_BY_PROFILE } from "@/lib/selector-options";

describe("selector URL vocabulary parity", () => {
  it.each([
    ["p", "profile", SELECTOR_PROFILES],
    ["peg", "pegCurrency", SELECTOR_ELIGIBLE_PEG_CURRENCIES],
    ["h", "horizon", HORIZON_VALUES],
    ["d", "depegTolerance", DEPEG_TOLERANCE_VALUES],
    ["u", "exitSpeed", EXIT_SPEED_VALUES],
  ] as const)("round-trips every canonical %s value", (key, field, values) => {
    for (const value of values) {
      const state = decodeSelectorState(`${key}=${value}`);
      expect(state[field]).toBe(value);
      expect(encodeSelectorState(state).toString()).toBe(key === "peg" && value === "USD" ? "" : `${key}=${value}`);
    }
    expect(decodeSelectorState(`${key}=invalid`)[field]).toBe(key === "peg" ? "USD" : null);
  });

  it.each([
    ["treasury", ["custody", "some", "active"], "spot,active,custody,all", ["active"]],
    ["yield", ["lend", "dex", "wrap", "all"], "cex,wrap,dex,wrap,custody", ["wrap", "dex"]],
    ["trading", ["cex", "perps", "spot", "all"], "lend,spot,cex,spot,custody", ["spot", "cex"]],
  ] as const)("preserves %s option order and prunes foreign venues", (profile, options, raw, expected) => {
    expect(VENUE_OPTIONS_BY_PROFILE[profile].map((option) => option.value)).toEqual(options);
    const state = decodeSelectorState(`p=${profile}&v=${raw}`);
    expect(state.venue).toEqual(expected);
    expect(encodeSelectorState(state).toString()).toBe(`p=${profile}&v=${expected.join("%2C")}`);
    expect(decodeSelectorState(`p=${profile}&v=${options.join(",")}`).venue).toEqual(
      profile === "treasury" ? ["custody"] : ["all"],
    );
  });
});
