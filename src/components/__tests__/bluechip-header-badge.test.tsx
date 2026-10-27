// @vitest-environment jsdom
import { act, cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { BluechipHeaderBadge } from "@/components/bluechip-header-badge";
import { BLUECHIP_OBSERVATION_MAX_AGE_SEC } from "@shared/lib/bluechip-freshness";
import { makeUnreportedBluechipRating } from "@shared/test-utils/bluechip.test-support";

const { ratings } = vi.hoisted(() => ({ ratings: {} as Record<string, unknown> }));

vi.mock("@/hooks/api-hooks", () => ({
  useBluechipRatings: () => ({ data: ratings }),
}));

describe("BluechipHeaderBadge", () => {
  afterEach(() => {
    cleanup();
    vi.useRealTimers();
    vi.restoreAllMocks();
    for (const id of Object.keys(ratings)) delete ratings[id];
  });

  it.each(["F", "B", "A"])("shows external grade %s without suspended Pharos qualification or tenure", (grade) => {
    ratings[grade] = {
      ...makeUnreportedBluechipRating(),
      grade,
      slug: "usdc",
      dateOfRating: "2024-08-15",
      lastObservedAt: Math.floor(Date.now() / 1000),
      observationState: "current",
      observationReason: null,
    };
    const html = renderToStaticMarkup(<BluechipHeaderBadge stablecoinId={grade} />);
    expect(html).toContain('href="https://bluechip.org/en/coins/usdc"');
    expect(html).toContain(`>${grade}<`);
    expect(html).toContain(`aria-label="Bluechip rating: ${grade} · Observed `);
    expect(html).not.toContain("Pharos Bluechip");
    expect(html).not.toContain("/about/bluechip/");
    expect(html).not.toContain("since");
    expect(html).not.toContain("2024-08");
    expect(html).not.toContain("designation");
  });

  const DAY = 86_400;
  it.each([
    { state: "current", age: 0, reason: null },
    { state: "retained", age: BLUECHIP_OBSERVATION_MAX_AGE_SEC, reason: "http-500" },
    { state: "retained", age: 3 * DAY, reason: "http-500" },
    { state: "stale", age: 3 * DAY, reason: "observation-expired" },
    { state: "retained", age: 12 * DAY, reason: "http-500" },
    { state: "retained", age: 12 * DAY + 1, reason: "http-500" },
  ] as const)("shows a neutral observation date for $state age=$age", ({ state, age, reason }) => {
    const now = 1_790_000_000;
    vi.spyOn(Date, "now").mockReturnValue(now * 1000);
    ratings.usdc = {
      ...makeUnreportedBluechipRating(),
      slug: "usdc",
      dateOfRating: "2024-08-15",
      lastObservedAt: now - age,
      observationState: state,
      observationReason: reason,
    };
    const date = new Date((now - age) * 1000).toISOString().slice(0, 10);
    const html = renderToStaticMarkup(<BluechipHeaderBadge stablecoinId="usdc" />);
    expect(html).toContain('href="https://bluechip.org/en/coins/usdc"');
    expect(html).toContain(">A</span>");
    expect(html).toContain(`title="Observed ${date} · View the external Bluechip methodology"`);
    expect(html).not.toContain(`>Observed ${date}</span>`);
    expect(html).toContain(`aria-label="Bluechip rating: A · Observed ${date} (via bluechip.org)"`);
    expect(html).not.toMatch(/retained|stale|observation unknown|2024-08/);
  });

  it.each([
    { label: "missing", lastObservedAt: null },
    { label: "future", lastObservedAt: 1_790_000_001 },
    { label: "non-finite", lastObservedAt: Number.NaN },
  ])("shows an unavailable date, never a fabricated one, for a $label clock", ({ lastObservedAt }) => {
    vi.spyOn(Date, "now").mockReturnValue(1_790_000_000 * 1000);
    ratings.usdc = { ...makeUnreportedBluechipRating(), lastObservedAt, observationState: "unknown", observationReason: null };
    const html = renderToStaticMarkup(<BluechipHeaderBadge stablecoinId="usdc" />);
    expect(html).toContain('title="Observation date unavailable · View the external Bluechip methodology"');
    expect(html).toContain('aria-label="Bluechip rating: A · Observation date unavailable (via bluechip.org)"');
    expect(html).not.toMatch(/Observed \d|observation unknown/);
  });

  it("keeps a mounted badge neutral across the 48h admission boundary", () => {
    const now = 1_790_000_000;
    vi.useFakeTimers();
    vi.setSystemTime(now * 1000);
    ratings.usdc = {
      ...makeUnreportedBluechipRating(),
      lastObservedAt: now - BLUECHIP_OBSERVATION_MAX_AGE_SEC,
      observationState: "current",
      observationReason: null,
    };
    const { rerender } = render(<BluechipHeaderBadge stablecoinId="usdc" />);
    act(() => { vi.advanceTimersByTime(1000); });
    rerender(<BluechipHeaderBadge stablecoinId="usdc" />);
    const label = screen.getByRole("link").getAttribute("aria-label");
    expect(label).toContain(`Observed ${new Date((now - BLUECHIP_OBSERVATION_MAX_AGE_SEC) * 1000).toISOString().slice(0, 10)}`);
    expect(label).not.toContain("stale");
  });

  it("renders nothing when the stablecoin has no Bluechip rating", () => {
    const html = renderToStaticMarkup(<BluechipHeaderBadge stablecoinId="dai-makerdao" />);
    expect(html).toBe("");
  });
});
