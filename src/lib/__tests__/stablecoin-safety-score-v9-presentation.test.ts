import { describe, expect, it } from "vitest";
import { SafetyScoreV9CurrentCardSchema } from "@shared/types/safety-score-v9-public";
import { makeV9Card, makeV9Pillars } from "@/test/fixtures/safety-score-v9";
import {
  buildStablecoinSafetyScoreV9Presentation,
} from "@/lib/stablecoin-safety-score-v9-presentation";
import { buildSafetyScoreV9AccessRows } from "@/lib/stablecoin-safety-score-v9-presentation-access";
import { buildSafetyScoreV9Attribution } from "@/lib/stablecoin-safety-score-v9-presentation-attribution";

// These suites author breakdowns whose published scores must match the
// card pillars, so they declare the pillars instead of tracking the shared
// fixture's default quality score.
const BREAKDOWN_PILLARS = makeV9Pillars({ backing: 88, exit: 84, control: 86 });

describe("stablecoin V9 safety presentation", () => {
  it("keeps excluded backing factors null and cause-labelled beside their surviving scored factors", () => {
    const card = makeV9Card({ localCauseGaps: ["transparency"], partialEvidence: {
      reasonCode: "partial-evidence-pipeline-gap", excludedPillars: [],
      excludedComponentKeys: ["reserve:reviewed:transparency"], causeGapRefs: [0], causes: ["B"],
    } });
    card.breakdowns!.backing.components[0].factors = [
      { componentKey: "assetQuality", score: 88, normalizedWeight: 0.8, effectiveScoringWeight: 1,
        cause: null, causeGapRefs: [], scoringDisposition: "included" },
      { componentKey: "transparency", score: null, normalizedWeight: 0.2, effectiveScoringWeight: 0,
        cause: "B", causeGapRefs: [0], scoringDisposition: "excluded-uncurated" },
    ];
    const children = buildStablecoinSafetyScoreV9Presentation(
      SafetyScoreV9CurrentCardSchema.parse(card),
    ).pillars[0].breakdown!.groups[0].rows[0].children;
    expect(children).toEqual([
      expect.objectContaining({ key: "assetQuality", score: 88, weight: 1 }),
      expect.objectContaining({ key: "transparency", score: null, weight: 0, status: expect.stringContaining("awaiting curation") }),
    ]);
  });

  it("labels U breakdown factors Unresolved without changing their cause", () => {
    const card = makeV9Card();
    card.breakdowns!.backing.components[0].factors = [
      { componentKey: "assetQuality", score: 88, normalizedWeight: 1, effectiveScoringWeight: 1,
        cause: "U", causeGapRefs: [], scoringDisposition: "included" },
    ];
    const children = buildStablecoinSafetyScoreV9Presentation(card)
      .pillars[0].breakdown!.groups[0].rows[0].children;
    expect(children).toContainEqual(expect.objectContaining({ key: "assetQuality", status: "Unresolved" }));
    expect(card.breakdowns!.backing.components[0].factors[0].cause).toBe("U");
  });

  it("explains limited score inputs without changing the visible evidence label or API key", () => {
    const card = makeV9Card();
    card.pillars.backing.evidenceLevel = "limited";
    const presentation = buildStablecoinSafetyScoreV9Presentation(card);
    expect(presentation.pillars[0].evidenceSummary).toBe("Evidence: limited · current");
    expect(presentation.pillars[0].evidenceDescription).toBe(
      "Evidence: limited — the pillar score relies on undisclosed or unresolved inputs.",
    );
    expect(card.pillars.backing.evidenceLevel).toBe("limited");
    expect(presentation.pillars[1].evidenceDescription).toBeNull();

    card.pillars.backing.aggregationDisposition = "excluded-a-b";
    expect(buildStablecoinSafetyScoreV9Presentation(card).pillars[0].evidenceDescription).toBeNull();
  });

  /**
   * Full three-pillar breakdown; tests override the pillar they exercise.
   * Published scores must equal the card's pillar scores (88 / 84 / 86) and
   * backing weights must sum to 1 with contributions summing to the evaluated
   * score, or SafetyScoreV9CurrentCardSchema rejects the fixture.
   */
  const breakdownsFixture = () => ({
    backing: { evaluatedScore: 86, publishedScore: 88, aggregationWeight: 0.4, aggregationDisposition: 'included' as const, causeGapRefs: [], limitedEvidenceCauses: [], groups: [{ key: "reserves" as const, label: "Reserves", score: 86, effectiveScoringWeight: 1, cause: null, causeGapRefs: [], scoringDisposition: 'included' as const }],
    components: [{ key: "reserve:reserve:wsteth", label: "wstETH", source: "reserve-exposure" as const, score: 86, effectiveScoringWeight: 1, wholeAssetWeight: 1, weightedContribution: 86, observationState: "known" as const, cause: null, causeGapRefs: [], scoringDisposition: 'included' as const }],
    adjustments: [{
      kind: "operational-resilience-credit" as const,
      scoreBefore: 86,
      scoreAfter: 88,
      delta: 2,
    }], },
    exit: { evaluatedScore: 84, publishedScore: 84, aggregationWeight: 0.35, aggregationDisposition: 'included' as const, causeGapRefs: [], limitedEvidenceCauses: [], stressRequest: null,
    primaryRoute: null,
    diversification: null,
    alternatives: [],
    adjustments: [], },
    control: { evaluatedScore: 86, publishedScore: 86, aggregationWeight: 0.25, aggregationDisposition: 'included' as const, causeGapRefs: [], limitedEvidenceCauses: [], method: "minimum-binding-component" as const,
    components: [
      { key: "mint", label: "Mint authority", kind: "mint" as const, score: 86, binding: true, posture: "concentrated" as const, effectiveScoringWeight: 1, cause: null, causeGapRefs: [], scoringDisposition: 'included' as const },
    ],
    adjustments: [], },
  });

  // Producer order and weights are fixed by the exit schema; fixtures differ
  // only in the per-component scores, and the contribution is score x weight.
  const EXIT_ROUTE_COMPONENTS = [
    { key: "access", label: "Access", weight: 0.2 },
    { key: "settlement", label: "Settlement", weight: 0.15 },
    { key: "executionCertainty", label: "Execution certainty", weight: 0.15 },
    { key: "capacity", label: "Capacity", weight: 0.25 },
    { key: "outputAssetQuality", label: "Output asset quality", weight: 0.15 },
    { key: "cost", label: "Cost", weight: 0.1 },
  ] as const;

  const exitRouteComponents = (
    scores: Record<(typeof EXIT_ROUTE_COMPONENTS)[number]["key"], number>,
  ) => EXIT_ROUTE_COMPONENTS.map(({ key, label, weight }) => ({
    key,
    label,
    weight,
    effectiveScoringWeight: weight,
    cause: null, causeGapRefs: [], scoringDisposition: "included" as const,
    score: scores[key],
    weightedContribution: Number((scores[key] * weight).toFixed(6)),
  }));

  it("keeps the three named pillars without recreating V8 dimensions", () => {
    const card = makeV9Card();

    const presentation = buildStablecoinSafetyScoreV9Presentation(card);

    expect(presentation.pillars.map((pillar) => pillar.label)).toEqual([
      "Backing",
      "Exit",
      "Economic Control",
    ]);
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

    expect(buildSafetyScoreV9AccessRows(card)).toContainEqual({
      key: "primaryExit",
      label: "Primary exit",
      value: "Incomplete exit surface",
    });
  });

  it("splits causal attribution and names whose gap each unresolved fact is", () => {
    const card = makeV9Card();
    card.localCauseGaps = ["assurance", "backing"];
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
        code: "missing-reserve-composition",
        path: "backing:reserve-envelope",
        message: "No reserve composition is present in the exact fixed input.",
        responsibility: "issuer-undisclosed",
        cause: "C", causeGapRefs: [1],
      },
      {
        source: "reason",
        code: "missing-latest-assurance-report",
        path: "backing:assurance-report",
        message: "The published assurance report is outside our freshness window.",
        responsibility: "published-evidence-expired",
        cause: "U", causeGapRefs: [0],
      },
    ];

    const presentation = buildSafetyScoreV9Attribution(card);

    // Six-decimal producer precision reads as noise in a sentence.
    expect(presentation.adverseMessages).toEqual(["Measured peg multiplier is 0.804."]);
    // The issuer's gaps lead; ours are still named as ours rather than hidden.
    expect(presentation.boundedGroups.map(({ key, messages }) => ({ key, messages }))).toEqual([
      {
        key: "issuer-undisclosed",
        messages: ["No reserve composition is present in the exact fixed input."],
      },
      {
        key: "published-evidence-expired",
        messages: ["The published assurance report is outside our freshness window."],
      },
    ]);
    // Machine keys must never reach the DOM.
    expect(JSON.stringify(presentation.boundedGroups)).not.toContain("exit:missing-same-notional-route");
  });

  it("adapts numeric V9 breakdowns without inventing control weights", () => {
    const card = makeV9Card({ pillars: BREAKDOWN_PILLARS });
    card.breakdowns = {
      ...breakdownsFixture(),
      exit: { evaluatedScore: 84, publishedScore: 84, aggregationWeight: 0.35, aggregationDisposition: 'included' as const, causeGapRefs: [], limitedEvidenceCauses: [], stressRequest: {
        requestedNotionalUsd: 25_000_000,
        maxCostBps: 200,
        comparisonWindowSec: 86_400,
      },
      primaryRoute: { key: "redemption:primary", routeId: "primary", lane: "redemption", label: "Direct redemption", routeFamily: "issuer-redemption", score: 84, components: exitRouteComponents({ access: 90, settlement: 84, executionCertainty: 80, capacity: 78, outputAssetQuality: 92, cost: 81 }), confidenceFactor: 1, confidenceDimensions: { observation: { factor: 1, cause: null, causeGapRefs: [] }, model: { factor: 1, cause: null, causeGapRefs: [] }, capacityMethod: { factor: 1, cause: null, causeGapRefs: [] } }, capacityEvidenceTier: 'live-direct' as const, rawSameNotionalCostBps: null, supportedComponentCeiling: exitRouteComponents({ access: 90, settlement: 84, executionCertainty: 80, capacity: 78, outputAssetQuality: 92, cost: 81 }).reduce((sum, component) => sum + component.weightedContribution, 0), eligibilityMultiplier: 1,
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
      }, },
      diversification: null,
      alternatives: [{ key: "dex:curve", routeId: "curve", lane: "dex", label: "Curve liquidity", routeFamily: "dex-amm", score: 77, included: true, exclusionReason: null, confidenceDimensions: null, capacityEvidenceTier: 'unknown' as const, rawSameNotionalCostBps: null, confidenceFactor: 0.75,
      capacity: {
        executableUsd: 24_580_000,
        requestedNotionalUsd: 25_000_000,
        completionRatio: 0.9832,
      }, }],
      adjustments: [], },
      control: {
        ...breakdownsFixture().control,
        components: [
          { key: "abstract", label: "Abstract bridge", kind: "bridge" as const, score: 65, binding: false, posture: "distributed" as const, effectiveScoringWeight: 0, cause: null, causeGapRefs: [], scoringDisposition: 'included' as const },
          { key: "mint", label: "Mint authority", kind: "mint" as const, score: 86, binding: true, posture: "concentrated" as const, effectiveScoringWeight: 1, cause: null, causeGapRefs: [], scoringDisposition: 'included' as const },
          { key: "oracle", label: "Oracle design", kind: "oracle" as const, score: 95, binding: false, posture: "distributed" as const, effectiveScoringWeight: 0, cause: null, causeGapRefs: [], scoringDisposition: 'included' as const },
        ],
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
        venueLabel: "Direct redemption",
        primaryRouteScore: 84,
        redundancyCredit: 0,
      },
      alternatives: [{
        label: "Curve liquidity",
        score: 77,
        included: true,
        redundancyCredit: null,
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

  it("keeps measured zero capacity, confidence, and its binding cap visible", () => {
    const card = makeV9Card({
      pillars: makeV9Pillars({ backing: 88, exit: 0, control: 86 }),
    });
    card.breakdowns = {
      ...breakdownsFixture(),
      exit: { evaluatedScore: 0, publishedScore: 0, aggregationWeight: 0.35, aggregationDisposition: 'included' as const, causeGapRefs: [], limitedEvidenceCauses: [], stressRequest: {
        requestedNotionalUsd: 1_000_000,
        maxCostBps: 200,
        comparisonWindowSec: 300,
      },
      primaryRoute: { key: "redemption:earn-queued", routeId: "earn-queued", lane: "redemption", label: "Queued USDC redemption", routeFamily: "protocol-redemption", score: 0, components: exitRouteComponents({ access: 100, settlement: 100, executionCertainty: 60, capacity: 0, outputAssetQuality: 100, cost: 100 }), confidenceFactor: 1, confidenceDimensions: { observation: { factor: 1, cause: null, causeGapRefs: [] }, model: { factor: 1, cause: null, causeGapRefs: [] }, capacityMethod: { factor: 1, cause: null, causeGapRefs: [] } }, capacityEvidenceTier: 'live-direct' as const, rawSameNotionalCostBps: null, supportedComponentCeiling: exitRouteComponents({ access: 100, settlement: 100, executionCertainty: 60, capacity: 0, outputAssetQuality: 100, cost: 100 }).reduce((sum, component) => sum + component.weightedContribution, 0), eligibilityMultiplier: 1,
      capsApplied: ["zero-executable-capacity"],
      capacity: {
        executableUsd: 0,
        requestedNotionalUsd: 1_000_000,
        completionRatio: 0,
        maxCostBps: 200,
        executionCostBps: 5,
        settlementDelaySec: 2_592_000,
        capacityScoringHorizon: "queued",
        chain: "ethereum",
        protocol: "eEARN",
        poolId: null,
        evidenceKind: "onchain-redeemable-liquidity",
        observedAtSec: 1_752_537_600,
      }, },
      diversification: null,
      alternatives: [],
      adjustments: [], },
    };

    const presentation = buildStablecoinSafetyScoreV9Presentation(
      SafetyScoreV9CurrentCardSchema.parse(card),
    );
    const exit = presentation.pillars[1];

    expect(exit.breakdown?.context).toEqual(expect.arrayContaining([
      {
        key: "confidence",
        label: "Confidence",
        value: "1x",
      },
      {
        key: "selected-route-capacity",
        label: "Selected route capacity",
        value: "$0 of $1,000,000 executable on selected eEARN route",
      },
      {
        key: "cap-0",
        label: "Applied cap",
        value: "Zero executable capacity",
      },
    ]));
    expect(exit.breakdown?.exitHighlight).toMatchObject({
      venueLabel: "Queued USDC redemption",
      primaryRouteScore: 0,
    });
    expect(exit.reasons).toEqual([
      "The selected Queued USDC redemption route had zero executable capacity for the $1,000,000 stress request.",
    ]);
    expect(JSON.stringify(exit)).not.toContain("no confidence");
  });

  it("rolls loose bridges into one composite carrying the cohort's worst score", () => {
    const card = makeV9Card({ pillars: BREAKDOWN_PILLARS });
    card.breakdowns = {
      ...breakdownsFixture(),
      control: {
        ...breakdownsFixture().control,
        // Producer order is alphabetical by key, which the schema enforces.
        components: [
          { key: "abstract", label: "Abstract bridge", kind: "bridge" as const, score: 65, binding: false, posture: "distributed" as const, effectiveScoringWeight: 0, cause: null, causeGapRefs: [], scoringDisposition: 'included' as const },
          { key: "boba", label: "Boba bridge", kind: "bridge" as const, score: 85, binding: false, posture: "distributed" as const, effectiveScoringWeight: 0, cause: null, causeGapRefs: [], scoringDisposition: 'included' as const },
          { key: "bsc", label: "Bsc bridge", kind: "bridge" as const, score: 86, binding: true, posture: "distributed" as const, effectiveScoringWeight: 1, cause: null, causeGapRefs: [], scoringDisposition: 'included' as const },
          { key: "flow", label: "Flow bridge", kind: "bridge" as const, score: 50, binding: false, posture: "distributed" as const, effectiveScoringWeight: 0, cause: null, causeGapRefs: [], scoringDisposition: 'included' as const },
          { key: "mint", label: "Mint authority", kind: "mint" as const, score: 90, binding: true, posture: "concentrated" as const, effectiveScoringWeight: 1, cause: null, causeGapRefs: [], scoringDisposition: 'included' as const },
        ],
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
    expect(composite.status).toBe("3 bridge components");
    expect(composite.detail).toBe("Worst of 3 · range 50–85 · not binding");
    expect(composite.children.map((child) => child.key)).toEqual(["flow", "abstract", "boba"]);
  });

  it("counts two same-chain bridge deployments as components, never as chains", () => {
    const card = makeV9Card({ pillars: BREAKDOWN_PILLARS });
    card.breakdowns = {
      ...breakdownsFixture(),
      control: {
        ...breakdownsFixture().control,
        components: [
          { key: "bridge:base:canonical", label: "Base canonical bridge", kind: "bridge", score: 85, binding: false, posture: "distributed", effectiveScoringWeight: 0, cause: null, causeGapRefs: [], scoringDisposition: "included" },
          { key: "bridge:base:oft", label: "Base OFT bridge", kind: "bridge", score: 65, binding: false, posture: "distributed", effectiveScoringWeight: 0, cause: null, causeGapRefs: [], scoringDisposition: "included" },
          { key: "mint", label: "Mint authority", kind: "mint", score: 86, binding: true, posture: "concentrated", effectiveScoringWeight: 1, cause: null, causeGapRefs: [], scoringDisposition: "included" },
        ],
      },
    };
    const rows = buildStablecoinSafetyScoreV9Presentation(
      SafetyScoreV9CurrentCardSchema.parse(card),
    ).pillars[2].breakdown!.groups[0].rows;
    const composite = rows.find((row) => row.key === "bridge-composite")!;
    expect(composite).toMatchObject({
      label: "Bridge components", status: "2 bridge components", score: 65,
      detail: "Worst of 2 · range 65–85 · not binding",
    });
    expect(composite.children.map((child) => child.key)).toEqual(["bridge:base:oft", "bridge:base:canonical"]);
    expect(JSON.stringify(composite)).not.toContain("2 chains");
  });

});
