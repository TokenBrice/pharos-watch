// @vitest-environment jsdom

import { act, cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { makeStablecoinMeta } from "@shared/test-utils/stablecoin";
import type { StablecoinMeta } from "@shared/types/stablecoin-meta-schemas";
import type { UpcomingLaunchPhase } from "@shared/types/stablecoin-lifecycle";
import type { UpcomingCoin } from "../upcoming/upcoming-client";

vi.mock("next/link", async () => {
  const { createNextLinkMock } = await import("@/test-utils/frontend");
  return createNextLinkMock();
});

vi.mock("next/image", () => ({
  default: ({ alt }: { alt: string }) => <img alt={alt} />,
}));

const { UpcomingClient } = await import("../upcoming/upcoming-client");

// Upcoming rows never carry the `launched` phase; the shared factory accepts any LaunchPhase.
function makeUpcomingCoin({ launchPhase, ...overrides }: Omit<Partial<StablecoinMeta>, "launchPhase"> & { launchPhase?: UpcomingLaunchPhase }): UpcomingCoin {
  return { ...makeStablecoinMeta(overrides), launchPhase };
}
const PRE_LAUNCH_STABLECOINS = [
  makeUpcomingCoin({ id: "fixture-announced", name: "Announced Coin", status: "pre-launch", launchPhase: "announced" }),
  makeUpcomingCoin({ id: "fixture-beta", name: "Beta Coin", status: "pre-launch", launchPhase: "beta" }),
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
          makeUpcomingCoin({ id: "fixture-unphased", name: "Unphased Coin", status: "pre-launch" }),
        ]}
        launchedCount={4}
        logos={{}}
        teasers={{}}
      />,
    );
    const hero = within(screen.getByRole("group", { name: "Pre-launch stablecoin readiness" }));
    const slipped = hero.getByText("Slipped").parentElement!;
    expect(within(slipped).getByText("2")).toBeTruthy();
    const soonest = hero.getByText("Soonest open target").parentElement!;
    expect(within(soonest).getByText("Beta Coin")).toBeTruthy();
    expect(within(soonest).getByText("Q4 2026")).toBeTruthy();
    // Explicit upcoming / launched split readout in the hero.
    expect(screen.getByTestId("upcoming-launched-split").textContent).toContain("3 upcoming");
    expect(screen.getByTestId("upcoming-launched-split").textContent).toContain("4 launched");
    // Countdown cue renders beside dated targets.
    expect(table().getByText(/Window opens in/)).toBeTruthy();
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
    const hero = within(screen.getByRole("group", { name: "Pre-launch stablecoin readiness" }));
    expect(table().getByText("No current target")).toBeTruthy();
    expect(hero.getByText("Slipped").parentElement!.textContent).toMatch(/^Slipped0/);
  });

  it("counts unphased coins in the phase filter so the pills sum to the tracked count", () => {
    window.history.replaceState(null, "", "/upcoming/");
    render(
      <UpcomingClient
        coins={[...PRE_LAUNCH_STABLECOINS, makeUpcomingCoin({ id: "fixture-unphased", name: "Unphased Coin", status: "pre-launch" })]}
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

  it("lazy-mounts expanded detail DOM only when a row is expanded", () => {
    window.history.replaceState(null, "", "/upcoming/");
    render(<UpcomingClient coins={PRE_LAUNCH_STABLECOINS} logos={{}} teasers={{ "fixture-beta": "Beta teaser text." }} />);
    // Header + 2 coin rows only; no hidden detail rows mounted initially.
    expect(table().getAllByRole("row")).toHaveLength(1 + PRE_LAUNCH_STABLECOINS.length);
    expect(document.getElementById("upcoming-details-fixture-beta")).toBeNull();
    expect(screen.queryByText("Beta teaser text.")).toBeNull();

    const toggle = screen.getByRole("button", { name: "Show details for Beta Coin" });
    expect(toggle.getAttribute("aria-expanded")).toBe("false");
    expect(toggle.getAttribute("aria-controls")).toBeNull();

    fireEvent.click(toggle);
    expect(table().getAllByRole("row")).toHaveLength(2 + PRE_LAUNCH_STABLECOINS.length);
    const details = document.getElementById("upcoming-details-fixture-beta")!;
    expect(details).toBeTruthy();
    expect(within(details).getByText("Beta teaser text.")).toBeTruthy();
    expect(toggle.getAttribute("aria-expanded")).toBe("true");
    expect(toggle.getAttribute("aria-controls")).toBe("upcoming-details-fixture-beta");

    fireEvent.click(toggle);
    expect(document.getElementById("upcoming-details-fixture-beta")).toBeNull();
  });

  it("toggles launch-phase filtering from hero phase orbs and supports search, Dated targets, and Slipped pills", () => {
    window.history.replaceState(null, "", "/upcoming/");
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-07-15T00:00:00Z"));
    const { container } = render(
      <UpcomingClient
        coins={[
          { ...PRE_LAUNCH_STABLECOINS[0], expectedLaunchDate: "2026-Q2" },
          { ...PRE_LAUNCH_STABLECOINS[1], expectedLaunchDate: "2026-Q4" },
          makeUpcomingCoin({ id: "fixture-undated", name: "Undated Coin", symbol: "UND", status: "pre-launch", launchPhase: "announced" }),
        ]}
        logos={{}}
        teasers={{}}
      />,
    );

    const betaOrb = container.querySelector<HTMLButtonElement>('button[data-phase-orb="beta"]')!;
    fireEvent.click(betaOrb);
    expect(betaOrb.getAttribute("aria-pressed")).toBe("true");
    expect(rowNames()).toEqual(["Beta Coin"]);

    fireEvent.click(screen.getByTestId("clear-phase-orb-filter"));
    expect(rowNames()).toHaveLength(3);

    const targetGroup = within(screen.getByRole("group", { name: "Target status" }));
    fireEvent.click(targetGroup.getByRole("button", { name: /Dated targets/ }));
    expect(rowNames()).toEqual(["Announced Coin", "Beta Coin"]);

    fireEvent.click(targetGroup.getByRole("button", { name: /Slipped/ }));
    expect(rowNames()).toEqual(["Announced Coin"]);

    fireEvent.click(targetGroup.getByRole("button", { name: /Slipped/ }));
    fireEvent.change(screen.getByRole("textbox", { name: "Search upcoming stablecoins" }), {
      target: { value: "UND" },
    });
    expect(rowNames()).toEqual(["Undated Coin"]);
  });
});
