import { describe, expect, it } from "vitest";
import brlvMetaSource from "@shared/data/stablecoins/coins/brlv-crown.json";
import xsgdMetaSource from "@shared/data/stablecoins/coins/xsgd-straitsx.json";
import brlvReserveSource from "@shared/data/stablecoins/domains/reserves/brlv-crown.json";
import xsgdReserveSource from "@shared/data/stablecoins/domains/reserves/xsgd-straitsx.json";
import type { ReserveSlice } from "@shared/types/reserves";
import {
  buildSafetyScoreV9ReviewedCuratedFallbackReserveRows,
  buildSafetyScoreV9ReviewedStandaloneReserveRows,
  buildSafetyScoreV9ReviewedStaticReserveRows,
  resolveSafetyScoreV9AssetIssuerKey,
  type V9ExtensionRegistryMeta,
} from "../safety-score-v9-extension";
import { deriveSafetyScoreV9PegScore } from "../safety-score-v9-fact-set";
import { resolveV9MintControlGroupSeverity } from "@shared/lib/safety-score-v9/evaluate-set";

const CLOCK_SEC = Date.UTC(2026, 6, 17) / 1_000;
const CURATION_CLOCK_SEC = Date.UTC(2026, 7, 9, 12) / 1_000;
const WINDOW_SEC = Math.ceil(3 * 365.25 * 86_400);
const LIVE_RESERVES_CONFIG: NonNullable<V9ExtensionRegistryMeta["liveReservesConfig"]> = {
  adapter: "curated-validated",
  version: 1,
  semantics: "collateral-mix",
  inputs: { primary: { kind: "onchain-solana" } },
};

function mintMeta(id: string, overrides: Partial<V9ExtensionRegistryMeta> = {}): V9ExtensionRegistryMeta {
  return {
    id,
    mintAuthority: {
      mintPath: "centralized",
      authorityPosture: "issuer-controlled",
      confidence: "verified",
      summary: "Fixture mint profile",
      review: {
        evidence: "Fixture evidence",
        reviewer: "fixture",
        reviewedAt: "2026-07-16",
      },
      supervision: "prudential",
    },
    ...overrides,
  } as V9ExtensionRegistryMeta;
}

function eligibleReserveMeta(overrides: Partial<V9ExtensionRegistryMeta> = {}): V9ExtensionRegistryMeta {
  const rows: ReserveSlice[] = [
    {
      name: "Treasury repo",
      pct: 90,
      risk: "very-low",
      assetClass: "repo",
      issuerOrObligor: "Regulated counterparties",
      riskFactors: ["counterparty", "custody"],
      liquidityHorizon: "one-day",
      maturityDaysMax: 1,
    },
    {
      name: "Cash",
      pct: 10,
      risk: "very-low",
      assetClass: "bank-deposit",
      issuerOrObligor: "Commercial banks",
      riskFactors: ["counterparty", "custody"],
      liquidityHorizon: "immediate",
    },
  ];
  return mintMeta("pyusd-paypal", {
    reserves: rows,
    reserveReview: {
      reviewedAt: "2026-07-16",
      reviewer: "fixture",
      confidence: "verified",
      sources: [{ label: "Composition", url: "https://example.com/composition" }],
      rationale: "Complete fixture composition",
      compositionBasis: "Signed report",
      compositionAsOf: "2026-06-30",
      scope: "full-composition",
      knownUnknownExposure: "None",
      knownUnknownExposurePct: 0,
    },
    proofOfReserves: {
      type: "independent-audit",
      url: "https://example.com/transparency",
      provider: "Independent LLP",
      attestorTier: "regional",
      cadence: "monthly",
      latestReport: {
        periodEnd: "2026-06-30",
        publishedAt: "2026-07-10",
        assuranceMethod: "examination",
        scope: "assets-and-liabilities",
        liabilityReconciliation: "full",
        reviewer: "fixture",
        confidence: "verified",
        sources: [{ label: "Signed report", url: "https://example.com/report.pdf" }],
      },
    },
    ...overrides,
  });
}

