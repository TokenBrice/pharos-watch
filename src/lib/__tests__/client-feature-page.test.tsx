// @vitest-environment jsdom

import { render, screen } from "@testing-library/react";
import type { ReactNode } from "react";
import { describe, expect, it, vi } from "vitest";
import { createClientFeaturePage } from "@/lib/client-feature-page";

vi.mock("next/dynamic", () => ({
  default: () => () => <div>client</div>,
}));

vi.mock("@/components/feature-page-shell", () => ({
  FeaturePageShell: ({ path, children }: { path: string; children: ReactNode }) => (
    <div data-path={path}>{children}</div>
  ),
}));

vi.mock("@/components/section-error-boundary", () => ({
  SectionErrorBoundary: ({ children }: { children: ReactNode }) => <>{children}</>,
}));

describe("createClientFeaturePage", () => {
  it("uses the route path for both metadata canonical and the feature shell", () => {
    const route = createClientFeaturePage({
      path: "/example/",
      metadata: { title: "Example", description: "Example route" },
      loadClient: async () => ({ default: () => null }),
      loading: null,
      shell: { breadcrumbName: "Example", title: "Example" },
    });

    expect(route.metadata.alternates?.canonical).toBe("/example/");
    render(<route.Page />);
    expect(screen.getByText("client").parentElement?.dataset.path).toBe("/example/");
  });
});
