// @vitest-environment jsdom

import { act, cleanup, waitFor } from "@testing-library/react";
import { createElement, useEffect } from "react";
import { hydrateRoot, type Root } from "react-dom/client";
import { renderToString } from "react-dom/server";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { useUrlFilters } from "../use-url-filters";
import { useCompareSelection } from "../use-compare-selection";
import { useSelectorState } from "../use-selector-state";
import { usePortfolio } from "../use-portfolio";
import { encodePortfolioHoldings } from "@/lib/portfolio-codec";

vi.mock("@/lib/analytics", () => ({ trackEvent: vi.fn() }));

const roots: Root[] = [];
beforeEach(() => {
  window.history.replaceState(null, "", "/");
  window.localStorage.clear();
});
afterEach(() => {
  act(() => { for (const root of roots.splice(0)) root.unmount(); });
  cleanup();
  document.body.innerHTML = "";
  vi.restoreAllMocks();
});

async function hydrate(Probe: () => ReturnType<typeof createElement>) {
  const container = document.createElement("div");
  container.innerHTML = renderToString(createElement(Probe));
  document.body.append(container);
  const serverText = container.textContent;
  const errors: unknown[] = [];
  await act(async () => {
    roots.push(hydrateRoot(container, createElement(Probe), { onRecoverableError: (error) => errors.push(error) }));
  });
  return { container, serverText, errors };
}

describe("URL-filter hydration", () => {
  it("uses a deterministic first snapshot then restores query and history without losing the fragment", async () => {
    window.history.replaceState(null, "", "/compare/?coins=usdc-circle&scope=all#data");
    function Probe() {
      const { getParam, isReady, setParam } = useUrlFilters();
      return createElement("button", { onClick: () => setParam("coins", "usdt-tether") }, `${isReady}:${getParam("coins")}`);
    }
    const { container, serverText, errors } = await hydrate(Probe);
    expect(serverText).toBe("false:");
    expect(container.textContent).toBe("true:usdc-circle");
    expect(errors).toEqual([]);
    await act(async () => { container.querySelector("button")!.click(); });
    expect(window.location.search).toBe("?coins=usdt-tether&scope=all");
    expect(window.location.hash).toBe("#data");
    expect(container.textContent).toBe("true:usdt-tether");
    await act(async () => {
      window.history.pushState(null, "", "/compare/?coins=usdc-circle#data");
      window.dispatchEvent(new PopStateEvent("popstate"));
    });
    expect(container.textContent).toBe("true:usdc-circle");
  });

  it("hydrates real comparison selection before normalizing duplicate IDs", async () => {
    window.history.replaceState(null, "", "/compare/?coins=usdc-circle,usdc-circle&scope=all#data");
    function Probe() {
      const { selectedIds } = useCompareSelection();
      return createElement("p", null, selectedIds.join(",") || "No selected coins");
    }
    const { container, serverText, errors } = await hydrate(Probe);
    expect(serverText).toBe("No selected coins");
    await waitFor(() => expect(container.textContent).toBe("usdc-circle"));
    expect(errors).toEqual([]);
    expect(window.location.search).toBe("?coins=usdc-circle&scope=all");
    expect(window.location.hash).toBe("#data");
  });

  it("waits for the real Selector state before consuming its one-time repair", async () => {
    window.history.replaceState(null, "", "/screener/picker/?scope=all&p=treasury&step=result#result");
    function Probe() {
      const { state } = useSelectorState();
      return createElement("p", null, `${state.profile}:${state.step}`);
    }
    const { container, errors } = await hydrate(Probe);
    await waitFor(() => expect(container.textContent).toBe("treasury:3"));
    expect(errors).toEqual([]);
    expect(window.location.search).toBe("?scope=all&p=treasury&step=3");
    expect(window.location.hash).toBe("#result");
  });

  it("restores a shared portfolio without publishing or persisting conflicting local holdings", async () => {
    const saved = JSON.stringify([{ coinId: "usdt-tether", amount: 50 }]);
    window.localStorage.setItem("pharos:portfolio", saved);
    window.history.replaceState(null, "", "/portfolio/?p=usdc-circle:20&scope=all#holdings");
    const storageWrite = vi.spyOn(Storage.prototype, "setItem");
    function Probe() {
      const { getParam, isReady, setParam } = useUrlFilters();
      const portfolio = usePortfolio(getParam("p"), isReady);
      useEffect(() => {
        if (portfolio.initialized) setParam("p", encodePortfolioHoldings(portfolio.holdings));
      }, [portfolio.initialized, portfolio.holdings, setParam]);
      return createElement("p", null, JSON.stringify({ initialized: portfolio.initialized, fromUrl: portfolio.isFromUrl, holdings: portfolio.holdings, total: portfolio.totalUsd }));
    }
    const { container, serverText, errors } = await hydrate(Probe);
    expect(JSON.parse(serverText!)).toEqual({ initialized: false, fromUrl: false, holdings: [], total: 0 });
    await waitFor(() => expect(JSON.parse(container.textContent!).holdings).toEqual([{ coinId: "usdc-circle", amount: 20 }]));
    expect(errors).toEqual([]);
    expect(JSON.parse(container.textContent!)).toMatchObject({ initialized: true, fromUrl: true, total: 20 });
    expect(new URLSearchParams(window.location.search).get("p")).toBe("usdc-circle:20");
    expect(new URLSearchParams(window.location.search).get("scope")).toBe("all");
    expect(window.location.hash).toBe("#holdings");
    expect(window.localStorage.getItem("pharos:portfolio")).toBe(saved);
    expect(storageWrite).not.toHaveBeenCalled();
  });
});
