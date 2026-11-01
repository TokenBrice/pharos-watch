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

  it("renders reserve factor keys as readable fact labels", () => {
    const card = makeV9Card();
    card.breakdowns!.backing.components[0].factors = [
      { componentKey: "reserve:reserve:69c2888ec8ecf49001af1889:assetClass", score: 90, normalizedWeight: 0.4,
        effectiveScoringWeight: 0.4, cause: null, causeGapRefs: [], scoringDisposition: "included" },
      { componentKey: "reserve:reserve:69c2888ec8ecf49001af1889:liquidity:covered", score: 88, normalizedWeight: 0.3,
        effectiveScoringWeight: 0.3, cause: null, causeGapRefs: [], scoringDisposition: "included" },
      { componentKey: "reserve:reserve:69c2888ec8ecf49001af1889:liquidity:uncovered", score: 86, normalizedWeight: 0.3,
        effectiveScoringWeight: 0.3, cause: null, causeGapRefs: [], scoringDisposition: "included" },
    ];
    const children = buildStablecoinSafetyScoreV9Presentation(card)
      .pillars[0].breakdown!.groups[0].rows[0].children;
    expect(children.map((child) => [child.key, child.label])).toEqual([
      ["reserve:reserve:69c2888ec8ecf49001af1889:assetClass", "Asset class"],
      ["reserve:reserve:69c2888ec8ecf49001af1889:liquidity:covered", "Liquidity (covered)"],
      ["reserve:reserve:69c2888ec8ecf49001af1889:liquidity:uncovered", "Liquidity (uncovered)"],
    ]);
    expect(JSON.stringify(children.map((child) => child.label))).not.toMatch(/:|69c2888e/u);
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

  it("annotates a limited pillar the server lists as documentation-only", () => {
    const card = makeV9Card();
    card.pillars.backing.evidenceLevel = "limited";

    const presentation = buildStablecoinSafetyScoreV9Presentation(card, ["backing"]);

    expect(presentation.pillars[0].evidenceSummary).toBe(
      "Evidence: limited · current · documentation gaps only",
    );
    expect(presentation.pillars[2].evidenceSummary).not.toContain("documentation gaps only");
  });

  it("keeps unlisted or absent documentation-only blocks as plain limited copy", () => {
    const card = makeV9Card();
    card.pillars.backing.evidenceLevel = "limited";

    expect(buildStablecoinSafetyScoreV9Presentation(card, ["control"]).pillars[0].evidenceSummary)
      .toBe("Evidence: limited · current");
    expect(buildStablecoinSafetyScoreV9Presentation(card).pillars[0].evidenceSummary)
      .toBe("Evidence: limited · current");
  });

  it("keeps the existing partial-DEX suffix beside the documentation annotation", () => {
    const card = makeV9Card();
    card.pillars.exit.evidenceLevel = "limited";
    card.scoreTrace.evidenceResponsibility.summaries = card.scoreTrace.evidenceResponsibility.summaries.map(
      (summary) => summary.responsibility === "unresearched"
        ? { ...summary, reasonCodes: ["incomplete-dex-route-coverage"] }
        : summary,
    );

    expect(buildStablecoinSafetyScoreV9Presentation(card).pillars[1].evidenceSummary)
      .toBe("Evidence: limited (selected route) · current · partial DEX coverage");
    expect(buildStablecoinSafetyScoreV9Presentation(card, ["exit"]).pillars[1].evidenceSummary)
      .toBe("Evidence: limited (selected route) · current · partial DEX coverage · documentation gaps only");
  });

  /**
   * Full three-pillar breakdown; tests override the pillar they exercise.
   * Published scores must equal the card's pillar scores (88 / 84 / 86) and
   * backing weights must sum to 1 with contributions summing to the evaluated
   * score, or SafetyScoreV9CurrentCardSchema rejects the fixture.
   */
  const breakdownsFixture = () => ({
    backing: { evaluatedScore: 88, publishedScore: 88, aggregationWeight: 0.4, aggregationDisposition: 'included' as const, causeGapRefs: [], limitedEvidenceCauses: [], groups: [{ key: "reserves" as const, label: "Reserves", score: 88, effectiveScoringWeight: 1, cause: null, causeGapRefs: [], scoringDisposition: 'included' as const }],
    components: [{ key: "reserve:reserve:wsteth", label: "wstETH", source: "reserve-exposure" as const, score: 88, effectiveScoringWeight: 1, wholeAssetWeight: 1, weightedContribution: 88, observationState: "known" as const, cause: null, causeGapRefs: [], scoringDisposition: 'included' as const }],
    adjustments: [], },
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
      primaryRoute: { key: "redemption:primary", routeId: "primary", lane: "redemption", label: "Direct redemption", routeFamily: "issuer-redemption", score: 84, components: exitRouteComponents({ access: 90, settlement: 84, executionCertainty: 80, capacity: 78, outputAssetQuality: 92, cost: 81 }), confidenceFactor: 1, confidenceDimensions: { observation: { factor: 1, cause: null, causeGapRefs: [] }, model: { factor: 1, cause: null, causeGapRefs: [] }, capacityMethod: { factor: 1, cause: null, causeGapRefs: [] } }, capacityEvidenceTier: 'live-direct' as const, rawSameNotionalCostBps: null, supportedComponentCeiling: exitRouteComponents({ access: 90, settlement: 84, executionCertainty: 80, capacity: 78, outputAssetQuality: 92, cost: 81 }).reduce((sum, component) => sum + component.weightedContribution, 0),
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
    // Group scores and weights head the section rather than repeating in context.
    expect(presentation.pillars[0].breakdown?.groups).toMatchObject([
      {
        key: "reserves",
        label: "Reserves",
        score: 88,
        weight: 1,
        rows: [{ label: "wstETH", score: 88, weight: 1, status: "Known" }],
        tail: null,
      },
    ]);
    expect(presentation.pillars[0].breakdown?.context).toEqual([]);
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
      { key: "confidence-capacityMethod", label: "Confidence — Capacity method", value: "1x" },
    ]));
    // The producer emits control components alphabetically: the limiting row
    // must lead regardless of producer order, then the diagnostics cheapest
    // first. A minimum has no weights, so none is invented for display.
    const controlRows = presentation.pillars[2].breakdown!.groups[0].rows;
    expect(controlRows.map((row) => [row.key, row.role, row.weight])).toEqual([
      ["mint", "limiting", null], ["abstract", "diagnostic", null], ["oracle", "diagnostic", null],
    ]);
    expect(controlRows[0]).toMatchObject({ label: "Mint authority" });
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
      primaryRoute: { key: "redemption:earn-queued", routeId: "earn-queued", lane: "redemption", label: "Queued USDC redemption", routeFamily: "protocol-redemption", score: 0, components: exitRouteComponents({ access: 100, settlement: 100, executionCertainty: 60, capacity: 0, outputAssetQuality: 100, cost: 100 }), confidenceFactor: 1, confidenceDimensions: { observation: { factor: 1, cause: null, causeGapRefs: [] }, model: { factor: 1, cause: null, causeGapRefs: [] }, capacityMethod: { factor: 1, cause: null, causeGapRefs: [] } }, capacityEvidenceTier: 'live-direct' as const, rawSameNotionalCostBps: null, supportedComponentCeiling: exitRouteComponents({ access: 100, settlement: 100, executionCertainty: 60, capacity: 0, outputAssetQuality: 100, cost: 100 }).reduce((sum, component) => sum + component.weightedContribution, 0),
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

  /** A published control component with the fields every fixture repeats. */
  const controlRow = (
    key: string, label: string, kind: "mint" | "oracle" | "bridge", score: number, binding: boolean, posture = "unbounded-reconciled",
  ) => ({ key, label, kind, score, binding, posture, effectiveScoringWeight: binding ? 1 : 0, cause: null, causeGapRefs: [], scoringDisposition: "included" as const });
  /** One bridged deployment: its bridge route and the authority minting its token there, over one control. */
  const bridgedDeployment = (chain: string, address: string, route: number, mint: number, binding = false, mintPosture = "unbounded-reconciled") => {
    const controlKey = `bridge-meta:usdc-circle:${chain}${address.slice(2, 6)}`;
    const name = chain.charAt(0).toUpperCase() + chain.slice(1);
    return [
      controlRow(`bridge:${chain}:${address}:${controlKey}`, `${name} bridge`, "bridge", route, binding, "external-lock-mint"),
      controlRow(`mint:bridge:${controlKey}`, `${name} bridged-token mint`, "mint", mint, binding, mintPosture),
    ];
  };
  const controlPresentation = (components: ReturnType<typeof controlRow>[], score: number) => {
    const card = makeV9Card({ pillars: makeV9Pillars({ backing: 88, exit: 84, control: score }) });
    card.breakdowns = {
      ...breakdownsFixture(),
      control: {
        ...breakdownsFixture().control, evaluatedScore: score, publishedScore: score,
        components: [...components].sort((left, right) => (left.key < right.key ? -1 : 1)),
      },
    };
    return buildStablecoinSafetyScoreV9Presentation(SafetyScoreV9CurrentCardSchema.parse(card)).pillars[2].breakdown!;
  };

  it("folds a wide asset's deployment inputs behind the limiting row, one row per deployment", () => {
    // usdc-circle's production shape: one native limiting control and dozens
    // of diagnostic bridged deployments, each published as a route + mint pair.
    const breakdown = controlPresentation([
      controlRow("mint", "X Layer upgrade authority", "mint", 80, true),
      ...bridgedDeployment("fantom", "0x04068da6c83afcfa0e13ba15a6696662335d5b75", 45, 25, false, "compromised"),
      ...bridgedDeployment("taiko", "0x07d83526730c7438048d55a4fc0b850e2aab6f0b", 85, 55),
      ...bridgedDeployment("boba", "0x66a2a913e447d6b4bf33efbec43aaef87890fbbc", 85, 90),
      // A token mint whose route the producer did not select stays its own row.
      controlRow("mint:bridge:bridge-meta:usdc-circle:nibiru", "Nibiru bridged-token mint", "mint", 90, false),
    ], 80);
    const rows = breakdown.groups[0].rows;
    expect(rows.map((row) => [row.label, row.score, row.role])).toEqual([
      ["X Layer upgrade authority", 80, "limiting"],
      // Worst, not mean: the pillar rule is a minimum and an average would flatter it.
      ["Deployments (4)", 25, "diagnostic"],
    ]);
    expect(rows[1].detail).toBe("Range 25–90 · weakest Fantom 25, Taiko 55");
    expect(rows[1].children.map((child) => [child.label, child.score, child.detail])).toEqual([
      ["Fantom", 25, "Bridge route 45 · Bridged-token mint 25 (compromised)"],
      ["Taiko", 55, "Bridge route 85 · Bridged-token mint 55"],
      ["Boba", 85, "Bridge route 85 · Bridged-token mint 90"],
      ["Nibiru bridged-token mint", 90, null],
    ]);
    expect(breakdown.context.map((item) => item.label)).toEqual(["Pillar rule"]);
    // v10.31 prices bridge routes, incidents and local authority, never a bridged-token mint's own score.
    expect(breakdown.note).toBe(
      "Diagnostic inputs sit outside the minimum. Deployment risk can still charge bridge routes, control incidents and deployment-local authority by their share of supply.",
    );
  });

  it("never folds away a deployment that sets the score, and folds a large tie at the minimum", () => {
    // A bridge is the lowest eligible control on dozens of assets.
    const single = controlPresentation([
      controlRow("mint", "Ethereum mint authority", "mint", 90, true),
      ...bridgedDeployment("bsc", "0x8ac76a51cc950d9822d68b83fe1ad97b32cd580d", 50, 85, true),
    ], 50).groups[0].rows;
    expect(single.map((row) => [row.label, row.score, row.role])).toEqual([
      ["BSC", 50, "limiting"], ["Ethereum mint authority", 90, "eligible"],
    ]);

    // sfrxusd-frax: 33 bridged-token mints tie the oracle at the minimum.
    const tie = controlPresentation([
      controlRow("oracle", "Oracle design", "oracle", 60, true),
      ...["aptos", "arbitrum", "base", "bsc"].map((chain) =>
        controlRow(`mint:bridge:bridge-meta:sfrxusd-frax:${chain}`, `${chain} bridged-token mint`, "mint", 60, true)),
    ], 60).groups[0].rows;
    // Asset-level inputs lead a tie: they name the whole asset.
    expect(tie.map((row) => [row.label, row.role, row.detail])).toEqual([
      ["Oracle design", "limiting", null],
      ["Deployments (4)", "limiting", "All 4 at 60"],
    ]);
  });

  it("keeps three tied limiting deployments as rows and folds only a larger tie", () => {
    const tie = (count: number) => controlPresentation(
      ["aptos", "arbitrum", "base", "bsc"].slice(0, count).map((chain) =>
        controlRow(`mint:bridge:bridge-meta:sfrxusd-frax:${chain}`, `${chain} bridged-token mint`, "mint", 60, true)),
      60,
    ).groups[0].rows.map((row) => row.key);
    expect(tie(3)).toHaveLength(3);
    expect(tie(4)).toEqual(["deployments:limiting"]);
  });

  it("pairs a Sui deployment through its control key and names an off-registry pair as a deployment", () => {
    const sui = "sui:0xdba34672e30cb065b1f93e3ab55318768fd6fef66c15942c9f7cb846e2f900e7::usdc::USDC";
    const rows = controlPresentation([
      controlRow("mint", "Native mint authority", "mint", 80, true),
      controlRow(`bridge:${sui}:bridge-meta:usdc-circle:sui`, "Sui bridge", "bridge", 65, false, "external-lock-mint"),
      controlRow("mint:bridge:bridge-meta:usdc-circle:sui", "Sui bridged-token mint", "mint", 90, false),
      controlRow("bridge:representation-group:xaut:bridge-meta:xaut:group", "Bridge authority", "bridge", 45, false, "external-lock-mint"),
      controlRow("mint:bridge:bridge-meta:xaut:group", "Bridged-token mint", "mint", 90, false),
    ], 80).groups[0].rows;
    expect(rows.map((row) => [row.label, row.score, row.detail])).toEqual([
      ["Native mint authority", 80, null],
      ["Bridged deployment", 45, "Bridge route 45 · Bridged-token mint 90"],
      ["Sui", 65, "Bridge route 65 · Bridged-token mint 90"],
    ]);
  });

  it("folds unscored deployment inputs without inventing a score", () => {
    const unscored = (chain: string) => ({
      ...controlRow(`mint:bridge:bridge-meta:alpha:${chain}`, `${chain} bridged-token mint`, "mint", 0, false),
      score: null, scoringDisposition: "not-applicable" as const,
    });
    const rows = controlPresentation([
      controlRow("mint", "Native mint authority", "mint", 86, true),
      ...["aptos", "base", "bsc"].map(unscored),
    ] as ReturnType<typeof controlRow>[], 86).groups[0].rows;
    expect(rows.at(-1)).toMatchObject({ key: "deployments:excluded", score: null, detail: "3 not scored", label: "Unscored deployments (3)" });
  });

  it("counts deployment inputs rather than chains and keeps same-chain deployments apart", () => {
    const rows = controlPresentation([
      controlRow("mint", "Ethereum mint authority", "mint", 86, true),
      ...bridgedDeployment("base", "0xaaaa00000000000000000000000000000000aaaa", 85, 90),
      ...bridgedDeployment("base", "0xbbbb00000000000000000000000000000000bbbb", 65, 90),
      // Two diagnostics fold nothing: a composite of two saves no height.
    ], 86).groups[0].rows;
    expect(rows.map((row) => row.label)).toEqual(["Ethereum mint authority", "Base · 0xbbbb…bbbb", "Base · 0xaaaa…aaaa"]);
    expect(JSON.stringify(rows)).not.toContain("chains");
  });

});
