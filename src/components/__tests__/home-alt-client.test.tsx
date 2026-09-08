// @vitest-environment jsdom

import { lazy, Suspense, type ComponentType } from "react";
import { act, render, screen } from "@testing-library/react";
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
vi.mock("@/components/home-alt-ddr-overview", () => ({ HomeAltDdrOverview: () => null }));
vi.mock("@/components/home-alt-yield-overview", () => ({ HomeAltYieldOverview: () => null }));
vi.mock("@/components/home-alt-status-telegram", () => ({ HomeAltStatusTelegram: () => null }));
vi.mock("@/components/home-alt-upcoming-horizon-constellation", () => ({ HomeAltUpcomingHorizonConstellation: () => null }));
vi.mock("@/components/shortcuts-section", () => ({ ShortcutsSection: () => null }));

const intersections: Array<() => void> = [];
beforeEach(() => {
  intersections.length = 0;
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

  it("force-mounts an initial hash target without intersection", async () => {
    window.history.replaceState(null, "", "/#home-alt-rankings");
    render(<HomeAltClient />);
    expect(await screen.findByRole("region", { name: "Loaded rankings" })).toBeTruthy();
  });
});
