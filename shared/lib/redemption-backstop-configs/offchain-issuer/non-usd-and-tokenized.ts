import type { RedemptionBackstopConfig } from "../shared";
import {
  documentedBoundSupplyFull,
  documentedVariableFee,
  expandIds,
  undisclosedReviewedFee,
  fixedFee,
  issuerBase,
  sourceRef,
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
    sourceRef("VNX docs", "https://vnx.gitbook.io/vnx-platform/", ["route", "capacity"]),
    sourceRef("VNX website", "https://vnx.li/", ["route"]),
  ],
};

/** eurau-allunity and chfau-allunity are byte-identical (same base, cost, docs). */
const allunityBase: RedemptionBackstopConfig = {
  ...issuerBase,
  ...reviewedDirectRedemptionSupplyFull,
  costModel: undisclosedReviewedFee("Direct 1:1 redemption through AllUnity; public fee schedule not disclosed"),
  docs: [
    sourceRef("AllUnity whitepaper", "https://allunity.com/whitepaper/", ["route", "capacity"]),
    sourceRef("AllUnity trust center", "https://allunity.com/trust-center/", ["capacity"]),
  ],
};

export const NON_USD_AND_TOKENIZED_OFFCHAIN_CONFIGS: Record<string, RedemptionBackstopConfig> = {
  "cadc-cad-coin": {
    ...issuerBase,
    ...reviewedDirectRedemptionSupplyFull,
    costModel: undisclosedReviewedFee(
      "Direct 1:1 redemption for CAD through Loon / PayTrie; public fee schedule not disclosed",
    ),
    docs: [
      sourceRef("CADC FAQ", "https://faq.paytrie.com/col/cadc-faqs", ["route", "capacity"]),
      sourceRef("Loon website", "https://loon.finance/", ["route"]),
    ],
  },
  ...expandIds(["vchf-vnx", "vgbp-vnx"], vnxGitbookBase),
  "tryb-bilira": {
    ...issuerBase,
    ...reviewedDirectRedemptionSupplyFull,
    costModel: undisclosedReviewedFee(
      "Direct 1:1 issuance and redemption through BiLira; public fee schedule not disclosed",
    ),
    docs: [sourceRef("BiLira TRYB page", "https://www.bilira.co/en/product/tryb-stablecoin", ["route", "capacity"])],
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
      "Direct 1:1 issuance and redemption through AnchorX for CNH transfers; public fee schedule not disclosed",
    ),
    v9RouteReviewTerms: {
      scoringDisposition: "bounded-terms-gap",
      missingScoringFields: ["capacity", "settlement", "cost"],
      rationale:
        "AnchorX establishes a direct CNH redemption mechanism, but reviewed public materials do not establish executable capacity, bank-credit settlement timing, or all-in redemption cost.",
      reviewedAt: "2026-08-24",
      docs: [sourceRef("AnchorX website", "https://www.anchorx.org/", ["route", "capacity"])],
    },
    docs: [sourceRef("AnchorX website", "https://www.anchorx.org/", ["route", "capacity"])],
  },
  "idrt-rupiah-token": {
    ...issuerBase,
    ...reviewedDirectRedemptionSupplyFull,
    costModel: undisclosedReviewedFee(
      "Direct 1:1 issuance and redemption through PT Rupiah Token Indonesia after KYC; public fee schedule not disclosed",
    ),
    docs: [sourceRef("Rupiah Token website", "https://www.rupiahtoken.com/", ["route", "capacity"])],
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
        sourceRef(
          "Juno MXNB and USD stablecoin conversions",
          "https://docs.bitso.com/juno/docs/conversions-between-mxnb-and-usd-stablecoins",
          ["route", "capacity", "fees"],
        ),
      ],
    },
    docs: [
      sourceRef(
        "Juno MXNB and USD stablecoin conversions",
        "https://docs.bitso.com/juno/docs/conversions-between-mxnb-and-usd-stablecoins",
        ["route", "capacity", "fees"],
      ),
      sourceRef("MXNB transparency", "https://mxnb.mx/transparency", ["capacity"]),
    ],
    notes: [
      "Modeled as the documented Juno issuer conversion rail between MXNB and USDC/USDT rather than as a separate fiat bank-wire redemption flow",
      "The published conversion pairs expose explicit per-quote and per-pair min/max limits, which establish reviewed route availability without separately publishing a deterministic fixed-fee schedule",
    ],
  },
  "europ-schuman": {
    ...issuerBase,
    ...reviewedDirectRedemptionSupplyFull,
    costModel: {
      ...documentedVariableFee(
        "EURØP tokens can be redeemed and exchanged for the underlying legal tender currency at any time, as described in the Right to Redemption above, without fees.",
      ),
      feeBpsMax: 0,
    },
    docs: [
      sourceRef("EUROP white paper", "https://schuman.io/wp-content/uploads/2025/02/EUROP-White-Paper_1.3.pdf", [
        "route",
        "capacity",
      ]),
      sourceRef("EUROP white paper v1.7", "https://schuman.io/wp-content/uploads/EUROP-White-Paper.pdf", ["fees"]),
      sourceRef("Schuman reserve audits", "https://schuman.io/reserve-audits/", ["capacity"]),
    ],
  },
  ...expandIds(["eurau-allunity", "chfau-allunity"], allunityBase),
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
      sourceRef("CASH overview", "https://www.usecash.xyz/", ["route", "capacity"]),
      sourceRef("Bridge issuance FAQ", "https://apidocs.bridge.xyz/platform/issuance/faq", [
        "route",
        "capacity",
        "fees",
      ]),
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
        "Brale's agreement preserves private limits and delay rights, while public pricing does not establish the scored notional's executable capacity, settlement SLA, or all-in payout-rail cost.",
      reviewedAt: "2026-08-24",
      docs: [
        sourceRef("Brale business user agreement", "https://brale.xyz/legal/business-user-agreement", [
          "route",
          "capacity",
          "access",
          "settlement",
        ]),
        sourceRef("Brale pricing", "https://brale.xyz/pricing", ["fees"]),
      ],
    },
    docs: [
      sourceRef("SBC stablecoin page", "https://brale.xyz/stablecoins/SBC", ["route", "capacity"]),
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
      sourceRef("M0 FAQ", "https://www.m0.org/faq", ["route", "capacity", "access"]),
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
    costModel: undisclosedReviewedFee(
      "Eligible FinChain customers mint and redeem FUSD through the issuer against a tokenized Treasury and money-market fund reserve portfolio; public docs reviewed do not publish one fixed redemption fee",
    ),
    docs: [
      sourceRef("FUSD introduction", "https://finchain.gitbook.io/finchain-docs/en/fusd/introduction", [
        "route",
        "capacity",
        "access",
      ]),
      sourceRef("FUSD reserves", "https://finchain.gitbook.io/finchain-docs/en/fusd/introduction/fusd-reserves", [
        "capacity",
        "settlement",
      ]),
      sourceRef("FUSD token", "https://finchain.gitbook.io/finchain-docs/en/fusd/fusd-token", ["route"]),
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
      sourceRef("MetaMask USD introduction", "https://musd.to/blog", ["route", "capacity"]),
      sourceRef("Bridge issuance FAQ", "https://apidocs.bridge.xyz/platform/issuance/faq", [
        "route",
        "capacity",
        "fees",
      ]),
      sourceRef("M0 FAQ", "https://www.m0.org/faq", ["capacity", "access"]),
    ],
    notes: [
      "Modeled as MetaMask's documented Bridge issuer rail on top of M0 reserve infrastructure rather than as a continuously measured live cash-buffer route",
    ],
  },
  "mtbill-midas": {
    ...issuerBase,
    ...reviewedDirectRedemptionSupplyFull,
    capacityModel: { kind: "supply-ratio", ratio: 0.02, confidence: "documented-bound", basis: "hot-buffer" },
    settlementModel: "days",
    costModel: fixedFee(7, "Midas documents a 0.07% redemption fee"),
    v9RouteReviewTerms: {
      scoringDisposition: "bounded-terms-gap",
      missingScoringFields: ["capacity", "settlement"],
      rationale:
        "The reviewed 7 bps redemption fee is retained, but the published atomic-capacity percentage is a target and the 1-7-business-day fallback does not establish a binding calendar-day SLA.",
      reviewedAt: "2026-08-24",
      docs: [
        sourceRef("Midas mTBILL atomic redemptions", "https://docs.midas.app/tokens/mtbill/atomic-redemptions", [
          "route",
          "capacity",
          "settlement",
        ]),
        sourceRef("Midas transparency", "https://midas.app/transparency", ["capacity"]),
      ],
    },
    reviewedAt: "2026-05-17",
    docs: [
      sourceRef("Midas mTBILL atomic redemptions", "https://docs.midas.app/tokens/mtbill/atomic-redemptions", [
        "route",
        "capacity",
        "settlement",
      ]),
      sourceRef("Midas prospectus documents", "https://docs.midas.app/resources/legal-documents/prospectus-documents", [
        "fees",
      ]),
      sourceRef("Midas transparency", "https://midas.app/transparency", ["capacity"]),
    ],
    notes: [
      "Midas documents atomic USDC redemptions when protocol liquidity is available, while standard processing completes within two business days in normal conditions and up to seven business days in stressed cases",
      "Tracked mTBILL metadata records a 3% USD cash buffer; Pharos uses a 2% documented hot-buffer lower bound rather than claiming the full daily NAV redeemability as immediate capacity",
    ],
  },
  "usdy-ondo-finance": {
    ...issuerBase,
    ...reviewedDirectRedemptionSupplyFull,
    capacityModel: { kind: "supply-ratio", ratio: 0.05, confidence: "documented-bound", basis: "hot-buffer" },
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
      sourceRef("Ondo USDY", "https://ondo.finance/usdy", ["route", "capacity"]),
      sourceRef("Ondo docs", "https://docs.ondo.finance/", ["route", "capacity"]),
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
      "Tracked USDY metadata records a 5% bank-demand-deposit slice; Pharos uses that reserve slice as the documented hot-buffer lower bound and does not promote the unvalidated 8% proposal.",
    ],
  },
  /** iauon-ondo and slvon-ondo share the Ondo GM shape; they differ only in ticker,
   *  asset page URL, and the underlying-fund name in the notes. */
  ...Object.fromEntries(
    (
      [
        ["iauon-ondo", "IAUon", "iauon", "IAU", "iShares Gold Trust"],
        ["slvon-ondo", "SLVon", "slvon", "SLV", "iShares Silver Trust"],
      ] as const
    ).map(([id, label, slug, underlyingTicker, fundName]) => [
      id,
      {
        ...issuerBase,
        ...documentedBoundSupplyFull("2026-05-24"),
        settlementModel: "days",
        executionModel: "rules-based-nav",
        outputAssetType: "nav",
        costModel: undisclosedReviewedFee(
          `Ondo Global Markets subscriptions and redemptions follow the tokenized ${underlyingTicker} economic exposure for eligible investors; public materials reviewed do not publish one fixed redemption fee`,
        ),
        docs: [
          sourceRef(`${label} asset page`, `https://app.ondo.finance/assets/${slug}`, ["route", "capacity"]),
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
    costModel: documentedVariableFee(
      "KYC-gated mint/redemption processed instantly in USDC; underlying collateral settled within T+4 business days",
    ),
    docs: [
      sourceRef("Theo thBILL overview", "https://docs.theo.xyz/thbill", ["route", "capacity", "settlement", "access"]),
      sourceRef(
        "Theo minting service",
        "https://docs.theo.xyz/technical-reference/ttokens-and-itokens/ttokens/minting-service",
        ["route", "settlement"],
      ),
    ],
    notes: [
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
      sourceRef(
        "Multipli unwind and peg module",
        "https://docs.multipli.fi/technical-architecture/unwind-and-peg-module",
        ["route", "capacity"],
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
        "Noble materials establish the USDN architecture and a secondary StableSwap venue, but dated issuer terms do not establish a holder redemption commitment and the venue lacks measured capacity, cost, and settlement evidence.",
      reviewedAt: "2026-08-24",
      docs: [
        sourceRef("NASD terms", "https://dollar.noble.xyz/terms-of-use", ["route", "access"]),
        sourceRef("Noble USDN launch", "https://noble.xyz/blog/introducing-usdn", ["route", "capacity"]),
      ],
    },
    docs: [
      sourceRef("USDN overview", "https://docs.noble.xyz/learn/usdn/overview/", ["route", "capacity"]),
      sourceRef("USDN architecture", "https://docs.noble.xyz/learn/usdn/architecture/", ["route", "capacity"]),
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
      sourceRef("Anchored Coins AEUR redemption", "https://www.anchoredcoins.com/en/landing/aeur", [
        "route",
        "capacity",
      ]),
      sourceRef(
        "Anchored Coins white paper",
        "https://static.anchoredcoins.com/static/cloud/anchoredcoins/static/images/admin_mgs_image_upload/whitepaper_for_launch.pdf",
        ["route", "capacity"],
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
      sourceRef("SG-FORGE CoinVertible", "https://www.sgforge.com/product/coinvertible/", ["route", "capacity"]),
      sourceRef(
        "EURCV white paper",
        "https://www.sgforge.com/wp-content/uploads/2025/06/EURCV-White-Paper_iXBRL-2.html",
        ["route", "capacity"],
      ),
    ],
    notes: ["White paper describes issuer-side redemption subject to KYC/AML and permitted-transferee checks"],
  },
  "eure-monerium": {
    ...issuerBase,
    ...reviewedDirectRedemptionSupplyFull,
    costModel: fixedFee(0, "Monerium currently states minting and burning EURe are free of charge"),
    docs: [
      sourceRef("EURe MiCA white paper", "https://monerium.com/whitepapers/eure-whitepaper/", ["route", "capacity"]),
      sourceRef("Monerium fee schedule", "https://monerium.com/fee-schedule/", ["fees"]),
    ],
  },
  "eurr-stablr": {
    ...issuerBase,
    ...reviewedDirectRedemptionSupplyFull,
    costModel: fixedFee(0, "StablR docs state qualified businesses can onramp and offramp EURR at no additional cost"),
    docs: [
      sourceRef("What is EURR", "https://docs.stablr.com/docs/what-is-eurr", ["route", "capacity", "fees"]),
      sourceRef("StablR overview", "https://docs.stablr.com/docs/overview", ["route", "capacity"]),
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
      sourceRef("Telcoin eXYZ Terms of Use", "https://www.telco.in/en/terms-of-use", [
        "route",
        "capacity",
        "fees",
        "access",
        "settlement",
      ]),
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
      sourceRef("HeLa HLUSD benefits", "https://docs.helalabs.com/hlusd/markdown", ["route", "capacity"]),
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
