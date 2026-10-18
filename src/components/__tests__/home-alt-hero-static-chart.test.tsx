// @vitest-environment jsdom

import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import { HomeAltHeroStaticChart } from "@/components/home-alt-hero-static-chart";
import { HOMEPAGE_HERO_MAX_FALLBACK_AGE_MS } from "@/lib/homepage-hero-snapshot";
import type { HomepageHistory, HomepageLaneMeta } from "@shared/types/homepage";

const now = Date.parse("2026-10-18T12:00:00Z");
function history(updatedAt: number | null): HomepageHistory {
  const assessment = { source: "stablecoin-charts", assessedAt: now / 1000, freshBudgetSec: 3600, degradedBudgetSec: 7200, reason: "dated-build-fallback", warning: null };
  const meta: HomepageLaneMeta = updatedAt === null
    ? { ...assessment, updatedAt: null, ageSeconds: null, status: "unknown" }
    : { ...assessment, updatedAt, ageSeconds: Math.max(0, now / 1000 - updatedAt), status: "stale" };
  return { sources: { total: meta, usdt: meta, usdc: meta, usds: meta, dai: meta }, rows: [100, null, 120].map((total, index) => ({
    ts: now - (3 - index) * 86400000, total, usdt: null, usdc: null, sky: null, others: null, nonUsd: null,
  })) };
}
afterEach(cleanup);

describe("dated hero history preview", () => {
  it("renders real dated content through the inclusive 72-hour bound and preserves the gap", () => {
    const { container } = render(<HomeAltHeroStaticChart history={history((now - HOMEPAGE_HERO_MAX_FALLBACK_AGE_MS) / 1000)} nowMs={now} />);
    expect(screen.getByText(/Fallback history/)).toBeTruthy();
    expect(screen.queryByText(/^Live ·/)).toBeNull();
    expect(container.querySelector("path")?.getAttribute("d")?.match(/M/g)).toHaveLength(2);
  });
  it.each([null, (now - HOMEPAGE_HERO_MAX_FALLBACK_AGE_MS - 1) / 1000, now / 1000 + 1])("withholds an undated, expired or future generation (%s)", (updatedAt) => {
    render(<HomeAltHeroStaticChart history={history(updatedAt)} nowMs={now} />);
    expect(screen.queryByText(/Fallback history/)).toBeNull();
  });
});
