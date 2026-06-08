// @vitest-environment jsdom

import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
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

vi.mock("@/components/sidebar-context", () => ({
  useSidebar: () => sidebarMock(),
}));

import { CoreTopRail } from "@/components/core-top-rail";

beforeAll(() => {
  // jsdom does not implement scrollIntoView; the rail centers the active pill on
  // mount/route change. Stub it so the effect runs without throwing.
  Element.prototype.scrollIntoView = vi.fn();
});

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
    expect(tape.parentElement?.className).toContain("contents");
    expect(tape.parentElement?.className).toContain("lg:sticky");
    expect(tape.parentElement?.className).toContain("lg:top-[3px]");
    const nav = screen.getByRole("navigation", { name: "Core pages" });
    expect(nav).toBeTruthy();
    expect(nav.className).toContain("sticky");
    expect(nav.className).toContain("top-[3px]");
    expect(nav.className).toContain("lg:relative");
    expect(nav.className).toContain("lg:ml-[var(--pharos-core-rail-offset)]");
    expect(nav.className).toContain("lg:w-[calc(100%-var(--pharos-core-rail-offset))]");
    expect(nav.querySelector(".justify-center")).toBeTruthy();
    const active = screen.getByRole("link", { name: "Dashboard" });
    expect(active.getAttribute("aria-current")).toBe("page");
    // The active pill mounts the one-shot frost beam and carries the lit-tab class.
    expect(active.className).toContain("pharos-rail-tab-active");
    expect(active.querySelector(".pharos-nav-beam")).toBeTruthy();
    // Per-item icons are decorative — kept out of the link's accessible name.
    const icon = active.querySelector("svg");
    expect(icon?.getAttribute("aria-hidden")).toBe("true");
  });

  it("does not center the active pill during initial dashboard hydration", () => {
    pathnameMock.mockReturnValue("/");
    sidebarMock.mockReturnValue({ expanded: true });

    render(<CoreTopRail />);

    expect(Element.prototype.scrollIntoView).not.toHaveBeenCalled();
  });

  it("centers the active pill after a client-side core route change", () => {
    pathnameMock.mockReturnValue("/");
    sidebarMock.mockReturnValue({ expanded: true });

    const { rerender } = render(<CoreTopRail />);
    expect(Element.prototype.scrollIntoView).not.toHaveBeenCalled();

    pathnameMock.mockReturnValue("/yield/");
    rerender(<CoreTopRail />);

    expect(Element.prototype.scrollIntoView).toHaveBeenCalledTimes(1);
    expect(Element.prototype.scrollIntoView).toHaveBeenCalledWith({
      inline: "center",
      block: "nearest",
      behavior: "auto",
    });
  });

  it("only the active link mounts the beam", () => {
    pathnameMock.mockReturnValue("/");
    sidebarMock.mockReturnValue({ expanded: true });

    render(<CoreTopRail />);

    const inactive = screen.getByRole("link", { name: "Safety Scores" });
    expect(inactive.className).not.toContain("pharos-rail-tab-active");
    expect(inactive.querySelector(".pharos-nav-beam")).toBeNull();
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
    expect(screen.queryByRole("link", { name: "Learn" })).toBeNull();
    expect(screen.queryByRole("link", { name: "Timeline" })).toBeNull();
    expect(screen.queryByRole("link", { name: "Status" })).toBeNull();
  });

  it("does not render on routes outside the trimmed core rail", () => {
    pathnameMock.mockReturnValue("/timeline/");
    sidebarMock.mockReturnValue({ expanded: true });

    const { container } = render(<CoreTopRail />);

    expect(container.firstChild).toBeNull();
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
