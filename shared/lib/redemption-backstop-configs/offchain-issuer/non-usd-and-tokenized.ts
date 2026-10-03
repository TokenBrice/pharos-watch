import type { RedemptionBackstopConfig } from "../shared";
import {
  documentedBoundSupplyFull,
  documentedVariableFee,
  expandIds,
  undisclosedReviewedFee,
  fixedFee,
  issuerBase,
  sourceRef,
  sourceRefFull,
  sourceRefRouteCapacity,
  sourceRefRouteCapacityAccess,
  sourceRefRouteCapacityFees,
} from "../shared";
import {
  reviewedDirectRedemptionSupplyFull,
  reviewedIssuerApiExpansionSupplyFull,
} from "./shared";

/** vchf-vnx and vgbp-vnx share an identical issuer-redemption shape and the
 *  VNX gitbook docs[]. */
const vnxGitbookBase: RedemptionBackstopConfig = {
  ...issuerBase,
  ...reviewedDirectRedemptionSupplyFull,
  costModel: undisclosedReviewedFee(
    "Direct 1:1 redemption through VNX Commodities AG for verified users; public fee schedule not disclosed",
  ),
  docs: [
    sourceRefRouteCapacity("VNX docs", "https://vnx.gitbook.io/vnx-platform/"),
    sourceRef("VNX website", "https://vnx.li/", ["route"]),
  ],
};

/** Historical AllUnity issuer-redemption shape; CHFAU has a separately reviewed fee policy below. */
const allunityBase: RedemptionBackstopConfig = {
  ...issuerBase,
  ...reviewedDirectRedemptionSupplyFull,
  costModel: undisclosedReviewedFee("Direct 1:1 redemption through AllUnity; public fee schedule not disclosed"),
  docs: [
    sourceRefRouteCapacity("AllUnity whitepaper", "https://allunity.com/whitepaper/"),
    sourceRef("AllUnity trust center", "https://allunity.com/trust-center/", ["capacity"]),
  ],
};

