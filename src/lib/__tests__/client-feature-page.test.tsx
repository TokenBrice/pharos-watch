// @vitest-environment jsdom

import { render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanupFrontendTest, createNextLinkMock } from "@/test-utils/frontend";

const dynamicMock = vi.hoisted(() => ({
  receivedProps: [] as Array<Record<string, unknown>>,
}));

vi.mock("next/dynamic", () => ({
  default: () => {
    function Dynamic(props: Record<string, unknown>) {
      dynamicMock.receivedProps.push(props);
      return <div data-testid="dynamic-client">{JSON.stringify(props)}</div>;
    }
    return Dynamic;
  },
}));

vi.mock("next/link", async () => createNextLinkMock());

import { createClientFeaturePage } from "@/lib/client-feature-page";

const shell = {
  breadcrumbName: "Test",
  title: "Test Feature",
  leadParagraphs: ["Lead"],
};

describe("createClientFeaturePage", () => {
  afterEach(() => {
    cleanupFrontendTest();
    dynamicMock.receivedProps.length = 0;
  });

  it("passes server-owned client props into the dynamic island", () => {
    const route = createClientFeaturePage<{ initialPreview: string | null }>({
      path: "/test-feature/",
      metadata: { title: "Test Feature", description: "Test feature description" },
      loadClient: async () => ({ default: () => null }),
      clientProps: { initialPreview: "dated-preview" },
      loading: <div>Loading</div>,
      shell,
    });

    render(<route.Page />);

    expect(screen.getByTestId("dynamic-client").textContent).toContain("dated-preview");
  });

  it("keeps no-prop callers rendering an empty prop bag", () => {
    const route = createClientFeaturePage({
      path: "/test-feature/",
      metadata: { title: "Test Feature", description: "Test feature description" },
      loadClient: async () => ({ default: () => null }),
      loading: <div>Loading</div>,
      shell,
    });

    render(<route.Page />);

    expect(screen.getByTestId("dynamic-client").textContent).toBe("{}");
  });
});