function usdgReserveRows(): ReserveSlice[] {
  return [
    {
      name: "BNY Dreyfus Government Cash Management Institutional Shares",
      pct: 53.21,
      risk: "low",
      assetClass: "money-market-fund",
      issuerOrObligor: "BNY Dreyfus Government Cash Management",
      riskFactors: ["counterparty", "duration", "liquidity", "custody"],
      liquidityHorizon: "one-day",
    },
    {
      name: "BNY Mellon U.S. Treasury Fund Advantage Shares",
      pct: 0.09,
      risk: "low",
      assetClass: "money-market-fund",
      issuerOrObligor: "BNY Mellon Liquidity Funds plc",
      riskFactors: ["counterparty", "duration", "liquidity", "custody"],
      liquidityHorizon: "one-day",
    },
    {
      name: "BlackRock ICS U.S. Treasury Fund Banking Circle Dis USD",
      pct: 0.08,
      risk: "low",
      assetClass: "money-market-fund",
      issuerOrObligor: "Institutional Cash Series plc",
      riskFactors: ["counterparty", "duration", "liquidity", "custody"],
      liquidityHorizon: "one-day",
    },
    {
      name: "U.S. Treasury bills",
      pct: 41.8,
      risk: "very-low",
      assetClass: "treasury-bill",
      issuerOrObligor: "United States Treasury",
      riskFactors: ["duration", "liquidity", "custody"],
      liquidityHorizon: "one-day",
      maturityDaysMax: 48,
    },
    {
      name: "Cash in demand deposit accounts",
      pct: 4.83,
      risk: "very-low",
      assetClass: "bank-deposit",
      issuerOrObligor: "Undisclosed commercial banks",
      riskFactors: ["counterparty", "custody", "concentration"],
      liquidityHorizon: "immediate",
    },
  ];
}

describe("Phase 1 D2 issuer identity adapter", () => {
  it("matches the accepted V8 matrix normalization, inheritance, and slug fallback", () => {
    const byId = new Map<string, V9ExtensionRegistryMeta>([
      [
        "usdp-paxos",
        mintMeta("usdp-paxos", {
          genius: {
            issuerEntity: "Paxos Trust Company, N.A.",
          } as V9ExtensionRegistryMeta["genius"],
        }),
      ],
      ["pyusd-paypal", mintMeta("pyusd-paypal", { variantOf: "usdp-paxos" })],
      ["wrapper-family-slug", mintMeta("wrapper-family-slug")],
    ]);

    expect(resolveSafetyScoreV9AssetIssuerKey("usdp-paxos", byId)).toBe("paxos");
    expect(resolveSafetyScoreV9AssetIssuerKey("pyusd-paypal", byId)).toBe("paxos");
    expect(resolveSafetyScoreV9AssetIssuerKey("wrapper-family-slug", byId)).toBe("family-slug");
  });

  it("fails closed on missing records, cycles, and inheritance deeper than five hops", () => {
    const byId = new Map<string, V9ExtensionRegistryMeta>([
      ["a-one", mintMeta("a-one", { variantOf: "b-two" })],
      ["b-two", mintMeta("b-two", { variantOf: "a-one" })],
      ["d0-zero", mintMeta("d0-zero", { variantOf: "d1-one" })],
      ["d1-one", mintMeta("d1-one", { variantOf: "d2-two" })],
      ["d2-two", mintMeta("d2-two", { variantOf: "d3-three" })],
      ["d3-three", mintMeta("d3-three", { variantOf: "d4-four" })],
      ["d4-four", mintMeta("d4-four", { variantOf: "d5-five" })],
      ["d5-five", mintMeta("d5-five")],
    ]);

    expect(resolveSafetyScoreV9AssetIssuerKey("missing-asset", byId)).toBeNull();
    expect(resolveSafetyScoreV9AssetIssuerKey("a-one", byId)).toBeNull();
    expect(resolveSafetyScoreV9AssetIssuerKey("d0-zero", byId)).toBeNull();
  });
});

