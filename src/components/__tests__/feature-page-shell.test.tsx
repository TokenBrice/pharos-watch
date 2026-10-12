// @vitest-environment jsdom

import { render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { FeaturePageShell } from "@/components/feature-page-shell";
import { Card, CardHeader } from "@/components/ui/card";

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
  });
});

describe("Card grammar", () => {
  it("emits the card-shell treatment and the standard header slots", () => {
    const { container } = render(
      <Card variant="shell">
        <CardHeader kicker="Kicker" heading="Panel title" freshness="Updated every 30 min" />
      </Card>,
    );

    const card = container.querySelector('[data-slot="card"]');
    expect(card?.className).toContain("pharos-card-shell");
    expect(card?.className).not.toContain("bg-card");
    const heading = screen.getByRole("heading", { level: 2, name: "Panel title" });
    expect(heading.className).toBe("pharos-section-title");
    screen.getByText("Kicker");
    screen.getByText("Updated every 30 min");
  });
});
