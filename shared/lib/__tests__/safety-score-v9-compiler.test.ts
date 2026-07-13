import { describe, expect, it } from "vitest";
import type { StablecoinMeta } from "@shared/types/core";
import type { DexExitRouteObservation, DexLiquidityData } from "@shared/types/market";
import type { ReportCard } from "@shared/types/report-cards";
import {
  compileHistoricalFixtureToV9Input,
  compileReportCardSetToV9Inputs,
  compileReportCardToV9Input,
  computeConservativeTrackRecordMonths,
  resolveConservativeImplementationDate,
} from "../safety-score-v9-compiler";
import { historicalFactsInput, type HistoricalV9Fixture } from "@shared/types/safety-score-v9";

const meta: StablecoinMeta = {
  id: "test-usd",
  name: "Test USD",
  symbol: "TUSD",
  flags: {
    backing: "crypto-backed",
    pegCurrency: "USD",
    governance: "decentralized",
    yieldBearing: false,
    rwa: false,
    navToken: false,
  },
  mechanismArchetype: "cdp",
  launchDate: "2020",
  collateralQuality: "native",
  reserves: [
    {
      name: "ETH",
      pct: 100,
      risk: "medium",
      assetClass: "cryptoasset",
      issuerOrObligor: "Ethereum protocol",
      riskFactors: ["market", "smart-contract"],
      liquidityHorizon: "immediate",
    },
  ],
  reserveReview: {
    reviewedAt: "2026-06-01",
    reviewer: "research",
    confidence: "verified",
    sources: [{ label: "Reserve docs", url: "https://example.com/reserves" }],
    rationale: "Complete reserve review.",
    compositionBasis: "Protocol configuration",
    scope: "full-composition",
    knownUnknownExposure: "None",
    knownUnknownExposurePct: 0,
  },
  oracleRisk: {
    tier: "redundant-with-failover",
    summary: "Two independent oracle providers with failover.",
    branchModel: "single-path",
    branchApplicability: {
      disposition: "not-applicable",
      reviewedAt: "2026-06-01",
      reviewer: "research",
      rationale: "This fixture has one collateral and liquidation path.",
      sources: [{ label: "Oracle docs", url: "https://example.com/oracle" }],
    },
    reviewedAt: "2026-06-01",
    reviewer: "research",
    confidence: "verified",
    sources: [{ label: "Oracle docs", url: "https://example.com/oracle" }],
  },
  mintAuthority: {
    mintPath: "immutable-user-collateralized",
    authorityPosture: "none-resolved",
    confidence: "verified",
    summary: "Users mint against immutable collateral rules.",
    upgradeability: {
      model: "immutable",
      canChangeMintLogic: false,
      sources: [{ label: "Contract", url: "https://example.com/contract" }],
    },
    review: {
      sources: [{ label: "Contract", url: "https://example.com/contract" }],
      evidence: "The production contract exposes no privileged mint path.",
      reviewer: "research",
      reviewedAt: "2026-06-01",
      disposition: "scoreable",
    },
  },
};

const card = {
  id: "test-usd",
  dimensions: {
    pegStability: { score: 95 },
    liquidity: { score: 75 },
    resilience: { score: 85 },
    decentralization: { score: 80 },
    dependencyRisk: { score: 90 },
  },
  rawInputs: { activeDepegBps: null, liquidityHasMeasuredEvidence: true, redemptionImmediateCapacityUsd: null },
} as ReportCard;

const options = {
  asOf: "2026-06-30T00:00:00.000Z",
  compiledAt: "2026-07-01T00:00:00.000Z",
  methodologyVersion: "8.16",
  dexExitObservationMaxAgeSec: 3_600,
  liveRedemptionExitObservationMaxAgeSec: 28_800,
};

const route: DexExitRouteObservation = {
  routeId: "dex:test",
  routeFamily: "dex-amm",
  scope: { kind: "chain-contract", chain: "ethereum", contractOrPoolId: "0xpool", protocol: "Test AMM" },
  requestedNotionalUsd: 1_000_000,
  settlementHorizonSec: 300,
  maxCostBps: 200,
  executableUsd: 800_000,
  completionRatio: 0.8,
  output: { kind: "fiat", currency: "USD" },
  evidenceKind: "reserve-based-amm-simulation",
  confidence: "high",
  scoreEligible: true,
  observedAt: Date.parse("2026-06-30T00:00:00.000Z") / 1_000,
  freshnessSeconds: 60,
  commonModeKeys: [],
};

