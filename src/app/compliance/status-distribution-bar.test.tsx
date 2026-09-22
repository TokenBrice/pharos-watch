// @vitest-environment jsdom

import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { ComplianceStatusDistributionBars } from "@/app/compliance/status-distribution-bar";

describe("ComplianceStatusDistributionBars", () => {
  it("keeps each colourless GENIUS outcome inspectable with its own filter link", () => {
    render(
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
  });
});
