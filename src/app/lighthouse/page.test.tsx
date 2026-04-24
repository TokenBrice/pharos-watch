// @vitest-environment jsdom

import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { render, screen } from "@testing-library/react";
import type { ReactNode } from "react";
import { describe, expect, it, vi } from "vitest";
import LighthousePage from "./page";

vi.mock("next/dynamic", () => ({
  default: () => () => <div data-testid="lighthouse-client">lighthouse-client</div>,
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

describe("LighthousePage", () => {
  it("renders the lighthouse route shell and client placeholder", () => {
    render(withQueryClient(<LighthousePage />));

    expect(screen.getByRole("heading", { name: "Pharos Lighthouse" })).toBeTruthy();
    expect(screen.getByTestId("lighthouse-client")).toBeTruthy();
  });
});
