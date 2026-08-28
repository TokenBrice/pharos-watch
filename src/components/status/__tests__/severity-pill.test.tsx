// @vitest-environment jsdom

import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { SeverityPill } from "../severity-pill";


describe("SeverityPill", () => {
  it("maps shared severity levels to the centralized badge classes", () => {
    render(
      <div>
        <SeverityPill severity="critical" />
        <SeverityPill severity="warning" />
        <SeverityPill severity="info" />
      </div>,
    );

    expect(screen.getByText("critical").className).toContain("bg-red-500/15");
    expect(screen.getByText("warning").className).toContain("bg-amber-500/15");
    expect(screen.getByText("info").className).toContain("bg-muted");
  });
});
