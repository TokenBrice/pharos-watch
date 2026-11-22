// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { createElement, lazy, type ComponentType } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { clearAllTrackingTimers } from "@/lib/analytics";

// Resolve next/dynamic through the real loader so this smoke proves the lazy
// workbench chunk actually loads and mounts instead of pinning source text.
vi.mock("next/dynamic", () => ({
  default: (loader: () => Promise<ComponentType>) => {
    const Workbench = lazy(async () => ({ default: await loader() }));
    return function DynamicWorkbench(props: Record<string, unknown>) {
      return createElement(Workbench, props);
    };
  },
}));

import { ComplianceClient } from "./client";

const scrollIntoView = vi.fn();

function panel(id: string): HTMLElement {
  const element = document.getElementById(id);
  if (!element) throw new Error(`Missing ${id}`);
  return element;
}

async function renderWorkbench() {
  render(createElement(ComplianceClient));
  await screen.findByRole("region", { name: "Compliance data" }, { timeout: 15_000 });
}

function tab(name: string): HTMLElement {
  return screen.getByRole("tab", { name });
}

describe("Compliance client boundary", () => {
  beforeEach(() => {
    window.history.replaceState(null, "", "/compliance/");
    scrollIntoView.mockReset();
    HTMLElement.prototype.scrollIntoView = scrollIntoView;
  });

  afterEach(() => {
    cleanup();
    clearAllTrackingTimers();
    delete (HTMLElement.prototype as { scrollIntoView?: unknown }).scrollIntoView;
  });

  it("mounts all three panels and exposes only Overview before any click", async () => {
    await renderWorkbench();

    expect(panel("compliance-overview-panel").hidden).toBe(false);
    expect(panel("compliance-mica-panel").hidden).toBe(true);
    expect(panel("compliance-genius-panel").hidden).toBe(true);
    expect(screen.getAllByRole("tabpanel")).toHaveLength(1);
    expect(screen.getByRole("tabpanel", { name: "Overview" })).toBeTruthy();
    expect(screen.queryByRole("tabpanel", { name: "MiCA" })).toBeNull();
    expect(screen.queryByRole("tabpanel", { name: "GENIUS" })).toBeNull();

    const micaHeading = document.getElementById("mica");
    const geniusHeading = document.getElementById("genius");
    expect(micaHeading?.tagName).toBe("H2");
    expect(micaHeading?.textContent).toBe("MiCA authorization");
    expect(micaHeading?.querySelector("a")?.getAttribute("href")).toBe("/compliance/?regime=mica#mica");
    expect(geniusHeading?.tagName).toBe("H2");
    expect(geniusHeading?.textContent).toBe("GENIUS Act status");
    expect(geniusHeading?.querySelector("a")?.getAttribute("href")).toBe("/compliance/?regime=genius#genius");
    expect(document.querySelectorAll("#mica")).toHaveLength(1);
    expect(document.querySelectorAll("#genius")).toHaveLength(1);
    expect(document.querySelectorAll("#implementation-watch")).toHaveLength(1);
    const ids = [...document.querySelectorAll("[id]")].map((element) => element.id);
    expect(new Set(ids).size).toBe(ids.length);
  });

  it("lazily mounts the compliance workbench and applies search filtering", async () => {
    await renderWorkbench();

    expect(screen.getByRole("region", { name: "Compliance data" }).textContent).toContain("stablecoins");
    expect(screen.queryByText(/matching/)).toBeNull();

    fireEvent.change(screen.getByLabelText("Search stablecoins by name or symbol"), {
      target: { value: "zzzz-no-such-stablecoin" },
    });

    await screen.findByText(/matching/);
    // Mounting the lazily loaded workbench chunk dominates this test; the
    // assertions themselves are immediate.
  }, 30_000);

  it("reads canonical type and peg filters and preserves explicit status, search and unrelated state on writes", async () => {
    window.history.replaceState(null, "", "/compliance/?regime=mica&status=authorized&type=EMT&peg=EUR&q=zzzz-no-such-stablecoin&campaign=retained#data");
    await renderWorkbench();

    expect(tab("MiCA").getAttribute("aria-selected")).toBe("true");
    expect(panel("compliance-mica-panel").hidden).toBe(false);
    expect(panel("compliance-overview-panel").hidden).toBe(true);
    expect(panel("compliance-genius-panel").hidden).toBe(true);
    expect(within(screen.getByRole("group", { name: "Filter by MiCA token type" })).getByRole("button", { name: "EMT" }).getAttribute("aria-pressed")).toBe("true");
    expect(within(screen.getByRole("group", { name: "Filter by MiCA status" })).getByRole("button", { name: "Authorized" }).getAttribute("aria-pressed")).toBe("true");
    const pegs = within(screen.getByRole("group", { name: "Filter by peg currency" }));
    expect(pegs.getByRole("button", { name: "EUR" }).getAttribute("aria-pressed")).toBe("true");
    fireEvent.click(pegs.getByRole("button", { name: "USD" }));

    await waitFor(() => expect(new URLSearchParams(window.location.search).get("peg")).toBe("USD"));
    const params = new URLSearchParams(window.location.search);
    expect(params.get("type")).toBe("EMT");
    expect(params.get("status")).toBe("authorized");
    expect(params.get("q")).toBe("zzzz-no-such-stablecoin");
    expect(params.get("campaign")).toBe("retained");
    expect(params.has("tokenType")).toBe(false);
    expect(params.has("pegCurrency")).toBe(false);
    expect(window.location.hash).toBe("#data");
  }, 30_000);

  it.each([
    ["/compliance/?status=authorized", "MiCA"],
    ["/compliance/?type=EMT", "MiCA"],
    ["/compliance/?status=issuer-announced-intent", "GENIUS"],
  ])("infers the regime from canonical filters at %s", async (url, expectedTab) => {
    window.history.replaceState(null, "", url);
    await renderWorkbench();

    await waitFor(() => expect(tab(expectedTab).getAttribute("aria-selected")).toBe("true"));
    expect(tab("Overview").getAttribute("aria-selected")).toBe("false");
  }, 30_000);

  it("moves roving tab focus with arrows and Home/End and links tabs to mounted panels", async () => {
    await renderWorkbench();

    const overview = tab("Overview");
    expect(overview.id).toBe("compliance-tab-all");
    expect(overview.getAttribute("aria-controls")).toBe("compliance-overview-panel");
    expect(overview.tabIndex).toBe(0);
    expect(tab("MiCA").tabIndex).toBe(-1);
    expect(panel("compliance-overview-panel").getAttribute("aria-labelledby")).toBe("compliance-tab-all");
    expect(panel("compliance-mica-panel").getAttribute("aria-labelledby")).toBe("compliance-tab-mica");
    expect(panel("compliance-genius-panel").getAttribute("aria-labelledby")).toBe("compliance-tab-genius");
    expect(panel("compliance-genius-panel").getAttribute("role")).toBe("tabpanel");

    overview.focus();
    fireEvent.keyDown(overview, { key: "ArrowRight" });
    await waitFor(() => expect(tab("MiCA").getAttribute("aria-selected")).toBe("true"));
    expect(document.activeElement).toBe(tab("MiCA"));
    expect(tab("MiCA").tabIndex).toBe(0);
    expect(panel("compliance-mica-panel").hidden).toBe(false);

    fireEvent.keyDown(tab("MiCA"), { key: "End" });
    await waitFor(() => expect(tab("GENIUS").getAttribute("aria-selected")).toBe("true"));
    expect(document.activeElement).toBe(tab("GENIUS"));
    expect(panel("compliance-genius-panel").hidden).toBe(false);
    expect(panel("compliance-mica-panel").hidden).toBe(true);

    fireEvent.keyDown(tab("GENIUS"), { key: "ArrowRight" });
    await waitFor(() => expect(tab("Overview").getAttribute("aria-selected")).toBe("true"));
    expect(document.activeElement).toBe(tab("Overview"));

    fireEvent.keyDown(tab("Overview"), { key: "ArrowLeft" });
    await waitFor(() => expect(tab("GENIUS").getAttribute("aria-selected")).toBe("true"));

    fireEvent.keyDown(tab("GENIUS"), { key: "Home" });
    await waitFor(() => expect(tab("Overview").getAttribute("aria-selected")).toBe("true"));
    expect(document.activeElement).toBe(tab("Overview"));
    // Ordinary tab switches never move focus to a heading.
    expect(scrollIntoView).not.toHaveBeenCalled();
  }, 30_000);

  it("aligns a supported heading permalink once its panel is visible", async () => {
    window.history.replaceState(null, "", "/compliance/?regime=genius#genius");
    await renderWorkbench();

    await waitFor(() => expect(panel("compliance-genius-panel").hidden).toBe(false));
    await waitFor(() => expect(scrollIntoView).toHaveBeenCalled());
    expect(scrollIntoView.mock.instances.at(-1)).toBe(document.getElementById("genius"));
  }, 30_000);

  it("does not infer a regime from a fragment or scroll to a hidden heading", async () => {
    window.history.replaceState(null, "", "/compliance/#genius");
    await renderWorkbench();

    await waitFor(() => expect(tab("Overview").getAttribute("aria-selected")).toBe("true"));
    expect(panel("compliance-genius-panel").hidden).toBe(true);
    expect(scrollIntoView).not.toHaveBeenCalled();
  }, 30_000);

  it("reconciles Back/Forward URL state into the visible panel", async () => {
    window.history.replaceState(null, "", "/compliance/?regime=mica&status=authorized");
    await renderWorkbench();
    await waitFor(() => expect(tab("MiCA").getAttribute("aria-selected")).toBe("true"));

    window.history.replaceState(null, "", "/compliance/?regime=genius&status=issuer-announced-intent");
    window.dispatchEvent(new PopStateEvent("popstate"));
    await waitFor(() => expect(tab("GENIUS").getAttribute("aria-selected")).toBe("true"));
    expect(panel("compliance-genius-panel").hidden).toBe(false);
    expect(panel("compliance-mica-panel").hidden).toBe(true);
    expect(new URLSearchParams(window.location.search).get("status")).toBe("issuer-announced-intent");
  }, 30_000);
});
