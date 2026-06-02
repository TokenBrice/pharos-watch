// @vitest-environment jsdom

import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, render, screen } from "@testing-library/react";

const pathnameMock = vi.fn<() => string>();
const sidebarMock = vi.fn<() => { expanded: boolean }>();

vi.mock("next/navigation", () => ({
  usePathname: () => pathnameMock(),
}));

vi.mock("@/components/homepage-tape", () => ({
  HomepageTape: ({ placement }: { placement: string }) => (
    <div data-testid="core-top-tape" data-placement={placement} />
  ),
}));

vi.mock("@/components/sidebar", () => ({
  useSidebar: () => sidebarMock(),
}));

import { CoreTopRail } from "@/components/core-top-rail";

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

describe("CoreTopRail", () => {
  it("renders the tape and core submenu on the dashboard", () => {
    pathnameMock.mockReturnValue("/");
    sidebarMock.mockReturnValue({ expanded: true });

    render(<CoreTopRail />);

    const tape = screen.getByTestId("core-top-tape");
    expect(tape.getAttribute("data-placement")).toBe("top");
    expect(tape.parentElement?.getAttribute("style")).toContain("--pharos-core-rail-offset");
    const nav = screen.getByRole("navigation", { name: "Core pages" });
    expect(nav).toBeTruthy();
    expect(nav.className).not.toContain("lg:ml-[var(--pharos-core-rail-offset)]");
    expect(nav.querySelector(".justify-center")).toBeTruthy();
    expect(screen.getByRole("link", { name: "Dashboard" }).getAttribute("aria-current")).toBe("page");
  });

  it("marks the active core page and keeps the full primary run available", () => {
    pathnameMock.mockReturnValue("/yield/");
    sidebarMock.mockReturnValue({ expanded: false });

    render(<CoreTopRail />);

    expect(screen.getByRole("link", { name: "Yield Intelligence" }).getAttribute("aria-current")).toBe("page");
    expect(screen.getByRole("link", { name: "Safety Scores" }).getAttribute("href")).toMatch(/^\/safety-scores\/?$/);
    expect(screen.getByRole("link", { name: "Depeg/DDR" }).getAttribute("href")).toMatch(/^\/depeg\/?$/);
    expect(screen.getByRole("link", { name: "Alt-Pegs" }).getAttribute("href")).toMatch(/^\/alt-pegs\/?$/);
    expect(screen.getByRole("link", { name: "FreezeWatch" }).getAttribute("href")).toMatch(/^\/freezewatch\/?$/);
    expect(screen.getByRole("link", { name: "Stability Index" }).getAttribute("href")).toMatch(/^\/stability-index\/?$/);
    expect(screen.getByRole("link", { name: "PharosWatchBot" }).getAttribute("href")).toMatch(/^\/pharoswatchbot\/?$/);
    expect(screen.getByRole("link", { name: "Learn" }).getAttribute("href")).toMatch(/^\/learn\/?$/);
    expect(screen.getByRole("link", { name: "Timeline" }).getAttribute("href")).toMatch(/^\/timeline\/?$/);
    expect(screen.getByRole("link", { name: "Status" }).getAttribute("href")).toMatch(/^\/status\/?$/);
  });

  it("renders on the added core pages", () => {
    pathnameMock.mockReturnValue("/timeline/");
    sidebarMock.mockReturnValue({ expanded: true });

    render(<CoreTopRail />);

    expect(screen.getByRole("link", { name: "Timeline" }).getAttribute("aria-current")).toBe("page");
  });

  it("does not render on non-core routes", () => {
    pathnameMock.mockReturnValue("/stablecoin/usdt-tether");
    sidebarMock.mockReturnValue({ expanded: true });

    const { container } = render(<CoreTopRail />);

    expect(container.firstChild).toBeNull();
  });

  it("does not render on core route descendants", () => {
    pathnameMock.mockReturnValue("/pharoswatchbot/app/");
    sidebarMock.mockReturnValue({ expanded: true });

    const { container } = render(<CoreTopRail />);

    expect(container.firstChild).toBeNull();
  });
});
