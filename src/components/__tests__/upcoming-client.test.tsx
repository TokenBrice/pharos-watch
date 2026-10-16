// @vitest-environment jsdom

import { act, cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { makeStablecoinMeta } from "@shared/test-utils/stablecoin";

vi.mock("next/link", async () => {
  const { createNextLinkMock } = await import("@/test-utils/frontend");
  return createNextLinkMock();
});

vi.mock("next/image", () => ({
  default: ({ alt }: { alt: string }) => <img alt={alt} />,
}));

const { UpcomingClient } = await import("../upcoming-client");
const PRE_LAUNCH_STABLECOINS = [
  makeStablecoinMeta({ id: "fixture-announced", name: "Announced Coin", status: "pre-launch", launchPhase: "announced" }),
  makeStablecoinMeta({ id: "fixture-beta", name: "Beta Coin", status: "pre-launch", launchPhase: "beta" }),
];

describe("UpcomingClient", () => {
  afterEach(() => { cleanup(); vi.useRealTimers(); });


  it("expires an unrevised target only at the next UTC midnight without a rerender or refetch", () => {
    window.history.replaceState(null, "", "/upcoming/");
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-06-30T23:59:59.999Z"));
    render(<UpcomingClient coins={[{ ...PRE_LAUNCH_STABLECOINS[0], expectedLaunchDate: "2026-Q2" }]} logos={{}} teasers={{}} />);
    expect(screen.queryByText("Overdue")).toBeNull();
    act(() => vi.advanceTimersByTime(1));
    expect(screen.getByText("Overdue")).toBeTruthy();
  });

});
