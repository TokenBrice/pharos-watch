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
  it("renders the client analytics without a duplicate server cohort directory", () => {
    const { container } = render(<AltPegsPage />);

    expect(screen.getByTestId("alt-pegs-client")).toBeTruthy();
    expect(container.querySelector('a[href="/stablecoins/eur"], a[href="/stablecoins/eur/"]')).toBeNull();
    expect(container.textContent).not.toContain("References beyond geography");
  });
});
