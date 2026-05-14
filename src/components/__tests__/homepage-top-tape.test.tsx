// @vitest-environment jsdom

import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, render, screen } from "@testing-library/react";

const pathnameMock = vi.fn<() => string>();

vi.mock("next/navigation", () => ({
  usePathname: () => pathnameMock(),
}));

vi.mock("@/components/homepage-tape", () => ({
  HomepageTape: ({ placement }: { placement: string }) => (
    <div data-testid="homepage-top-tape" data-placement={placement} />
  ),
}));

vi.mock("@/components/sidebar", () => ({
  useSidebar: () => ({ expanded: true }),
}));

import { HomepageTopTape } from "@/components/homepage-top-tape";

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

describe("HomepageTopTape", () => {
  it("renders the top tape on the homepage", () => {
    pathnameMock.mockReturnValue("/");

    render(<HomepageTopTape />);

    const tape = screen.getByTestId("homepage-top-tape");
    expect(tape.getAttribute("data-placement")).toBe("top");
    expect(tape.parentElement?.getAttribute("style")).toContain("--pharos-homepage-tape-offset");
  });

  it("does not render on other routes", () => {
    pathnameMock.mockReturnValue("/stablecoin/usdt-tether");

    const { container } = render(<HomepageTopTape />);

    expect(container.firstChild).toBeNull();
  });
});
