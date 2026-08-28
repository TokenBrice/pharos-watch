// @vitest-environment jsdom

import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
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

function appPageFiles(directory: string): string[] {
  // eslint-disable-next-line security/detect-non-literal-fs-filename -- recurse through the explicit src/app test root
  return readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) return appPageFiles(path);
    return entry.name === "page.tsx" ? [path] : [];
  });
}

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

  it("keeps every consumer on the single-path route-definition API", () => {
    const consumers = appPageFiles(join(process.cwd(), "src/app"))
      // eslint-disable-next-line security/detect-non-literal-fs-filename -- read page modules discovered under src/app
      .map((path) => ({ path, source: readFileSync(path, "utf8") }))
      .filter(({ source }) => source.includes("createClientFeaturePage({"));

    expect(consumers).toHaveLength(13);
    for (const { path, source } of consumers) {
      expect(source, path).toMatch(/createClientFeaturePage\(\{\s*path: "\/[^"]+\/",\s*metadata: \{/);
      expect(source, path).not.toMatch(/canonical:/);
      expect(source, path).not.toMatch(/shell:\s*\{[^}]*\bpath:/s);
      expect(source, path).toContain("export const metadata = route.metadata;");
      expect(source, path).toContain("export default route.Page;");
    }
  });
});
