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
    expect(html).toContain(`aria-label="Bluechip rating: ${grade} (via bluechip.org)"`);
    expect(html).not.toContain("Pharos Bluechip");
    expect(html).not.toContain("/about/bluechip/");
    expect(html).not.toContain("since");
    expect(html).not.toContain("2024-08");
    expect(html).not.toContain("designation");
  });

  it.each([
    { state: "current", age: 0, label: null },
    { state: "retained", age: BLUECHIP_OBSERVATION_MAX_AGE_SEC, label: "retained" },
    { state: "current", age: BLUECHIP_OBSERVATION_MAX_AGE_SEC + 1, label: "stale retained" },
    { state: "retained", age: BLUECHIP_OBSERVATION_MAX_AGE_SEC + 1, label: "stale retained" },
    { state: "unknown", age: null, label: "observation unknown" },
    { state: "current", age: -1, label: "observation unknown" },
  ])("exposes $state age=$age beside the grade and in its accessible name", ({ state, age, label }) => {
    const now = 1_790_000_000;
    vi.spyOn(Date, "now").mockReturnValue(now * 1000);
    ratings.usdc = {
      ...makeUnreportedBluechipRating(),
      slug: "usdc",
      lastObservedAt: age == null ? null : now - age,
      observationState: state,
      observationReason: state === "retained" ? "http-500" : null,
    };
    const html = renderToStaticMarkup(<BluechipHeaderBadge stablecoinId="usdc" />);
    expect(html).toContain('href="https://bluechip.org/en/coins/usdc"');
    expect(html).toContain(">A</span>");
    if (label) {
      expect(html).toContain(`>(${label})</span>`);
      expect(html).toContain(`aria-label="Bluechip rating: A · ${label} (via bluechip.org)"`);
    } else {
      expect(html).not.toMatch(/retained|observation unknown/);
    }
    expect(html).not.toContain("/about/bluechip/");
  });

  it("marks a mounted rating stale when its own observation window expires", () => {
    const now = 1_790_000_000;
    vi.useFakeTimers();
    vi.setSystemTime(now * 1000);
    ratings.usdc = {
      ...makeUnreportedBluechipRating(),
      lastObservedAt: now - BLUECHIP_OBSERVATION_MAX_AGE_SEC,
      observationState: "current",
      observationReason: null,
    };
    render(<BluechipHeaderBadge stablecoinId="usdc" />);
    expect(screen.getByRole("link").getAttribute("aria-label")).not.toContain("stale");
    act(() => { vi.advanceTimersByTime(1000); });
    expect(screen.getByRole("link").getAttribute("aria-label")).toContain("stale retained");
  });

  it("renders nothing when the stablecoin has no Bluechip rating", () => {
    const html = renderToStaticMarkup(<BluechipHeaderBadge stablecoinId="dai-makerdao" />);
    expect(html).toBe("");
  });
});
