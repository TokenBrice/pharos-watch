// @vitest-environment jsdom

import { fireEvent, render, screen } from "@testing-library/react";
import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanupFrontendTest, createNextLinkMock } from "@/test-utils/frontend";
import type { SafetyScoresPreview } from "@/lib/safety-grade-snapshot";

vi.mock("next/link", async () => createNextLinkMock());

import { SafetyScoresContentLoadingState } from "./loading-state";
import { SafetyMapPoster } from "./map/poster";

const PREVIEW: SafetyScoresPreview = {
  kind: "safety-grade-preview",
  rows: [{
    id: "asset-a",
    name: "Asset A",
    symbol: "AAA",
    href: "/stablecoin/asset-a/",
    grade: "A",
    score: 90,
    provisional: false,
    gradeHoldRawGrade: null,
  }],
  shownCount: 1,
  eligibleRatedCount: 1,
  publicationCompleteness: { expectedCount: 1, ratedCount: 1, notRatedCount: 0, pipelineGapCount: 0 },
  publicationHealth: {
    schemaVersion: 2,
    status: "current",
    acceptedPublicationGenerationId: "v9-publication-1",
    acceptedAtSec: 1_793_171_906,
    attemptedAtSec: 1_793_171_906,
    heldSinceSec: null,
    reasons: [],
  },
  identity: {
    model: "v9",
    schemaVersion: 1,
    methodologyVersion: "9.0",
    evaluationBuildDigest: "b".repeat(64),
    baseInputGenerationId: `report-cards-input:v1:${"c".repeat(64)}`,
    publicationGenerationId: "v9-publication-1",
    policyId: "safety-score-v9",
    policyDigest: "a".repeat(64),
  },
  publishedAtSec: 1_793_171_906,
  capturedAtSec: 1_793_174_453,
  snapshotDate: "2026-10-28",
  expiresAtSec: 1_793_433_600,
};

describe("SafetyScoresContentLoadingState", () => {
  afterEach(cleanupFrontendTest);

  it("prerenders no results region without an admissible preview and uses ChartSkeleton", () => {
    const html = renderToStaticMarkup(<SafetyScoresContentLoadingState />);
    expect(html).not.toContain('aria-label="Safety score cards"');
    expect(html).not.toContain("Grades as of");
    expect(html).toContain('data-chart-skeleton-variant="bars"');
    const { container } = render(<SafetyScoresContentLoadingState />);
    expect(container.querySelectorAll('img[src="/safety-scores/map.webp"]')).toHaveLength(1);
    const mobileSource = container.querySelector('picture > source[media="(max-width: 639px)"]');
    expect(mobileSource?.getAttribute("srcset")).toBe("/safety-scores/map.webp?w=400");
    expect(mobileSource?.getAttribute("type")).toBe("image/webp");
  });

  it("renders one dated results region when a retained preview is passed and omits raw (A)/(B) cause codes", () => {
    const { container } = render(<SafetyScoresContentLoadingState preview={PREVIEW} />);
    expect(container.querySelectorAll('[aria-label="Safety score cards"]')).toHaveLength(1);
    expect(container.textContent).toContain("Grades as of 2026-10-28");
    expect(container.querySelector('a[href="/stablecoin/asset-a/"]')).not.toBeNull();
    expect(container.textContent).not.toMatch(/\(A\)|\(B\)/);
  });

  it("dates the caption with the publication clock, not the dataset date", () => {
    // A publication that lands after UTC midnight is dated by its own clock,
    // the same clock the <time> carries.
    const { container } = render(
      <SafetyScoresContentLoadingState
        preview={{ ...PREVIEW, snapshotDate: "2026-10-27" }}
      />,
    );
    const time = container.querySelector("time");
    expect(time?.getAttribute("datetime")).toBe("2026-10-28T07:18:26.000Z");
    expect(time?.textContent).toBe("Grades as of 2026-10-28");
    expect(container.querySelector('a[href="/datasets/scores-latest/2026-10-27.json"]')).not.toBeNull();
  });

  it("opens an accessible full-size Dialog lightbox with zoom toggle from SafetyMapPoster", () => {
    render(<SafetyMapPoster />);
    const trigger = screen.getByRole("button", { name: "Open full-size Safety Score Map lightbox" });
    fireEvent.click(trigger);

    expect(screen.getByRole("dialog")).toBeTruthy();
    const fitBtn = screen.getByRole("button", { name: "Fit window" });
    const actualBtn = screen.getByRole("button", { name: "100% detail" });
    expect(fitBtn.getAttribute("aria-pressed")).toBe("true");
    fireEvent.click(actualBtn);
    expect(actualBtn.getAttribute("aria-pressed")).toBe("true");
  });
});
