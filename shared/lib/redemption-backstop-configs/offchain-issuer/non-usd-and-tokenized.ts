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
    costModel: undisclosedReviewedFee(
      "Direct 1:1 redemption through Schuman Financial; public fee schedule not disclosed",
    ),
    docs: [
      sourceRef("EUROP white paper", "https://schuman.io/wp-content/uploads/2025/02/EUROP-White-Paper_1.3.pdf", [
        "route",
        "capacity",
      ]),
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
    costModel: undisclosedReviewedFee(
      "CASH is minted 1:1 from USD deposits via Bridge and redeemed into USD or supported stablecoins; public issuer fee schedule not disclosed",
    ),
    docs: [
      sourceRef("CASH overview", "https://www.usecash.xyz/", ["route", "capacity"]),
      sourceRef("Bridge issuance FAQ", "https://apidocs.bridge.xyz/platform/issuance/faq", [
        "route",
        "capacity",
        "fees",
      ]),
    ],
  },
  "sbc-brale": {
    ...issuerBase,
    ...reviewedDirectRedemptionSupplyFull,
    costModel: documentedVariableFee(
      "Brale pricing lists stablecoin offramp as included with API plans, while wire and ACH payout rails can still carry transfer fees",
    ),
    docs: [
      sourceRef("SBC stablecoin page", "https://brale.xyz/stablecoins/SBC", ["route", "capacity"]),
      sourceRef("Brale pricing", "https://brale.xyz/pricing", ["fees"]),
    ],
  },
  "m-m0": {
    ...issuerBase,
    ...reviewedDirectRedemptionSupplyFull,
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
    costModel: undisclosedReviewedFee("Bank wire redemption at NAV-based price; public fee schedule not disclosed"),
    reviewedAt: "2026-05-17",
    docs: [
      sourceRef("Ondo USDY", "https://ondo.finance/usdy", ["route", "capacity"]),
      sourceRef("Ondo docs", "https://docs.ondo.finance/", ["route", "capacity"]),
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
};
