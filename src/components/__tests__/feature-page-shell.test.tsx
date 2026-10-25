// @vitest-environment jsdom

import { render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { FeaturePageShell } from "@/components/feature-page-shell";

vi.mock("next/link", async () => {
  const { createNextLinkMock } = await import("@/test-utils/frontend");
  return createNextLinkMock();
});

describe("FeaturePageShell instrument header", () => {
  it("renders one deck, the methodology meta row with actions, and folds extra lead paragraphs", () => {
    const { container } = render(
      <FeaturePageShell
        breadcrumbName="Example"
        path="/example/"
        title="Example"
        header="instrument"
        methodology={{ version: "v1.2", changelogPath: "/changelog/example/" }}
        headerActions={<button type="button">Share</button>}
        leadParagraphs={["The deck.", "The longer how-to-read paragraph."]}
        leadDisclosureLabel="How to read it"
      >
        <div>body</div>
      </FeaturePageShell>,
    );

    screen.getByRole("heading", { level: 1, name: "Example" });
    screen.getByText("The deck.");
    expect(screen.getByRole("link", { name: /Version history/ }).getAttribute("href")).toBe("/changelog/example/");
    screen.getByRole("button", { name: "Share" });
    const details = container.querySelector("details");
    expect(details?.querySelector("summary")?.textContent).toBe("How to read it");
    expect(details?.textContent).toContain("The longer how-to-read paragraph.");
    expect(screen.queryByRole("link", { name: /How this is computed/ })).toBeNull();
  });

  it.each(["instrument", "standard"] as const)("links the methodology docs page in the %s header meta row", (header) => {
    render(
      <FeaturePageShell
        breadcrumbName="Example"
        path="/example/"
        title="Example"
        header={header}
        methodology={{ version: "v1.2", changelogPath: "/changelog/example/", docsPath: "/docs/example/" }}
      >
        <div>body</div>
      </FeaturePageShell>,
    );

    const link = screen.getByRole("link", { name: /How this is computed/ });
    expect(link.getAttribute("href")).toBe("/docs/example/");
    expect(link.closest("p")?.textContent).toContain("Version history");
  });
});
