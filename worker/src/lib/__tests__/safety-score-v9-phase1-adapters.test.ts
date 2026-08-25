import { describe, expect, it } from "vitest";
import brlvMetaSource from "@shared/data/stablecoins/coins/brlv-crown.json";
import xsgdMetaSource from "@shared/data/stablecoins/coins/xsgd-straitsx.json";
import brlvReserveSource from "@shared/data/stablecoins/domains/reserves/brlv-crown.json";
import xsgdReserveSource from "@shared/data/stablecoins/domains/reserves/xsgd-straitsx.json";
import brlvMintAuthoritySource from "@shared/data/stablecoins/domains/mint-authority/brlv-crown.json";
import xsgdMintAuthoritySource from "@shared/data/stablecoins/domains/mint-authority/xsgd-straitsx.json";
import ceurComplianceSource from "@shared/data/stablecoins/domains/compliance/ceur-celo.json";
import chfmComplianceSource from "@shared/data/stablecoins/domains/compliance/chfm-mento.json";
import cusdComplianceSource from "@shared/data/stablecoins/domains/compliance/cusd-celo.json";
import gbpmComplianceSource from "@shared/data/stablecoins/domains/compliance/gbpm-mento.json";
import jpymComplianceSource from "@shared/data/stablecoins/domains/compliance/jpym-mento.json";
import type { ReserveSlice } from "@shared/types/reserves";
import {
  buildSafetyScoreV9ReviewedCuratedFallbackReserveRows,
  buildSafetyScoreV9ReviewedStandaloneReserveRows,
  buildSafetyScoreV9ReviewedAuditedFallbackReserveRows,
  buildSafetyScoreV9ReviewedStaticReserveRows,
  resolveSafetyScoreV9AssetIssuerKey,
  type V9ExtensionRegistryMeta,
} from "../safety-score-v9-extension";
import { deriveSafetyScoreV9PegScore } from "../safety-score-v9-fact-set";
import { hasPublishedReserveReconciliationEvidence } from "../safety-score-v9-extension";
import { resolveV9MintControlGroupSeverity } from "@shared/lib/safety-score-v9/evaluate-set";
import { addReviewedStaticReserveEvidence } from "../safety-score-v9-extension-reserves";
import { ReviewEvidenceBuilder } from "../safety-score-v9-extension-shared";
import {
  LIVE_RESERVES_CONFIG,
  eligibleReserveMeta,
  mintMeta,
} from "./safety-score-v9-reserve-admission.test-support";