describe("Phase 1 D2 curated issuer-identity alias (MakerDAO / Sky)", () => {
  // Sky is the rebranded MakerDAO, governed by the same PauseProxy. DAI declares
  // "MakerDAO / Sky Protocol governance"; USDS/sUSDS declare "Sky Protocol
  // governance". Without the curated alias these normalize to different keys
  // ("makerdao" vs "sky"), so the PauseProxy same-issuer group fails closed.
  const skyById = new Map<string, V9ExtensionRegistryMeta>([
    ["dai-makerdao", mintMeta("dai-makerdao", {
      genius: { issuerEntity: "MakerDAO / Sky Protocol governance" } as V9ExtensionRegistryMeta["genius"],
    })],
    ["usds-sky", mintMeta("usds-sky", {
      genius: { issuerEntity: "Sky Protocol governance" } as V9ExtensionRegistryMeta["genius"],
    })],
    // No genius entity: the issuer key resolves by walking variantOf to usds-sky.
    ["susds-sky", mintMeta("susds-sky", { variantOf: "usds-sky" })],
  ]);

  it("canonicalizes DAI, USDS, and sUSDS to a single issuer key", () => {
    const dai = resolveSafetyScoreV9AssetIssuerKey("dai-makerdao", skyById);
    const usds = resolveSafetyScoreV9AssetIssuerKey("usds-sky", skyById);
    const susds = resolveSafetyScoreV9AssetIssuerKey("susds-sky", skyById);
    expect(dai).toBe("makerdao");
    expect(usds).toBe("makerdao");
    expect(susds).toBe("makerdao");
    expect(new Set([dai, usds, susds]).size).toBe(1);
  });

  it("grades the shared PauseProxy mint-control group as diagnostic (low)", () => {
    const members = ["dai-makerdao", "usds-sky", "susds-sky"].map((assetId) => ({
      assetId,
      pathKey: "mint-control:ethereum:0xbe8e3e3618f7474f8cb1d074a26affef007e98fb",
      assetIssuerKey: resolveSafetyScoreV9AssetIssuerKey(assetId, skyById),
    }));
    expect(
      resolveV9MintControlGroupSeverity({
        controllerIssuerKey: members[0]!.assetIssuerKey,
        members,
      }),
    ).toBe("low");
  });

  it("does NOT merge an unrelated issuer that only shares a leading token", () => {
    // "Sky Mavis" (Ronin/Axie) normalizes to first token "sky" but its full
    // phrase is not the aliased "sky protocol governance"; exact-phrase matching
    // keeps it distinct from the MakerDAO / Sky identity.
    const byId = new Map<string, V9ExtensionRegistryMeta>([
      ["skygold-mavis", mintMeta("skygold-mavis", {
        genius: { issuerEntity: "Sky Mavis" } as V9ExtensionRegistryMeta["genius"],
      })],
      ["usds-sky", mintMeta("usds-sky", {
        genius: { issuerEntity: "Sky Protocol governance" } as V9ExtensionRegistryMeta["genius"],
      })],
    ]);
    const unrelated = resolveSafetyScoreV9AssetIssuerKey("skygold-mavis", byId);
    expect(unrelated).toBe("sky");
    expect(unrelated).not.toBe(resolveSafetyScoreV9AssetIssuerKey("usds-sky", byId));

    // A cross-issuer group therefore stays fail-closed (high).
    expect(
      resolveV9MintControlGroupSeverity({
        controllerIssuerKey: "makerdao",
        members: [
          { assetId: "usds-sky", pathKey: "mint-control:x", assetIssuerKey: "makerdao" },
          { assetId: "skygold-mavis", pathKey: "mint-control:x", assetIssuerKey: unrelated },
        ],
      }),
    ).toBe("high");
  });
});

describe("Phase 1 R5 V9-only peg adapter", () => {
  it.each([
    ["no event", null, false, 91, 97],
    ["older than cutoff", CLOCK_SEC - WINDOW_SEC - 1, false, 91, 97],
    ["at cutoff", CLOCK_SEC - WINDOW_SEC, false, 91, 91],
    ["recent", CLOCK_SEC - 1, false, 91, 91],
    ["active depeg", null, true, 91, 91],
    ["already at floor", null, false, 97, 97],
  ] as const)("applies the 36-month matrix proxy for %s", (_label, lastEventAt, activeDepeg, pegScore, expected) => {
    expect(deriveSafetyScoreV9PegScore({ pegScore, activeDepeg, lastEventAt }, CLOCK_SEC)).toBe(expected);
  });

  it("preserves absent peg scores", () => {
    expect(
      deriveSafetyScoreV9PegScore({ pegScore: null, activeDepeg: false, lastEventAt: null }, CLOCK_SEC),
    ).toBeNull();
  });
});

