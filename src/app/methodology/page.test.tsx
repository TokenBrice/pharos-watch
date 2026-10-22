// @vitest-environment jsdom
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
import { PSI_COMPONENT_LIMITS, PSI_CONDITION_BANDS, getConditionBand } from "@shared/lib/psi-policy";
import { GAUGE_BAND_RANGES, getGaugeBand } from "@shared/lib/mint-burn-gauge-bands";
import { getPressureShiftState } from "@shared/lib/mint-burn-signals";
import { CRON_SCHEDULE_CADENCES } from "@shared/lib/cron-cadences";
import { QUALITY_WEIGHT, CHAIN_ENVIRONMENT_WEIGHT, CONCENTRATION_WEIGHT, PEG_STABILITY_WEIGHT, BACKING_DIVERSITY_WEIGHT } from "@shared/lib/chains/health";
import { PYS_BENCHMARK_SPREAD_WEIGHT, PYS_RISK_PENALTY_EXPONENT, PYS_RISK_PENALTY_FLOOR, PYS_SUSTAINABILITY_FLOOR, PYS_MAX_SOURCE_RISK_PENALTY, PYS_APY_SANITY_MAX } from "@shared/lib/yield-scoring";
import { DEFINITIONS } from "@/lib/definitions";
import { PRICING_PIPELINE_SECTION_CONTENT, SAFETY_SCORES_SECTION_CONTENT } from "@/lib/methodology-content";
import { METHODOLOGY_HISTORY_ARCHIVES, methodologyHistoryAnchor } from "@shared/lib/methodology-versions/archives";

function methodologyDocument() {
  const root = document.createElement("div");
  root.innerHTML = renderToStaticMarkup(<MethodologyPage />);
  return root;
}

function tableCells(root: HTMLElement, testId: string) {
  return [...root.querySelectorAll(`[data-testid="${testId}"] tbody tr`)].map((row) =>
    [...row.querySelectorAll("td")].map((cell) => cell.textContent?.replace(/\s+/g, " ").trim()),
  );
}

