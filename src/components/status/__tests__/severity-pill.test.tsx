// @vitest-environment jsdom

import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { SeverityPill } from "../severity-pill";


describe("SeverityPill", () => {
  it("labels each severity and keeps the three levels visually distinguishable", () => {
    render(
      <div>
        <SeverityPill severity="critical" />
        <SeverityPill severity="warning" />
        <SeverityPill severity="info" />
      </div>,
    );

    const tones = ["critical", "warning", "info"].map((severity) => screen.getByText(severity).className);
    expect(new Set(tones).size).toBe(3);
  });
});
