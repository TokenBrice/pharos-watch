// @vitest-environment jsdom

import { render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

vi.mock("next/link", async () => {
  const { createNextLinkMock } = await import("@/test-utils/frontend");
  return createNextLinkMock();
});

const { AiSummary } = await import("../ai-summary");

describe("AiSummary", () => {
  it("renders optional labeled sources without inventing review provenance", () => {
    render(<AiSummary
      title="Evidence correction"
      text="A sourced summary."
      updatedAt="2026-08-09"
      authoredBy="ai"
      model="gpt-test"
      factsAsOf="2026-08-09"
      sources={[
        { label: "Product documentation", url: "https://example.com/docs" },
        { label: "Timestamped reserve API", url: "https://example.com/api" },
      ]}
    />);

    expect(screen.getByText("Sources")).toBeTruthy();
    expect(screen.getByRole("link", { name: "Product documentation" }).getAttribute("href")).toBe(
      "https://example.com/docs",
    );
    expect(screen.getByRole("link", { name: "Timestamped reserve API" }).getAttribute("href")).toBe(
      "https://example.com/api",
    );
    expect(document.body.textContent).toContain("drafted by gpt-test");
    expect(document.body.textContent).not.toContain("reviewed by");
  });

  it("renders current claim values with a facts-as-of badge", () => {
    render(<AiSummary
      title="Current assessment"
      text="The current grade is {{grade}}."
      updatedAt="2026-08-09"
      factsAsOf="2026-08-09"
      claimTokens={[{
        token: "grade",
        placeholder: "{{grade}}",
        source: "report-card.grade",
        factsAsOf: "2026-09-01",
      }]}
      claimValues={{ "report-card.grade": "B+" }}
    />);

    expect(document.body.textContent).toContain("The current grade is B+.");
    expect(document.body.textContent).toContain("Claims as of September 1, 2026");
  });

  it("renders unresolved or malicious claim values as N/A and preserves source links", () => {
    render(<AiSummary
      title="Current assessment"
      text="The current grade is {{grade}}."
      updatedAt="2026-08-09"
      claimTokens={[{
        token: "grade",
        placeholder: "{{grade}}",
        source: "report-card.grade",
        factsAsOf: "2026-09-01",
      }]}
      claimValues={{ "report-card.grade": "<script>alert(1)</script>" }}
      sources={[{ label: "Primary evidence", url: "https://example.com/evidence" }]}
    />);

    expect(document.body.textContent).toContain("The current grade is N/A.");
    expect(document.querySelector("script")).toBeNull();
    expect(screen.getByRole("link", { name: "Primary evidence" }).getAttribute("href")).toBe(
      "https://example.com/evidence",
    );
  });
});