export const NON_USD_AND_TOKENIZED_OFFCHAIN_CONFIGS: Record<string, RedemptionBackstopConfig> = {
  "cadc-cad-coin": {
    ...issuerBase,
    ...reviewedDirectRedemptionSupplyFull,
    costModel: fixedFee(
      0,
      "Loon's support centre states no fees from Loon and that standard on-chain gas applies per transaction. This is the issuer fee only; partner-ramp, bank, and network charges are not promised to be zero",
    ),
    docs: [
      sourceRefRouteCapacity("CADC FAQ", "https://faq.paytrie.com/col/cadc-faqs"),
      sourceRef("Loon website", "https://loon.finance/", ["route"]),
      sourceRef("Loon support centre (reviewed 2026-10-03)", "https://loon.finance/support-centre/", ["fees"]),
    ],
  },
  ...expandIds(["vchf-vnx", "vgbp-vnx"], vnxGitbookBase),
  "tryb-bilira": {
    ...issuerBase,
    ...reviewedDirectRedemptionSupplyFull,
    costModel: undisclosedReviewedFee(
      "Direct 1:1 issuance and redemption through BiLira; public fee schedule not disclosed",
    ),
    docs: [sourceRefRouteCapacity("BiLira TRYB page", "https://www.bilira.co/en/product/tryb-stablecoin")],
  },
  "tgbp-tokenised": {
    ...issuerBase,
    ...reviewedDirectRedemptionSupplyFull,
    settlementModel: "days",
    costModel: undisclosedReviewedFee(
      "Direct 1:1 redemption through BCP Technologies Ltd; public fee schedule not disclosed",
    ),
    docs: [
      sourceRef("Tokenised GBP website", "https://www.tokenisedgbp.com/", ["route", "capacity", "settlement"]),
      sourceRef("tGBP audit", "https://www.openzeppelin.com/news/tgbp-audit", ["route"]),
    ],
  },
  "jpyc-jpyc": {
    ...issuerBase,
    ...reviewedDirectRedemptionSupplyFull,
    costModel: fixedFee(
      0,
      "JPYC EX states that registered users redeem 1 JPYC for JPY 1 with no redemption fee; users still pay blockchain gas when sending JPYC",
    ),
    docs: [
      sourceRef("JPYC EX", "https://ex.jpyc.co.jp/", ["route", "fees", "access", "settlement"]),
      sourceRef("JPYC launch announcement", "https://corporate.jpyc.co.jp/news/posts/jpyc-ex-launch", [
        "route",
        "capacity",
        "access",
        "settlement",
      ]),
    ],
  },
  "axcnh-anchorx": {
    ...issuerBase,
    ...reviewedDirectRedemptionSupplyFull,
    costModel: undisclosedReviewedFee(
      "Direct 1:1 AnchorX redemption for CNH; the Terms of Service reserve the right to implement fees and publish no all-in fee bound",
    ),
    reviewedAt: "2026-10-02",
    v9RouteReviewTerms: {
      scoringDisposition: "bounded-terms-gap",
      missingScoringFields: ["capacity", "settlement", "cost"],
      rationale:
        "AnchorX's Terms of Service and disclosure pages were re-opened on 2026-10-02. The terms limit services to Professional Investors, reserve the right to implement fees, and permit access suspension or termination at any time for any reason; no public terms establish executable capacity at the scoring notional, bank-credit settlement timing, or all-in redemption cost.",
      reviewedAt: "2026-10-02",
      docs: [
        sourceRef("AnchorX Terms of Service (undated; reviewed 2026-10-02)", "https://www.anchorx.org/terms", ["route", "access", "fees"]),
        sourceRef("AnchorX transparency disclosure", "https://www.anchorx.org/transparency", ["route"]),
      ],
    },
    docs: [
      sourceRef("AnchorX Terms of Service (undated; reviewed 2026-10-02)", "https://www.anchorx.org/terms", ["route", "access", "fees"]),
      sourceRef("AnchorX transparency disclosure", "https://www.anchorx.org/transparency", ["route"]),
    ],
    notes: [
      "AnchorX Group's public Terms of Service limit platform subscription and redemption services to Professional Investors as defined in Part 1 of Schedule 1 of the Hong Kong SFO; this is not an ordinary-holder access guarantee.",
      "The 1:1 CNH redemption description is not a USD payout promise, scored-notional capacity certificate, settlement SLA, or zero-fee commitment. The public portal requires account login.",
    ],
  },
  "idrt-rupiah-token": {
    ...issuerBase,
    ...reviewedDirectRedemptionSupplyFull,
    costModel: undisclosedReviewedFee(
      "Direct 1:1 issuance and redemption through PT Rupiah Token Indonesia after KYC; public fee schedule not disclosed",
    ),
    docs: [sourceRefRouteCapacity("Rupiah Token website", "https://www.rupiahtoken.com/")],
  },
  "idrx-idrx": {
    ...issuerBase,
    ...reviewedIssuerApiExpansionSupplyFull,
    costModel: documentedVariableFee(
      "IDRX redemption fees are flat IDR charges that depend on redemption size (Rp5,000 up to Rp250,000,000; Rp35,000 above that during office hours), so the effective bps varies by ticket size",
    ),
    docs: [
      sourceRef("IDRX redeem IDR guide", "https://docs.idrx.co/services/redeem-idr", [
        "route",
        "capacity",
        "settlement",
      ]),
      sourceRef(
        "IDRX redeem request API",
        "https://docs.idrx.co/api/transaction-api/post-api-transaction-redeem-request",
        ["route", "access", "settlement"],
      ),
      sourceRef("IDRX fees", "https://docs.idrx.co/services/fees", ["fees", "settlement"]),
    ],
    notes: [
      "Primary modeled route is the issuer's direct burn-to-bank-account redemption flow for IDRX rather than the separate partner-mediated other-stablecoin off-ramp",
      "Docs state redemptions up to Rp250,000,000 process in real time while larger bank payouts are handled during office hours, with a stated outer bound of 24 hours after request submission",
    ],
  },
  "mxnb-juno": {
    ...issuerBase,
    ...reviewedIssuerApiExpansionSupplyFull,
    outputAssetType: "stable-basket",
    outputAssets: ["usdc-circle", "usdt-tether"],
    costModel: undisclosedReviewedFee(
      "Juno documents quote-based MXNB conversions into USDC or USDT with pair-specific min/max limits, but it does not publish a fixed redemption or conversion fee schedule",
    ),
    v9RouteReviewTerms: {
      scoringDisposition: "bounded-terms-gap",
      missingScoringFields: ["capacity", "settlement", "cost"],
      rationale:
        "Juno documents quote-specific MXNB conversion limits, but no dated public terms establish the scored notional's executable limit, settlement SLA, or conversion cost.",
      reviewedAt: "2026-08-24",
      docs: [
        sourceRefRouteCapacityFees(
          "Juno MXNB and USD stablecoin conversions",
          "https://docs.bitso.com/juno/docs/conversions-between-mxnb-and-usd-stablecoins",
        ),
      ],
    },
    docs: [
      sourceRefRouteCapacityFees(
        "Juno MXNB and USD stablecoin conversions",
        "https://docs.bitso.com/juno/docs/conversions-between-mxnb-and-usd-stablecoins",
      ),
      sourceRef("MXNB transparency", "https://mxnb.mx/transparency", ["capacity"]),
    ],
    notes: [
      "Payout identity reviewed 2026-09-30 against Juno's conversion guide (updated 2026-03-14): the modeled MXNB conversion pairs pay USDC or USDT, not a bank-wire payout.",
      "Modeled as the documented Juno issuer conversion rail between MXNB and USDC/USDT rather than as a separate fiat bank-wire redemption flow",
      "The published conversion pairs expose explicit per-quote and per-pair min/max limits, which establish reviewed route availability without separately publishing a deterministic fixed-fee schedule",
    ],
  },
  "europ-schuman": {
    ...issuerBase,
    ...reviewedDirectRedemptionSupplyFull,
    costModel: fixedFee(
      0,
      "EURØP tokens can be redeemed and exchanged for the underlying legal tender currency at any time, as described in the Right to Redemption above, without fees.",
    ),
    docs: [
      sourceRefRouteCapacity("EUROP white paper", "https://schuman.io/wp-content/uploads/2025/02/EUROP-White-Paper_1.3.pdf"),
      sourceRef("EUROP white paper v1.7", "https://schuman.io/wp-content/uploads/EUROP-White-Paper.pdf", ["fees"]),
      sourceRef("Schuman reserve audits", "https://schuman.io/reserve-attestations/", ["capacity"]),
    ],
  },
  "eurau-allunity": {
    ...allunityBase,
    costModel: fixedFee(
      0,
      "AllUnity's ecosystem page states institutions can mint and redeem AllUnity stablecoins at no cost. This is the currently advertised issuer fee only: the governing terms defer issuance and redemption fees to a separate fee schedule, and holders pay third-party blockchain gas",
    ),
    docs: [
      sourceRefRouteCapacity("AllUnity whitepaper", "https://allunity.com/whitepaper/"),
      sourceRef("AllUnity trust center", "https://allunity.com/trust-center/", ["capacity"]),
      sourceRef("AllUnity ecosystem (reviewed 2026-10-03)", "https://allunity.com/ecosystem", ["fees"]),
    ],
  },
  "chfau-allunity": {
    ...allunityBase,
    reviewedAt: "2026-10-02",
    costModel: fixedFee(
      0,
      "AllUnity Redemption Policy section 3.5: the issuer does not charge administrative, processing, or redemption fees; holders pay third-party blockchain gas.",
    ),
    docs: [
      sourceRefRouteCapacity("AllUnity whitepaper", "https://allunity.com/whitepaper/"),
      sourceRef("AllUnity trust center", "https://allunity.com/trust-center/", ["capacity"]),
      sourceRef(
        "AllUnity Redemption Policy, section 3.5",
        "https://framerusercontent.com/assets/keEVPCLx5HJ504alVRJUCVRjBz0.pdf",
        ["fees"],
      ),
    ],
    notes: [
      "AllUnity Redemption Policy section 4.3 aims to complete the process within five business days after documentation is fully received and verified; this is a target, not a guaranteed bank-credit deadline. Retain the platform's reviewed direct-redemption treatment pending a platform-wide owner ruling on settlement aims.",
    ],
  },
  "usda-anzens": {
    ...issuerBase,
    ...reviewedDirectRedemptionSupplyFull,
    settlementModel: "days",
    costModel: undisclosedReviewedFee(
      "Tracked issuer materials describe direct 1:1 USDA redemption into USD through KYC-verified banking rails; public fee schedule not disclosed",
    ),
    docs: [sourceRef("Anzens website", "https://www.anzens.com/", ["route", "capacity", "settlement"])],
    notes: [
      "Tracked metadata describes redemption through bank transfers rather than an instant onchain stablecoin withdrawal rail",
    ],
  },
  "cash-phantom": {
    ...issuerBase,
    ...reviewedDirectRedemptionSupplyFull,
    costModel: {
      ...documentedVariableFee("Swap from Cash account into other stablecoins on Solana (USDT, USDG, PYUSD): 0.85%"),
      feeBpsMax: 85,
    },
    docs: [
      sourceRefRouteCapacity("CASH overview", "https://www.usecash.xyz/"),
      sourceRefRouteCapacityFees("Bridge issuance FAQ", "https://apidocs.bridge.xyz/platform/issuance/faq"),
      sourceRef("Phantom Cash fees", "https://help.phantom.com/hc/en-us/articles/44800531617939-Cash-fees", ["fees"]),
    ],
  },
  "sbc-brale": {
    ...issuerBase,
    ...reviewedDirectRedemptionSupplyFull,
    costModel: documentedVariableFee(
      "Brale pricing lists stablecoin offramp as included with API plans, while wire and ACH payout rails can still carry transfer fees",
    ),
    v9RouteReviewTerms: {
      scoringDisposition: "bounded-terms-gap",
      missingScoringFields: ["capacity", "settlement", "cost"],
      rationale:
        "Brale's Business User Agreement (updated 2026-05-27) permits discretionary redemption delays and account transaction limits, while fees are described inside the account; the 2026-09-04 review found no public scored-notional capacity, settlement SLA, or all-in payout-rail cost.",
      reviewedAt: "2026-09-04",
      docs: [
        sourceRef("Brale business user agreement (updated 2026-05-27)", "https://brale.xyz/legal/business-user-agreement", [
          "route",
          "capacity",
          "access",
          "settlement",
        ]),
        sourceRef("Brale pricing", "https://brale.xyz/pricing", ["fees"]),
      ],
    },
    docs: [
      sourceRefRouteCapacity("SBC stablecoin page", "https://brale.xyz/stablecoins/SBC"),
      sourceRef("Brale pricing", "https://brale.xyz/pricing", ["fees"]),
    ],
  },
  "m-m0": {
    ...issuerBase,
    ...reviewedDirectRedemptionSupplyFull,
    v9ComposedDexExit: {
      intermediateAssetId: "wm-m0",
      conversionModel: "permissionless-atomic-wrap",
      chain: "ethereum",
      wrapperContract: "0x437cc33344a0B27A429f795ff6B469C72698B291",
      reviewedAt: "2026-07-24",
      docs: [
        sourceRef(
          "M0 WrappedMToken source",
          "https://github.com/m0-foundation/wrapped-m-token/blob/main/src/WrappedMToken.sol",
          ["route", "fees", "access", "settlement"],
        ),
        sourceRef("M0 wM FAQ", "https://www.m0.org/faq", ["route", "fees", "access"]),
      ],
    },
    costModel: documentedVariableFee(
      "M0 docs describe $M as fully backed and redeemable 1:1, but direct mint and redemption access is restricted to permissioned minters and no public fee schedule is disclosed",
    ),
    docs: [
      sourceRefRouteCapacityAccess("M0 FAQ", "https://www.m0.org/faq"),
      sourceRef("M0 Dashboard", "https://dashboard.m0.org/", ["capacity"]),
    ],
    notes: [
      "Base $M liquidity is institution-facing; most end users access M0 liquidity through branded extensions and integrations rather than direct M redemption",
    ],
  },
  "fusd-finchain": {
    ...issuerBase,
    ...documentedBoundSupplyFull("2026-05-24"),
    settlementModel: "days",
    costModel: fixedFee(
      50,
      "FinChain's FUSD fees page states a 50 bps (0.5%) redemption fee is charged on each transaction and deducted from the FUSD redeemed. It does not cover bank or network charges and does not resolve the documented USDT payout identity",
    ),
    docs: [
      sourceRefRouteCapacityAccess("FUSD introduction", "https://finchain.gitbook.io/finchain-docs/en/fusd/introduction"),
      sourceRef("FUSD reserves", "https://finchain.gitbook.io/finchain-docs/en/fusd/introduction/fusd-reserves", [
        "capacity",
        "settlement",
      ]),
      sourceRef("FUSD token", "https://finchain.gitbook.io/finchain-docs/en/fusd/fusd-token", ["route"]),
      sourceRef(
        "FUSD fees (reviewed 2026-10-03)",
        "https://finchain.gitbook.io/finchain-docs/en/fusd/fusd-token/fees",
        ["fees"],
      ),
      sourceRef("FUSD website", "https://fusd.finchain.global/", ["fees", "access"]),
    ],
    notes: [
      "Modeled route is the issuer-gated primary mint/redeem rail documented for eligible customers, not secondary-market liquidity.",
      "Because FUSD rebases against tokenized Treasury and money-market fund reserves, Pharos treats settlement as delayed issuer redemption rather than atomic onchain exchange.",
    ],
  },
  "musd-metamask": {
    ...issuerBase,
    ...reviewedDirectRedemptionSupplyFull,
    costModel: undisclosedReviewedFee(
      "MetaMask USD is issued 1:1 by Bridge on top of M0 reserve infrastructure; public redemption fees are not disclosed",
    ),
    docs: [
      sourceRefRouteCapacity("MetaMask USD introduction", "https://musd.to/blog"),
      sourceRefRouteCapacityFees("Bridge issuance FAQ", "https://apidocs.bridge.xyz/platform/issuance/faq"),
      sourceRef("M0 FAQ", "https://www.m0.org/faq", ["capacity", "access"]),
    ],
    notes: [
      "Modeled as MetaMask's documented Bridge issuer rail on top of M0 reserve infrastructure rather than as a continuously measured live cash-buffer route",
    ],
  },
  "mtbill-midas": {
    ...issuerBase,
    ...reviewedDirectRedemptionSupplyFull,
    capacityModel: { kind: "supply-ratio", ratio: 0.02, confidence: "heuristic", basis: "hot-buffer" },
    settlementModel: "days",
    outputAssets: ["usdc-circle"],
    costModel: fixedFee(7, "The July 17, 2026 mTBILL Final Terms specify a 0.07% instant redemption fee"),
    v9RouteReviewTerms: {
      scoringDisposition: "bounded-terms-gap",
      missingScoringFields: ["capacity", "settlement"],
      rationale:
        "The July 17, 2026 Final Terms specify USDC settlement and a 7 bps instant fee, but instant capacity is not guaranteed. Standard redemption has a one-business-day realisation period plus up to five business days under base-prospectus condition 8.3c, subject to a 25% daily gate and market-disruption postponements; no unconditional calendar-day bound or measured executable capacity is established.",
      reviewedAt: "2026-10-02",
      docs: [
        sourceRef("Midas atomic redemption targets and shared liquidity", "https://midas-docs.gitbook.io/midas-docs/defi-integration/atomic-redemption.md", [
          "route",
          "capacity",
          "settlement",
        ]),
        sourceRef("Midas transparency", "https://midas.app/transparency", ["capacity"]),
        sourceRef("mTBILL Final Terms dated July 17, 2026", "https://3475141875-files.gitbook.io/~/files/v0/b/gitbook-x-prod.appspot.com/o/spaces%2FMndxFHqGeA4nzBBeKDTV%2Fuploads%2FUDquVH8yRhSxnVqxp0X4%2F20260714_mTBILL_FT_signed_final.pdf?alt=media&token=bf215cdc-f549-474d-8ca9-5a1810fabeb8", ["route", "access", "fees", "settlement"]),
        sourceRef("Midas 2026 base prospectus conditions 8.3c and 12", "https://3475141875-files.gitbook.io/~/files/v0/b/gitbook-x-prod.appspot.com/o/spaces%2FMndxFHqGeA4nzBBeKDTV%2Fuploads%2FkVT2uAi2AipgeMIyZAJe%2FMidas%20Software%20GmbH%20Base%20Prospectus%202026.pdf?alt=media&token=d80ceabb-07a6-4dc4-9020-70ec86b4f42f", ["access", "capacity", "settlement"]),
      ],
    },
    reviewedAt: "2026-10-02",
    docs: [
      sourceRef("Midas atomic redemption targets and shared liquidity", "https://midas-docs.gitbook.io/midas-docs/defi-integration/atomic-redemption.md", [
        "route",
        "capacity",
        "settlement",
      ]),
      sourceRef("mTBILL Final Terms dated July 17, 2026", "https://3475141875-files.gitbook.io/~/files/v0/b/gitbook-x-prod.appspot.com/o/spaces%2FMndxFHqGeA4nzBBeKDTV%2Fuploads%2FUDquVH8yRhSxnVqxp0X4%2F20260714_mTBILL_FT_signed_final.pdf?alt=media&token=bf215cdc-f549-474d-8ca9-5a1810fabeb8", ["route", "access", "fees", "settlement"]),
      sourceRef("Midas 2026 base prospectus conditions 8.3c and 12", "https://3475141875-files.gitbook.io/~/files/v0/b/gitbook-x-prod.appspot.com/o/spaces%2FMndxFHqGeA4nzBBeKDTV%2Fuploads%2FkVT2uAi2AipgeMIyZAJe%2FMidas%20Software%20GmbH%20Base%20Prospectus%202026.pdf?alt=media&token=d80ceabb-07a6-4dc4-9020-70ec86b4f42f", ["access", "capacity", "settlement"]),
      sourceRef("Midas transparency", "https://midas.app/transparency", ["capacity"]),
    ],
    notes: [
      "Reviewed USDC payout: instant fee 0.07%; standard fee up to 0.05%, one-business-day realisation plus up to five business days, subject to the 25% daily gate and disruption clauses; instant Deferred Price Method may retain up to 5% holdback.",
      "The 2% hot-buffer ratio is a conservative modeling heuristic, not a documented lower bound; current Midas materials publish a dynamic atomic-capacity target rather than a binding floor",
      "Ethereum block 26103199: the instant vault holds 0.000008 USDC but can source USDC by redeeming USTB through its configured external facility. The direct cash balance is not total executable capacity and does not establish a no-liquidity finding.",
    ],
  },
  "usdy-ondo-finance": {
    ...issuerBase,
    ...reviewedDirectRedemptionSupplyFull,
    capacityModel: { kind: "supply-ratio", ratio: 0.05, confidence: "heuristic", basis: "hot-buffer" },
    settlementModel: "days",
    costModel: {
      ...documentedVariableFee(
        "USDY InstantManager's default redemption fee configuration returned 0 bps at Ethereum block 25,825,933; individual user fee overrides may apply",
        "formula",
      ),
      feeBpsMin: 0,
    },
    v9RouteReviewTerms: {
      settlementModel: "atomic",
      settlementDelaySec: 0,
      reviewedAt: "2026-08-24",
      docs: [
        sourceRef(
          "USDY InstantManager verified source",
          "https://eth.blockscout.com/address/0xa42613c243b67bf6194ac327795b926b4b491f15?tab=contract",
          ["route", "settlement"],
        ),
        sourceRef("Ethereum block 25825933", "https://eth.blockscout.com/block/25825933", [
          "route",
          "settlement",
        ]),
      ],
    },
    reviewedAt: "2026-05-17",
    docs: [
      sourceRefRouteCapacity("Ondo USDY", "https://ondo.finance/usdy"),
      sourceRefRouteCapacity("Ondo docs", "https://docs.ondo.finance/"),
      sourceRef(
        "Ondo USDY STEP application",
        "https://forum.arbitrum.foundation/t/ondo-finance-usdy-llc-step-application/23593",
        ["fees"],
      ),
      sourceRef(
        "USDY InstantManager redemption-fee contract",
        "https://eth.blockscout.com/address/0xe1cb24077d77d2fe763fcac63e5653d97dc8d20c?tab=contract",
        ["fees"],
      ),
    ],
    notes: [
      "The 5% hot-buffer ratio is a conservative modeling heuristic, not a documented lower bound; current Ondo materials do not publish a durable bank-demand-deposit allocation or instant-redemption floor.",
    ],
  },
  /** iauon-ondo and slvon-ondo share the Ondo GM shape; they differ only in ticker,
   *  asset page URL, Final Terms document, and the underlying-fund name in the notes. */
  ...Object.fromEntries(
    (
      [
        [
          "iauon-ondo", "IAUon", "iauon", "IAU", "iShares Gold Trust",
          "https://cdn.sanity.io/files/8k2tqa6n/production/f8568100c8d43609c8d83e6d57c7130d590711b0.pdf",
        ],
        [
          "slvon-ondo", "SLVon", "slvon", "SLV", "iShares Silver Trust",
          "https://cdn.sanity.io/files/8k2tqa6n/production/1e83310304939f644ad250b298c14f2a2ac6449c.pdf",
        ],
      ] as const
    ).map(([id, label, slug, underlyingTicker, fundName, finalTermsUrl]) => [
      id,
      {
        ...issuerBase,
        ...documentedBoundSupplyFull("2026-05-24"),
        settlementModel: "days",
        executionModel: "rules-based-nav",
        outputAssetType: "nav",
        costModel: {
          ...documentedVariableFee(
            `${label} Final Terms (2025-11-11) set the maximum issuer redemption fee at up to 0.1% of the ${underlyingTicker} market price, at the issuer's discretion; the live quote and user gas are separate`,
          ),
          feeBpsMax: 10,
        },
        docs: [
          sourceRefRouteCapacity(`${label} asset page`, `https://app.ondo.finance/assets/${slug}`),
          sourceRef("Ondo Global Markets overview", "https://docs.ondo.finance/ondo-global-markets/overview", [
            "route",
            "access",
            "settlement",
          ]),
          sourceRef(
            "Ondo Global Markets important notes",
            "https://docs.ondo.finance/ondo-global-markets/important-notes",
            ["access", "fees", "settlement"],
          ),
          sourceRef(
            "Ondo Global Markets trust and transparency",
            "https://docs.ondo.finance/ondo-global-markets/trust-and-transparency",
            ["capacity"],
          ),
          sourceRef(`${label} Final Terms (dated 2025-11-11; reviewed 2026-10-03)`, finalTermsUrl, ["fees"]),
        ],
        notes: [
          `${label} is modeled as an eligible-investor NAV redemption route to Ondo GM value, not as direct holder ownership or delivery of underlying ${fundName} shares.`,
        ],
      } satisfies RedemptionBackstopConfig,
    ]),
  ),
  "thbill-theo": {
    ...issuerBase,
    ...reviewedDirectRedemptionSupplyFull,
    outputAssetType: "stable-basket",
    outputAssets: ["usdc-circle", "usdt-tether"],
    costModel: documentedVariableFee(
      "KYC-gated mint/redemption processed instantly in USDC; underlying collateral settled within T+4 business days",
    ),
    docs: [
      sourceRef("Theo thBILL payout documentation (reviewed 2026-09-30)", "https://docs.theo.xyz/products/thbill/mint-and-redeem.md", ["route", "access"]),
      sourceRef("Theo thBILL overview", "https://docs.theo.xyz/thbill", ["route", "capacity", "settlement", "access"]),
      sourceRef(
        "Theo minting service",
        "https://docs.theo.xyz/technical-reference/ttokens-and-itokens/ttokens/minting-service",
        ["route", "settlement"],
      ),
    ],
    notes: [
      "Payout identity reviewed 2026-09-30: Theo explicitly says holders receive USDC or USDT, not underlying fund units or Treasury securities.",
      "Direct minting and redemption require KYC; Theo describes optimistic issuance against USDC while issuer settlement completes asynchronously",
    ],
  },
  "rwausdi-multipli": {
    ...issuerBase,
    ...reviewedDirectRedemptionSupplyFull,
    settlementModel: "days",
    costModel: documentedVariableFee(
      "NAV-based valuation; KYB-gated 1:1 minting and redemption restricted to verified institutional counterparties",
    ),
    docs: [
      sourceRefRouteCapacity(
        "Multipli unwind and peg module",
        "https://docs.multipli.fi/technical-architecture/unwind-and-peg-module",
      ),
      sourceRef(
        "Multipli issuer, custody & operational risk",
        "https://docs.multipli.fi/risks/issuer-custody-and-operational-risk",
        ["access", "settlement", "capacity"],
      ),
      sourceRef("AFI verification", "https://verification.afiprotocol.xyz/multipli", ["capacity"]),
    ],
    notes: [
      "Multipli documents an institution-only primary redemption rail into underlying liquidity-class assets, so the route remains a delayed issuer exit rather than an instant public stablecoin off-ramp",
    ],
  },
  "usdn-noble": {
    ...issuerBase,
    ...reviewedDirectRedemptionSupplyFull,
    costModel: undisclosedReviewedFee(
      "USDN users mint and redeem via USDC through Noble Express; public redemption fees are not disclosed",
    ),
    v9RouteReviewTerms: {
      scoringDisposition: "bounded-terms-gap",
      missingScoringFields: ["capacity", "settlement", "cost"],
      rationale:
        "The NASD terms page is last revised 2025-02-26 but governs site use rather than a holder redemption commitment; the current USDN overview and architecture re-opened on 2026-09-04 still provide no dated issuer terms for capacity, settlement, or cost, while StableSwap has no measured bounds.",
      reviewedAt: "2026-09-04",
      docs: [
        sourceRef("NASD terms (last revised 2025-02-26)", "https://dollar.noble.xyz/terms-of-use", ["route", "access"]),
        sourceRef("Noble USDN launch", "https://noble.xyz/blog/introducing-usdn", ["route"]),
        sourceRef("USDN overview", "https://docs.noble.xyz/learn/usdn/overview/", ["route"]),
      ],
    },
    docs: [
      sourceRefRouteCapacity("USDN overview", "https://docs.noble.xyz/learn/usdn/overview/"),
      sourceRefRouteCapacity("USDN architecture", "https://docs.noble.xyz/learn/usdn/architecture/"),
      sourceRef("M0 Dashboard", "https://dashboard.m0.org/", ["capacity"]),
    ],
    notes: [
      "Current model scores the documented Noble Express USDC mint-and-redeem rail as eventual issuer redemption rather than a separately measured live cash buffer",
    ],
  },
  "aeur-anchored-coins": {
    ...issuerBase,
    ...reviewedDirectRedemptionSupplyFull,
    settlementModel: "days",
    costModel: undisclosedReviewedFee(
      "Direct redemption is available through Anchored Coins AG for amounts of at least AEUR 250,000; public fee schedule not disclosed",
    ),
    docs: [
      sourceRefRouteCapacity("Anchored Coins AEUR redemption", "https://www.anchoredcoins.com/en/landing/aeur"),
      sourceRefRouteCapacity(
        "Anchored Coins white paper",
        "https://static.anchoredcoins.com/static/cloud/anchoredcoins/static/images/admin_mgs_image_upload/whitepaper_for_launch.pdf",
      ),
    ],
    notes: [
      "Redemption timing depends on customer due diligence, banking-partner review, and payment-processing timelines",
    ],
  },
  "eurcv-societe-generale-forge": {
    ...issuerBase,
    ...reviewedDirectRedemptionSupplyFull,
    settlementModel: "days",
    costModel: undisclosedReviewedFee(
      "Redeemable 1:1 in EUR directly with SG-FORGE; public fee schedule not disclosed",
    ),
    docs: [
      sourceRefRouteCapacity("SG-FORGE CoinVertible", "https://www.sgforge.com/product/coinvertible/"),
      sourceRefRouteCapacity(
        "EURCV white paper",
        "https://www.sgforge.com/wp-content/uploads/2025/06/EURCV-White-Paper_iXBRL-2.html",
      ),
    ],
    notes: ["White paper describes issuer-side redemption subject to KYC/AML and permitted-transferee checks"],
  },
  "eure-monerium": {
    ...issuerBase,
    ...reviewedDirectRedemptionSupplyFull,
    costModel: fixedFee(0, "Monerium currently states minting and burning EURe are free of charge"),
    docs: [
      sourceRefRouteCapacity("EURe MiCA white paper", "https://monerium.com/whitepapers/eure-whitepaper/"),
      sourceRef("Monerium fee schedule", "https://monerium.com/fee-schedule/", ["fees"]),
    ],
  },
  "eurr-stablr": {
    ...issuerBase,
    ...reviewedDirectRedemptionSupplyFull,
    costModel: fixedFee(0, "StablR docs state qualified businesses can onramp and offramp EURR at no additional cost"),
    docs: [
      sourceRefRouteCapacityFees("What is EURR", "https://docs.stablr.com/docs/what-is-eurr"),
      sourceRefRouteCapacity("StablR overview", "https://docs.stablr.com/docs/overview"),
    ],
  },
  "emxn-telcoin": {
    ...issuerBase,
    ...documentedBoundSupplyFull("2026-08-13"),
    settlementModel: "days",
    executionModel: "opaque",
    outputAssetType: "stable-single",
    unresolvedOutputAssetKeys: ["fiat:MXN"],
    unresolvedOutputDisposition: "reviewed-external",
    capacityModel: { kind: "supply-full", confidence: "documented-bound", basis: "issuer-term-redemption" },
    costModel: documentedVariableFee(
      "Telcoin's eXYZ terms state a 0.15% redemption fee; wire, international-transfer, expedited-processing, and other partner charges may also apply",
    ),
    holderEligibility: "verified-customer",
    routeExitCorrelation: "independent-issuer-rail",
    docs: [
      sourceRef("Telcoin Digital Cash", "https://www.telco.in/en/digital-cash", ["route", "access", "capacity"]),
      sourceRefFull("Telcoin eXYZ Terms of Use", "https://www.telco.in/en/terms-of-use"),
      sourceRef("Telcoin eXYZ Terms, redemption policy", "https://www.telco.in/index.html/terms-of-use", [
        "route",
        "fees",
        "access",
        "settlement",
      ]),
      sourceRef("eMXN Polygon contract page", "https://polygonscan.com/token/0x68727e573d21a49c767c3c86a92d9f24bd933c99", [
        "route",
        "access",
      ]),
      sourceRef("Telcoin wallet", "https://wallet.telco.in/", ["route", "access", "settlement"]),
    ],
    notes: [
      "Telcoin's verified-customer issuer rail redeems eMXN 1:1 for the applicable reference currency through the official wallet; MXN remains an unresolved fiat output rather than a tracked stablecoin.",
      "Standard processing is 1–3 business days, with requests above $2,000 potentially taking 3–5 business days or longer; the $1 minimum and $2,000 transaction maximum remain compliance controls.",
      "supply-full is eventual issuer-term capacity only: no current eMXN reserve or executable-capacity telemetry was published.",
    ],
  },
  "jpysc-sbi-startale": {
    ...issuerBase,
    ...documentedBoundSupplyFull("2026-08-13"),
    outputAssetType: "stable-single",
    unresolvedOutputAssetKeys: ["fiat:JPY"],
    unresolvedOutputDisposition: "reviewed-external",
    costModel: documentedVariableFee(
      "Direct issuer redemption costs 3,000 JPY plus consumption tax per redemption; bank transfer fees are borne by the holder",
    ),
    holderEligibility: "verified-customer",
    routeExitCorrelation: "independent-issuer-rail",
    docs: [
      sourceRef("SBI Shinsei Trust JPYSC product page", "https://www.shinseitrust.com/stablecoin/jpysc.html", [
        "route",
        "access",
        "settlement",
        "fees",
      ]),
      sourceRef(
        "SBI Shinsei Trust JPYSC terms PDF",
        "https://www.shinseitrust.com/stablecoin/pdf/jpysc_terms_20260624.pdf",
        ["route", "access", "settlement", "fees", "capacity"],
      ),
      sourceRef("SBI VC Trade token manual", "https://www.sbivc.co.jp/assets/docs/manual_tt.pdf", ["route", "settlement"]),
      sourceRef("SBI VC Trade JPYSC page", "https://www.sbivc.co.jp/jpysc", ["route", "access"]),
      sourceRef("Startale JPYSC launch announcement", "https://startale.com/ja/blog/jpysc-launch", ["access", "settlement"]),
      sourceRef("Ethereum JPYSC explorer", "https://etherscan.io/address/0x6781d5631bfe47432b089e64e3eab3b6edd26177#code", [
        "route",
        "access",
        "capacity",
      ]),
      sourceRef("Ethereum RPC", "https://ethereum.publicnode.com", ["capacity", "access"]),
    ],
    notes: [
      "The primary modeled route is direct 1:1 JPY redemption from SBI Shinsei Trust after the holder transfers JPYSC to the issuer-designated wallet; the separate SBI VC Trade account route is not required.",
      "The current terms allow a principal beneficiary to request partial redemption subject to identity and transaction checks, with prompt JPY payment after receipt; JPY remains an unresolved fiat output rather than a tracked stablecoin.",
      "supply-full is the documented legal redemption bound, not a claim that same-day bank liquidity equals current token supply; requests can lapse or be delayed under the terms' wallet-designation and transfer windows.",
      "The 3,000 JPY plus consumption-tax issuer fee and holder-borne bank transfer fee are documented flat-currency charges, so the cost is retained as a documented variable/unclear model rather than converted into fabricated bps.",
    ],
  },
  "hlusd-hela": {
    ...issuerBase,
    accessModel: "manual",
    settlementModel: "days",
    executionModel: "opaque",
    outputAssetType: "stable-basket",
    outputAssets: ["usdc-circle", "usdt-tether"],
    capacityModel: { kind: "supply-full", confidence: "heuristic", basis: "issuer-term-redemption" },
    costModel: fixedFee(100, "StableHodl documents a 1% OTC fee for selling HLUSD"),
    holderEligibility: "unknown",
    reviewedAt: "2026-08-13",
    docs: [
      sourceRef("HeLa HLUSD documentation", "https://docs.helalabs.com/hlusd/editor", ["route", "access"]),
      sourceRefRouteCapacity("HeLa HLUSD benefits", "https://docs.helalabs.com/hlusd/markdown"),
      sourceRef("StableHodl HLUSD trading guide", "https://docs.stablehodl.com/product/trade-hlusd", [
        "route",
        "fees",
        "access",
        "settlement",
      ]),
      sourceRef("HeLa HLUSD minting/redemption page", "https://docs.helalabs.com/hlusd/minting-redemption-of-hlusd", [
        "route",
        "access",
      ]),
    ],
    notes: [
      "The modeled backstop is a manual third-party StableHodl OTC rail under HeLa's 1:1 redemption promise: HLUSD is sold for USDT or USDC and the output is claimed after processing.",
      "supply-full is a heuristic eventual-capacity model, not an immediate-reserve claim; StableHodl publishes no capacity, processing-time SLA, geographic eligibility, or current reserve availability, so days is conservative.",
      "The documented OTC fee is 1%; wallet connection and a separate claim step remain part of the opaque execution flow, while DEX trading is excluded.",
    ],
  },
};