describe("MethodologyPage", () => {
  it("discloses provisional uncertainty, single-key repricing and the final R4 calibration rules", () => {
    const section = methodologyDocument().querySelector("#safety-scores-methodology")!;
    const text = section.textContent!;
    expect(text).toContain("Verified worse facts score lower than unresolved ones");
    expect(text).toContain("Unknown is priced as uncertainty, not as safety");
    expect(text).toContain("more than 50% of its original scoring weight");
    expect(text).toContain("The label changes no score, grade or availability");
    expect(text).toContain("clamped to $1m–$25m");
    expect(text).toContain("overall Control pillar at 90");
    expect(text).toContain("24-to-under-36-month tier at 86 is removed");
    expect(text).toContain("Published letter grades use two-consecutive-publication hysteresis");
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

  it("derives PSI caps, cadence and fractional condition boundaries from the scoring policy", () => {
    const root = methodologyDocument();
    const rows = tableCells(root, "methodology-stability-index-condition-bands-table");
    expect(rows.map((row) => row.slice(0, 2))).toEqual(PSI_CONDITION_BANDS.map(({ min, band }, index) =>
      [`[${min}, ${index === 0 ? "100]" : `${PSI_CONDITION_BANDS[index - 1].min})`}`, band],
    ));
    expect(getConditionBand(89.9)).toBe("STEADY");
    expect(rows.find((row) => row[1] === "STEADY")?.[0]).toBe("[75, 90)");
    expect(rows[0][0]).toBe("[90, 100]");
    expect(tableCells(root, "methodology-stability-index-components-table").map((row) => row[1])).toEqual([
      `0–${PSI_COMPONENT_LIMITS.severity}`, `0–${PSI_COMPONENT_LIMITS.breadth}`,
      `0–${PSI_COMPONENT_LIMITS.stressBreadth}`, `−${PSI_COMPONENT_LIMITS.trend} to +${PSI_COMPONENT_LIMITS.trend}`,
    ]);
    expect(root.textContent).toContain(`${CRON_SCHEDULE_CADENCES.dewsPsiOffset.intervalSec / 60}m refresh`);
  });

  it("prints non-overlapping gauge bands and includes exact +10 in improving pressure", () => {
    const root = methodologyDocument();
    expect(tableCells(root, "methodology-mint-burn-bank-run-gauge-table").map((row) => row.slice(0, 2))).toEqual(
      GAUGE_BAND_RANGES.map(({ band, min, max }, index) =>
        [band, `[${min}, ${max}${index === GAUGE_BAND_RANGES.length - 1 ? "]" : ")"}`]),
    );
    expect(getGaugeBand(10)).toBe("HEALTHY");
    expect(root.textContent).toContain("≥ +10 = improving vs baseline");
    expect(DEFINITIONS.bankRunGauge.long).toContain("scores ≥ +10 indicate improving issuance pressure");
    expect(root.textContent).not.toContain("scores above +10");
    expect(getPressureShiftState(10)).toBe("stable");
    expect(root.textContent).toContain("Per-coin pressure-state labels are separate: exactly +10 is stable.");
    expect(tableCells(root, "methodology-mint-burn-bank-run-gauge-table").at(-1)?.[1]).toBe("[70, 100]");
  });

  it("derives active PYS constants and publication cadence without rewriting worked examples", () => {
    const text = methodologyDocument().textContent;
    for (const label of [
      `benchmarkSpread × ${PYS_BENCHMARK_SPREAD_WEIGHT}`, `max=${PYS_MAX_SOURCE_RISK_PENALTY}`,
      `riskPenalty = max(${PYS_RISK_PENALTY_FLOOR}`, `riskPenalty ^ ${PYS_RISK_PENALTY_EXPONENT}`,
      `sustainability = max(${PYS_SUSTAINABILITY_FLOOR}`, `APY above the ${PYS_APY_SANITY_MAX}%`,
      `${CRON_SCHEDULE_CADENCES.hourlyYieldSync.intervalSec / 3600}h publish / ${CRON_SCHEDULE_CADENCES.fourHourlyYieldSupplemental.intervalSec / 3600}h supplemental`,
    ]) expect(text).toContain(label);
    expect(text).toContain("PYS=clamp(round(4.10*0.82*8),0,100)=27");
  });

  it.each([
    ["chain-health-factor-weights", "Chain Health factor weights", ["Factor", "Weight", "What it measures"], ["Quality", "Chain Environment", "Concentration", "Peg Stability", "Backing Diversity"]],
    ["chain-health-l2beat-risk-fields", "L2BEAT chain environment inputs", ["Component", "Mapping"], ["Stage", "Risk fields", "Risk sentiment"]],
    ["chain-health-resilience-tiers", "Chain resilience tiers", ["Tier", "Score", "Criteria", "Examples"], ["Tier 1", "Tier 2", "Tier 3"]],
    ["chain-health-bands", "Chain Health bands", ["Band", "Score Range", "Interpretation"], ["Robust", "Healthy", "Mixed", "Fragile", "Concentrated"]],
  ])("preserves %s headers, labels, row count and accessible name", (id, label, headers, labels) => {
    const root = methodologyDocument();
    const table = root.querySelector(`[data-testid="${id}-table"] table`)!;
    expect(table.getAttribute("aria-label")).toBe(label);
    expect([...table.querySelectorAll("thead th")].map((cell) => cell.textContent)).toEqual(headers);
    expect(tableCells(root, `${id}-table`).map((row) => row[0])).toEqual(labels);
    expect(table.querySelectorAll("tbody tr")).toHaveLength(labels.length);
    expect([...table.querySelectorAll("thead th")].every((cell) => cell.getAttribute("scope") === "col")).toBe(true);
  });

  it("keeps chain weights, fallback scores, mappings and band ranges intact", () => {
    const root = methodologyDocument();
    expect(tableCells(root, "chain-health-factor-weights-table").map((row) => row[1])).toEqual(
      [QUALITY_WEIGHT, CHAIN_ENVIRONMENT_WEIGHT, CONCENTRATION_WEIGHT, PEG_STABILITY_WEIGHT, BACKING_DIVERSITY_WEIGHT].map((weight) => `${weight * 100}%`),
    );
    expect(tableCells(root, "chain-health-resilience-tiers-table").map((row) => row.slice(1))).toEqual([
      ["100", "Highly decentralized, battle-tested, censorship-resistant L1", "Ethereum"],
      ["60", "Established chains with moderate centralization (default for unlisted chains)", "Solana, BSC, Tron, Avalanche"],
      ["20", "Unproven, known centralization issues, or compromised security", "PulseChain, Harmony, BitTorrent"],
    ]);
    expect(tableCells(root, "chain-health-bands-table").map((row) => row[1])).toEqual(["80–100", "60–79", "40–59", "20–39", "0–19"]);
    expect(tableCells(root, "chain-health-l2beat-risk-fields-table").map((row) => row[1])).toEqual([
      "Stage 2 = 100, Stage 1 = 80, Stage 0 = 55, not applicable or under review = 50",
      "Sequencer Failure, State Validation, Data Availability, Exit Window, Proposer Failure",
      "Good = 100, warning = 60, bad = 20, neutral or under review = 50",
    ]);
  });

  it.each([SAFETY_SCORES_SECTION_CONTENT, PRICING_PIPELINE_SECTION_CONTENT])(
    "keeps $id current rules identical in HTML and Markdown with canonical history links",
    (content) => {
      const section = methodologyDocument().querySelector(`#${content.id}`)!;
      const paragraphs = [...section.querySelectorAll("p")].map((node) => node.textContent);
      for (const paragraph of content.markdownParagraphs) {
        expect(paragraphs).toContain(paragraph);
        expect(content.markdown).toContain(paragraph);
      }
      for (const { label, href } of content.historyLinks) {
        const link = [...section.querySelectorAll("a")].find((node) => node.textContent === label)!;
        expect(link, label).toBeDefined();
        expect(link.getAttribute("href")?.replace(/\/(?=#|$)/, "")).toBe(href.replace(/\/(?=#|$)/, ""));
        expect(content.markdown).toContain(`[${label}](https://pharos.watch${href})`);
        if (!href.includes("#")) continue;
        const [path, anchor] = href.split("#");
        const archive = METHODOLOGY_HISTORY_ARCHIVES.find((item) => item.path === path)!;
        expect(archive, href).toBeDefined();
        expect(archive.entries.some((entry) => methodologyHistoryAnchor(archive.changelog, entry.version) === anchor)).toBe(true);
      }
    },
  );

  it("retains current Safety admission rules rather than replacing them with replay results", () => {
    const text = methodologyDocument().querySelector("#safety-scores-methodology")!.textContent;
    for (const rule of [
      "120-second skew and 30-minute age limits", "Exactly 1%", "inclusive eight-hour book budget",
      "within one hour", "L = 100 − t × (100 − q)", "including HBD",
      "next UTC midnight", "Two usable pillars permit a rating", "Physical GOLD/SILVER delivery",
      "code-unit order", "capacity materiality gates", "86,400-second allowance",
    ]) expect(text).toContain(rule);
    expect(text).toContain("1% of the actual stress request");
    expect(text).toContain("caps a material route at 50 before confidence");
    expect(text).toContain("Backing 35, Exit 50 and Control 50");
    expect(text).toContain("C/U cause label is presentation-only");
    expect(text).toContain("USDT longevity premium returns to +12");
    expect(text).toContain("35 / 50 / 50");
    expect(text).toContain("50 / 50 / 60");
    expect(text).toContain("Presentation-only C/U labels");
    expect(text).not.toContain("The ledger records 833");
    expect(text).not.toContain("open data points fell 1,280");
  });

  it("explains evidence availability and the simplified cap families without retired NR guards", () => {
    const text = methodologyDocument().querySelector("#safety-scores-methodology")!.textContent;
    for (const rule of [
      "Fewer than two usable pillars are a technical Pipeline gap", "LEVER-1", "D/F evidence guards are retired",
      "never an open question or low score", "five whole-score limit families",
      "speculative-credit residual limit (59)", "at least 25% limits the score to 39",
      "at least 1% but below 25% limits it to 49",
      "not dropped or renormalized", "original weights", "pricing a missing pillar does not make it usable evidence",
    ]) expect(text).toContain(rule);
    expect(text).not.toContain("two or three are excluded");
  });

  it("preserves pricing table identities and wrapper versus issuer-conversion distinctions", () => {
    const section = methodologyDocument().querySelector("#pricing-pipeline-methodology")!;
    for (const id of ["methodology-pricing-source-weights", "methodology-pricing-confidence-levels"]) {
      expect(section.querySelector(`[data-table-id="${id}"]`)).not.toBeNull();
    }
    for (const rule of ["ONED / PYUSDx", "do not establish direct-wrapper", "1.05", "1.45", "1.02", "1.50"]) {
      expect(section.textContent).toContain(rule);
    }
  });

});
