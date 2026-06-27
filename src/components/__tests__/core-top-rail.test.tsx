// @vitest-environment jsdom

import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, render, screen } from "@testing-library/react";

const pathnameMock = vi.fn<() => string>();

vi.mock("next/navigation", () => ({
  usePathname: () => pathnameMock(),
}));

vi.mock("@/components/homepage-tape", () => ({
  HomepageTape: ({ placement }: { placement: string }) => (
    <div data-testid="core-top-tape" data-placement={placement} />
  ),
}));

import { CoreTopRail } from "@/components/core-top-rail";

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

describe("CoreTopRail", () => {
  it("renders the events tape on core routes", () => {
    pathnameMock.mockReturnValue("/");

    render(<CoreTopRail />);

    const tape = screen.getByTestId("core-top-tape");
    expect(tape.getAttribute("data-placement")).toBe("top");
    expect(tape.parentElement?.className).toContain("contents");
    expect(tape.parentElement?.className).toContain("lg:sticky");
    expect(tape.parentElement?.className).toContain("lg:top-14");
    // The redundant core-nav pill rail is gone — the Terminal dropdown in the
    // top nav now carries those destinations.
    expect(screen.queryByRole("navigation", { name: "Core pages" })).toBeNull();
  });

  it("renders on non-core desktop routes while staying hidden below lg", () => {
    pathnameMock.mockReturnValue("/timeline/");

    render(<CoreTopRail />);

    const tape = screen.getByTestId("core-top-tape");
    expect(tape.parentElement?.className).toContain("hidden");
    expect(tape.parentElement?.className).toContain("lg:block");
    expect(tape.parentElement?.className).toContain("lg:sticky");
    expect(tape.parentElement?.className).toContain("lg:top-[calc(3px+3.5rem)]");
  });

  it("renders on stablecoin detail desktop routes", () => {
    pathnameMock.mockReturnValue("/stablecoin/usdt-tether");

    render(<CoreTopRail />);

    const tape = screen.getByTestId("core-top-tape");
    expect(tape.parentElement?.className).toContain("hidden");
    expect(tape.parentElement?.className).toContain("lg:block");
  });

  it("does not render on chromeless Mini App routes", () => {
    pathnameMock.mockReturnValue("/pharoswatchbot/app/");

    const { container } = render(<CoreTopRail />);

    expect(container.firstChild).toBeNull();
  });
});
