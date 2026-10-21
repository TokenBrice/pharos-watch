// @vitest-environment jsdom
import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import { ChainsFreshnessChip } from "./freshness-chip";

afterEach(cleanup);

const now = Math.floor(Date.now() / 1000);

describe("ChainsFreshnessChip", () => {
  it("keeps a degraded read with current report-card inputs off the hero", () => {
    const { container } = render(<ChainsFreshnessChip meta={{
      updatedAt: now, ageSeconds: 60, status: "degraded", warning: "Chain supply coverage incomplete",
      dependencies: { reportCards: { status: "fresh" } },
    }} />);
    expect(container.textContent).toBe("");
  });

  it("names a stale read and a non-fresh report-card dependency", () => {
    const { unmount } = render(<ChainsFreshnessChip meta={{ updatedAt: now - 86_400, ageSeconds: 86_400, status: "stale" }} />);
    expect(screen.getByRole("button", { name: /Stale data/ })).toBeTruthy();
    unmount();
    render(<ChainsFreshnessChip meta={{
      updatedAt: now, ageSeconds: 60, status: "degraded",
      dependencies: { reportCards: { status: "stale", reason: "ratings-old" } },
    }} />);
    expect(screen.getByRole("button", { name: /Chain Health inputs stale/ })).toBeTruthy();
  });
});
