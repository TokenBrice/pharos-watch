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
import { LiquidityTechnicalDetails } from "./sections/core/liquidity-technical-details";
import { SafetyScoresScoringDetails } from "./sections/core/safety-scores-scoring-details";
import { SafetyScoresDimensionDetails } from "./sections/core/safety-scores-dimension-details";
import { DEX_VOLUME_COVERAGE_MIN } from "@shared/lib/dex-volume-availability";
import {
  EVIDENCE_STRESS_THRESHOLD,
  SEVERE_ISSUER_CONTROL_THRESHOLD,
  WATCH_MAX_SCORE,
} from "@shared/lib/dews-config";
import { PSI_BAND_CLASSES } from "@shared/lib/classification";
import { PSI_CONDITION_BAND_VALUES } from "@shared/types/stability";
import { StabilityIndexMethodologySection } from "./sections/core/stability-index-section";

function renderSection(element: ReactNode): HTMLDivElement {
  const root = document.createElement("div");
  root.innerHTML = renderToStaticMarkup(element);
  return root;
}

describe("MethodologyPage", () => {
  it("uses canonical PSI band styles in the methodology table", () => {
    const root = renderSection(<StabilityIndexMethodologySection />);
    const table = root.querySelector('[data-table-id="methodology-stability-index-condition-bands"] table')!;
    expect(table).not.toBeNull();
    const cells = Array.from(table.querySelectorAll("tbody tr"), (row) => (row as HTMLTableRowElement).cells[1]);
    expect(cells.map((cell) => cell.textContent)).toEqual([...PSI_CONDITION_BAND_VALUES]);
    for (const [index, band] of PSI_CONDITION_BAND_VALUES.entries()) {
      for (const className of PSI_BAND_CLASSES[band].split(" ")) {
        expect(cells[index].classList.contains(className), `${band}: ${className}`).toBe(true);
      }
    }
  });

  it.each([
    { element: <PricingPipelineMethodologySection />, id: "methodology-pricing-source-weights",
      headers: ["Source", "Weight", "Type", "Notes"],
      labels: ["CoinGecko", "CoinGecko ticker", "DefiLlama (list)", "Binance", "Kraken", "Bitstamp", "Coinbase", "RedStone", "Curve on-chain", "Curve oracle", "DEX pools", "Protocol DEX APIs", "GeckoTerminal", "Exact-address providers"] },
    { element: <PricingPipelineMethodologySection />, id: "methodology-pricing-confidence-levels",
      headers: ["Level", "Condition", "Downstream effect"], labels: ["high", "single-source", "low", "fallback"] },
    { element: <LiquidityTechnicalDetails />, id: "methodology-liquidity-components",
      headers: ["Component", "Weight", "How it works"], labels: ["TVL Depth", "Volume Activity", "Pool Quality", "Durability", "Diversity"] },
    { element: <SafetyScoresScoringDetails />, id: "methodology-safety-base-dimensions",
      headers: ["Dimension", "Weight", "Source", "Description"], labels: ["Exit Liquidity", "Resilience", "Decentralization", "Dependency Risk"] },
    { element: <SafetyScoresDimensionDetails />, id: "methodology-safety-resilience-scoring",
      headers: ["Sub-factor", "What it measures", "Scoring"], labels: ["Collateral Quality", "Custody Model"] },
    { element: <SafetyScoresDimensionDetails />, id: "methodology-safety-grade-thresholds",
      headers: ["Grade", "Score Range"], labels: ["A+", "A", "A−", "B+", "B", "B−", "C+", "C", "C−", "D", "F", "NR"] },
  ])("preserves $id content, ids, and compact table semantics", ({ element, id, headers, labels }) => {
    const root = renderSection(element);
    const shell = root.querySelector(`[data-table-id="${id}"]`)!;
    expect(shell.getAttribute("data-testid")).toBe(`${id}-table`);
    expect(shell.classList.contains("pharos-density-compact")).toBe(true);
    const table = shell.querySelector("table")!;
    expect(Array.from(table.querySelectorAll("thead th"), (cell) => cell.textContent)).toEqual(headers);
    expect(Array.from(table.querySelectorAll("thead th")).every((cell) => cell.getAttribute("scope") === "col")).toBe(true);
    const rows = Array.from(table.querySelectorAll<HTMLTableRowElement>("tbody tr"));
    expect(rows.map((row) => row.cells[0].textContent)).toEqual(labels);
    expect(rows.every((row) => row.cells.length === headers.length)).toBe(true);
    if (id === "methodology-safety-grade-thresholds") {
      expect(table.classList.contains("w-auto")).toBe(true);
      expect(rows.map((row) => row.cells[1].textContent)).toEqual([
        "87–100", "83–86", "80–82", "75–79", "70–74", "65–69", "60–64", "55–59", "50–54", "40–49", "0–39", "Not enough data",
      ]);
      expect(rows.every((row) => row.cells[0].classList.contains("pr-8") && Array.from(row.cells).every((cell) => cell.classList.contains("py-1.5")))).toBe(true);
    } else {
      expect(rows.every((row) => row.cells[row.cells.length - 1].classList.contains("whitespace-normal"))).toBe(true);
    }
    if (id === "methodology-pricing-source-weights") {
      expect(Array.from(table.querySelectorAll("code"), (node) => node.textContent)).toEqual(["/simple/price", "stablecoins.llama.fi", "get_dy()", "crvusd-curve"]);
      expect(rows.map((row) => row.cells[1].textContent)).toEqual(["2", "2", "1", "2", "2", "1", "2", "1", "3", "3", "1", "2-3", "1", "1"]);
    }
    if (id === "methodology-pricing-confidence-levels") {
      expect(rows.map((row) => row.cells[0].className)).toEqual([
        expect.stringContaining("text-green-700"), expect.stringContaining("text-yellow-700"),
        expect.stringContaining("text-orange-700"), expect.stringContaining("text-red-700"),
      ]);
    }
  });


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
