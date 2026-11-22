// @vitest-environment jsdom

import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { ComplianceStatusDistributionBars } from "@/app/compliance/status-distribution-bar";

describe("ComplianceStatusDistributionBars", () => {
  beforeEach(() => {
    window.history.replaceState(null, "", "/compliance/");
  });

  afterEach(() => {
    cleanup();
    window.history.replaceState(null, "", "/compliance/");
  });

  it("keeps each neutral GENIUS outcome visually distinct and clickable in both bar and legend", () => {
    const { container } = render(
      <ComplianceStatusDistributionBars
        distribution={{
          mica: [{ status: "authorized", count: 12 }],
          genius: [
            { status: "issuer-announced-intent", count: 3 },
            { status: "no-public-authorization-found", count: 137 },
            { status: "not-applicable", count: 52 },
            { status: "unknown", count: 4 },
          ],
        }}
      />,
    );

    const queries = screen.getAllByRole("link").map((link) => link.getAttribute("href")?.split("?")[1]);
    expect(queries).toContain("regime=genius&status=no-public-authorization-found");
    expect(queries).toContain("regime=genius&status=not-applicable");
    expect(queries).toContain("regime=genius&status=unknown");
    expect(queries).not.toContain("regime=genius&status=all");
    expect(screen.getByText("196 assessed")).toBeTruthy();
    expect(screen.getAllByText("Not Applicable").length).toBeGreaterThan(0);

    // Visually differentiate the three GENIUS neutral outcomes (R1-R8).
    const noneFoundClass = container.querySelector('[data-status="no-public-authorization-found"]')?.className ?? "";
    const notApplicableClass = container.querySelector('[data-status="not-applicable"]')?.className ?? "";
    const unknownClass = container.querySelector('[data-status="unknown"]')?.className ?? "";
    expect(noneFoundClass).not.toBe(notApplicableClass);
    expect(unknownClass).toContain("border-dashed");
    expect(unknownClass).toContain("repeating-linear-gradient");

    // Clicking a legend item toggles the status filter on and off.
    const legendUnknown = container.querySelector('[data-legend-status="unknown"]') as HTMLElement;
    expect(legendUnknown.tagName).toBe("A");
    fireEvent.click(legendUnknown);
    expect(new URLSearchParams(window.location.search).get("regime")).toBe("genius");
    expect(new URLSearchParams(window.location.search).get("status")).toBe("unknown");
    expect(legendUnknown.getAttribute("aria-current")).toBe("true");

    fireEvent.click(legendUnknown);
    expect(new URLSearchParams(window.location.search).get("regime")).toBe("genius");
    expect(new URLSearchParams(window.location.search).get("status")).toBeNull();
  });
});
