import { describe, expect, it } from "vitest";
import { V9EvidenceResponsibilitySchema } from "@shared/types/safety-score-v9-fact-primitives";
import { SafetyScoreV9CurrentCardSchema } from "@shared/types/safety-score-v9-public";
import { makeV9Card, makeV9Pillars } from "@/test/fixtures/safety-score-v9";
import { SAFETY_SCORE_V9_RESPONSIBILITY_LABELS } from "@/lib/safety-score-v9-labels";
import {
  buildStablecoinSafetyScoreV9Presentation,
  describeSafetyScoreV9Components,
  humanizeSafetyScoreV9Value,
} from "@/lib/stablecoin-safety-score-v9-presentation";

// These suites author breakdowns whose published scores must match the
// card pillars, so they declare the pillars instead of tracking the shared
// fixture's default quality score.
const BREAKDOWN_PILLARS = makeV9Pillars({ backing: 88, exit: 84, control: 86 });

describe("stablecoin V9 safety presentation", () => {
  it("has public copy for every evidence-responsibility value", () => {
    expect(Object.keys(SAFETY_SCORE_V9_RESPONSIBILITY_LABELS).sort())
      .toEqual([...V9EvidenceResponsibilitySchema.options].sort());
  });

  /**
   * Full three-pillar breakdown; tests override the pillar they exercise.
   * Published scores must equal the card's pillar scores (88 / 84 / 86) and
   * backing weights must sum to 1 with contributions summing to the evaluated
   * score, or SafetyScoreV9CurrentCardSchema rejects the fixture.
   */
  const breakdownsFixture = () => ({
    backing: {
      evaluatedScore: 86,
      publishedScore: 88,
      aggregationWeight: 0.4,
      groups: [{ key: "reserves" as const, label: "Reserves", score: 86, effectiveWeight: 1 }],
      components: [{
        key: "reserve:reserve:wsteth",
        label: "wstETH",
        source: "reserve-exposure" as const,
        score: 86,
        effectiveWeight: 1,
        weightedContribution: 86,
        observationState: "known" as const,
      }],
      adjustments: [{
        kind: "operational-resilience-credit" as const,
        scoreBefore: 86,
        scoreAfter: 88,
        delta: 2,
      }],
    },
    exit: {
      evaluatedScore: 84,
      publishedScore: 84,
      aggregationWeight: 0.35,
      stressRequest: null,
      primaryRoute: null,
      diversification: null,
      alternatives: [],
      adjustments: [],
    },
    control: {
      evaluatedScore: 86,
      publishedScore: 86,
      aggregationWeight: 0.25,
      method: "minimum-binding-component" as const,
      components: [
        { key: "mint", label: "Mint authority", kind: "mint" as const, score: 86, binding: true, posture: "concentrated" as const },
      ],
      adjustments: [],
    },
  });

  it("derives honest score trace labels without recreating V8 dimensions", () => {
    const card = makeV9Card({
      score: 84,
      grade: "A",
      bindingCap: {
        kind: "track-record",
        limit: 84,
        source: "structural",
        reason: "Less than two years of implementation history.",
        binding: true,
      },
    });
    card.scoreTrace.stages.preCapScore = 86.9;
    card.scoreTrace.stages.deploymentAdjustmentPoints = 0.3;
    card.scoreTrace.stages.pegMultiplier = 0.99;

    const presentation = buildStablecoinSafetyScoreV9Presentation(card);

    expect(presentation.traceParts).toEqual([
      "Pre-cap 86.9",
      "Track-record cap 84",
      "Peg x0.990",
      "Deployment -0.3",
    ]);
    expect(presentation.pillars.map((pillar) => pillar.label)).toEqual([
      "Backing",
      "Exit",
      "Economic Control",
    ]);
  });

  it("humanizes public enum values and omits unknown access fields", () => {
    const card = makeV9Card({
      accessPosture: {
        transfer: "permissionless",
        freezeExposure: "none-known",
        primaryExit: "unknown",
        governance: "single-entity",
        unknownFields: ["primaryExit"],
        signals: [],
        reasons: [],
      },
    });

    const presentation = buildStablecoinSafetyScoreV9Presentation(card);

    expect(presentation.accessRows).toEqual([
      { key: "transfer", label: "Transfer", value: "Permissionless" },
      { key: "freezeExposure", label: "Freeze exposure", value: "None known" },
      { key: "governance", label: "Governance", value: "Single entity" },
    ]);
    expect(humanizeSafetyScoreV9Value("issuer-discretionary")).toBe("Issuer discretionary");
  });

  it("renders an undisclosed primary exit as an explicit row rather than dropping it", () => {
    const card = makeV9Card({
      accessPosture: {
        transfer: "permissionless",
        freezeExposure: "none-known",
        primaryExit: "undisclosed",
        governance: "single-entity",
        unknownFields: [],
        signals: [],
        reasons: [],
      },
    });

    const presentation = buildStablecoinSafetyScoreV9Presentation(card);

    expect(presentation.accessRows).toContainEqual({
      key: "primaryExit",
      label: "Primary exit",
      value: "Not disclosed",
    });
  });

  it("turns opaque public component keys into categorized input details", () => {
    expect(describeSafetyScoreV9Components([
      "mechanism:liquidation-mechanics",
      "reserve:concentration",
      "reserve:reserve:abc",
      "reserve:reserve:def",
      "dex:generation:dex:asset:dl:ethereum%3Afp%3Aethereum%3Acurve%3Apool",
      "redemption:generation:redemption:asset:collateral-redeem",
      "bridge:arbitrum:0x123:bridge-meta:asset:key",
      "mint",
      "oracle",
    ])).toEqual([
      { key: "mechanism:liquidation-mechanics", label: "Liquidation mechanics", category: "Mechanism" },
      { key: "reserve:concentration", label: "Reserve concentration", category: "Reserve" },
      { key: "reserve:reserve:abc", label: "Reserve slice 1", category: "Reserve" },
      { key: "reserve:reserve:def", label: "Reserve slice 2", category: "Reserve" },
      {
        key: "dex:generation:dex:asset:dl:ethereum%3Afp%3Aethereum%3Acurve%3Apool",
        label: "Curve liquidity route",
        category: "DEX",
      },
      {
        key: "redemption:generation:redemption:asset:collateral-redeem",
        label: "Collateral redemption",
        category: "Redemption",
      },
      { key: "bridge:arbitrum:0x123:bridge-meta:asset:key", label: "Arbitrum bridge", category: "Bridge" },
      { key: "mint", label: "Mint authority", category: "Authority" },
      { key: "oracle", label: "Oracle design", category: "Oracle" },
    ]);
  });

  it("splits causal attribution and names whose gap each unresolved fact is", () => {
    const card = makeV9Card();
    card.scoreTrace.adverseAttribution.items = [
      {
        source: "peg-performance",
        path: "peg:historical-performance",
        message: "Measured peg multiplier is 0.804213.",
        responsibility: "measured-adverse",
      },
    ];
    card.scoreTrace.boundedUncertaintyAttribution.items = [
      {
        source: "reason",
        code: "missing-same-notional-route",
        path: "exit:missing-same-notional-route",
        message: "Comparable exit route is missing",
        responsibility: "integration-missing",
      },
      {
        source: "reason",
        code: "missing-reserve-composition",
        path: "backing:reserve-envelope",
        message: "No reserve composition is present in the exact fixed input.",
        responsibility: "issuer-undisclosed",
      },
      {
        source: "reason",
        code: "missing-latest-assurance-report",
        path: "backing:assurance-report",
        message: "The published assurance report is outside our freshness window.",
        responsibility: "published-evidence-expired",
      },
    ];

    const presentation = buildStablecoinSafetyScoreV9Presentation(card);

    // Six-decimal producer precision reads as noise in a sentence.
    expect(presentation.adverseMessages).toEqual(["Measured peg multiplier is 0.804."]);
    // The issuer's gaps lead; ours are still named as ours rather than hidden.
    expect(presentation.boundedGroups).toEqual([
      {
        key: "issuer-undisclosed",
        label: "The issuer has not disclosed this",
        messages: ["No reserve composition is present in the exact fixed input."],
      },
      {
        key: "published-evidence-expired",
        label: "This was published, but our copy is out of date",
        messages: ["The published assurance report is outside our freshness window."],
      },
      {
        key: "integration-missing",
        label: "We have not built this integration yet",
        messages: ["Comparable exit route is missing"],
      },
    ]);
    // Machine keys must never reach the DOM.
    expect(JSON.stringify(presentation.boundedGroups)).not.toContain("exit:missing-same-notional-route");
  });

  it("adapts numeric V9 breakdowns without inventing control weights", () => {
    const card = makeV9Card({ pillars: BREAKDOWN_PILLARS });
    card.breakdowns = {
      ...breakdownsFixture(),
      backing: {
        evaluatedScore: 86,
        publishedScore: 88,
        aggregationWeight: 0.4,
        groups: [{ key: "reserves" as const, label: "Reserves", score: 86, effectiveWeight: 1 }],
        components: [{
          key: "reserve:reserve:wsteth",
          label: "wstETH",
          source: "reserve-exposure",
          score: 86,
          effectiveWeight: 1,
          weightedContribution: 86,
          observationState: "known",
        }],
        adjustments: [{
          kind: "operational-resilience-credit",
          scoreBefore: 86,
          scoreAfter: 88,
          delta: 2,
        }],
      },
      exit: {
        evaluatedScore: 84,
        publishedScore: 84,
        aggregationWeight: 0.35,
        stressRequest: {
          requestedNotionalUsd: 25_000_000,
          maxCostBps: 200,
          comparisonWindowSec: 86_400,
        },
        primaryRoute: {
          key: "redemption:primary",
          label: "Direct redemption",
          routeFamily: "issuer-redemption",
          score: 84,
          components: [
            { key: "access", label: "Access", score: 90, weight: 0.2, weightedContribution: 18 },
            { key: "settlement", label: "Settlement", score: 84, weight: 0.15, weightedContribution: 12.6 },
            { key: "executionCertainty", label: "Execution certainty", score: 80, weight: 0.15, weightedContribution: 12 },
            { key: "capacity", label: "Capacity", score: 78, weight: 0.25, weightedContribution: 19.5 },
            { key: "outputAssetQuality", label: "Output asset quality", score: 92, weight: 0.15, weightedContribution: 13.8 },
            { key: "cost", label: "Cost", score: 81, weight: 0.1, weightedContribution: 8.1 },
          ],
          confidenceFactor: 1,
          eligibilityMultiplier: 1,
          capsApplied: [],
          capacity: {
            executableUsd: 1_000,
            requestedNotionalUsd: 25_000_000,
            completionRatio: 0.00004,
            maxCostBps: 200,
            executionCostBps: 74,
            settlementDelaySec: 600,
            capacityScoringHorizon: "immediate",
            chain: "tron",
            protocol: "SunSwap",
            poolId: "pool-1",
            evidenceKind: "measured-executable-depth",
            observedAtSec: 1_752_537_600,
          },
        },
        diversification: null,
        alternatives: [{
          key: "dex:curve",
          label: "Curve liquidity",
          routeFamily: "dex-amm",
          score: 77,
          included: true,
          exclusionReason: null,
          confidenceFactor: 0.75,
          capacity: {
            executableUsd: 24_580_000,
            requestedNotionalUsd: 25_000_000,
            completionRatio: 0.9832,
          },
        }],
        adjustments: [],
      },
      control: {
        evaluatedScore: 86,
        publishedScore: 86,
        aggregationWeight: 0.25,
        method: "minimum-binding-component",
        components: [
          { key: "abstract", label: "Abstract bridge", kind: "bridge", score: 65, binding: false, posture: "distributed" },
          { key: "mint", label: "Mint authority", kind: "mint", score: 86, binding: true, posture: "concentrated" },
          { key: "oracle", label: "Oracle design", kind: "oracle", score: 95, binding: false, posture: "distributed" },
        ],
        adjustments: [],
      },
    };

    const presentation = buildStablecoinSafetyScoreV9Presentation(
      SafetyScoreV9CurrentCardSchema.parse(card),
    );

    expect(presentation.pillars[0].breakdown).toMatchObject({
      aggregationWeight: 0.4,
      sectionLabel: "Backing components",
    });
    // Group score and weight head the section, so they are no longer repeated
    // as context rows; only adjustments remain there.
    expect(presentation.pillars[0].breakdown?.groups).toMatchObject([
      {
        key: "reserves",
        label: "Reserves",
        score: 86,
        weight: 1,
        rows: [{ label: "wstETH", score: 86, weight: 1, status: "Known" }],
        tail: null,
      },
    ]);
    expect(presentation.pillars[0].breakdown?.context).toContainEqual({
      key: "operational-resilience-credit-0",
      label: "Resilience credit",
      value: "+2.0 to 88.0",
    });
    expect(presentation.pillars[1].breakdown).toMatchObject({
      sectionLabel: "Primary route components — Direct redemption",
      exitHighlight: {
        primaryRouteLabel: "Direct redemption",
        primaryRouteScore: 84,
        redundancyCredit: 0,
        capacityLine: "<1% of $25m executable within 10m · 74 bps",
      },
      alternatives: [{
        label: "Curve liquidity",
        score: 77,
        included: true,
        redundancyCredit: null,
        detail: "$24,580,000 of $25,000,000 executable · confidence 0.75x",
      }],
    });
    // Exit keeps one unlabelled group in producer order.
    expect(presentation.pillars[1].breakdown?.groups).toHaveLength(1);
    expect(presentation.pillars[1].breakdown?.groups[0].label).toBeNull();
    expect(presentation.pillars[1].breakdown?.groups[0].rows).toEqual(expect.arrayContaining([
      expect.objectContaining({ label: "Access", score: 90, weight: 0.2 }),
      expect.objectContaining({
        label: "Capacity score — selected route",
        score: 78,
        weight: 0.25,
      }),
    ]));
    expect(presentation.pillars[1].breakdown?.context).toEqual(expect.arrayContaining([
      { key: "stress-request", label: "Stress request", value: "$25m / 200 bps / 1d" },
      {
        key: "selected-route-capacity",
        label: "Selected route capacity",
        value: "$1,000 of $25,000,000 executable on selected SunSwap route",
      },
      {
        key: "selected-route-bound",
        label: "Horizon / execution cost",
        value: "10m / 74 bps observed / 200 bps bound",
      },
      { key: "selected-route-scope", label: "Chain / pool", value: "tron / pool-1" },
    ]));
    // The producer emits control components alphabetically, so the binding row
    // is listed last in the fixture on purpose: the pillar that scores on the
    // lowest binding control must lead with it regardless of producer order.
    // One loose bridge is below the composite threshold, so it stays a row.
    expect(presentation.pillars[2].breakdown?.groups[0].rows.map((row) => row.key))
      .toEqual(["mint", "oracle", "abstract"]);
    expect(presentation.pillars[2].breakdown?.groups[0].rows[0]).toMatchObject({
      label: "Mint authority",
    });
  });

  it("rolls loose bridges into one composite carrying the cohort's worst score", () => {
    const card = makeV9Card({ pillars: BREAKDOWN_PILLARS });
    card.breakdowns = {
      ...breakdownsFixture(),
      control: {
        evaluatedScore: 86,
        publishedScore: 86,
        aggregationWeight: 0.25,
        method: "minimum-binding-component" as const,
        // Producer order is alphabetical by key, which the schema enforces.
        components: [
          { key: "abstract", label: "Abstract bridge", kind: "bridge" as const, score: 65, binding: false, posture: "distributed" as const },
          { key: "boba", label: "Boba bridge", kind: "bridge" as const, score: 85, binding: false, posture: "distributed" as const },
          { key: "bsc", label: "Bsc bridge", kind: "bridge" as const, score: 86, binding: true, posture: "distributed" as const },
          { key: "flow", label: "Flow bridge", kind: "bridge" as const, score: 50, binding: false, posture: "distributed" as const },
          { key: "mint", label: "Mint authority", kind: "mint" as const, score: 90, binding: true, posture: "concentrated" as const },
        ],
        adjustments: [],
      },
    };

    const rows = buildStablecoinSafetyScoreV9Presentation(
      SafetyScoreV9CurrentCardSchema.parse(card),
    ).pillars[2].breakdown!.groups[0].rows;

    // A bridge is the lowest binding control on 37 assets, so a binding bridge
    // stays a top-level row instead of disappearing into the composite. Binding
    // rows lead cheapest-first, so the row that sets the score is read first.
    expect(rows.map((row) => row.key)).toEqual(["bsc", "mint", "bridge-composite"]);
    const composite = rows[2];
    // Worst, not mean: the pillar rule is a minimum and an average would flatter it.
    expect(composite.score).toBe(50);
    expect(composite.status).toBe("3 chains");
    expect(composite.detail).toBe("Worst of 3 · range 50–85 · not binding");
    expect(composite.children.map((child) => child.key)).toEqual(["flow", "abstract", "boba"]);
  });

  it("folds low-weight reserve slices into a tail and tints only weak rows", () => {
    const card = makeV9Card({ pillars: BREAKDOWN_PILLARS });
    const slice = (key: string, score: number, weight: number) => ({
      key,
      label: key,
      source: "reserve-exposure" as const,
      score,
      effectiveWeight: weight,
      weightedContribution: score * weight,
      observationState: "known" as const,
    });
    // Weights sum to 1; contributions sum to the evaluated score; keys sorted.
    card.breakdowns = {
      ...breakdownsFixture(),
      backing: {
        evaluatedScore: 89.08,
        publishedScore: 89.08,
        aggregationWeight: 0.4,
        groups: [{ key: "reserves" as const, label: "Reserves", score: 89.08, effectiveWeight: 1 }],
        components: [
          slice("a-dust", 30, 0.01),
          slice("b-core", 95, 0.85),
          slice("c-dust", 60, 0.012),
          slice("d-mid", 55, 0.11),
          slice("e-dust", 70, 0.018),
        ],
        adjustments: [],
      },
    };
    card.pillars.backing.score = 89.08;

    const group = buildStablecoinSafetyScoreV9Presentation(
      SafetyScoreV9CurrentCardSchema.parse(card),
    ).pillars[0].breakdown!.groups[0];

    // Heaviest first, and the three sub-2% slices fold away with their combined weight.
    expect(group.rows.map((row) => row.key)).toEqual(["b-core", "d-mid"]);
    expect(group.tail?.rows.map((row) => row.key)).toEqual(["e-dust", "c-dust", "a-dust"]);
    expect(group.tail?.label).toBe("Smaller holdings (3) · 4.0% combined");
    // Colour only where it means something: 95 neutral, 55 warns, 30 is critical.
    expect(group.rows.map((row) => row.tone)).toEqual(["neutral", "warn"]);
    expect(group.tail?.rows.map((row) => row.tone)).toEqual(["neutral", "warn", "critical"]);
  });

});