const CLOCK_SEC = Date.UTC(2026, 6, 17) / 1_000;
const CURATION_CLOCK_SEC = Date.UTC(2026, 7, 9, 12) / 1_000;
const WINDOW_SEC = Math.ceil(3 * 365.25 * 86_400);

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

  it("resolves the reviewed Mento issuer instead of inferring issuer keys from id suffixes", () => {
    const reviewedMentoAssets = [
      ceurComplianceSource,
      chfmComplianceSource,
      cusdComplianceSource,
      gbpmComplianceSource,
      jpymComplianceSource,
    ];
    const byId = new Map<string, V9ExtensionRegistryMeta>(
      reviewedMentoAssets.map((source) => [
        source.id,
        mintMeta(source.id, {
          genius: source.genius as V9ExtensionRegistryMeta["genius"],
        }),
      ]),
    );
    const issuerKeys = reviewedMentoAssets.map((source) =>
      resolveSafetyScoreV9AssetIssuerKey(source.id, byId),
    );

    expect(issuerKeys).toEqual(["mento", "mento", "mento", "mento", "mento"]);
    expect(resolveSafetyScoreV9AssetIssuerKey("ceur-celo", byId)).not.toBe("celo");
    const members = reviewedMentoAssets.map((source) => ({
      assetId: source.id,
      pathKey: "mint-control:safe:celo:0x58099b74f4acd642da77b4b7966b4138ec5ba458",
      assetIssuerKey: resolveSafetyScoreV9AssetIssuerKey(source.id, byId),
    }));
    expect(
      resolveV9MintControlGroupSeverity({
        controllerIssuerKey: "mento",
        members,
      }),
    ).toBe("low");
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

const POR_BASE = {
  type: "self-reported",
  url: "https://example.invalid/por",
} as const;

describe("Phase 1 D6 issuer-attested reserve admission", () => {
  it("retains issuer publisher and publication dates for an otherwise-admissible expired reserve report", () => {
    const clockSec = Date.UTC(2027, 7, 1) / 1_000;
    const metadata = eligibleReserveMeta();
    const admitted = buildSafetyScoreV9ReviewedStaticReserveRows(metadata, clockSec);
    const evidence = new ReviewEvidenceBuilder(metadata.id, clockSec);

    expect(admitted).toBeNull();
    addReviewedStaticReserveEvidence(metadata, admitted, evidence, clockSec);
    const compiled = evidence.finish();
    const issuerReport = compiled.researchEvidence.find(
      (entry) => entry.publishedAtSec === Date.parse("2026-07-10T00:00:00.000Z") / 1_000,
    );
    expect(issuerReport).toMatchObject({
      observedAtSec: Date.parse("2026-06-30T00:00:00.000Z") / 1_000,
      publishedAtSec: Date.parse("2026-07-10T00:00:00.000Z") / 1_000,
      publishedBy: "issuer",
    });
    expect(compiled.componentEvidence).toContainEqual({
      componentKey: "reserve-composition-history",
      evidenceKeys: expect.arrayContaining([issuerReport!.evidenceKey]),
    });
  });

  it("admits a signed independent report for a prudential issuer at the owner-ratify 0.8 confidence", () => {
    const admitted = buildSafetyScoreV9ReviewedStaticReserveRows(eligibleReserveMeta(), CLOCK_SEC);
    expect(admitted).toMatchObject({ evidenceClass: "issuer-attested" });
    expect(admitted?.rows).toHaveLength(2);
  });

  it("admits an unsupervised issuer's audited composition one rung down, never at independent strength", () => {
    // Tether's shape: an independently attested full composition from an issuer
    // with no prudential supervision. Discarding it entirely reported the asset
    // as having no reserve composition at all, which is a worse claim than the
    // evidence supports; crediting it fully would erase the supervision gap.
    const unsupervised = eligibleReserveMeta({
      mintAuthority: { ...eligibleReserveMeta().mintAuthority!, supervision: "attestation-only" },
    });
    expect(buildSafetyScoreV9ReviewedStaticReserveRows(unsupervised, CLOCK_SEC)).toBeNull();
    const admitted = buildSafetyScoreV9ReviewedAuditedFallbackReserveRows(unsupervised, CLOCK_SEC);
    expect(admitted).toMatchObject({ evidenceClass: "static-validated" });
    expect(admitted?.rows).toHaveLength(2);
  });

  it("keeps direct independent assurance from lifting an unsupervised issuer to independent strength", () => {
    // Direct assurance describes the reserves; supervision describes the
    // issuer. The rung must be pinned before any strength test runs, otherwise
    // a strong attestation silently restores full credit through the fallback.
    const base = eligibleReserveMeta();
    const reportSource = base.proofOfReserves!.latestReport!.sources[0]!;
    const directlyAssuredButUnsupervised = eligibleReserveMeta({
      mintAuthority: { ...base.mintAuthority!, supervision: "attestation-only" },
      reserveReview: { ...base.reserveReview!, sources: [reportSource] },
      proofOfReserves: {
        ...base.proofOfReserves!,
        latestReport: { ...base.proofOfReserves!.latestReport!, assuranceMethod: "examination" },
      },
    });

    const supervised = buildSafetyScoreV9ReviewedStaticReserveRows(
      { ...directlyAssuredButUnsupervised, mintAuthority: base.mintAuthority },
      CLOCK_SEC,
    );
    expect(supervised).toMatchObject({ evidenceClass: "independent" });

    const admitted = buildSafetyScoreV9ReviewedAuditedFallbackReserveRows(directlyAssuredButUnsupervised, CLOCK_SEC);
    expect(admitted).toMatchObject({ evidenceClass: "static-validated" });
  });

  it("refuses the audited fallback for a prudential issuer, which owns the higher rung", () => {
    // The two builders partition on supervision, so a supervised issuer must
    // never reach the lower rung and quietly lose its ceiling.
    expect(buildSafetyScoreV9ReviewedAuditedFallbackReserveRows(eligibleReserveMeta(), CLOCK_SEC)).toBeNull();
  });

  it("keeps the issuer and report dates on audited fallback evidence", () => {
    // This is what makes an expired composition resolve to
    // `published-evidence-expired` rather than `issuer-undisclosed`: emitting
    // it as an anonymous standalone review would drop the publisher and blame
    // the issuer for a document they did publish.
    const metadata = eligibleReserveMeta({
      mintAuthority: { ...eligibleReserveMeta().mintAuthority!, supervision: "attestation-only" },
    });
    const admitted = buildSafetyScoreV9ReviewedAuditedFallbackReserveRows(metadata, CLOCK_SEC);
    expect(admitted).toMatchObject({ evidenceClass: "static-validated", provenance: "audited-fallback" });

    const evidence = new ReviewEvidenceBuilder(metadata.id, CLOCK_SEC);
    addReviewedStaticReserveEvidence(metadata, admitted, evidence, CLOCK_SEC);
    const compiled = evidence.finish();
    const emitted = compiled.researchEvidence.find(
      (entry) => entry.sourceId === "stablecoin-meta.reviewed-audited-fallback-reserves",
    );
    expect(emitted).toMatchObject({
      publishedBy: "issuer",
      observedAtSec: Date.parse("2026-06-30T00:00:00.000Z") / 1_000,
      publishedAtSec: Date.parse("2026-07-10T00:00:00.000Z") / 1_000,
    });
    expect(compiled.componentEvidence).toContainEqual(
      expect.objectContaining({ componentKey: "reviewed-static-reserves" }),
    );
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

  it("fails closed for self-attested, onchain-only, or unsourced reports", () => {
    // Absent supervision is no longer in this list: it selects the rung rather
    // than refusing admission, and is pinned separately above. What still fails
    // closed is the absence of independent attestation itself.
    const base = eligibleReserveMeta();
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

    expect(buildSafetyScoreV9ReviewedStaticReserveRows(selfAttested, CLOCK_SEC)).toBeNull();
    expect(buildSafetyScoreV9ReviewedStaticReserveRows(onchainOnly, CLOCK_SEC)).toBeNull();
    expect(buildSafetyScoreV9ReviewedStaticReserveRows(unsourced, CLOCK_SEC)).toBeNull();
  });

  it("scores `undisclosed` exactly like `none`, so reclassifying a curated tier cannot move a grade", () => {
    // The independence gate is a whitelist (big4/regional/niche), so the
    // display-only split of "no attestor" into `none` (reviewed negative) and
    // `undisclosed` (absence of evidence) is score-neutral by construction.
    const base = eligibleReserveMeta();
    const noneTier = eligibleReserveMeta({
      proofOfReserves: { ...base.proofOfReserves!, attestorTier: "none" },
    });
    const undisclosedTier = eligibleReserveMeta({
      proofOfReserves: { ...base.proofOfReserves!, attestorTier: "undisclosed" },
    });

    expect(buildSafetyScoreV9ReviewedStaticReserveRows(noneTier, CLOCK_SEC)).toBeNull();
    expect(buildSafetyScoreV9ReviewedStaticReserveRows(undisclosedTier, CLOCK_SEC)).toEqual(
      buildSafetyScoreV9ReviewedStaticReserveRows(noneTier, CLOCK_SEC),
    );
  });

  it("does not infer a periodic reconciliation from a `none` or `undisclosed` cadence", () => {
    // Regression: `cadence` was read for truthiness, and both sentinels are
    // non-empty strings, so an issuer publishing no reconciliation at all was
    // inferred to reconcile `periodic`ally. Absence must not flatter.
    expect(hasPublishedReserveReconciliationEvidence({ ...POR_BASE, cadence: "none" })).toBe(false);
    expect(hasPublishedReserveReconciliationEvidence({ ...POR_BASE, cadence: "undisclosed" })).toBe(false);
    expect(hasPublishedReserveReconciliationEvidence({ ...POR_BASE, cadence: undefined })).toBe(false);
    expect(hasPublishedReserveReconciliationEvidence(undefined)).toBe(false);
  });

  it("still infers a periodic reconciliation from a real cadence or a dated report", () => {
    expect(hasPublishedReserveReconciliationEvidence({ ...POR_BASE, cadence: "monthly" })).toBe(true);
    expect(hasPublishedReserveReconciliationEvidence({ ...POR_BASE, cadence: "real-time" })).toBe(true);
    // A dated report stands on its own even when the rhythm is undisclosed.
    expect(
      hasPublishedReserveReconciliationEvidence({
        ...POR_BASE,
        cadence: "none",
        latestReport: {
          periodEnd: "2026-07-31",
          publishedAt: "2026-08-05",
          assuranceMethod: "attestation",
          scope: "assets-and-liabilities",
          liabilityReconciliation: "full",
          reviewer: "fixture",
          confidence: "verified",
          sources: [{ label: "Fixture report", url: "https://example.invalid/report" }],
        },
      }),
    ).toBe(true);
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
      mintAuthority: xsgdMintAuthoritySource.mintAuthority,
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
      mintAuthority: brlvMintAuthoritySource.mintAuthority,
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
        // 46 days before CLOCK_SEC: outside the 31-day composition window and
        // outside the 7-day reporting grace that now follows it.
        reserveReview: { ...base.reserveReview!, compositionAsOf: "2026-06-01" },
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
