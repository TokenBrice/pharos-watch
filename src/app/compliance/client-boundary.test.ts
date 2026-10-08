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

describe("Compliance client boundary", () => {
  beforeEach(() => {
    window.history.replaceState(null, "", "/compliance/");
  });

  afterEach(() => {
    cleanup();
    clearAllTrackingTimers();
  });

  it("lazily mounts the compliance workbench and applies search filtering", async () => {
    render(createElement(ComplianceClient));

    const region = await screen.findByRole("region", { name: "Compliance data" }, { timeout: 15_000 });
    expect(region.textContent).toContain("stablecoins");
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
    render(createElement(ComplianceClient));
    await screen.findByRole("region", { name: "Compliance data" }, { timeout: 15_000 });

    expect(screen.getByRole("tab", { name: "MiCA" }).getAttribute("aria-selected")).toBe("true");
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

  it("ignores alias-only bookmarks without inferring a regime or peg", async () => {
    window.history.replaceState(null, "", "/compliance/?tokenType=EMT&pegCurrency=EUR");
    render(createElement(ComplianceClient));
    await screen.findByRole("region", { name: "Compliance data" }, { timeout: 15_000 });

    expect(screen.getByRole("tab", { name: "Overview" }).getAttribute("aria-selected")).toBe("true");
    expect(screen.queryByRole("group", { name: "Filter by MiCA token type" })).toBeNull();
    expect(within(screen.getByRole("group", { name: "Filter by peg currency" })).getByRole("button", { name: "All pegs" }).getAttribute("aria-pressed")).toBe("true");
  }, 30_000);

  it("normalizes invalid canonical inputs conservatively without falling back to retired aliases", async () => {
    window.history.replaceState(null, "", "/compliance/?regime=mica&status=invalid&type=invalid&peg=invalid&tokenType=EMT&pegCurrency=EUR");
    render(createElement(ComplianceClient));
    await screen.findByRole("region", { name: "Compliance data" }, { timeout: 15_000 });

    expect(within(screen.getByRole("group", { name: "Filter by MiCA token type" })).getByRole("button", { name: "All types" }).getAttribute("aria-pressed")).toBe("true");
    expect(within(screen.getByRole("group", { name: "Filter by MiCA status" })).getByRole("button", { name: "All statuses" }).getAttribute("aria-pressed")).toBe("true");
    expect(within(screen.getByRole("group", { name: "Filter by peg currency" })).getByRole("button", { name: "All pegs" }).getAttribute("aria-pressed")).toBe("true");
  }, 30_000);
});
