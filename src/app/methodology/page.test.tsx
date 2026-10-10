// @vitest-environment jsdom
import type { ReactNode } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";

vi.mock("next/font/local", () => ({
  default: () => ({ className: "mock-local-font", variable: "--mock-local-font" }),
}));

vi.mock("next/link", async () => {
  const { createNextLinkMock } = await import("@/test-utils/frontend");
  return createNextLinkMock();
});

import MethodologyPage from "@/app/methodology/page";
import { METHODOLOGY_CONTEXT } from "@/lib/methodology-context";
import { PricingPipelineMethodologySection } from "./sections/core-sections-pricing";
import { LiquidityPreconditions } from "./sections/core/liquidity-overview";
import { DepegResolverMethodologySection } from "./sections/monitoring/depeg-resolver-section";
import { PegScoreDewsTechnicalDetails } from "./sections/monitoring/pegscore-dews-technical-details";
import { DEX_VOLUME_COVERAGE_MIN } from "@shared/lib/dex-volume-availability";
import {
  EVIDENCE_STRESS_THRESHOLD,
  SEVERE_ISSUER_CONTROL_THRESHOLD,
  WATCH_MAX_SCORE,
} from "@shared/lib/dews-config";

function renderSection(element: ReactNode): HTMLDivElement {
  const root = document.createElement("div");
  root.innerHTML = renderToStaticMarkup(element);
  return root;
}

describe("MethodologyPage", () => {

  it("renders every section anchor that methodology context deep-links to", () => {
    const html = renderToStaticMarkup(<MethodologyPage />);
    const anchors = new Set(
      Object.values(METHODOLOGY_CONTEXT)
        .map((item) => item.methodologyPath)
        .filter((path) => path.startsWith("/methodology/#"))
        .map((path) => path.slice("/methodology/#".length)),
    );

    expect(anchors.size).toBeGreaterThan(0);
    for (const anchor of anchors) {
      expect(html, `methodologyPath anchor #${anchor} is not rendered on /methodology/`).toContain(`id="${anchor}"`);
    }
  });

  it("publishes the six-source example's even-cluster midpoint without four-decimal rounding", () => {
    const root = renderSection(<PricingPipelineMethodologySection />);
    const example = Array.from(root.querySelectorAll("details")).find((node) =>
      node.querySelector("summary")?.textContent?.includes("USDC"),
    )!;
    const inputs = Array.from(example.textContent!.matchAll(/([\w-]+)=(\d+\.\d+) \(w(\d+)\)/g))
      .map(([, label, price, weight]) => ({ label, price: Number(price), weight: Number(weight) }));
    expect(inputs).toEqual([
      { label: "CoinGecko", price: 1.0001, weight: 2 },
      { label: "DL-list", price: 0.9999, weight: 1 },
      { label: "Binance", price: 1.0001, weight: 2 },
      { label: "Kraken", price: 1, weight: 2 },
      { label: "Coinbase", price: 0.9998, weight: 2 },
      { label: "Curve", price: 1.0003, weight: 3 },
    ]);
    const published = Number(example.textContent!.match(/median\s*=\s*([\d.]+)/)![1]);
    const result = Number(example.textContent!.match(/Result:\s*price\s*([\d.]+)/)![1]);
    expect(published).toBe(1.00005);
    expect(result).toBe(published);
  });

  it("explains the inclusive activity gate separately from durability history defaults", () => {
    const root = renderSection(<LiquidityPreconditions />);
    const paragraphs = Array.from(root.querySelectorAll("p"));
    const minimum = paragraphs.find((node) => node.textContent === "Minimum data")!.nextElementSibling!.textContent!;
    const threshold = Number(minimum.match(/(\d+)%/)![1]) / 100;
    expect(threshold).toBe(DEX_VOLUME_COVERAGE_MIN);
    expect(minimum).toMatch(/complete 24h window or at least \d+% retained-TVL coverage \(inclusive\)/);
    expect(minimum).toContain("otherwise the composite is not rated");
    const history = paragraphs.find((node) => node.textContent === "Durability history")!.nextElementSibling!.textContent!;
    expect(Number(history.match(/\b50\b/)![0])).toBe(50);
    expect(history).toContain("does not bypass the volume-coverage requirement");
  });

  it("includes issuer wind-down in the Stage 1 six-signal enumeration", () => {
    const root = renderSection(<DepegResolverMethodologySection />);
    const stage1 = Array.from(root.querySelectorAll("p")).find((node) => node.textContent?.includes("Stage 1"))!;
    const signals = stage1.textContent!.match(/kill signals \(([^)]+)\)/)![1].split(",").map((signal) => signal.trim());
    expect(signals).toHaveLength(6);
    expect(signals.filter((signal) => /wind.down/.test(signal))).toHaveLength(1);
  });

  it("distinguishes preliminary and final DEWS and both evidence overrides", () => {
    const root = renderSection(<PegScoreDewsTechnicalDetails />);
    const formula = Array.from(root.querySelectorAll("h3")).find((node) => node.textContent === "Score Formula")!.parentElement!;
    const text = formula.textContent!.replace(/\s+/g, " ");
    expect(text).toMatch(/preliminaryScore\s*=\s*round/);
    const cap = Number(text.match(/finalScore\s*=\s*min\(preliminaryScore,\s*(\d+)\)/)![1]);
    expect(cap).toBe(WATCH_MAX_SCORE);
    const evidenceThresholds = Array.from(text.matchAll(/sub-signal at least (\d+)/g)).map((match) => Number(match[1]));
    expect(evidenceThresholds).toEqual([EVIDENCE_STRESS_THRESHOLD, SEVERE_ISSUER_CONTROL_THRESHOLD]);
    expect(text).toContain("qualifying market-price or DEX-liquidity stress evidence");
    expect(text).toContain("Cross-Source Divergence, Pool Balance Drift, or Liquidity Erosion");
    expect(text).toContain("Blacklist Activity");
    expect(text).toContain("severe issuer-control evidence");
    expect(text).toContain("Mere source availability does not qualify");
    expect(text).toContain("With either bypass the preliminary score is final");
  });
});
