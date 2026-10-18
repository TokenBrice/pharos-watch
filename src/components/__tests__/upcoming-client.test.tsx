// @vitest-environment jsdom

import { act, cleanup, fireEvent, render, screen, within } from "@testing-library/react";
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

function table() {
  return within(screen.getByTestId("upcoming-table"));
}

function rowNames(): string[] {
  return table()
    .getAllByRole("link")
    .filter((link) => link.getAttribute("href")?.startsWith("/stablecoin/"))
    .map((link) => link.textContent ?? "");
}

describe("UpcomingClient", () => {
  afterEach(() => { cleanup(); vi.useRealTimers(); });

  it("expires an unrevised target only at the next UTC midnight without a rerender or refetch", () => {
    window.history.replaceState(null, "", "/upcoming/");
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-06-30T23:59:59.999Z"));
    render(<UpcomingClient coins={[{ ...PRE_LAUNCH_STABLECOINS[0], expectedLaunchDate: "2026-Q2" }]} logos={{}} teasers={{}} />);
    expect(table().queryByText("Overdue")).toBeNull();
    act(() => vi.advanceTimersByTime(1));
    expect(table().getByText("Overdue")).toBeTruthy();
  });

  it("reads Slipped and the soonest open target from the visitor clock, skipping overdue targets", () => {
    window.history.replaceState(null, "", "/upcoming/");
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-07-15T00:00:00Z"));
    render(
      <UpcomingClient
        coins={[
          { ...PRE_LAUNCH_STABLECOINS[0], expectedLaunchDate: "2026-Q2" },
          { ...PRE_LAUNCH_STABLECOINS[1], expectedLaunchDate: "2026-Q4", dateHistory: [{ date: "2026-Q3", setOn: "2026-01-01" }] },
          makeStablecoinMeta({ id: "fixture-unphased", name: "Unphased Coin", status: "pre-launch" }),
        ]}
        logos={{}}
        teasers={{}}
      />,
    );
    const slipped = screen.getByText("Slipped").parentElement!;
    expect(within(slipped).getByText("2")).toBeTruthy();
    const soonest = screen.getByText("Soonest open target").parentElement!;
    expect(within(soonest).getByText("Beta Coin")).toBeTruthy();
    expect(within(soonest).getByText("Q4 2026")).toBeTruthy();
    // The missing target is explicit, not blank.
    expect(table().getAllByText("—").length).toBeGreaterThan(0);
    // The chip names the set instead of restating the beam.
    expect(screen.getByRole("button", { name: /Universe: Pre-launch, not yet live/ })).toBeTruthy();
  });

  it("shows a retired target as a neutral No current target, not counted in Slipped", () => {
    window.history.replaceState(null, "", "/upcoming/");
    render(
      <UpcomingClient
        coins={[{ ...PRE_LAUNCH_STABLECOINS[0], dateHistory: [{ date: "2026-Q1", setOn: "2025-06-01" }] }]}
        logos={{}}
        teasers={{}}
      />,
    );
    expect(table().getByText("No current target")).toBeTruthy();
    expect(screen.getByText("Slipped").parentElement!.textContent).toMatch(/^Slipped0/);
  });

  it("counts unphased coins in the phase filter so the pills sum to the tracked count", () => {
    window.history.replaceState(null, "", "/upcoming/");
    render(
      <UpcomingClient
        coins={[...PRE_LAUNCH_STABLECOINS, makeStablecoinMeta({ id: "fixture-unphased", name: "Unphased Coin", status: "pre-launch" })]}
        logos={{}}
        teasers={{}}
      />,
    );
    const phaseGroup = screen.getByRole("group", { name: "Phase" });
    const unphased = within(phaseGroup).getByRole("button", { name: /Unphased/ });
    fireEvent.click(unphased);
    expect(rowNames()).toEqual(["Unphased Coin"]);
    expect(window.location.search).toBe("?phase=unphased");
  });

  it("sorts by column header on the URL codec, phase first in its reading direction", () => {
    window.history.replaceState(null, "", "/upcoming/");
    render(<UpcomingClient coins={PRE_LAUNCH_STABLECOINS} logos={{}} teasers={{}} />);
    fireEvent.click(table().getByRole("button", { name: /Phase/ }));
    expect(rowNames()).toEqual(["Beta Coin", "Announced Coin"]);
    expect(new URLSearchParams(window.location.search).get("sort")).toBe("phase");
    expect(new URLSearchParams(window.location.search).get("dir")).toBe("desc");
    fireEvent.click(table().getByRole("button", { name: /Phase/ }));
    expect(rowNames()).toEqual(["Announced Coin", "Beta Coin"]);
  });

  it("reveals the teaser on row expand", () => {
    window.history.replaceState(null, "", "/upcoming/");
    render(<UpcomingClient coins={PRE_LAUNCH_STABLECOINS} logos={{}} teasers={{ "fixture-beta": "Beta teaser text." }} />);
    const toggle = screen.getByRole("button", { name: "Show details for Beta Coin" });
    const details = document.getElementById(toggle.getAttribute("aria-controls")!)!;
    // The controlled row always exists; it is hidden until expanded.
    expect(details.hidden).toBe(true);
    expect(within(details).getByText("Beta teaser text.")).toBeTruthy();
    fireEvent.click(toggle);
    expect(details.hidden).toBe(false);
    expect(toggle.getAttribute("aria-expanded")).toBe("true");
  });
});
