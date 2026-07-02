import { describe, expect, it } from "vitest";
import {
  markStartHereOpened,
  normalizeStartHereCalloutState,
  shouldShowStartHereNavigation,
} from "@/lib/start-here-callout";

describe("normalizeStartHereCalloutState", () => {
  it("falls back to the default shape for invalid persisted data", () => {
    expect(normalizeStartHereCalloutState(null)).toEqual({
      homepageSessions: 0,
      hasOpenedStartHere: false,
    });

    expect(
      normalizeStartHereCalloutState({
        homepageSessions: -4,
        hasOpenedStartHere: "yes",
      }),
    ).toEqual({
      homepageSessions: 0,
      hasOpenedStartHere: false,
    });
  });
});

describe("markStartHereOpened", () => {
  it("sets the opened flag without resetting session history", () => {
    expect(
      markStartHereOpened({
        homepageSessions: 1,
        hasOpenedStartHere: false,
      }),
    ).toEqual({
      homepageSessions: 1,
      hasOpenedStartHere: true,
    });
  });
});

describe("shouldShowStartHereNavigation", () => {
  it("shows Start Here only for first-session users who have not opened it", () => {
    expect(
      shouldShowStartHereNavigation({
        homepageSessions: 0,
        hasOpenedStartHere: false,
      }),
    ).toBe(true);

    expect(
      shouldShowStartHereNavigation({
        homepageSessions: 1,
        hasOpenedStartHere: false,
      }),
    ).toBe(true);

    expect(
      shouldShowStartHereNavigation({
        homepageSessions: 2,
        hasOpenedStartHere: false,
      }),
    ).toBe(false);

    expect(
      shouldShowStartHereNavigation({
        homepageSessions: 0,
        hasOpenedStartHere: true,
      }),
    ).toBe(false);
  });
});
