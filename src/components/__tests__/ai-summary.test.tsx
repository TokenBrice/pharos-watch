// @vitest-environment jsdom

import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { AnchorHTMLAttributes } from "react";

vi.mock("next/link", () => ({
  default: ({ prefetch, ...props }: AnchorHTMLAttributes<HTMLAnchorElement> & { prefetch?: boolean | null }) => (
    <a {...props} data-prefetch={prefetch === false ? "disabled" : "auto"} />
  ),
}));

afterEach(cleanup);

const { AiSummary } = await import("../ai-summary");

describe("AiSummary", () => {
  it.each(["mouseEnter", "focus"] as const)("prefetches the AI policy only after %s intent", (intent) => {
    render(<AiSummary title="Summary" text="Evidence." updatedAt="2026-10-18" />);
    const link = screen.getByRole("link", { name: "AI policy" });
    expect(link.getAttribute("href")).toBe("/about/#editorial-ai-policy");
    expect(link.getAttribute("data-prefetch")).toBe("disabled");
    fireEvent[intent](link);
    expect(link.getAttribute("data-prefetch")).toBe("auto");
  });

  it("does not invent review provenance for AI drafts", () => {
    render(<AiSummary
      title="Evidence correction"
      text="A draft summary."
      updatedAt="2026-08-09"
      authoredBy="ai"
      model="gpt-test"
      factsAsOf="2026-08-09"
    />);

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
    expect(document.body.textContent).toContain("Claims as of 2026-09-01");
  });

  it("dates the provenance footer in ISO days, including the review date", () => {
    render(<AiSummary
      title="Reviewed summary"
      text="A reviewed summary."
      updatedAt="2026-08-09"
      authoredBy="ai"
      model="gpt-test"
      reviewedBy="@reviewer"
      reviewedAt="2026-08-10T12:00:00Z"
      factsAsOf="2026-08-08"
    />);

    const updated = document.querySelector("time");
    expect(updated?.getAttribute("dateTime")).toBe("2026-08-09");
    const footer = updated?.parentElement?.textContent ?? "";
    expect(footer).toContain("reviewed by @reviewer on 2026-08-10");
    expect(footer).toContain("facts as of 2026-08-08");
    expect(footer).not.toMatch(/August/);
    expect(screen.getByRole("link", { name: "AI policy" }).getAttribute("href")).toBe("/about/#editorial-ai-policy");
  });

  it.each([
    { label: "an unresolved", claimValues: {} },
    { label: "a malicious", claimValues: { "report-card.grade": "<script>alert(1)</script>" } },
  ])("withholds the overview for $label claim value instead of rendering N/A", ({ claimValues }) => {
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
      claimValues={claimValues}
    />);

    const text = document.body.textContent ?? "";
    expect(text).toContain("The current Safety Score and live assessment are available on the interactive page.");
    expect(text).not.toContain("N/A");
    expect(text).not.toContain("Claims as of");
    expect(document.querySelector("script")).toBeNull();
  });
});
