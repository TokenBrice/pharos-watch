// @vitest-environment jsdom

import { act, cleanup, render, screen } from "@testing-library/react";
import { renderToString } from "react-dom/server";
import { afterEach, describe, expect, it, vi } from "vitest";
import { BackToSource, SourceNavigationProvider } from "@/components/back-to-source";

let pathname = "/screener/";
vi.mock("next/navigation", () => ({ usePathname: () => pathname }));
// The mock factory is hoisted; its shared helper must load inside the factory.
vi.mock("next/link", async () => {
  const { createNextLinkMock } = await import("@/test-utils/frontend");
  return createNextLinkMock();
});

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  window.history.replaceState(null, "", "/");
});

const tree = () => <SourceNavigationProvider><BackToSource /></SourceNavigationProvider>;

describe("BackToSource client-route provenance", () => {
  it("preserves updated tracker filters and replaces the source on a second client navigation", async () => {
    pathname = "/screener/";
    window.history.replaceState(null, "", "/screener/?safetyMin=80");
    const view = render(tree());
    expect(screen.queryByRole("link")).toBeNull();
    await act(async () => { window.history.replaceState(null, "", "/screener/?safetyMin=90&peg=USD"); });
    await act(async () => {
      window.history.pushState(null, "", "/stablecoin/usdt-tether/");
      pathname = "/stablecoin/usdt-tether/";
      view.rerender(tree());
    });
    expect(screen.getByRole("link", { name: /Back to Screener results/ }).getAttribute("href"))
      .toBe("/screener/?safetyMin=90&peg=USD");

    await act(async () => {
      window.history.pushState(null, "", "/compare/?coins=usdt-tether,usdc-circle");
      pathname = "/compare/";
      view.rerender(tree());
    });
    await act(async () => {
      window.history.pushState(null, "", "/stablecoin/usdc-circle/");
      pathname = "/stablecoin/usdc-circle/";
      view.rerender(tree());
    });
    expect(screen.getByRole("link", { name: /Back to Compare/ }).getAttribute("href"))
      .toBe("/compare/?coins=usdt-tether,usdc-circle");
    expect(screen.queryByRole("link", { name: /Screener/ })).toBeNull();
  });

  it.each(["https://example.com/search", "http://localhost/screener/?safetyMin=80"])(
    "does not invent a prior client route from document-entry referrer %s",
    (referrer) => {
      pathname = "/stablecoin/usdt-tether/";
      window.history.replaceState(null, "", pathname);
      vi.spyOn(document, "referrer", "get").mockReturnValue(referrer);
      expect(renderToString(tree())).not.toContain("Back to");
      render(tree());
      expect(screen.queryByRole("link")).toBeNull();
    },
  );
});
