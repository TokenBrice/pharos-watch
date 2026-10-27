// @vitest-environment jsdom

import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { HomeMarketStateLine } from "@/components/home-market-state-line";
import { API_FRESHNESS_MAX_AGE_SEC } from "@shared/lib/api-freshness";

const { useHomepageSnapshotMock } = vi.hoisted(() => ({ useHomepageSnapshotMock: vi.fn() }));
vi.mock("@/hooks/api-hooks", () => ({ useHomepageSnapshot: useHomepageSnapshotMock }));
afterEach(() => { cleanup(); vi.clearAllMocks(); });

const now = Date.parse("2026-10-18T12:00:00Z");
function meta(source: string, updatedAt = now / 1000) {
  return { source, updatedAt, ageSeconds: now / 1000 - updatedAt, assessedAt: now / 1000,
    freshBudgetSec: API_FRESHNESS_MAX_AGE_SEC.stabilityIndex, degradedBudgetSec: 7200,
    status: "fresh", reason: null, warning: null };
}

describe("HomeMarketStateLine compact lanes", () => {
  it("renders the projected displayed PSI and canonical incident count with destination links", () => {
    useHomepageSnapshotMock.mockReturnValue({ data: {
      psi: { data: { score: 91.9, band: "BEDROCK", computedAt: now / 1000 }, meta: meta("stability-index") },
      incidents: { data: { activeDepegCount: 1 }, meta: meta("peg-summary") },
    }, dataUpdatedAt: now, error: null, isLoading: false });
    render(<HomeMarketStateLine nowMs={now} />);
    expect(screen.getByRole("link", { name: /PSI/ }).textContent).toContain("Bedrock91.9");
    expect(screen.getByRole("link", { name: /PSI/ }).getAttribute("href")).toMatch(/^\/stability-index\/?$/);
    expect(screen.getByRole("link", { name: /active depeg/ }).textContent).toContain("1active depeg");
  });

  it("ages retained evidence without treating response receipt as its generation", () => {
    useHomepageSnapshotMock.mockReturnValue({ data: {
      psi: { data: { score: 91.2, band: "BEDROCK", computedAt: now / 1000 - 7 * 86400 }, meta: meta("stability-index", now / 1000 - 7 * 86400) },
      incidents: { data: null, meta: { ...meta("peg-summary"), updatedAt: null, ageSeconds: null, status: "unknown", reason: "source-read-failed" } },
    }, dataUpdatedAt: now, error: null, isLoading: false });
    render(<HomeMarketStateLine nowMs={now} />);
    expect(screen.getByRole("link", { name: /PSI/ }).textContent).not.toMatch(/stale|retained/i);
    expect(screen.getByText("Bedrock").className).toContain("text-foreground");
    expect(screen.getByRole("link", { name: /Active depegs/ }).textContent).toContain("—");
  });

  it("keeps a successful zero independent from a failed PSI lane", () => {
    useHomepageSnapshotMock.mockReturnValue({ data: {
      psi: { data: null, meta: { ...meta("stability-index"), status: "unknown", reason: "source-read-failed" } },
      incidents: { data: { activeDepegCount: 0 }, meta: meta("peg-summary") },
    }, dataUpdatedAt: now, error: null, isLoading: false });
    render(<HomeMarketStateLine nowMs={now} />);
    expect(screen.getByRole("link", { name: /PSI/ }).textContent).toContain("—");
    expect(screen.getByRole("link", { name: /active depegs/ }).textContent).toContain("0active depegs");
  });

  it("never turns a failed read into calm or zero", () => {
    useHomepageSnapshotMock.mockReturnValue({ data: undefined, dataUpdatedAt: 0, error: new Error("failed"), isLoading: false });
    render(<HomeMarketStateLine nowMs={now} />);
    expect(screen.getAllByText("—")).toHaveLength(2);
    expect(screen.queryByText("0")).toBeNull();
  });
});
