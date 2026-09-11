import { describe, expect, it } from "vitest";
import {
  markStartHereOpened,
  normalizeStartHereCalloutState,
  shouldShowStartHereNavigation,
} from "@/lib/start-here-callout";

describe("normalizeStartHereCalloutState", () => {
  it("falls back to the default shape for invalid persisted data", () => {
    expect(normalizeStartHereCalloutState(null)).toEqual({ hasOpenedStartHere: false });
    expect(normalizeStartHereCalloutState({ hasOpenedStartHere: "yes" })).toEqual({
      hasOpenedStartHere: false,
    });
  });

  it("ignores the legacy homepageSessions field from older stored state", () => {
    expect(normalizeStartHereCalloutState({ homepageSessions: 3, hasOpenedStartHere: true })).toEqual({
      hasOpenedStartHere: true,
    });
  });
});

describe("markStartHereOpened", () => {
  it("sets the opened flag", () => {
    expect(markStartHereOpened({ hasOpenedStartHere: false })).toEqual({ hasOpenedStartHere: true });
  });

  it("leaves already-opened state untouched", () => {
    expect(markStartHereOpened({ hasOpenedStartHere: true })).toEqual({ hasOpenedStartHere: true });
  });
});

describe("shouldShowStartHereNavigation", () => {
  it("shows Start Here until it has been opened once", () => {
    expect(shouldShowStartHereNavigation({ hasOpenedStartHere: false })).toBe(true);
    expect(shouldShowStartHereNavigation({ hasOpenedStartHere: true })).toBe(false);
  });
});
