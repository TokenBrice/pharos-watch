// @vitest-environment jsdom

import { describe, it, expect } from "vitest";
import { render, screen } from "@testing-library/react";
import { SectionErrorBoundary } from "../section-error-boundary";

function Bomb() {
  throw new Error("boom");
}

describe("SectionErrorBoundary", () => {
  it("renders children when no error", () => {
    render(
      <SectionErrorBoundary section="overview">
        <div>child-ok</div>
      </SectionErrorBoundary>,
    );
    expect(screen.getByText("child-ok")).toBeTruthy();
  });

  it("renders fallback with section name and error message on crash", () => {
    const originalError = console.error;
    console.error = () => undefined;
    try {
      render(
        <SectionErrorBoundary section="crons">
          <Bomb />
        </SectionErrorBoundary>,
      );
      const alert = screen.getByRole("alert");
      expect(alert.textContent ?? "").toContain("Section failed to render: crons");
      expect(alert.textContent ?? "").toContain("boom");
      expect(alert.textContent ?? "").toContain("Other sections continue to work");
    } finally {
      console.error = originalError;
    }
  });
});
