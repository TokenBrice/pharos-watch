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
