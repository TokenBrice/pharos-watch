// @vitest-environment jsdom

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { render, screen } from "@testing-library/react";

const pathnameMock = vi.fn<() => string>();
const isBelowDesktopMock = vi.fn<() => boolean>();

vi.mock("next/navigation", () => ({
  usePathname: () => pathnameMock(),
}));

vi.mock("@/components/homepage-tape", () => ({
  HomepageTape: ({ placement }: { placement: string }) => (
    <div data-testid="core-top-tape" data-placement={placement} />
  ),
}));

vi.mock("@/hooks/use-is-mobile", () => ({
  useIsMobile: () => isBelowDesktopMock(),
}));

import { CoreTopRail } from "@/components/core-top-rail";

afterEach(() => {
  vi.clearAllMocks();
});

beforeEach(() => {
  isBelowDesktopMock.mockReturnValue(false);
});

describe("CoreTopRail", () => {
  it("renders on stablecoin detail desktop routes", () => {
    pathnameMock.mockReturnValue("/stablecoin/usdt-tether");

    render(<CoreTopRail />);

    expect(screen.getByTestId("core-top-tape")).toBeTruthy();
  });

  it("does not mount the data-fetching tape on mobile interior routes", () => {
    pathnameMock.mockReturnValue("/liquidity/");
    isBelowDesktopMock.mockReturnValue(true);

    render(<CoreTopRail />);

    expect(screen.queryByTestId("core-top-tape")).toBeNull();
  });

  it("does not render on chromeless Mini App routes", () => {
    pathnameMock.mockReturnValue("/pharoswatchbot/app/");

    const { container } = render(<CoreTopRail />);

    expect(container.firstChild).toBeNull();
  });
});
