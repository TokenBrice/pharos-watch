// @vitest-environment jsdom

import { afterEach, describe, expect, it } from "vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { BackingMechanicsCard } from "../backing-mechanics-card";
import type { MechanismBackingView } from "@/lib/mechanism-backing";

const view: MechanismBackingView = {
  archetype: "synthetic-delta-neutral",
  reviewedAt: "2026-07-15",
  sourceLabel: "Ethena transparency dashboard",
  sourceUrl: "https://example.com/transparency",
  metrics: [
    { key: "hedge", label: "Hedge coverage", value: 100.4, unit: "percent", hint: "Delta-neutral hedge ratio." },
    { key: "unwind", label: "Unwind window", value: 3, unit: "days", hint: "Time to unwind the hedge book." },
  ],
  protocolFacts: [],
  notes: [],
};

afterEach(cleanup);

describe("BackingMechanicsCard", () => {
  it("renders nothing without a reviewed backing view", () => {
    const { container } = render(<BackingMechanicsCard view={null} />);
    expect(container.firstChild).toBeNull();
  });

  it("folds the citation behind the standard Sources disclosure", () => {
    render(<BackingMechanicsCard view={view} />);

    expect(screen.getByText("100.4%")).toBeTruthy();
    expect(screen.getByText("Reviewed 2026-07-15")).toBeTruthy();

    // WS8.13: the hand-rolled always-visible frost-blue link is now the shared
    // `EvidenceFooter`, so the source ships collapsed but stays in the DOM.
    const sourcesToggle = screen.getByRole("button", { name: /Sources/ });
    expect(sourcesToggle.getAttribute("aria-expanded")).toBe("false");
    fireEvent.click(sourcesToggle);
    expect(screen.getByRole("link", { name: /Ethena transparency dashboard/ }).getAttribute("href")).toBe(
      "https://example.com/transparency",
    );
  });
});
