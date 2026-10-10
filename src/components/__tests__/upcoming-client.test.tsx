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

  it.each([undefined, [], [{ date: "2026-06", setOn: "2026-01-01" }], [{ date: "2026-05", setOn: "2026-01-01" }, { date: "2026-06", setOn: "2026-02-01" }]])(
    "marks elapsed targets overdue independently of revisions (%j)",
    (dateHistory) => {
      window.history.replaceState(null, "", "/upcoming/");
      vi.useFakeTimers();
      vi.setSystemTime(new Date("2026-07-02T00:00:00Z"));
      render(<UpcomingClient coins={[{ ...PRE_LAUNCH_STABLECOINS[0], expectedLaunchDate: "2026-06", dateHistory }]} logos={{}} teasers={{}} />);
      expect(screen.getByText("Overdue")).toBeTruthy();
    },
  );

  it("expires an unrevised target only at the next UTC midnight without a rerender or refetch", () => {
    window.history.replaceState(null, "", "/upcoming/");
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-06-30T23:59:59.999Z"));
    render(<UpcomingClient coins={[{ ...PRE_LAUNCH_STABLECOINS[0], expectedLaunchDate: "2026-Q2" }]} logos={{}} teasers={{}} />);
    expect(screen.queryByText("Overdue")).toBeNull();
    act(() => vi.advanceTimersByTime(1));
    expect(screen.getByText("Overdue")).toBeTruthy();
  });

  it("renders AI-summary term markers as plain labels inside linked teaser cards", () => {
    const preLaunchId = "fixture-announced";

    const { container } = render(
      <UpcomingClient
        coins={PRE_LAUNCH_STABLECOINS}
        logos={{}}
        teasers={{
          [preLaunchId]:
            "An {{term:overcollateralization}}overcollateralized{{/term}} note parked in {{term:money-market-fund}}MMFs{{/term}}.",
        }}
      />,
    );
    const text = container.textContent ?? "";

    expect(text).not.toContain("{{term:");
    expect(text).not.toContain("{{/term}}");
    expect(text).toContain("overcollateralized");
    expect(text).toContain("MMFs");
  });

  it("hydrates phase and sort filters from the URL", () => {
    window.history.replaceState(null, "", "/upcoming/?phase=beta&sort=alphabetical");

    render(
      <UpcomingClient
        coins={PRE_LAUNCH_STABLECOINS}
        logos={{}}
        teasers={{}}
      />,
    );

    expect(screen.getByRole("button", { name: "Beta" }).getAttribute("aria-pressed")).toBe("true");
    expect(screen.getByRole("button", { name: "Name" }).getAttribute("aria-pressed")).toBe("true");
  });
});