describe("Phase 1 D6 issuer-attested reserve admission", () => {
  it("admits a signed independent report for a prudential issuer at the owner-ratify 0.8 confidence", () => {
    const admitted = buildSafetyScoreV9ReviewedStaticReserveRows(eligibleReserveMeta(), CLOCK_SEC);
    expect(admitted).toMatchObject({ evidenceClass: "issuer-attested" });
    expect(admitted?.rows).toHaveLength(2);
  });

  it("retains full confidence when the verified examination directly reconciles the reviewed composition", () => {
    const base = eligibleReserveMeta();
    const reportSource = base.proofOfReserves!.latestReport!.sources[0]!;
    const admitted = buildSafetyScoreV9ReviewedStaticReserveRows(
      eligibleReserveMeta({
        reserveReview: {
          ...base.reserveReview!,
          sources: [reportSource],
        },
      }),
      CLOCK_SEC,
    );

    expect(admitted).toMatchObject({ evidenceClass: "independent" });
  });

  it("keeps partial, probable, attestation, and separately sourced reviews at issuer-attested confidence", () => {
    const base = eligibleReserveMeta();
    const reportSource = base.proofOfReserves!.latestReport!.sources[0]!;
    const directlySourced = {
      ...base.reserveReview!,
      sources: [reportSource],
    };
    const cases = [
      eligibleReserveMeta({
        reserveReview: directlySourced,
        proofOfReserves: {
          ...base.proofOfReserves!,
          latestReport: {
            ...base.proofOfReserves!.latestReport!,
            liabilityReconciliation: "partial",
          },
        },
      }),
      eligibleReserveMeta({
        reserveReview: {
          ...directlySourced,
          confidence: "probable",
        },
      }),
      eligibleReserveMeta({
        reserveReview: directlySourced,
        proofOfReserves: {
          ...base.proofOfReserves!,
          latestReport: {
            ...base.proofOfReserves!.latestReport!,
            assuranceMethod: "attestation",
          },
        },
      }),
      eligibleReserveMeta({
        reserveReview: {
          ...directlySourced,
          sources: [{ label: "Transparency index", url: base.proofOfReserves!.url }],
        },
        proofOfReserves: {
          ...base.proofOfReserves!,
          latestReport: {
            ...base.proofOfReserves!.latestReport!,
            sources: [{ label: "Transparency index", url: base.proofOfReserves!.url }],
          },
        },
      }),
      eligibleReserveMeta(),
    ];

    for (const meta of cases) {
      expect(buildSafetyScoreV9ReviewedStaticReserveRows(meta, CLOCK_SEC)).toMatchObject({
        evidenceClass: "issuer-attested",
      });
    }
  });

  it("normalizes the real USDG-shaped 100.01% rounded composition before fact compilation", () => {
    const admitted = buildSafetyScoreV9ReviewedStaticReserveRows(
      eligibleReserveMeta({ id: "usdg-paxos", reserves: usdgReserveRows() }),
      CLOCK_SEC,
    );

    expect(usdgReserveRows().reduce((sum, row) => sum + row.pct, 0)).toBeCloseTo(100.01, 8);
    expect(admitted).not.toBeNull();
    expect(admitted!.rows.reduce((sum, row) => sum + row.pct, 0)).toBeCloseTo(100, 12);
    expect(admitted!.rows.reduce((sum, row) => sum + row.pct / 100, 0)).toBeLessThanOrEqual(1.000001);
  });

  it("fails closed for non-prudential, self-attested, onchain-only, or unsourced reports", () => {
    const base = eligibleReserveMeta();
    const nonPrudential = eligibleReserveMeta({
      mintAuthority: { ...base.mintAuthority!, supervision: "attestation-only" },
    });
    const selfAttested = eligibleReserveMeta({
      proofOfReserves: { ...base.proofOfReserves!, attestorTier: "self" },
    });
    const onchainOnly = eligibleReserveMeta({
      proofOfReserves: {
        ...base.proofOfReserves!,
        latestReport: { ...base.proofOfReserves!.latestReport!, assuranceMethod: "onchain-proof" },
      },
    });
    const unsourced = eligibleReserveMeta({
      proofOfReserves: {
        ...base.proofOfReserves!,
        latestReport: { ...base.proofOfReserves!.latestReport!, sources: [] },
      },
    });

    expect(buildSafetyScoreV9ReviewedStaticReserveRows(nonPrudential, CLOCK_SEC)).toBeNull();
    expect(buildSafetyScoreV9ReviewedStaticReserveRows(selfAttested, CLOCK_SEC)).toBeNull();
    expect(buildSafetyScoreV9ReviewedStaticReserveRows(onchainOnly, CLOCK_SEC)).toBeNull();
    expect(buildSafetyScoreV9ReviewedStaticReserveRows(unsourced, CLOCK_SEC)).toBeNull();
  });

  it("keeps a USDai-shaped issuer excluded even if curated rows later appear", () => {
    const eligible = eligibleReserveMeta();
    const usdai = eligibleReserveMeta({
      id: "usdai-usd-ai",
      mintAuthority: { ...eligible.mintAuthority!, supervision: "none", reconciliation: "unknown" },
      proofOfReserves: undefined,
    });

    expect(buildSafetyScoreV9ReviewedStaticReserveRows(usdai, CLOCK_SEC)).toBeNull();
  });

  it("fails closed when rows are not bound to the signed period or report dates are invalid", () => {
    const base = eligibleReserveMeta();
    const mismatchedPeriod = eligibleReserveMeta({
      reserveReview: { ...base.reserveReview!, compositionAsOf: "2026-06-29" },
    });
    const futurePeriod = eligibleReserveMeta({
      reserveReview: { ...base.reserveReview!, compositionAsOf: "2027-06-30" },
      proofOfReserves: {
        ...base.proofOfReserves!,
        latestReport: {
          ...base.proofOfReserves!.latestReport!,
          periodEnd: "2027-06-30",
          publishedAt: "2027-07-10",
        },
      },
    });
    const staleReport = eligibleReserveMeta({
      reserveReview: { ...base.reserveReview!, compositionAsOf: "2024-06-30" },
      proofOfReserves: {
        ...base.proofOfReserves!,
        latestReport: {
          ...base.proofOfReserves!.latestReport!,
          periodEnd: "2024-06-30",
          publishedAt: "2026-07-10",
        },
      },
    });

    expect(buildSafetyScoreV9ReviewedStaticReserveRows(mismatchedPeriod, CLOCK_SEC)).toBeNull();
    expect(buildSafetyScoreV9ReviewedStaticReserveRows(futurePeriod, CLOCK_SEC)).toBeNull();
    expect(buildSafetyScoreV9ReviewedStaticReserveRows(staleReport, CLOCK_SEC)).toBeNull();
  });

  it("admits the curated XSGD composition through the independent-static path", () => {
    const xsgdMeta = {
      ...xsgdMetaSource,
      reserves: xsgdReserveSource.reserves,
      reserveReview: xsgdReserveSource.reserveReview,
    } as unknown as V9ExtensionRegistryMeta;

    expect(xsgdMeta.mintAuthority).toMatchObject({
      reconciliation: "periodic",
      supervision: "prudential",
    });
    expect(xsgdMeta.proofOfReserves?.cadence).toBe("semi-monthly");
    expect(xsgdMeta.reserves?.[1]).toMatchObject({
      assetClass: "other",
      liquidityHorizon: "unknown",
    });
    expect(buildSafetyScoreV9ReviewedStaticReserveRows(xsgdMeta, CURATION_CLOCK_SEC)).toMatchObject({
      evidenceClass: "independent",
      provenance: "curated",
      rows: xsgdReserveSource.reserves,
    });
  });

  it("keeps BRLV excluded while issuer supervision remains attestation-only", () => {
    const brlvMeta = {
      ...brlvMetaSource,
      reserves: brlvReserveSource.reserves,
      reserveReview: brlvReserveSource.reserveReview,
    } as unknown as V9ExtensionRegistryMeta;

    expect(brlvMeta.mintAuthority?.supervision).toBe("attestation-only");
    expect(buildSafetyScoreV9ReviewedStaticReserveRows(brlvMeta, CURATION_CLOCK_SEC)).toBeNull();
  });
});

