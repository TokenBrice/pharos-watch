import { describe, expect, it } from "vitest";
import { DETAIL_PROVIDER_VALUES } from "../../types/price";
import deadStablecoinAsset from "../../data/dead-stablecoins.json";
import canonicalOrderAsset from "../../data/stablecoins/canonical-order.json";
import perCoinGeneratedAsset from "../../data/stablecoins/coins.generated.json";
import { DEAD_STABLECOINS } from "../dead-stablecoins";
import {
  ACTIVE_META_BY_ID,
  ACTIVE_STABLECOINS,
  DELISTED_STABLECOINS,
  FROZEN_STABLECOINS,
  PRE_LAUNCH_STABLECOINS,
  QUARANTINED_STABLECOINS,
  TRACKED_META_BY_ID,
  TRACKED_STABLECOINS,
} from "@shared/lib/stablecoins/registry";
import {
  findStablecoinCatalogInvariantIssues,
  parseCanonicalOrderAsset,
  parseDeadStablecoinAssets,
  parseStablecoinMetaAssets,
} from "../stablecoins/schema";

function makeStablecoinAsset(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: "schema-test-usd",
    name: "Schema Test USD",
    symbol: "STUSD",
    flags: {
      backing: "rwa-backed",
      pegCurrency: "USD",
      governance: "centralized",
      yieldBearing: false,
      rwa: false,
      navToken: false,
    },
    ...overrides,
  };
}