const dexRow = {
  updatedAt: route.observedAt,
  exitRouteObservations: [route],
  exitRouteObservationCoverage: {
    status: "populated",
    capabilityMatrixVersion: "test-v1",
    retainedPoolCount: 1,
    scoreEligiblePoolCount: 1,
    observationCount: 1,
    scoreEligibleObservationCount: 1,
    unsupportedPoolCount: 0,
    evidenceCounts: { "reserve-based-amm-simulation": 1 },
    unsupportedReasons: {},
  },
} as unknown as DexLiquidityData;

describe("production-to-v9 research compiler", () => {
  it("uses conservative lower bounds for fuzzy launch dates", () => {
    expect(resolveConservativeImplementationDate("2020")).toBe("2020-12-31");
    expect(resolveConservativeImplementationDate("2020-02")).toBe("2020-02-29");
    expect(resolveConservativeImplementationDate("2020-02-03")).toBe("2020-02-03");
    expect(computeConservativeTrackRecordMonths("2020-12-31", options.asOf)).toBe(65);
  });

  it("compiles evidence and signals without authored expectations or caps", () => {
    const compiled = compileReportCardToV9Input(meta, card, {
      ...options,
      metaById: new Map([[meta.id, meta]]),
      dexLiquidityById: new Map([[meta.id, dexRow]]),
    });
    expect(compiled.pillars.backing.score).toBe(65);
    expect(compiled.pillars.exit.score).toBe(80);
    expect(compiled.pillars.control.score).toBe(90);
    expect(compiled.pillars.backing.signals).not.toContain("v8-resilience-adapter");
    expect(compiled.pillars.exit.signals).toEqual(["route:dex-amm:fiat:independent"]);
    expect(compiled.implementationLaunchDate).toBe("2020-12-31");
    expect(compiled).not.toHaveProperty("expected");
    expect(compiled).not.toHaveProperty("structuralCaps");
  });

  it("does not read legacy v8 backing, liquidity, or decentralization scores", () => {
    const compile = (inputCard: ReportCard) =>
      compileReportCardToV9Input(meta, inputCard, {
        ...options,
        metaById: new Map([[meta.id, meta]]),
        dexLiquidityById: new Map([[meta.id, dexRow]]),
      });
    const changedLegacyScores = {
      ...card,
      dimensions: {
        ...card.dimensions,
        liquidity: { ...card.dimensions.liquidity, score: 1 },
        resilience: { ...card.dimensions.resilience, score: 2 },
        decentralization: { ...card.dimensions.decentralization, score: 3 },
        dependencyRisk: { ...card.dimensions.dependencyRisk, score: 4 },
      },
    } as ReportCard;

    expect(compile(changedLegacyScores).pillars).toEqual(compile(card).pillars);
  });

  it("fails closed when retained DEX pools are only partially modeled", () => {
    const partialCoverage = {
      ...dexRow,
      exitRouteObservationCoverage: {
        ...dexRow.exitRouteObservationCoverage,
        retainedPoolCount: 2,
        scoreEligiblePoolCount: 1,
      },
    } as DexLiquidityData;
    const compiled = compileReportCardToV9Input(meta, card, {
      ...options,
      metaById: new Map([[meta.id, meta]]),
      dexLiquidityById: new Map([[meta.id, partialCoverage]]),
    });

    expect(compiled.pillars.exit.score).toBeNull();
    expect(compiled.pillars.exit.unresolved).toContainEqual(
      expect.objectContaining({ code: "incomplete-dex-route-coverage", critical: true }),
    );
  });

  it("records future route observations as critical input facts before eligibility filtering", () => {
    const futureObservation = { ...route, observedAt: Date.parse(options.asOf) / 1_000 + 1 };
    const futureRow = {
      ...dexRow,
      exitRouteObservations: [route, futureObservation],
      exitRouteObservationCoverage: {
        ...dexRow.exitRouteObservationCoverage,
        retainedPoolCount: 2,
        scoreEligiblePoolCount: 2,
        observationCount: 2,
        scoreEligibleObservationCount: 2,
      },
    } as DexLiquidityData;
    const compiled = compileReportCardToV9Input(meta, card, {
      ...options,
      metaById: new Map([[meta.id, meta]]),
      dexLiquidityById: new Map([[meta.id, futureRow]]),
    });

    expect(compiled.pillars.exit.score).toBeNull();
    expect(compiled.pillars.exit.unresolved).toContainEqual(
      expect.objectContaining({
        code: "future-dated-input-fact",
        critical: true,
        path: "exitRouteObservations.1.observedAt",
      }),
    );
  });

  it("fails closed with itemized facts when production evidence is missing", () => {
    const sparse = { ...meta, reserves: undefined, reserveReview: undefined, mintAuthority: undefined };
    const compiled = compileReportCardToV9Input(sparse, card, {
      ...options,
      metaById: new Map([[sparse.id, sparse]]),
    });
    expect(compiled.pillars.backing.score).toBeNull();
    expect(compiled.pillars.exit.score).toBeNull();
    expect(compiled.pillars.control.score).toBeNull();
    expect(compiled.pillars.backing.unresolved.map((fact) => fact.code)).toContain("missing-reserve-composition");
    expect(compiled.pillars.exit.unresolved.map((fact) => fact.code)).toContain("missing-runtime-route-evidence");
    expect(compiled.pillars.control.unresolved.map((fact) => fact.code)).toContain("missing-mint-authority");
  });

  it("fails closed when a CDP has unresolved oracle branch applicability", () => {
    const unresolvedApplicability = {
      ...meta,
      oracleRisk: {
        ...meta.oracleRisk!,
        branchApplicability: {
          ...meta.oracleRisk!.branchApplicability!,
          disposition: "unresolved" as const,
          rationale: "Market-specific oracle and liquidation branches remain unreviewed.",
        },
      },
    };
    const compiled = compileReportCardToV9Input(unresolvedApplicability, card, {
      ...options,
      metaById: new Map([[unresolvedApplicability.id, unresolvedApplicability]]),
      dexLiquidityById: new Map([[unresolvedApplicability.id, dexRow]]),
    });

    expect(compiled.pillars.control.unresolved).toContainEqual(
      expect.objectContaining({ code: "unresolved-oracle-branch-applicability", critical: true }),
    );
  });

  it("does not infer an active incident from unbounded authority", () => {
    const unbounded = {
      ...meta,
      mintAuthority: {
        ...meta.mintAuthority!,
        mintPath: "issuer-direct-mint" as const,
        authorityPosture: "unbounded-or-compromised" as const,
        upgradeability: {
          model: "transparent-proxy" as const,
          canChangeMintLogic: true,
          controlRef: "Admin",
          sources: [{ label: "Proxy", url: "https://example.com/proxy" }],
        },
        controls: [
          {
            label: "Admin",
            role: "proxy-admin" as const,
            authorityType: "eoa" as const,
            directMintAbility: "upgrade-only" as const,
            evidence: "Admin controls mint-critical implementation upgrades.",
          },
        ],
      },
    };
    const compiled = compileReportCardToV9Input(unbounded, card, {
      ...options,
      metaById: new Map([[unbounded.id, unbounded]]),
      dexLiquidityById: new Map([[unbounded.id, dexRow]]),
    });
    expect(compiled.structuralSignals.map((signal) => signal.kind)).toContain("centralized-mint");
    expect(compiled.structuralSignals.map((signal) => signal.kind)).not.toContain("active-control-incident");
  });

  it("creates active-control-incident only from active incident state", () => {
    const incidentMeta: StablecoinMeta = {
      ...meta,
      mintAuthority: {
        ...meta.mintAuthority!,
        mintIncidents: [
          {
            date: "2026-06-01",
            status: "active",
            summary: "Production mint authority is actively compromised.",
            sources: [{ label: "Incident", url: "https://example.com/incident" }],
          },
        ],
      },
    };
    const compiled = compileReportCardToV9Input(incidentMeta, card, {
      ...options,
      metaById: new Map([[incidentMeta.id, incidentMeta]]),
      dexLiquidityById: new Map([[incidentMeta.id, dexRow]]),
    });
    expect(compiled.structuralSignals.map((signal) => signal.kind)).toContain("active-control-incident");
  });

  it("fails closed when a runtime-selected bridge route has no reviewed route", () => {
    const bridgeMeta: StablecoinMeta = {
      ...meta,
      contracts: [
        { chain: "ethereum", address: "0x0000000000000000000000000000000000000001", decimals: 18 },
        { chain: "arbitrum", address: "0x0000000000000000000000000000000000000002", decimals: 18 },
      ],
      bridgeRouteRisk: {
        tier: "canonical-rollup-bridge",
        summary: "Reviewed canonical route.",
        reviewedAt: "2026-06-01",
        reviewer: "research",
        confidence: "verified",
        routes: [
          {
            id: "ethereum:arbitrum:reviewed",
            sourceChain: "ethereum",
            destinationChain: "arbitrum",
            contractAddress: "0x0000000000000000000000000000000000000002",
            protocol: "Canonical bridge",
            issuanceModel: "bridge-representation",
            routeClass: "canonical",
            riskTier: "canonical-rollup-bridge",
            semantics: "lock-mint",
            scope: "canonical",
            reviewDisposition: "reviewed",
          },
        ],
      },
    };
    const bridgeCard = {
      ...card,
      rawInputs: {
        ...card.rawInputs,
        bridgeRouteMaterialityStatus: "complete",
        bridgeRouteSelectedRouteId: "ethereum:arbitrum:missing",
        bridgeRouteMatchedSupplyRatio: 1,
        bridgeRouteUnknownSupplyRatio: 0,
      },
    } as ReportCard;

    const compiled = compileReportCardToV9Input(bridgeMeta, bridgeCard, {
      ...options,
      metaById: new Map([[bridgeMeta.id, bridgeMeta]]),
      dexLiquidityById: new Map([[bridgeMeta.id, dexRow]]),
    });

    expect(compiled.pillars.control.score).toBeNull();
    expect(compiled.pillars.control.unresolved).toContainEqual(
      expect.objectContaining({
        code: "selected-bridge-route-missing",
        critical: true,
        path: "rawInputs.bridgeRouteSelectedRouteId",
      }),
    );
  });

  it("fails closed on future-dated reviews and active incidents but accepts the exact as-of boundary", () => {
    const withDatedFacts = (date: string): StablecoinMeta => ({
      ...meta,
      reserveReview: { ...meta.reserveReview!, reviewedAt: date },
      mintAuthority: {
        ...meta.mintAuthority!,
        mintIncidents: [
          {
            date,
            status: "active",
            summary: "Dated production incident.",
            sources: [{ label: "Incident", url: "https://example.com/incident" }],
          },
        ],
      },
    });
    const compile = (datedMeta: StablecoinMeta) =>
      compileReportCardToV9Input(datedMeta, card, {
        ...options,
        metaById: new Map([[datedMeta.id, datedMeta]]),
        dexLiquidityById: new Map([[datedMeta.id, dexRow]]),
      });

    const boundary = compile(withDatedFacts("2026-06-30"));
    expect(
      [...boundary.pillars.backing.unresolved, ...boundary.pillars.control.unresolved].map((fact) => fact.code),
    ).not.toContain("future-dated-input-fact");

    const future = compile(withDatedFacts("2026-07-01"));
    expect(future.pillars.backing.score).toBeNull();
    expect(future.pillars.control.score).toBeNull();
    expect(future.pillars.backing.unresolved).toContainEqual(
      expect.objectContaining({
        code: "future-dated-input-fact",
        critical: true,
        path: "reserveReview.reviewedAt",
      }),
    );
    expect(future.pillars.control.unresolved).toContainEqual(
      expect.objectContaining({
        code: "future-dated-input-fact",
        critical: true,
        path: "mintAuthority.mintIncidents.0.date",
      }),
    );
  });

  it("enforces an exact report-card ID bijection before set compilation", () => {
    expect(() => compileReportCardSetToV9Inputs([meta, meta], [card], options)).toThrow(
      "duplicate metadata IDs: test-usd",
    );
    expect(() => compileReportCardSetToV9Inputs([meta], [card, card], options)).toThrow(
      "duplicate report card IDs: test-usd",
    );
    expect(() => compileReportCardSetToV9Inputs([meta], [], options)).toThrow("missing report cards");
    expect(() => compileReportCardSetToV9Inputs([meta], [{ ...card, id: "unexpected" }], options)).toThrow(
      "missing report cards: test-usd; unexpected report cards: unexpected",
    );
  });

  it("sorts the active set and marks mint-control domains shared across assets", () => {
    const withSharedControl = (id: string): StablecoinMeta => ({
      ...meta,
      id,
      mintAuthority: {
        ...meta.mintAuthority!,
        mintPath: "permissioned-minter",
        authorityPosture: "bounded-admin",
        controls: [
          {
            label: "Shared mint operator",
            role: "direct-minter",
            authorityType: "contract",
            directMintAbility: "cap-limited",
            failureDomainKeys: ["operator:shared-mint"],
          },
        ],
      },
    });
    const compiled = compileReportCardSetToV9Inputs(
      [withSharedControl("z-asset"), withSharedControl("a-asset")],
      [
        { ...card, id: "z-asset" },
        { ...card, id: "a-asset" },
      ],
      options,
    );

    expect(compiled.map((input) => input.assetId)).toEqual(["a-asset", "z-asset"]);
    for (const input of compiled) {
      expect(input.structuralSignals).toContainEqual(
        expect.objectContaining({
          kind: "centralized-mint",
          severity: "moderate",
          failureDomainKeys: ["operator:shared-mint"],
        }),
      );
    }
  });

  it("fails closed on per-asset ID mismatches", () => {
    expect(() =>
      compileReportCardToV9Input(meta, { ...card, id: "wrong" }, { ...options, metaById: new Map() }),
    ).toThrow("ID mismatch");
  });

  it("compiles historical facts without reading the labeled outcome", () => {
    const fixture: HistoricalV9Fixture = {
      schemaVersion: 1,
      id: "outcome-blind",
      assetId: "historical-usd",
      asOf: "2022-01-01T00:00:00.000Z",
      factsVersion: 1,
      facts: {
        archetype: "cdp",
        implementationAgeMonths: 12,
        signals: ["documented collateral"],
        riskSignals: [
          {
            pillar: "backing",
            kind: "critical-dependency",
            severity: "moderate",
            reason: "One reviewed dependency.",
          },
        ],
        unresolvedCriticalFacts: [],
      },
      sources: [
        {
          title: "Point-in-time documentation",
          url: "https://example.com/2021-docs",
          publishedAt: "2021-12-01T00:00:00.000Z",
          supports: ["collateral"],
          capture: { status: "unarchived", note: "Regression fixture deliberately has no archival capture." },
        },
      ],
      factFreeze: {
        role: "facts-curator",
        reviewer: "facts reviewer",
        frozenAt: "2026-07-01T00:00:00.000Z",
        outcomeAccess: "withheld",
        attestation: "Facts were frozen before labels were supplied to the scorer.",
      },
      outcome: {
        classification: "adverse",
        categories: ["backing"],
        observedFrom: "2022-02-01T00:00:00.000Z",
        observedThrough: "2022-03-01T00:00:00.000Z",
        summary: "Adverse label unavailable to the compiler.",
      },
      outcomeAnnotation: {
        role: "outcome-annotator",
        reviewer: "outcome reviewer",
        annotatedAt: "2026-07-01T00:00:00.000Z",
        factSetVersion: 1,
        attestation: "Outcome was annotated after the frozen facts input.",
      },
      blinding: { mode: "independent-reviewers", rationale: "Separate fixture reviewers." },
    };
    const resilient = {
      ...fixture,
      outcome: {
        ...fixture.outcome,
        classification: "resilient" as const,
        categories: ["survivor" as const],
        summary: "Different outcome label and summary.",
      },
    };

    expect(compileHistoricalFixtureToV9Input(historicalFactsInput(resilient))).toEqual(
      compileHistoricalFixtureToV9Input(historicalFactsInput(fixture)),
    );
    expect(() =>
      compileHistoricalFixtureToV9Input({ ...historicalFactsInput(fixture), outcome: fixture.outcome } as never),
    ).toThrow();
  });
});