describe("Phase 1 D6 reviewed curated fallback admission", () => {
  it("admits a current verified full composition at static-validated confidence", () => {
    const admitted = buildSafetyScoreV9ReviewedCuratedFallbackReserveRows(
      eligibleReserveMeta({ proofOfReserves: undefined, liveReservesConfig: LIVE_RESERVES_CONFIG }),
      CLOCK_SEC,
    );

    expect(admitted).toMatchObject({
      evidenceClass: "static-validated",
      provenance: "curated-fallback",
    });
    expect(admitted?.rows).toHaveLength(2);
  });

  it("fails closed for stale, probable, partial, unsourced, or incomplete compositions", () => {
    const base = eligibleReserveMeta({
      proofOfReserves: undefined,
      liveReservesConfig: LIVE_RESERVES_CONFIG,
    });
    const cases = [
      eligibleReserveMeta({
        proofOfReserves: undefined,
        liveReservesConfig: LIVE_RESERVES_CONFIG,
        reserveReview: { ...base.reserveReview!, compositionAsOf: "2026-06-15" },
      }),
      eligibleReserveMeta({
        proofOfReserves: undefined,
        liveReservesConfig: LIVE_RESERVES_CONFIG,
        reserveReview: { ...base.reserveReview!, confidence: "probable" },
      }),
      eligibleReserveMeta({
        proofOfReserves: undefined,
        liveReservesConfig: LIVE_RESERVES_CONFIG,
        reserveReview: { ...base.reserveReview!, scope: "selected-slices" },
      }),
      eligibleReserveMeta({
        proofOfReserves: undefined,
        liveReservesConfig: LIVE_RESERVES_CONFIG,
        reserveReview: { ...base.reserveReview!, sources: [] },
      }),
      eligibleReserveMeta({
        proofOfReserves: undefined,
        liveReservesConfig: LIVE_RESERVES_CONFIG,
        reserves: [{ ...base.reserves![0]!, pct: 50 }],
      }),
    ];

    for (const meta of cases) {
      expect(buildSafetyScoreV9ReviewedCuratedFallbackReserveRows(meta, CLOCK_SEC)).toBeNull();
    }
  });

  it("requires a configured producer for fallback provenance", () => {
    expect(
      buildSafetyScoreV9ReviewedCuratedFallbackReserveRows(
        eligibleReserveMeta({ proofOfReserves: undefined }),
        CLOCK_SEC,
      ),
    ).toBeNull();
  });
});

