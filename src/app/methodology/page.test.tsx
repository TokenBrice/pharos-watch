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

import MethodologyPage, { metadata } from "@/app/methodology/page";
import { SAFETY_SCORE_METHODOLOGY_VERSION_LABEL } from "@shared/lib/methodology-versions/constants";
import {
  getMethodologyVersionAt,
  METHODOLOGY_CHANGELOG_REGISTRY,
  SAFETY_SCORE_METHODOLOGY_CHANGELOG,
} from "@shared/lib/methodology-versions/registry";
import { METHODOLOGY_CONTEXT } from "@/lib/methodology-context";
import { PSI_COMPONENT_LIMITS, PSI_CONDITION_BANDS, getConditionBand } from "@shared/lib/psi-policy";
import { GAUGE_BAND_RANGES, getGaugeBand } from "@shared/lib/mint-burn-gauge-bands";
import { getPressureShiftState } from "@shared/lib/mint-burn-signals";
import { CRON_SCHEDULE_CADENCES } from "@shared/lib/cron-cadences";
import { QUALITY_WEIGHT, CHAIN_ENVIRONMENT_WEIGHT, CONCENTRATION_WEIGHT, PEG_STABILITY_WEIGHT, BACKING_DIVERSITY_WEIGHT } from "@shared/lib/chains/health";
import { PYS_BENCHMARK_SPREAD_WEIGHT, PYS_RISK_PENALTY_EXPONENT, PYS_RISK_PENALTY_FLOOR, PYS_SUSTAINABILITY_FLOOR, PYS_MAX_SOURCE_RISK_PENALTY, PYS_APY_SANITY_MAX } from "@shared/lib/yield-scoring";
import { DEFINITIONS } from "@/lib/definitions";
import {
  DEPEG_RESOLVER_SECTION_CONTENT,
  LIQUIDITY_SECTION_CONTENT,
  MINT_BURN_FLOW_SECTION_CONTENT,
  PEGSCORE_DEWS_SECTION_CONTENT,
  PRICING_PIPELINE_SECTION_CONTENT,
  SAFETY_SCORES_SECTION_CONTENT,
  STABILITY_INDEX_SECTION_CONTENT,
} from "@/lib/methodology-content";
import { METHODOLOGY_HISTORY_ARCHIVES, methodologyHistoryAnchor } from "@shared/lib/methodology-versions/archives";
import { SAFETY_GRADE_SCALE_TIERS } from "@/app/methodology/sections/core/safety-scores-overview";

// The page is static (no props, constant date): render once and reuse the parsed document.
let cachedHtml: string | null = null;
let cachedRoot: HTMLElement | null = null;

function methodologyHtml() {
  cachedHtml ??= renderToStaticMarkup(<MethodologyPage />);
  return cachedHtml;
}

function methodologyDocument() {
  if (!cachedRoot) {
    cachedRoot = document.createElement("div");
    cachedRoot.innerHTML = methodologyHtml();
  }
  return cachedRoot;
}

function tableCells(root: HTMLElement, testId: string) {
  return [...root.querySelectorAll(`[data-testid="${testId}"] tbody tr`)].map((row) =>
    [...row.querySelectorAll("td")].map((cell) => cell.textContent?.replace(/\s+/g, " ").trim()),
  );
}

