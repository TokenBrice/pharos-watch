// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { createElement, lazy, type ComponentType } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
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
});