describe("tracked stablecoin metadata", () => {
  const perCoinGenerated = parseStablecoinMetaAssets(perCoinGeneratedAsset, "coins.generated");
  const canonicalOrder = parseCanonicalOrderAsset(canonicalOrderAsset, "canonical-order");

  it("loads all JSON registry assets through the shared schemas", () => {
    expect(perCoinGenerated).toHaveLength(TRACKED_META_BY_ID.size);
    expect(canonicalOrder).toHaveLength(TRACKED_META_BY_ID.size);
    expect(perCoinGenerated.length).toBe(canonicalOrder.length);
    // Raw JSON length vs. the production DEAD_STABLECOINS export: catches the schema
    // parser silently dropping or duplicating rows (DEAD_STABLECOINS.length alone would
    // be a tautology, since it's built from the same parse call on the same asset).
    expect(deadStablecoinAsset).toHaveLength(DEAD_STABLECOINS.length);
    expect(new Set(DEAD_STABLECOINS.map((coin) => coin.id)).size).toBe(DEAD_STABLECOINS.length);
  });

  it("keeps canonical order references limited to known tracked IDs", () => {
    const knownIds = new Set(perCoinGenerated.map((coin) => coin.id));

    expect(canonicalOrder.filter((id) => !knownIds.has(id))).toEqual([]);
  });

  it("keeps pre-launch metadata in per-coin assets", () => {
    const preLaunchCoins = perCoinGenerated.filter((coin) => coin.status === "pre-launch");

    expect(preLaunchCoins.map((coin) => coin.id).sort()).toEqual(PRE_LAUNCH_STABLECOINS.map((coin) => coin.id).sort());
  });

  it("keeps every lifecycle partition aligned after the JSON migration", () => {
    const partitionIds = [
      ...ACTIVE_STABLECOINS,
      ...PRE_LAUNCH_STABLECOINS,
      ...FROZEN_STABLECOINS,
      ...QUARANTINED_STABLECOINS,
      ...DELISTED_STABLECOINS,
    ].map(
      (coin) => coin.id,
    );

    // The lifecycle registries must partition the tracked catalog: no row may
    // vanish from every partition or appear twice, and a pre-launch row must not
    // reach the active registry.
    expect(partitionIds.toSorted()).toEqual(TRACKED_STABLECOINS.map((coin) => coin.id).toSorted());
    for (const coin of PRE_LAUNCH_STABLECOINS) {
      expect(coin.status, coin.id).toBe("pre-launch");
      expect(ACTIVE_META_BY_ID.has(coin.id), coin.id).toBe(false);
    }
  });

  it("keeps tracked registry metadata free of standalone algorithmic backing classifications", () => {
    const algorithmicIds = TRACKED_STABLECOINS.filter((coin) => coin.flags.backing === "algorithmic").map(
      (coin) => coin.id,
    );

    expect(algorithmicIds).toEqual([]);
  });

  it("accepts supported fuzzy launch date formats", () => {
    const accepted = ["2026", "2026-05", "2026-05-27", "2026-Q2", "2026-H1"];

    for (const value of accepted) {
      expect(
        parseStablecoinMetaAssets(
          [
            makeStablecoinAsset({
              launchDate: value,
              announcedDate: value,
              expectedLaunchDate: value,
              milestones: [{ date: value, type: "milestone", title: "Launch milestone" }],
              dateHistory: [{ date: value, setOn: "2026-01-15" }],
            }),
          ],
          `accepted ${value}`,
        )[0],
      ).toMatchObject({
        launchDate: value,
        announcedDate: value,
        expectedLaunchDate: value,
      });
    }
  });

  it("validates mechanism reviews and sourced implementation boundaries", () => {
    const review = {
      disposition: "resolved",
      reviewedAt: "2026-07-13",
      reviewer: "test reviewer",
      rationale: "The current implementation is a reserve-backed receipt.",
      sources: [{ label: "Docs", url: "https://example.com/docs" }],
    };

    expect(
      parseStablecoinMetaAssets(
        [
          makeStablecoinAsset({
            launchDate: "2020-04-22",
            mechanismArchetype: "fiat-cash",
            mechanismArchetypeReview: review,
            implementationLaunchDate: "2026-H1",
          }),
        ],
        "reviewed mechanism",
      ),
    ).toHaveLength(1);

    expect(() =>
      parseStablecoinMetaAssets(
        [makeStablecoinAsset({ mechanismArchetypeReview: review })],
        "resolved review without archetype",
      ),
    ).toThrow(/resolved mechanismArchetypeReview requires mechanismArchetype/);
    expect(() =>
      parseStablecoinMetaAssets(
        [
          makeStablecoinAsset({
            mechanismArchetype: "fiat-cash",
            mechanismArchetypeReview: { ...review, disposition: "unresolved" },
          }),
        ],
        "unresolved review with archetype",
      ),
    ).toThrow(/unresolved mechanismArchetypeReview cannot declare mechanismArchetype/);
    expect(() =>
      parseStablecoinMetaAssets(
        [makeStablecoinAsset({ launchDate: "2026", implementationLaunchDate: "2025" })],
        "unsourced implementation date",
      ),
    ).toThrow(/implementationLaunchDate requires a sourced mechanismArchetypeReview/);
    expect(() =>
      parseStablecoinMetaAssets(
        [
          makeStablecoinAsset({
            launchDate: "2026",
            mechanismArchetype: "fiat-cash",
            mechanismArchetypeReview: review,
            implementationLaunchDate: "2025",
          }),
        ],
        "implementation before project",
      ),
    ).toThrow(/implementationLaunchDate cannot unambiguously precede launchDate/);
  });

  it("requires declared multi-branch oracle structure", () => {
    const profile = {
      tier: "standard-external",
      summary: "Collateral markets use separate reviewed feed paths.",
      reviewedAt: "2026-07-13",
      reviewer: "test reviewer",
      confidence: "verified",
    };
    const branch = {
      id: "eth",
      label: "ETH branch",
      tier: "standard-external",
      summary: "ETH branch uses a reviewed external feed path.",
    };
    const flags = {
      backing: "crypto-backed", pegCurrency: "USD", governance: "decentralized",
      yieldBearing: false, rwa: false, navToken: false,
    };
    expect(parseStablecoinMetaAssets([makeStablecoinAsset({
      mechanismArchetype: "cdp", flags,
      oracleRisk: { ...profile, branchModel: "multi-branch", branches: [branch] },
    })], "valid multi branch")[0]?.oracleRisk?.branches?.[0]?.id).toBe("eth");

    expect(() =>
      parseStablecoinMetaAssets(
        [
          makeStablecoinAsset({
            mechanismArchetype: "cdp",
            flags,
            oracleRisk: { ...profile, branchModel: "multi-branch" },
          }),
        ],
        "multi branch without rows",
      ),
    ).toThrow(/multi-branch oracleRisk profiles require branches/);

    expect(() =>
      parseStablecoinMetaAssets(
        [
          makeStablecoinAsset({
            mechanismArchetype: "cdp",
            flags,
            oracleRisk: { ...profile, branches: [branch] },
          }),
        ],
        "branch rows without model",
      ),
    ).toThrow(/oracleRisk branches require branchModel multi-branch/);
  });

  it("rejects unsupported launch date formats", () => {
    const rejected = ["2026-13", "2026-02-30", "2026-Q5", "2026-H3", "H1 2026", "2026/05/27"];

    for (const value of rejected) {
      expect(() =>
        parseStablecoinMetaAssets([makeStablecoinAsset({ expectedLaunchDate: value })], `rejected ${value}`),
      ).toThrow(/Expected YYYY/);
    }
  });

  it("keeps dateHistory setOn strict while allowing fuzzy historical dates", () => {
    expect(
      parseStablecoinMetaAssets(
        [makeStablecoinAsset({ dateHistory: [{ date: "2026-H2", setOn: "2026-06-28" }] })],
        "dateHistory fuzzy date",
      ),
    ).toHaveLength(1);

    expect(() =>
      parseStablecoinMetaAssets(
        [makeStablecoinAsset({ dateHistory: [{ date: "2026-H2", setOn: "2026-H1" }] })],
        "dateHistory fuzzy setOn",
      ),
    ).toThrow(/Expected YYYY-MM-DD/);
  });

  it("requires http URLs for external evidence fields", () => {
    const cases: Array<{ label: string; overrides: Record<string, unknown> }> = [
      {
        label: "proofOfReserves",
        overrides: { proofOfReserves: { type: "independent-audit", url: "ftp://example.com/report.pdf" } },
      },
      {
        label: "links",
        overrides: { links: [{ label: "Docs", url: "/docs" }] },
      },
      {
        label: "mica references",
        overrides: {
          mica: { status: "authorized", references: [{ label: "Register", url: "mailto:issuer@example.com" }] },
        },
      },
      {
        label: "milestone source",
        overrides: {
          milestones: [{ date: "2026-01-01", type: "milestone", title: "Milestone", sourceUrl: "ftp://example.com" }],
        },
      },
      {
        label: "featured content url",
        overrides: {
          featuredContent: [{ type: "article", url: "/article", title: "Article" }],
        },
      },
    ];

    for (const { label, overrides } of cases) {
      expect(() => parseStablecoinMetaAssets([makeStablecoinAsset(overrides)], `bad ${label}`)).toThrow(
        /Expected an http\(s\) URL/,
      );
    }
  });

  it("keeps tracked variant parents active and canonical", () => {
    for (const coin of ACTIVE_STABLECOINS.filter((entry) => entry.variantOf != null)) {
      expect(ACTIVE_META_BY_ID.has(coin.variantOf!), coin.id).toBe(true);
      expect(coin.pegReferenceId, coin.id).toBe(coin.variantOf);
    }
  });

  it("rejects malformed stablecoin assets with readable schema errors", () => {
    expect(() =>
      parseStablecoinMetaAssets(
        [
          {
            id: "broken-coin",
            name: "Broken Coin",
            symbol: "BROKE",
            flags: {
              backing: "rwa-backed",
              pegCurrency: "USD",
              yieldBearing: false,
              rwa: false,
              navToken: false,
            },
          },
        ],
        "broken.json",
      ),
    ).toThrowError(/broken\.json/);
  });

  it("enforces contract decimals as finite integers from 0 through 255", () => {
    expect(
      parseStablecoinMetaAssets(
        [
          makeStablecoinAsset({
            contracts: [{ chain: "ethereum", address: "0x0", decimals: 0 }],
          }),
        ],
        "decimals-zero.json",
      )[0]?.contracts?.[0]?.decimals,
    ).toBe(0);

    for (const decimals of [-1, 1.5, 256, Infinity]) {
      expect(() =>
        parseStablecoinMetaAssets(
          [
            makeStablecoinAsset({
              contracts: [{ chain: "ethereum", address: "0x0", decimals }],
            }),
          ],
          `decimals-${decimals}.json`,
        ),
      ).toThrowError(/decimals/);
    }
  });

  it("enforces dependency weights as finite positive fractions", () => {
    for (const weight of [0, -0.1, 1.01, Infinity]) {
      expect(() =>
        parseStablecoinMetaAssets(
          [
            makeStablecoinAsset({
              dependencies: [{ id: "usdc-circle", weight }],
            }),
          ],
          `dependency-${weight}.json`,
        ),
      ).toThrowError(/weight/);
    }
  });

  it("rejects static dependency and reserve self-links", () => {
    expect(() =>
      parseStablecoinMetaAssets(
        [makeStablecoinAsset({ dependencies: [{ id: "schema-test-usd", weight: 1 }] })],
        "self-dependency.json",
      ),
    ).toThrowError(/cannot reference the stablecoin itself/);
    expect(() =>
      parseStablecoinMetaAssets(
        [
          makeStablecoinAsset({
            reserves: [{ name: "Self", pct: 100, risk: "low", coinId: "schema-test-usd" }],
          }),
        ],
        "self-reserve.json",
      ),
    ).toThrowError(/cannot reference the stablecoin itself/);
  });

  it("requires exact review provenance for manual-only dependencies", () => {
    const dependencies = [{ id: "usdc-circle", weight: 1, type: "mechanism" as const }];
    expect(() =>
      parseStablecoinMetaAssets([makeStablecoinAsset({ dependencies })], "manual-without-review.json"),
    ).toThrowError(/require dependencyReview provenance/);

    const parsed = parseStablecoinMetaAssets(
      [
        makeStablecoinAsset({
          dependencies,
          dependencyReview: {
            reviewedAt: "2026-07-12",
            reviewer: "test",
            confidence: "verified",
            sources: [{ label: "Docs", url: "https://example.com/docs" }],
            rationale: "The mechanism relationship cannot be represented as proportional reserves.",
            relationships: [
              { id: "usdc-circle", weight: 1, type: "mechanism", reason: "Required stabilization route." },
            ],
          },
        }),
      ],
      "manual-with-review.json",
    );

    expect(parsed[0]?.dependencyReview?.relationships).toHaveLength(1);
    expect(() =>
      parseStablecoinMetaAssets(
        [
          makeStablecoinAsset({
            dependencies,
            dependencyReview: {
              ...parsed[0]!.dependencyReview!,
              relationships: [{ ...parsed[0]!.dependencyReview!.relationships[0]!, weight: 1 - 5e-7 }],
            },
          }),
        ],
        "manual-with-rounded-weight.json",
      ),
    ).not.toThrow();
    expect(() =>
      parseStablecoinMetaAssets(
        [
          makeStablecoinAsset({
            dependencies,
            dependencyReview: {
              ...parsed[0]!.dependencyReview!,
              relationships: [{ ...parsed[0]!.dependencyReview!.relationships[0]!, weight: 0.99 }],
            },
          }),
        ],
        "manual-with-stale-weight.json",
      ),
    ).toThrowError(/weight must match the authored dependency weight/);
  });

  it("fingerprints reviewed non-link dispositions to the current reserve slice", () => {
    const reserveReview = {
      reviewedAt: "2026-07-12",
      reviewer: "test",
      confidence: "manual-review" as const,
      sources: [{ label: "Reserve report", url: "https://example.com/reserves" }],
      rationale: "The named basket needs a constituent split before dependency links are safe.",
      compositionBasis: "issuer reserve report",
      scope: "selected-slices" as const,
      knownUnknownExposure: "The stablecoin basket constituents and weights are not disclosed.",
      knownUnknownExposurePct: 20,
      nonLinkDispositions: [
        {
          reserveIndex: 1,
          reserveName: "Stablecoin basket",
          pct: 20,
          disposition: "basket-needs-split" as const,
          rationale: "No constituent weights are available.",
          candidateCoinIds: ["usdc-circle", "usdt-tether"],
        },
      ],
    };
    const reserves = [
      { name: "Cash", pct: 80, risk: "very-low" as const },
      { name: "Stablecoin basket", pct: 20, risk: "low" as const },
    ];

    expect(
      parseStablecoinMetaAssets([makeStablecoinAsset({ reserves, reserveReview })], "reviewed-reserves.json")[0]
        ?.reserveReview,
    ).toEqual(reserveReview);
    expect(() =>
      parseStablecoinMetaAssets(
        [
          makeStablecoinAsset({
            reserves,
            reserveReview: {
              ...reserveReview,
              nonLinkDispositions: [{ ...reserveReview.nonLinkDispositions[0], pct: 20 + 5e-7 }],
            },
          }),
        ],
        "reviewed-reserves-rounded-pct.json",
      ),
    ).not.toThrow();
    expect(() =>
      parseStablecoinMetaAssets(
        [
          makeStablecoinAsset({
            reserves: [reserves[0], { ...reserves[1], name: "Changed basket" }],
            reserveReview,
          }),
        ],
        "stale-reviewed-reserves.json",
      ),
    ).toThrowError(/must match the current reserve index and name/);
    expect(() =>
      parseStablecoinMetaAssets(
        [
          makeStablecoinAsset({
            reserves,
            reserveReview: {
              ...reserveReview,
              nonLinkDispositions: [{ ...reserveReview.nonLinkDispositions[0], pct: 19.99 }],
            },
          }),
        ],
        "stale-reviewed-reserve-pct.json",
      ),
    ).toThrowError(/disposition pct must match the current reserve slice/);
    expect(() =>
      parseStablecoinMetaAssets(
        [makeStablecoinAsset({ reserves, reserveReview: { ...reserveReview, knownUnknownExposurePct: 19.99 } })],
        "stale-known-unknown-pct.json",
      ),
    ).toThrowError(/knownUnknownExposurePct must equal the total pct of unresolved dispositions/);
  });

  it("keeps adapter-owned composition and report dates independent, without changing assurance scope", () => {
    const reserveReview = {
      reviewedAt: "2026-07-13",
      reviewer: "test",
      confidence: "verified",
      sources: [{ label: "Live composition", url: "https://example.com/live" }],
      rationale: "Adapter snapshot has its own observed date.",
      compositionBasis: "Live adapter snapshot",
      compositionAsOf: "2026-07-12",
      compositionSource: "live-adapter",
      scope: "full-composition",
      knownUnknownExposure: "None",
      knownUnknownExposurePct: 0,
    };
    const latestReport = {
      periodEnd: "2026-06-30",
      publishedAt: "2026-07-10",
      assuranceMethod: "unknown",
      scope: "unknown",
      liabilityReconciliation: "unknown",
      reviewer: "test",
      confidence: "verified",
      sources: [{ label: "Monthly report", url: "https://example.com/monthly" }],
    };
    const asset = makeStablecoinAsset({
      reserves: [{ name: "Cash", pct: 100, risk: "very-low" }],
      reserveReview,
      proofOfReserves: { type: "real-time", url: "https://example.com/live", latestReport },
      liveReservesConfig: {
        adapter: "ethena", version: 1, semantics: "collateral-mix",
        inputs: { primary: { kind: "http-json", url: "https://example.com/live" } },
      },
    });
    const parsed = parseStablecoinMetaAssets([asset], "adapter-independent-dates.json")[0]!;
    expect(parsed.reserveReview?.compositionAsOf).toBe("2026-07-12");
    expect(parsed.proofOfReserves?.latestReport).toEqual(latestReport);
    for (const overrides of [
      { liveReservesConfig: undefined },
      { reserveReview: { ...reserveReview, compositionSource: undefined } },
      { reserveReview: { ...reserveReview, confidence: "unknown" } },
      { proofOfReserves: { type: "real-time", url: "https://example.com/live", latestReport: { ...latestReport, publishedAt: undefined } } },
      { proofOfReserves: { type: "real-time", url: "https://example.com/live", latestReport: { ...latestReport, confidence: "unknown" } } },
    ]) {
      expect(() => parseStablecoinMetaAssets([{ ...asset, ...overrides }], "invalid-independent-dates.json"))
        .toThrowError(/lockstep|requires liveReservesConfig/);
    }
    const curated = { ...asset, liveReservesConfig: undefined, reserveReview: {
      ...reserveReview, compositionSource: undefined, compositionAsOf: latestReport.periodEnd,
    } };
    expect(parseStablecoinMetaAssets([curated], "curated-lockstep.json")[0]?.reserveReview?.compositionAsOf)
      .toBe(latestReport.periodEnd);
  });

  it.each(["mixed", "unknown"])("preserves the conservative whole-book custody value %s", (custodyModel) => {
    expect(parseStablecoinMetaAssets([makeStablecoinAsset({ custodyModel })], "custody-coverage.json")[0]?.custodyModel)
      .toBe(custodyModel);
  });

  it("accepts structured reserve facts and validates latest assurance reports", () => {
    const proofOfReserves = {
      type: "independent-audit",
      url: "https://example.com/reports",
      latestReport: {
        periodEnd: "2026-06-30",
        publishedAt: "2026-07-10",
        assuranceMethod: "examination",
        scope: "assets-and-liabilities",
        liabilityReconciliation: "full",
        reviewer: "test",
        confidence: "verified",
        sources: [{ label: "Report", url: "https://example.com/reports/june" }],
      },
    };
    const parsed = parseStablecoinMetaAssets(
      [
        makeStablecoinAsset({
          reserves: [
            {
              name: "Treasury bills",
              pct: 100,
              risk: "very-low",
              assetClass: "treasury-bill",
              issuerOrObligor: "United States Treasury",
              riskFactors: ["duration", "custody"],
              liquidityHorizon: "one-day",
              maturityDaysMax: 90,
            },
          ],
          proofOfReserves,
        }),
      ],
      "reserve-evidence.json",
    );
    expect(parsed[0]?.reserves?.[0]?.assetClass).toBe("treasury-bill");
    expect(parsed[0]?.proofOfReserves?.latestReport?.publishedAt).toBe("2026-07-10");

    expect(() =>
      parseStablecoinMetaAssets(
        [
          makeStablecoinAsset({
            proofOfReserves: {
              ...proofOfReserves,
              latestReport: {
                ...proofOfReserves.latestReport,
                publishedAt: "2026-06-29",
              },
            },
          }),
        ],
        "future-period-report.json",
      ),
    ).toThrowError(/publishedAt cannot precede periodEnd/);
  });

  it("preserves uncertain report dates without fabricating period or publication dates", () => {
    const report = {
      reviewReference: { date: "2026-05-31", reviewedAt: "2026-06-18", dateKind: "unspecified" },
      assuranceMethod: "unknown",
      scope: "unknown",
      liabilityReconciliation: "unknown",
      reviewer: "test",
      confidence: "unknown",
      sources: [{ label: "Reserve disclosure", url: "https://example.com/reserves" }],
    };
    const proofOfReserves = { type: "attestation", url: "https://example.com/reserves", latestReport: report };
    const parsed = parseStablecoinMetaAssets(
      [makeStablecoinAsset({ proofOfReserves })],
      "uncertain-report.json",
    )[0]!.proofOfReserves!.latestReport!;
    expect(parsed.reviewReference).toEqual(report.reviewReference);
    expect(parsed.periodEnd).toBeUndefined();
    expect(parsed.publishedAt).toBeUndefined();
    for (const latestReport of [
      { ...report, reviewReference: undefined },
      { ...report, sources: [] },
    ]) {
      expect(() => parseStablecoinMetaAssets(
        [makeStablecoinAsset({ proofOfReserves: { ...proofOfReserves, latestReport } })],
        "unsupported-report.json",
      )).toThrow();
    }
    for (const dates of [{ periodEnd: "2026-05-31" }, { publishedAt: "2026-06-18" }]) {
      const latestReport = { ...report, reviewReference: undefined, ...dates };
      const singleDate = parseStablecoinMetaAssets(
        [makeStablecoinAsset({ proofOfReserves: { ...proofOfReserves, latestReport } })],
        "single-date-report.json",
      )[0]!.proofOfReserves!.latestReport!;
      expect(singleDate.periodEnd).toBe("periodEnd" in dates ? dates.periodEnd : undefined);
      expect(singleDate.publishedAt).toBe("publishedAt" in dates ? dates.publishedAt : undefined);
    }
  });

  it("validates reviewed custody concentration without deriving custodyModel", () => {
    const custodyProfile = {
      providers: [
        { name: "Bank A", role: "bank" as const, sharePct: 60, jurisdiction: "US" },
        { name: "Bank B", role: "bank" as const, sharePct: 30, jurisdiction: "US" },
      ],
      segregation: "segregated" as const,
      bankruptcyRemoteness: "contractual-only" as const,
      rehypothecation: "prohibited" as const,
      reviewedAt: "2026-07-12",
      reviewer: "test",
      confidence: "verified" as const,
      sources: [{ label: "Custody disclosure", url: "https://example.com/custody" }],
      uncertainty: "Ten percent of cash placement is not allocated by provider.",
      knownUnknownExposurePct: 10,
    };
    expect(
      parseStablecoinMetaAssets([makeStablecoinAsset({ custodyProfile })], "custody-profile.json")[0]?.custodyProfile,
    ).toEqual(custodyProfile);
    expect(() =>
      parseStablecoinMetaAssets(
        [
          makeStablecoinAsset({
            custodyProfile: {
              ...custodyProfile,
              providers: custodyProfile.providers.map((provider) => ({ ...provider, sharePct: 60 })),
            },
          }),
        ],
        "overweight-custody.json",
      ),
    ).toThrowError(/shares cannot exceed 100%/);
  });

  it("enforces reserve percentages as finite positive percentages", () => {
    for (const pct of [0, -1, 100.1, Infinity]) {
      expect(() =>
        parseStablecoinMetaAssets(
          [
            makeStablecoinAsset({
              reserves: [{ name: "Cash", pct, risk: "low" }],
            }),
          ],
          `reserve-${pct}.json`,
        ),
      ).toThrowError(/pct/);
    }
  });

  it("enforces commodity ounces as finite positive values", () => {
    for (const commodityOunces of [0, -1, Infinity]) {
      expect(() =>
        parseStablecoinMetaAssets([makeStablecoinAsset({ commodityOunces })], `commodity-${commodityOunces}.json`),
      ).toThrowError(/commodityOunces/);
    }
  });

  it("validates detailProvider through the canonical metadata enum schema", () => {
    for (const detailProvider of DETAIL_PROVIDER_VALUES) {
      expect(
        parseStablecoinMetaAssets(
          [makeStablecoinAsset({ detailProvider })],
          `detail-provider-${detailProvider}.json`,
        )[0]?.detailProvider,
      ).toBe(detailProvider);
    }

    expect(() =>
      parseStablecoinMetaAssets(
        [makeStablecoinAsset({ detailProvider: "coinmarketcap" })],
        "detail-provider-broken.json",
      ),
    ).toThrowError(/detailProvider/);
  });

  it("reports duplicate IDs and canonical-order drift through the shared invariant helper", () => {
    expect(
      findStablecoinCatalogInvariantIssues({
        canonicalOrder: ["alpha-usd", "alpha-usd", "ghost-usd"],
        stablecoins: [{ id: "alpha-usd" }, { id: "alpha-usd" }, { id: "beta-usd" }],
      }),
    ).toEqual({
      duplicateStablecoinIds: ["alpha-usd"],
      duplicateCanonicalOrderIds: ["alpha-usd"],
      missingCanonicalOrderIds: ["beta-usd"],
      unknownCanonicalOrderIds: ["ghost-usd"],
    });
  });

  it("rejects malformed dead assets against a valid baseline with readable errors", () => {
    const asset = {
      id: "broken-dead-coin",
      name: "Broken Dead Coin",
      symbol: "DEAD",
      pegCurrency: "USD",
      causeOfDeath: "algorithmic-failure",
      deathDate: "2025-01-01",
      recordedAt: "2026-02-11",
      obituary: "Broken",
      sourceUrl: "https://example.com",
      sourceLabel: "Example",
    };
    expect(parseDeadStablecoinAssets([asset], "valid-dead.json")[0]?.id).toBe("broken-dead-coin");
    expect(() => parseDeadStablecoinAssets(
      [{ ...asset, obituary: undefined }], "dead-broken.json",
    )).toThrowError(/dead-broken\.json/);
    expect(() => parseDeadStablecoinAssets(
      [{ ...asset, id: "Broken Dead Coin" }], "dead-id-broken.json",
    )).toThrowError(/id/);
    expect(() => parseDeadStablecoinAssets(
      [{ ...asset, recordedAt: undefined }], "dead-recorded-missing.json",
    )).toThrowError(/dead-recorded-missing\.json: 0\.recordedAt/);
    expect(() => parseDeadStablecoinAssets(
      [{ ...asset, recordedAt: "2026-02-30" }], "dead-recorded-invalid.json",
    )).toThrowError(/dead-recorded-invalid\.json: 0\.recordedAt: Expected YYYY-MM-DD/);
  });

  it("gives business-day NAV oracles enough freshness headroom for weekends", () => {
    const maxAgeSec = 4 * 24 * 60 * 60;
    const businessDayNavIds = ["ousg-ondo-finance"];

    const underConfigured = businessDayNavIds.flatMap((id) => {
      const params = TRACKED_META_BY_ID.get(id)?.liveReservesConfig?.params;
      const maxOracleAgeSec =
        typeof params === "object" && params !== null && !Array.isArray(params)
          ? (params as { maxOracleAgeSec?: unknown }).maxOracleAgeSec
          : undefined;

      return typeof maxOracleAgeSec === "number" && maxOracleAgeSec >= maxAgeSec
        ? []
        : [`${id}:${maxOracleAgeSec ?? "missing"}`];
    });

    expect(underConfigured).toEqual([]);
  });
});

describe("suspended live reserve feeds", () => {
  it("strips a suspended liveReservesConfig at registry load and keeps others intact", async () => {
    const { withoutSuspendedLiveReserves } = await import("@shared/lib/stablecoins/registry");
    const base = {
      id: "test-coin",
      liveReservesConfig: {
        adapter: "m0",
        version: 1,
        semantics: "protocol-reserve",
        inputs: { primary: { kind: "http-json", url: "https://example.com/graphql" } },
      },
    } as unknown as Parameters<typeof withoutSuspendedLiveReserves>[0];

    expect(withoutSuspendedLiveReserves(base)).toBe(base);

    const suspended = {
      ...base,
      liveReservesConfig: {
        ...base.liveReservesConfig,
        suspended: { reason: "upstream keyed access", since: "2026-08-19" },
      },
    } as unknown as Parameters<typeof withoutSuspendedLiveReserves>[0];
    const stripped = withoutSuspendedLiveReserves(suspended);
    expect(stripped.liveReservesConfig).toBeUndefined();
    expect(stripped.id).toBe("test-coin");
  });
});
