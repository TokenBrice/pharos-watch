// @vitest-environment jsdom

import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

const { usePathnameMock } = vi.hoisted(() => ({ usePathnameMock: vi.fn() }));

vi.mock("next/navigation", () => ({
  usePathname: usePathnameMock,
}));

import { GlobalFooterChrome, MainContent, RegimeBarChrome, RouteChrome } from "../route-chrome";

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

describe("operator route chrome", () => {
  it.each(["/admin/", "/admin/actions/", "/admin-api/"])("suppresses public chrome on %s", (pathname) => {
    usePathnameMock.mockReturnValue(pathname);

    render(
      <>
        <RouteChrome>
          <div>public navigation</div>
        </RouteChrome>
        <RegimeBarChrome>
          <div>regime tape</div>
        </RegimeBarChrome>
        <GlobalFooterChrome>
          <div>public footer</div>
        </GlobalFooterChrome>
      </>,
    );

    expect(screen.queryByText("public navigation")).toBeNull();
    expect(screen.queryByText("regime tape")).toBeNull();
    expect(screen.queryByText("public footer")).toBeNull();
  });

  it("uses an unframed full-width main content area for operator routes", () => {
    usePathnameMock.mockReturnValue("/admin/pipeline/");

    render(
      <MainContent>
        <div>workspace</div>
      </MainContent>,
    );

    const main = screen.getByRole("main");
    expect(main.className).toContain("min-w-0");
    expect(main.className).not.toContain("max-w-[120rem]");
    expect(screen.getByText("workspace")).toBeTruthy();
  });

  it("keeps public chrome on normal product routes", () => {
    usePathnameMock.mockReturnValue("/yield/");

    render(
      <RouteChrome>
        <div>public navigation</div>
      </RouteChrome>,
    );

    expect(screen.getByText("public navigation")).toBeTruthy();
  });
});
