// @vitest-environment jsdom

import { render, screen } from "@testing-library/react";
import type { ReactNode } from "react";
import { describe, expect, it, vi } from "vitest";
import AltPegsPage from "@/app/alt-pegs/page";

vi.mock("next/dynamic", () => ({
  default: () => () => <div data-testid="alt-pegs-client">alt-pegs-client</div>,
}));

vi.mock("@/components/feature-page-shell", () => ({
  FeaturePageShell: ({ title, children }: { title: string; children: ReactNode }) => (
    <div>
      <h1>{title}</h1>
      {children}
    </div>
  ),
}));

vi.mock("@/components/section-error-boundary", () => ({
  SectionErrorBoundary: ({ children }: { children: ReactNode }) => <>{children}</>,
}));

describe("AltPegsPage", () => {
  it("includes the static link hub in the page composition", () => {
    render(<AltPegsPage />);

    expect(screen.getByTestId("alt-pegs-client")).toBeTruthy();
    expect(screen.getByRole("heading", { name: "Explore Peg Cohorts" })).toBeTruthy();
    expect(screen.getByRole("link", { name: /Euro/i }).getAttribute("href")).toBe("/stablecoins/eur");
  });
});
