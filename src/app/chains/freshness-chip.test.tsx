// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { renderToString } from "react-dom/server";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ChainsFreshnessChip } from "./freshness-chip";

const generation = Date.UTC(2026, 9, 26) / 1000; // 2026-10-26 00:00 UTC
// The Worker publishes supply budgets explicitly (sync interval x2 endpoint age); these win over generic ratios.
const served = { updatedAt: generation, ageSeconds: 0, status: "fresh" as const, freshBudgetSec: 1_800, degradedBudgetSec: 3_600 };
const receivedAt = generation * 1000;

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(receivedAt);
});
afterEach(() => {
  cleanup();
  vi.useRealTimers();
});

const chip = () => screen.queryByRole("button", { name: /Stale data/ });
const openChip = () => fireEvent.click(chip()!);

describe("ChainsFreshnessChip", () => {
  it("ages a served fresh generation into the stale band at its producer budget without a refetch", async () => {
    render(<ChainsFreshnessChip meta={served} dataUpdatedAt={receivedAt} />);
    await act(async () => { vi.advanceTimersByTime(0); });
    expect(chip()).toBeNull();

    // past the fresh budget is degraded: operator signal only
    await act(async () => { vi.advanceTimersByTime(1_801_000); });
    expect(chip()).toBeNull();
    // the exact stale boundary is still inclusive of the degraded band
    await act(async () => { vi.advanceTimersByTime(1_799_000); });
    expect(chip()).toBeNull();
    await act(async () => { vi.advanceTimersByTime(1); });
    const button = chip();
    expect(button?.getAttribute("data-reason-codes")).toBe("api-fresh health-stale");
    openChip();
    expect(document.body.textContent).toContain("Data is stale.");
    expect(document.body.textContent).toContain("Supply snapshot as of 2026-10-26 00:00 UTC, 1h old; stale after 1h.");
  });

  it("ages from the producer clock, not the saved ageSeconds, and keeps the original supply date", async () => {
    vi.setSystemTime(receivedAt + 7_200_000);
    render(<ChainsFreshnessChip meta={served} dataUpdatedAt={receivedAt} />);
    await act(async () => { vi.advanceTimersByTime(0); });
    openChip();
    expect(document.body.textContent).toContain("Supply snapshot as of 2026-10-26 00:00 UTC, 2h old; stale after 1h.");
  });

  it("keeps held, stale or unavailable report-card inputs over fresh supply off the hero", () => {
    for (const status of ["degraded", "stale", "unavailable"] as const) {
      const { container, unmount } = render(<ChainsFreshnessChip
        meta={{ ...served, status: "degraded", warning: "Chain Health inputs held", dependencies: { reportCards: { status, reason: "publication-held", ageSeconds: 0 } } }}
        dataUpdatedAt={receivedAt}
      />);
      expect(container.textContent).toBe("");
      unmount();
    }
  });

  it("names a genuinely stale supply read without raw warnings or dependency copy", () => {
    render(<ChainsFreshnessChip
      meta={{ updatedAt: generation - 86_400, ageSeconds: 86_400, status: "stale", warning: "110 - \"operator detail\"", dependencies: { reportCards: { status: "stale" } } }}
      dataUpdatedAt={receivedAt}
    />);
    expect(chip()?.getAttribute("data-reason-codes")).toBe("api-stale health-stale");
    openChip();
    expect(document.body.textContent).not.toContain("operator detail");
    expect(document.body.textContent).not.toContain("Chain Health");
    expect(document.body.textContent).toContain("Supply snapshot as of 2026-10-25 00:00 UTC, 1d old");
  });

  it("leaves absent and warning-only metadata to the route", () => {
    const { container, rerender } = render(<ChainsFreshnessChip meta={null} />);
    expect(container.textContent).toBe("");
    rerender(<ChainsFreshnessChip meta={{ ...served, status: "degraded", warning: "Chain supply coverage incomplete" }} dataUpdatedAt={receivedAt} />);
    expect(container.textContent).toBe("");
  });

  it("renders the same verdict on the server and first hydration from the receipt clock", () => {
    vi.setSystemTime(receivedAt + 86_400_000);
    // SSR has no local clock: a fresh-at-receipt generation stays quiet rather than mismatching hydration
    expect(renderToString(<ChainsFreshnessChip meta={served} dataUpdatedAt={receivedAt} />)).toBe("");
  });
});