describe("MethodologyPage", () => {
  it("activates the eleven coordinated methodology releases at the same timed boundary", () => {
    const depegRelease = METHODOLOGY_CHANGELOG_REGISTRY
      .find(({ key }) => key === "depeg-dews")!.entries.find(({ version }) => version === "6.50")!;
    const activation = depegRelease.effectiveAt;
    expect(activation).toBeGreaterThan(Date.parse(depegRelease.date) / 1000);
    const releases = METHODOLOGY_CHANGELOG_REGISTRY.flatMap(({ key, entries }) =>
      entries.flatMap((entry, index) => entry.effectiveAt === activation ? [{ key, entry, previous: entries[index + 1] }] : []),
    );
    expect(releases).toHaveLength(11);
    for (const { key, entry, previous } of releases) {
      expect(getMethodologyVersionAt(key, activation - 1)).toBe(previous.version);
      expect(getMethodologyVersionAt(key, activation)).toBe(entry.version);
      expect(getMethodologyVersionAt(key, activation + 1)).toBe(entry.version);
    }
  });

  it("explains current admission in the rendered and Markdown methodology sections", () => {
    for (const [content, claims] of [
      [PEGSCORE_DEWS_SECTION_CONTENT, ["Friday at 5 p.m. and reopens Sunday at 5 p.m.", "Sunday 6 p.m. reopen",
        "three other independently sourced same-peg tokens", "traded native pair or independent 24/7 pool",
        "keeps the deepest discount or largest premium", "PegScore and dedicated incident page eligibility use the grouped peak"]],
      [STABILITY_INDEX_SECTION_CONTENT, ["scores confirmed peer-relative events on their own lower-confidence basis",
        "carry the last admitted contribution for that event", "FX evidence switch ships off", "Methodology v3.69", "Methodology v3.68"]],
      [MINT_BURN_FLOW_SECTION_CONTENT, ["Counted Tron Issue and Redeem events", "USDT holder pressure stays unavailable",
        "The Bank Run Gauge weights only eligible coins"]],
    ] as const) {
      const text = methodologyDocument().querySelector(`#${content.id}`)!.textContent;
      for (const copy of [text, content.markdown]) {
        for (const claim of claims) expect(copy).toContain(claim);
        expect(copy).not.toMatch(/Friday 21:00 to Sunday 23:00 UTC|unless it moves 25%|pressure baseline and tracked-chain gauge weight/);
      }
    }
  });

  it("qualifies DDR verdict summaries by depeg direction in the page and Markdown export", () => {
    const summary = "In either direction, a terminal status or a severe issuer wind-down signal is Terminal evidence. An above-direction event whose live signed deviation is itself a below-peg break deeper than 1,000 bps is evaluated by the below-peg mapping, so a stale stored direction cannot publish No break signals for a live deep break. Otherwise, above peg, an exit-collapse signal reads as Stress signals and everything else as No break signals, even a severe kill signal. Below peg, any severe kill signal, or two or more kill signals without a strong non-inflatable-supply or hard-collateral/redemption anchor on a break deeper than 1,000 bps (the worse of the stored peak and live deviation), is Terminal evidence. Any other below-peg kill signal, or a deep break with none, reads as Stress signals.";
    const section = methodologyDocument().querySelector("#depeg-resolver-methodology");
    expect(section?.textContent?.replace(/\s+/g, " ")).toContain(summary);
    expect(DEPEG_RESOLVER_SECTION_CONTENT.markdown).toContain(summary);
    for (const text of [section?.textContent ?? "", DEPEG_RESOLVER_SECTION_CONTENT.markdown]) {
      expect(text).not.toMatch(/Terminal evidence means a terminal status|No break signals means no kill signal/);
    }
  });

  it.each([
    ["methodology", () => methodologyDocument().querySelector(`#${SAFETY_SCORES_SECTION_CONTENT.id}`)?.textContent],
    ["changelog", () => SAFETY_SCORE_METHODOLOGY_CHANGELOG.find(entry => entry.version === "10.47")?.summary],
  ] as const)("qualifies the own-liability denominator in the %s", (_source, copy) => {
    expect(copy()).toContain("scoped issuer report");
  });

  it("leads with the 6-tier grade scale bar and desktop Reader guide toggle before reading meta", () => {
    const html = methodologyHtml();
    const glanceAt = html.indexOf('id="methodology-at-a-glance"');
    expect(glanceAt).toBeGreaterThan(-1);
    for (const meta of ["Page rhythm:", "How to read this page", "Editorial preface"]) {
      expect(html.indexOf(meta), meta).toBeGreaterThan(glanceAt);
    }
    const root = methodologyDocument();
    const desktopGuide = root.querySelector('[data-testid="methodology-reader-guide-desktop"]')!;
    expect(desktopGuide).not.toBeNull();
    expect(desktopGuide.querySelector('[aria-label="Methodology view mode"]')).not.toBeNull();
    const glance = root.querySelector('[aria-labelledby="methodology-at-a-glance"]')!;
    const scaleBar = glance.querySelector('[data-testid="safety-grade-scale-bar"]')!;
    expect(scaleBar).not.toBeNull();
    for (const { tier, range, meaning } of SAFETY_GRADE_SCALE_TIERS) {
      expect(scaleBar.textContent).toContain(tier);
      expect(scaleBar.textContent).toContain(range);
      expect(scaleBar.textContent).toContain(meaning);
    }
    expect(glance.querySelector('a[href="#safety-scores-methodology"]')).not.toBeNull();
  });

  it("names the Safety Score version, weights and changelog dates in metadata and the header", () => {
    const latest = SAFETY_SCORE_METHODOLOGY_CHANGELOG[0];
    expect(metadata.title).toBe(`Stablecoin Safety Score Methodology (${SAFETY_SCORE_METHODOLOGY_VERSION_LABEL})`);
    expect(metadata.description).toBe(
      `How Pharos grades stablecoins A+ to F: Backing 40%, Exit 35%, Economic Control 25%, with peg, liquidity and dependency inputs. Safety Score ${SAFETY_SCORE_METHODOLOGY_VERSION_LABEL}.`,
    );
    const root = methodologyDocument();
    const article = [...root.querySelectorAll('script[type="application/ld+json"]')]
      .map((script) => JSON.parse(script.textContent!))
      .find((entry) => entry.headline === metadata.title);
    expect(article).toMatchObject({
      datePublished: `${SAFETY_SCORE_METHODOLOGY_CHANGELOG.at(-1)!.date}T00:00:00Z`,
      dateModified: `${latest.date}T00:00:00Z`,
    });
    const versionLine = root.querySelector(`time[datetime="${latest.date}"]`)?.parentElement?.textContent;
    expect(versionLine?.startsWith(`Safety Score methodology ${SAFETY_SCORE_METHODOLOGY_VERSION_LABEL} · updated `)).toBe(true);
  });

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
    expect(text).toContain("Date-only oracle-profile (oracleRisk) reviews admit from 00:00Z on their review date");
    expect(text).toContain("date-only incident reviews admit only after their UTC day ends");
    expect(text).toContain("Mechanism overlays, chain-maturity reviews, reserve-bound facts, typed classification evidence and MPC attestations admit after the reviewed UTC day");
  });


  it("renders every section anchor that methodology context deep-links to", () => {
    const html = methodologyHtml();
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
      "within two hours", "L = 100 − t × (100 − q)", "including HBD",
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

  it("describes aggregate DEX suppression at candidate creation, matching the owning table", () => {
    const text = methodologyDocument().querySelector("#pricing-pipeline-methodology")!.textContent!.replace(/\s+/g, " ");
    expect(text).toContain("withheld once an overlapping protocol DEX candidate passes registry, freshness, price and TVL checks, even if corroboration later fails");
    expect(text).not.toContain("withheld only when an overlapping protocol-level DEX bridge lane is admitted");
  });

  it("explains Bank Run Gauge unavailability by missing or zero weights, not only all-NR", () => {
    const text = methodologyDocument().querySelector("#mint-burn-flow-methodology")!.textContent!.replace(/\s+/g, " ");
    expect(text).toContain("The gauge is unavailable when no coin with a pressure-shift value has a positive market-cap weight");
    expect(text).toContain("their weights are unavailable or zero");
    expect(text).not.toContain("Returns null only when all tracked coins are NR");
  });

  it("limits PSI replay threshold dropout to the start day", () => {
    const text = methodologyDocument().querySelector("#stability-index-methodology")!.textContent!.replace(/\s+/g, " ");
    expect(text).toContain("a start day whose restored daily price is back inside the configured threshold drops out of the replay");
    expect(text).toContain("Later days of an active event keep their daily-price deviation");
    expect(text).not.toContain("Replay days whose restored daily price is back inside the configured threshold drop out entirely");
  });

  it("shows the corrected Volume Activity saturation example", () => {
    const text = methodologyDocument().querySelector("#liquidity-methodology")!.textContent!.replace(/\s+/g, " ");
    expect(text).toContain("~43%+->100");
    expect(text).not.toContain("~32%+->100");
  });

  it.each(["HTML", "Markdown"])("describes the frozen registry clock without a payload version in %s", (format) => {
    const copy = format === "HTML"
      ? methodologyDocument().querySelector("#liquidity-methodology")!.textContent
      : LIQUIDITY_SECTION_CONTENT.markdown;
    expect(copy).toContain("frozen basis");
    expect(copy).not.toMatch(/stage payload v\d+/i);
  });

  it("states the PegScore tracking gate without a retired early-score label", () => {
    const root = methodologyDocument();
    const faq = [...root.querySelectorAll('script[type="application/ld+json"]')]
      .map((script) => JSON.parse(script.textContent!))
      .flatMap((value) => (Array.isArray(value) ? value : [value]))
      .find((value) => value["@type"] === "FAQPage");
    const entry = faq?.mainEntity.find((item: { name: string }) => item.name === "How is the Pharos peg score calculated?");
    expect(entry?.acceptedAnswer.text).not.toMatch(/early/i);
    expect(entry?.acceptedAnswer.text).not.toContain("historyCoverage");
    expect(DEFINITIONS.pegScore.detail).not.toMatch(/early/i);
    expect(DEFINITIONS.pegScore.long).not.toMatch(/early/i);
    const technical = root.querySelector("#pegscore-dews-methodology")!.textContent!.replace(/\s+/g, " ");
    expect(technical).not.toMatch(/Early score/);
    expect(technical).not.toContain("historyCoverage");
  });

  it("states the leg-quarantine rule instead of keeping a stalled mint/burn leg in scope", () => {
    const text = methodologyDocument().querySelector("#mint-burn-flow-methodology")!.textContent!.replace(/\s+/g, " ");
    expect(text).toContain("quarantined from the common watermark");
    expect(text).toContain("reactivation-pending");
    expect(text).not.toContain("that later stalls stays in scope");
    expect(MINT_BURN_FLOW_SECTION_CONTENT.markdown).toContain("quarantines an admitted leg");
  });

  it("lists only blacklist contracts with an active scan", () => {
    const text = methodologyDocument().querySelector("#blacklist-tracker-methodology")!.textContent!.replace(/\s+/g, " ");
    expect(text).not.toMatch(/\bAEUR\b/);
  });

  it("keeps a confirm-required opposite reading from retiring the live depeg", () => {
    const text = methodologyDocument().querySelector("#pegscore-dews-methodology")!.textContent!.replace(/\s+/g, " ");
    expect(text).not.toMatch(/retires the stale live row/);
    expect(text).toContain("keeps the existing old-direction lifecycle open");
    expect(text).toContain("superseded-direction");
  });

  it("separates per-coin unrated fallback PYS from an unavailable safety snapshot and opportunity-evidence-missing NR", () => {
    const text = methodologyDocument().querySelector("#yield-intelligence-methodology")!.textContent!.replace(/\s+/g, " ");
    expect(text).toContain("Rows whose per-coin report card is unrated keep the 40/NR fallback and publish null PYS with `safety-unrated`");
    expect(text).toContain("an unavailable common safety snapshot publishes PYS NR with the same reason");
    expect(text).toContain("rows carrying `opportunity-evidence-missing` publish PYS NR");
    expect(text).not.toContain("`safety-unrated` or `opportunity-evidence-missing` remain estimated");
  });

  it("uses reader-facing Safety Score wording instead of internal V9/V10 engine prefixes in current prose", () => {
    const root = methodologyDocument();
    const internalPrefix = /\b(?:Safety Score V10|Safety v10\.18|In V10 Exit|Any V10 Exit|canonical V10|accepted V10|invalid V10|V9 exit capacity|V9 grade context|Safety Score v10\.(?:3[1-9]|4\d))\b/;
    for (const sectionId of [
      "safety-scores-methodology",
      "mint-authority-score",
      "liquidity-methodology",
      "redemption-backstop-methodology",
      "mint-burn-flow-methodology",
      "blacklist-tracker-methodology",
      "depeg-resolver-methodology",
      "chain-health-score",
    ]) {
      const text = root.querySelector(`#${sectionId}`)!.textContent!;
      expect(text, `#${sectionId} retained internal engine prefix`).not.toMatch(internalPrefix);
    }
    expect(SAFETY_SCORES_SECTION_CONTENT.markdown).not.toMatch(internalPrefix);
    // Historical V8.17 archive disclosure remains intact.
    expect(root.querySelector("#safety-scores-methodology")!.textContent).toContain("Historical V8.17 methodology");
  });

});
