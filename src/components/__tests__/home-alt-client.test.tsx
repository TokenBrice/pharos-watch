// @vitest-environment jsdom

import { lazy, Suspense, type ComponentType } from "react";
import { act, cleanup, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { HomeAltClient } from "@/components/home-alt-client";

vi.mock("next/dynamic", () => ({
  default: (loader: () => Promise<ComponentType>) => {
    const Component = lazy(() => loader().then((defaultExport) => ({ default: defaultExport })));
    return function DynamicLeaf(props: Record<string, unknown>) {
      return <Suspense fallback={null}><Component {...props} /></Suspense>;
    };
  },
}));
vi.mock("@/components/home-alt-mini-card-grid", () => ({ HomeAltMiniCardGrid: () => <div data-testid="mini-cards" /> }));
vi.mock("@/components/home-alt-rankings-section", () => ({
  HomeAltRankingsSection: ({ titleId }: { titleId: string }) => <h2 id={titleId}>Loaded rankings</h2>,
}));
vi.mock("@/components/home-alt-ddr-overview", () => ({
  HomeAltDdrOverview: () => <h2 id="ddr-overview-title" data-testid="ddr">DDR overview</h2>,
}));
vi.mock("@/components/home-alt-yield-overview", () => ({
  HomeAltYieldOverview: () => <h2 id="yield-overview-title" data-testid="yield">Yield overview</h2>,
}));
vi.mock("@/components/home-alt-status-telegram", () => ({
  HomeAltStatusTelegram: () => <h2 id="home-alt-status-telegram-title" data-testid="status">Status</h2>,
}));
vi.mock("@/components/home-alt-upcoming-horizon-constellation", () => ({
  HomeAltUpcomingHorizonConstellation: () => <h2 id="upcoming-horizon-constellation-title" data-testid="horizon">Horizon</h2>,
}));
vi.mock("@/components/shortcuts-section", () => ({ ShortcutsSection: () => null }));

const intersections: Array<() => void> = [];
const scrollIntoView = vi.fn();
const originalScrollIntoView = Object.getOwnPropertyDescriptor(Element.prototype, "scrollIntoView");
beforeEach(() => {
  intersections.length = 0;
  scrollIntoView.mockReset();
  Object.defineProperty(Element.prototype, "scrollIntoView", {
    configurable: true,
    value: scrollIntoView,
    writable: true,
  });
  vi.stubGlobal("IntersectionObserver", class {
    constructor(callback: IntersectionObserverCallback) {
      intersections.push(() => callback([{ isIntersecting: true } as IntersectionObserverEntry], this as unknown as IntersectionObserver));
    }
    observe() {}
    disconnect() {}
    unobserve() {}
  });
});
afterEach(() => {
  cleanup();
  if (originalScrollIntoView) {
    Object.defineProperty(Element.prototype, "scrollIntoView", originalScrollIntoView);
  } else {
    Reflect.deleteProperty(Element.prototype, "scrollIntoView");
  }
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  window.history.replaceState(null, "", "/");
});

describe("HomeAltClient", () => {
  it("keeps rankings unmounted until the real lazy boundary intersects", async () => {
    render(<HomeAltClient />);
    expect(screen.queryByRole("heading", { name: "Loaded rankings" })).toBeNull();
    expect(screen.queryByTestId("mini-cards")).toBeNull();
    expect(intersections.length).toBeGreaterThan(0);
    await act(async () => intersections.forEach((intersect) => intersect()));
    expect(await screen.findByRole("region", { name: "Loaded rankings" })).toBeTruthy();
    expect(await screen.findByTestId("mini-cards")).toBeTruthy();
  });

  it.each(["home-alt-rankings", "home-alt-rankings-title"])("force-mounts only rankings for #%s", async (id) => {
    window.history.replaceState(null, "", `/#${id}`);
    render(<HomeAltClient />);
    const rankings = await screen.findByRole("region", { name: "Loaded rankings" });
    expect(rankings.firstElementChild?.classList.contains("min-h-[1230px]")).toBe(true);
    expect(screen.queryByTestId("mini-cards")).toBeNull();
    expect(screen.queryByTestId("horizon")).toBeNull();
    expect(screen.queryByTestId("ddr")).toBeNull();
    expect(screen.queryByTestId("yield")).toBeNull();
    expect(screen.queryByTestId("status")).toBeNull();
    expect(scrollIntoView).toHaveBeenCalledWith({ block: "start" });
  });

  it.each([
    ["upcoming-horizon-constellation-title", "horizon"],
    ["ddr-overview-title", "ddr"],
    ["yield-overview-title", "yield"],
    ["home-alt-status-telegram-title", "status"],
    ["%79ield-overview-title", "yield"],
  ])("mounts and scrolls only the section containing #%s", async (id, testId) => {
    window.history.replaceState(null, "", `/#${id}`);
    render(<HomeAltClient />);
    const target = await screen.findByTestId(testId);
    expect(scrollIntoView.mock.contexts).toContain(target);
    expect(screen.queryByRole("heading", { name: "Loaded rankings" })).toBeNull();
    expect(screen.queryByTestId("mini-cards")).toBeNull();
    for (const other of ["horizon", "ddr", "yield", "status"]) {
      if (other !== testId) expect(screen.queryByTestId(other)).toBeNull();
    }
  });

  it.each(["data", "unknown-section", "%E0%A4%A", ""])("does not force-mount panels for unrelated #%s", (id) => {
    window.history.replaceState(null, "", `/#${id}`);
    render(<HomeAltClient />);
    expect(screen.queryByRole("heading", { name: "Loaded rankings" })).toBeNull();
    for (const testId of ["mini-cards", "horizon", "ddr", "yield", "status"]) {
      expect(screen.queryByTestId(testId)).toBeNull();
    }
    expect(scrollIntoView).not.toHaveBeenCalled();
  });
});
