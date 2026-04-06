import { describe, expect, it } from "vitest";
import {
  evaluateHomepageStartHereCallout,
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

describe("evaluateHomepageStartHereCallout", () => {
  it("shows the callout during the first homepage session", () => {
    const evaluation = evaluateHomepageStartHereCallout(
      {
        homepageSessions: 0,
        hasOpenedStartHere: false,
      },
      false,
    );

    expect(evaluation).toEqual({
      nextState: {
        homepageSessions: 1,
        hasOpenedStartHere: false,
      },
      shouldPersist: true,
      shouldShow: true,
    });
  });

  it("does not increment again within the same browser session", () => {
    const evaluation = evaluateHomepageStartHereCallout(
      {
        homepageSessions: 1,
        hasOpenedStartHere: false,
      },
      true,
    );

    expect(evaluation).toEqual({
      nextState: {
        homepageSessions: 1,
        hasOpenedStartHere: false,
      },
      shouldPersist: false,
      shouldShow: true,
    });
  });

  it("hides the callout from the second distinct homepage session onward", () => {
    const evaluation = evaluateHomepageStartHereCallout(
      {
        homepageSessions: 1,
        hasOpenedStartHere: false,
      },
      false,
    );

    expect(evaluation).toEqual({
      nextState: {
        homepageSessions: 2,
        hasOpenedStartHere: false,
      },
      shouldPersist: true,
      shouldShow: false,
    });
  });

  it("keeps the callout hidden after the Start Here page has been opened", () => {
    const evaluation = evaluateHomepageStartHereCallout(
      {
        homepageSessions: 0,
        hasOpenedStartHere: true,
      },
      false,
    );

    expect(evaluation.shouldShow).toBe(false);
    expect(evaluation.nextState).toEqual({
      homepageSessions: 1,
      hasOpenedStartHere: true,
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
