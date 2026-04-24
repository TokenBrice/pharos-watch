// @vitest-environment jsdom

import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
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

function withQueryClient(children: ReactNode): ReactNode {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return <QueryClientProvider client={client}>{children}</QueryClientProvider>;
}

describe("AltPegsPage", () => {
  it("renders the static peg diversity hero before the client analytics", () => {
    const { container } = render(withQueryClient(<AltPegsPage />));

    expect(screen.getByTestId("alt-pegs-client")).toBeTruthy();
    expect(screen.getByRole("heading", { name: "Peg Diversity Map" })).toBeTruthy();
    expect(container.querySelector('a[href="/stablecoins/eur"], a[href="/stablecoins/eur/"]')).not.toBeNull();

    const text = container.textContent ?? "";
    expect(text.indexOf("Peg Diversity Map")).toBeLessThan(text.indexOf("alt-pegs-client"));
  });
});
