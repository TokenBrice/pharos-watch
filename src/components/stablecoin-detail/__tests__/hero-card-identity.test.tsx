// @vitest-environment jsdom

import { render } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import type { StablecoinClientMeta } from "@shared/lib/stablecoins/client-registry";
import type { V9ConsumerCard } from "@/lib/safety-score-v9-consumers";
import { HeroVariantChip, SafetyGradeHero } from "../hero-card-identity";

vi.mock("next/link", async () => {
  const { createNextLinkMock } = await import("@/test-utils/frontend");
  return createNextLinkMock();
});

describe("SafetyGradeHero read states", () => {
  it("shows a neutral placeholder, not a dash, while the first report-card read is in flight", () => {
    const { container } = render(<SafetyGradeHero reportCard={null} read="pending" mobile />);

    expect(container.querySelector('[role="status"]')?.getAttribute("aria-label")).toBe("Loading Safety Score");
    expect(container.textContent).not.toContain("—");
  });

  it("says the grade is unavailable after a failed read, never the unscored dash", () => {
    const { container } = render(<SafetyGradeHero reportCard={null} read="failed" mobile />);

    expect(container.textContent).toBe("Grade unavailable");
    expect(container.querySelector('[data-safety-state="unavailable"]')).not.toBeNull();
  });

  it("keeps the unscored dash once the read has settled without a card", () => {
    const { container } = render(<SafetyGradeHero reportCard={null} mobile />);

    expect(container.textContent).toBe("—");
    expect(container.querySelector('[role="status"]')).toBeNull();
  });
  it("uses the identical grade track for pending, saved, failed, unscored, scored and pipeline-gap states", () => {
    const { container, rerender } = render(<SafetyGradeHero reportCard={null} read="pending" mobile />);
    const track = container.querySelector("[data-safety-grade-track]")!;
    const trackClass = track.className;
    rerender(<SafetyGradeHero reportCard={null} read="pending" mobile savedGrade={{
      grade: "B+", score: 80, dewsScore: null, dewsBand: null, liquidityScore: null, asOfMs: Date.UTC(2026, 9, 24),
    }} />);
    expect(track.textContent).toContain("as of 2026-10-24");
    expect(track.className).toBe(trackClass);
    for (const read of ["failed", "settled"] as const) {
      rerender(<SafetyGradeHero reportCard={null} read={read} mobile />);
      expect(container.querySelector("[data-safety-grade-track]")).toBe(track);
      expect(track.className).toBe(trackClass);
    }
    for (const grade of ["B+", null] as const) {
      const card = { grade, score: grade ? 100 : null } as V9ConsumerCard;
      rerender(<SafetyGradeHero reportCard={card} mobile />);
      expect(container.querySelector("[data-safety-grade-track]")).toBe(track);
      expect(track.className).toBe(trackClass);
      expect(track.textContent).toContain(grade ?? "Pipeline gap");
    }
  });
});

describe("HeroVariantChip", () => {
  it("names the wrapped parent and lets the chip wrap instead of clipping it", () => {
    const parent = { id: "usds-sky", name: "Sky Dollar", symbol: "USDS" } as StablecoinClientMeta;
    const { container } = render(
      <HeroVariantChip
        variantParent={parent}
        variantChipClass="border-frost-blue/30 bg-frost-blue/10 text-frost-blue"
        mobile
      />,
    );
    const link = container.querySelector("a")!;
    expect(link.getAttribute("href")).toBe("/stablecoin/usds-sky/");
    expect(link.getAttribute("aria-label")).toBe("Wraps Sky Dollar (USDS), variant of Sky Dollar");
    expect(link.textContent).toContain("Wraps Sky Dollar (USDS)");
    expect(link.className).toContain("min-w-0");
    expect(link.querySelector("span.min-w-0")?.textContent).toBe("Wraps Sky Dollar (USDS)");
  });
});
