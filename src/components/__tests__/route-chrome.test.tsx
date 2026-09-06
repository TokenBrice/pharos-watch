// @vitest-environment jsdom

import { render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

const { usePathnameMock } = vi.hoisted(() => ({ usePathnameMock: vi.fn() }));

vi.mock("next/navigation", () => ({
  usePathname: usePathnameMock,
}));

import { GlobalFooterChrome, MainContent, RegimeBarChrome, RouteChrome } from "../route-chrome";

afterEach(() => {
  vi.clearAllMocks();
});

describe("operator route chrome", () => {
  it.each([
    "/", "/liquidity", "/screener", "/flows", "/timeline", "/safety-scores",
    "/freezewatch", "/depeg", "/compliance", "/yield",
  ])("retains the data shortcut for workspace %s with either slash form", (pathname) => {
    usePathnameMock.mockReturnValue(pathname);
    const { rerender } = render(<RouteChrome dataTableOnly><a href="#data">Skip to data table</a></RouteChrome>);
    expect(screen.getByRole("link", { name: "Skip to data table" }).getAttribute("href")).toBe("#data");
    usePathnameMock.mockReturnValue(pathname === "/" ? "/" : `${pathname}/`);
    rerender(<RouteChrome dataTableOnly><a href="#data">Skip to data table</a></RouteChrome>);
    expect(screen.getByRole("link", { name: "Skip to data table" })).toBeTruthy();
  });

  it.each([
    "/blog/", "/digest/2026-09-06/", "/compare/", "/compare/usdc-circle-vs-usdt-tether/",
    "/stablecoin/usdc-circle/", "/learn/", "/depeg/usdc-2023-03-11/", "/screener/picker/",
    "/admin/", "/admin-api/", "/pharoswatchbot/app/", null,
  ])("omits the data shortcut without a workspace target on %s", (pathname) => {
    usePathnameMock.mockReturnValue(pathname);
    render(<RouteChrome dataTableOnly><a href="#data">Skip to data table</a></RouteChrome>);
    expect(screen.queryByRole("link", { name: "Skip to data table" })).toBeNull();
  });

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

  it("does not wrap an operator shell main landmark in another main landmark", () => {
    usePathnameMock.mockReturnValue("/admin/pipeline/");

    render(
      <MainContent>
        <main id="ops-main-content">workspace</main>
      </MainContent>,
    );

    const mains = screen.getAllByRole("main");
    expect(mains).toHaveLength(1);
    expect(mains[0]?.id).toBe("ops-main-content");
    expect(document.getElementById("main-content")).toBeNull();
    expect(screen.getByText("workspace")).toBeTruthy();
  });

  it("retains the standard main-content landmark on product routes", () => {
    usePathnameMock.mockReturnValue("/yield/");

    render(
      <MainContent>
        <div>yield workspace</div>
      </MainContent>,
    );

    expect(screen.getByRole("main").id).toBe("main-content");
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