describe("Phase 1 D6 reviewed standalone reserve admission", () => {
  it("admits a current verified full composition at static-validated confidence", () => {
    const admitted = buildSafetyScoreV9ReviewedStandaloneReserveRows(
      eligibleReserveMeta({ proofOfReserves: undefined }),
      CLOCK_SEC,
    );

    expect(admitted).toMatchObject({
      evidenceClass: "static-validated",
      provenance: "curated",
    });
    expect(admitted?.rows).toHaveLength(2);
  });

  it("fails closed for producer-backed assets, wrappers, invalid dates, and incomplete reviews", () => {
    const base = eligibleReserveMeta({ proofOfReserves: undefined });
    const cases = [
      eligibleReserveMeta({
        proofOfReserves: undefined,
        liveReservesConfig: LIVE_RESERVES_CONFIG,
      }),
      eligibleReserveMeta({
        proofOfReserves: undefined,
        variantOf: "usdc-circle",
      }),
      eligibleReserveMeta({
        proofOfReserves: undefined,
        reserveReview: { ...base.reserveReview!, compositionAsOf: "2026-07-18" },
      }),
      eligibleReserveMeta({
        proofOfReserves: undefined,
        reserveReview: { ...base.reserveReview!, compositionAsOf: undefined },
      }),
      eligibleReserveMeta({
        proofOfReserves: undefined,
        reserveReview: { ...base.reserveReview!, reviewedAt: "2026-06-29" },
      }),
      eligibleReserveMeta({
        proofOfReserves: undefined,
        reserveReview: { ...base.reserveReview!, reviewedAt: "2026-07-18" },
      }),
      eligibleReserveMeta({
        proofOfReserves: undefined,
        reserveReview: { ...base.reserveReview!, confidence: "probable" },
      }),
      eligibleReserveMeta({
        proofOfReserves: undefined,
        reserveReview: { ...base.reserveReview!, scope: "selected-slices" },
      }),
      eligibleReserveMeta({
        proofOfReserves: undefined,
        reserveReview: { ...base.reserveReview!, sources: [] },
      }),
      eligibleReserveMeta({
        proofOfReserves: undefined,
        reserves: [{ ...base.reserves![0]!, pct: 50 }],
      }),
    ];

    for (const meta of cases) {
      expect(buildSafetyScoreV9ReviewedStandaloneReserveRows(meta, CLOCK_SEC)).toBeNull();
    }
  });
});
