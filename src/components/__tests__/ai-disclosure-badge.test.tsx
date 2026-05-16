// @vitest-environment jsdom

import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import { AiDisclosureBadge } from "@/components/ai-disclosure-badge";

afterEach(cleanup);

describe("AiDisclosureBadge", () => {
  it("renders all five disclosure fields when provided", () => {
    render(
      <AiDisclosureBadge
        authoredBy="ai"
        model="claude-opus-4-7"
        reviewedBy="@TokenBrice"
        reviewedAt="2026-05-15"
        factsAsOf="2026-05-15"
      />,
    );
    expect(
      screen.getByText(
        "AI summary · drafted by claude-opus-4-7 · reviewed by @TokenBrice on May 15, 2026 · facts as of May 15, 2026",
      ),
    ).toBeTruthy();
  });

  it("renders a human-authored disclosure without a model attribution", () => {
    render(
      <AiDisclosureBadge
        authoredBy="human"
        reviewedBy="@TokenBrice"
        reviewedAt="2026-05-15"
        factsAsOf="2026-05-15"
      />,
    );
    expect(
      screen.getByText(
        "Human summary · reviewed by @TokenBrice on May 15, 2026 · facts as of May 15, 2026",
      ),
    ).toBeTruthy();
  });

  it("renders nothing when no provenance fields are provided", () => {
    const { container } = render(<AiDisclosureBadge />);
    expect(container.textContent).toBe("");
  });
});
