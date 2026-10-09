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

/** Retained VNX issuer-redemption base; VCHF adds its current published fee
 *  schedule independently below. */
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
  ...expandIds(["vgbp-vnx"], vnxGitbookBase),
  "vchf-vnx": {
    ...vnxGitbookBase,
    reviewedAt: "2026-10-09",
    costModel: documentedVariableFee(
      "VNX Global Terms Annex III(C) charges CHF 30 for a SWIFT withdrawal from the platform account. A separate 3% unused-funds fee applies when less than 75% of previously transferred funds has been spent, on funds exceeding the cumulative USD 100,000-equivalent threshold. This is a disclosed account-history-dependent tariff, not an all-in USD redemption quote: CHF/USD conversion, fee applicability, network and third-party charges remain unquantified. Annex III(A)'s 2% conversion fee is a separate service and is not assumed to apply to every VCHF redemption.",
    ),
    docs: [
      ...vnxGitbookBase.docs!,
      sourceRef(
        "VNX Global current VCHF terms and fee schedule (reviewed 2026-10-09)",
        "https://prod-global-terms.s3.sa-east-1.amazonaws.com/VNX-Global-Terms.pdf",
        ["route", "fees", "access", "settlement"],
      ),
      sourceRef(
        "Current VCHF institutional platform",
        "https://vnx.io/swiss-franc",
        ["route", "access"],
      ),
    ],
    notes: [
      "Sol curation campaign 2026-10-09 (Lane52Vnx), observed 2026-10-09T10:35:08Z: current terms name VNX Global Ltd., separately from the legacy VNX Commodities AG platform. Section 3.2 restricts direct issuance/redemption to verified organizations classified as sophisticated customers and permits reserve-related delay and in-kind redemption. These clauses do not establish an unconditional settlement SLA, complete cash output or currently executable capacity.",
      "The fixed fee is CHF 30, not USD 30. No feeBpsMax, minFeeUsd, gasOrBridgeCostUsd or numerical all-in cost is authored. The existing B/cost classification remains valid until an exact account-history scenario and authoritative CHF/USD conversion can be evaluated at the requested notional and captured by the producer.",
    ],
  },
  "tryb-bilira": {
    ...issuerBase,
    ...reviewedDirectRedemptionSupplyFull,
    costModel: documentedVariableFee(
      "BiLira Kripto's published deposit/withdrawal tariff lists Banka Transferi as Ücretsiz (free) for both directions, reviewed 2026-10-05. The known zero applies only to that issuer-platform bank-transfer leg, not the complete TRYB redemption: crypto withdrawal charges vary by network, and holder gas, conversion applicability, third-party commissions and taxes remain separate and unquantified. No all-in zero fee or route-wide ceiling is asserted.",
    ),
    docs: [
      sourceRefRouteCapacity("BiLira TRYB page", "https://www.bilira.co/en/product/tryb-stablecoin"),
      sourceRef("BiLira Kripto deposit/withdrawal tariff (reviewed 2026-10-05)", "https://kripto.bilira.co/komisyonlar-ve-ucretler/ucretler", ["fees"]),
    ],
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
    costModel: {
      ...documentedVariableFee(
        "Issuer redemption fee is 0.5% plus an IDR 6,500 bank-transfer charge when applicable",
        "formula",
      ),
      feeBpsMin: 50,
    },
    docs: [
      sourceRefRouteCapacity("Rupiah Token website", "https://www.rupiahtoken.com/"),
      sourceRef(
        "Rupiah Token IDRT-to-IDR withdrawal fee FAQ",
        "https://rupiahtoken.com/faq/berapa-biaya-pencairan-idrt-ke-idr",
        ["fees"],
      ),
    ],
    notes: [
      "Sol curation campaign 2026-10-09 (Lane28Rupiah), observed 2026-10-09T10:37:58Z: the issuer publishes a 0.5% withdrawal fee plus IDR 6,500 bank-transfer fee if applicable. The percentage leg is 50 bps, but the IDR flat leg has no capture-bound USD conversion in this config.",
      "The 50 bps value is a lower bound, not an all-in ceiling. No feeBpsMax, minFeeUsd or gasOrBridgeCostUsd is invented. Cost remains unresolved until the producer can value the applicable IDR charge at the captured FX reference and requested notional; this fragment changes no capacity, settlement or holder-eligibility terms.",
    ],
  },
  "idrx-idrx": {
    ...issuerBase,
    ...reviewedIssuerApiExpansionSupplyFull,
    costModel: documentedVariableFee(
      "IDRX redemption fees are deducted from received IDR: Rp5,000 below Rp250,000,000 via BI-FAST; Rp35,000 at or above Rp250,000,000 via RTGS. A bank with a lower BI-FAST limit can force RTGS and its fee below that threshold. These local-IDR flat fees are not a fixed USD amount or fixed-bps fee.",
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
      "The fee table states BI-FAST below Rp250,000,000 is real-time, 24/7, while RTGS at or above that threshold operates Monday–Friday, 08:00–15:00 WIB. Bank-specific lower BI-FAST limits may force RTGS earlier; no unconditional calendar-time bank-credit bound is inferred from that office-hours window.",
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
    costModel: {
      ...documentedVariableFee(
        "Anzens Terms section 15(e) publishes a $30 domestic-wire fee and $70 international-wire fee. Burning also incurs variable Cardano gas; additional banking, custody, ACH and partner fees may apply. These are published components, not an all-in cost ceiling",
        "formula",
      ),
    },
    v9RouteReviewTerms: {
      scoringDisposition: "bounded-terms-gap",
      missingScoringFields: ["cost", "settlement"],
      rationale:
        "The published wire schedule does not bound gas and additional applicable fees. Section 12 targets USDA account credit within two business days and withdrawal processing within three business days, but expressly allows delay and excludes the receiving bank's time. Neither target is a binding end-to-end settlement SLA or a justified five-business-day guarantee.",
      reviewedAt: "2026-10-09",
      docs: [
        sourceRef("Anzens Terms revised April 14, 2025, sections 12 and 15", "https://www.anzens.com/landing/terms-and-conditions", ["route", "access", "fees", "settlement"]),
      ],
    },
    docs: [
      sourceRef("Anzens website", "https://www.anzens.com/", ["route", "capacity", "settlement"]),
      sourceRef("Anzens Terms revised April 14, 2025, sections 12 and 15", "https://www.anzens.com/landing/terms-and-conditions", ["route", "access", "fees", "settlement"]),
    ],
    notes: [
      "Redemption credits the Anzens account before a separate bank withdrawal. Foreign-account withdrawals have a $100,000 minimum and use Encryptus; that condition is not applied to the domestic rail.",
      "Wire prices are rail-specific components. No generic minimum, zero gas, uniform basis-point fee, complete cost ceiling or guaranteed settlement delay is authored for the aggregate issuer route.",
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
      "Brale publishes 0 bps on standard money movement and bank-payout usage fees of $0.25 per ACH, $2 per RTP and $20 per wire. Onchain transfers cost actual gas plus 20%. The Business User Agreement retains account-specific fees and discretionary pricing changes; no uniform all-in basis-point fee or maximum is established",
      "formula",
    ),
    v9RouteReviewTerms: {
      scoringDisposition: "bounded-terms-gap",
      missingScoringFields: ["capacity", "settlement", "cost"],
      rationale:
        "Brale's Business User Agreement (updated 2026-05-27), sections 3.2 and 3.5, permits discretionary redemption delays and account transaction limits. Current public pricing discloses ACH/RTP/wire fees and actual gas plus 20%, but the reviewed materials do not establish scored-notional capacity, an end-to-end settlement SLA or a complete payout cost ceiling.",
      reviewedAt: "2026-10-09",
      docs: [
        sourceRef("Brale business user agreement (updated 2026-05-27)", "https://brale.xyz/legal/business-user-agreement", ["route", "capacity", "access", "settlement", "fees"]),
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
    v9RouteReviewTerms: {
      businessDayTerms: {
        businessDays: 3, calendarId: "hong-kong-banking",
        cutoff: { time: "08:00", timezone: "Asia/Hong_Kong" },
        assurance: "target", conditional: true,
        conditions: ["Completed KYC/KYB and account settings", "Universal redemption timing is a typically/up-to operational statement, not a binding guarantee"],
        startEvent: "FUSD-paid universal redemption order; requests after 08:00 Hong Kong roll to the next business day",
      },
      reviewedAt: "2026-10-05",
      docs: [
        sourceRef("FinChain universal redemption", "https://finchain.gitbook.io/finchain-docs/en/fusd/fusd-token/redeem.md", ["settlement"]),
        sourceRef("FinChain Hong Kong cutoff", "https://finchain.gitbook.io/finchain-docs/en/fusd/fusd-token/cut-off-time.md", ["settlement"]),
      ],
    },
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
        "The modeled instant USDC branch retains its 7 bps issuer fee and heuristic 2% hot buffer; neither the dynamic 50% atomic-capacity target nor shared liquidity establishes a funded bound. Standard redemption is a separate branch at up to 5 bps, with one-business-day realisation plus up to five business days, a 25% daily gate and disruption postponements; those terms do not guarantee completion or capacity for the instant branch.",
      reviewedAt: "2026-10-07",
      docs: [
        sourceRef("Midas atomic redemption targets and shared liquidity", "https://midas-docs.gitbook.io/midas-docs/defi-integration/atomic-redemption.md", [
          "route",
          "access",
          "settlement",
        ]),
        sourceRef("mTBILL Final Terms dated July 17, 2026", "https://3475141875-files.gitbook.io/~/files/v0/b/gitbook-x-prod.appspot.com/o/spaces%2FMndxFHqGeA4nzBBeKDTV%2Fuploads%2FUDquVH8yRhSxnVqxp0X4%2F20260714_mTBILL_FT_signed_final.pdf?alt=media&token=bf215cdc-f549-474d-8ca9-5a1810fabeb8", ["route", "access", "fees", "settlement"]),
        sourceRef("Midas 2026 base prospectus conditions 8.3c and 12 (standard branch context)", "https://3475141875-files.gitbook.io/~/files/v0/b/gitbook-x-prod.appspot.com/o/spaces%2FMndxFHqGeA4nzBBeKDTV%2Fuploads%2FkVT2uAi2AipgeMIyZAJe%2FMidas%20Software%20GmbH%20Base%20Prospectus%202026.pdf?alt=media&token=d80ceabb-07a6-4dc4-9020-70ec86b4f42f", ["route", "access", "settlement"]),
      ],
    },
    reviewedAt: "2026-10-07",
    docs: [
      sourceRef("Midas atomic redemption targets and shared liquidity", "https://midas-docs.gitbook.io/midas-docs/defi-integration/atomic-redemption.md", [
        "route",
        "access",
        "settlement",
      ]),
      sourceRef("mTBILL Final Terms dated July 17, 2026", "https://3475141875-files.gitbook.io/~/files/v0/b/gitbook-x-prod.appspot.com/o/spaces%2FMndxFHqGeA4nzBBeKDTV%2Fuploads%2FUDquVH8yRhSxnVqxp0X4%2F20260714_mTBILL_FT_signed_final.pdf?alt=media&token=bf215cdc-f549-474d-8ca9-5a1810fabeb8", ["route", "access", "fees", "settlement"]),
      sourceRef("Midas 2026 base prospectus conditions 8.3c and 12 (standard branch context)", "https://3475141875-files.gitbook.io/~/files/v0/b/gitbook-x-prod.appspot.com/o/spaces%2FMndxFHqGeA4nzBBeKDTV%2Fuploads%2FkVT2uAi2AipgeMIyZAJe%2FMidas%20Software%20GmbH%20Base%20Prospectus%202026.pdf?alt=media&token=d80ceabb-07a6-4dc4-9020-70ec86b4f42f", ["route", "access", "settlement"]),
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
    outputAssets: ["usdc-circle"],
    costModel: {
      ...documentedVariableFee(
        "The documented Ethereum USDY InstantManager pays USDC. Its verified BaseRWAManager._processRedemption computes redemptionUSDValue from the RWA oracle and token decimals, calls ondoRedemptionFees.getAndUpdateFee(rwaToken, receivingToken, userId, redemptionUSDValue), subtracts that fee, and converts the remainder through the receiving-token oracle. A historical zero default fee is not an all-holder bound; actual registered-user fee state, gas and executable request-specific payout remain unmeasured.",
        "formula",
      ),
      feeBpsMin: 0,
    },
    v9RouteReviewTerms: {
      settlementModel: "atomic",
      settlementDelaySec: 0,
      minRedeemUsd: 1,
      scoringDisposition: "bounded-terms-gap",
      missingScoringFields: ["capacity", "cost"],
      rationale:
        "The exact USDY InstantManager enforces minimumRedemptionUSD of $1 and atomic USDC payout. Registered-holder compliance, receiver eligibility, user-specific router sources, actual user/global limits and fee overrides remain prerequisites. Public default liquidity, zero-ID limits and default zero fees do not establish eligible-holder capacity or an all-user fee ceiling; the 5% ratio remains heuristic.",
      reviewedAt: "2026-10-07",
      docs: [
        sourceRef("USDY InstantManager integration guide (reviewed 2026-10-07)", "https://docs.ondo.finance/developer-guides/usdy-instant-manager-integration", ["route", "access", "settlement", "fees"]),
        sourceRef("USDY deployed addresses (reviewed 2026-10-07)", "https://docs.ondo.finance/addresses", ["route"]),
        sourceRef("USDY InstantManager verified source (reviewed 2026-10-07)", "https://eth.blockscout.com/api/v2/smart-contracts/0xa42613c243b67bf6194ac327795b926b4b491f15", ["route", "access", "settlement", "fees"]),
        sourceRef("Ethereum pinned block 26143090", "https://eth.blockscout.com/block/26143090", ["route"]),
      ],
    },
    reviewedAt: "2026-10-07",
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
      sourceRef("USDY InstantManager integration guide (reviewed 2026-10-07)", "https://docs.ondo.finance/developer-guides/usdy-instant-manager-integration", ["route", "access", "settlement", "fees"]),
      sourceRef("USDY InstantManager verified source (reviewed 2026-10-07)", "https://eth.blockscout.com/api/v2/smart-contracts/0xa42613c243b67bf6194ac327795b926b4b491f15", ["route", "access", "settlement", "fees"]),
    ],
    notes: [
      "The 5% hot-buffer ratio is a conservative modeling heuristic, not a documented lower bound; current Ondo materials do not publish a durable bank-demand-deposit allocation or instant-redemption floor.",
      "At Ethereum block 26143090 (2026-10-07), public defaults showed 27,220,717.712216 USDC router liquidity, $15M global headroom, a $10M/86400s new-user limit and zero default flat/bps fees. These are separate diagnostics, not additive inventory or actual-holder entitlement. Zero user ID is not registered; active user sources, instantiated limits and fee overrides take precedence.",
      "At Ethereum block 26154601 (2026-10-09T11:37:59Z; hash 0xf6d6c7e8f5c1585fb116934eabfc00023f0f89330f014b504eb0a4b593af8672), InstantManager redeemPaused was false and minimumRedemptionUSD was 1e18 ($1). The configured redemption-fee contract 0xe1cb24077d77d2fe763fcac63e5653d97dc8d20c returned an active USDY default with zero flat and bps fees and an inactive USDY/USDC default override. These pinned configuration facts do not establish registered-user overrides, volume-dependent fees, executable same-notional payout, gas or eligible capacity; cost remains unmeasured and no all-holder zero-fee bound is asserted.",
    ],
  },
  ...expandIds(["iauon-ondo", "slvon-ondo"], {
    ...issuerBase,
    reviewedAt: "2026-10-09",
    holderEligibility: "verified-customer",
    settlementModel: "immediate",
    outputAssetType: "stable-single",
    outputAssets: ["usdon-ondo"],
    capacityModel: { kind: "unquantified" },
    costModel: documentedVariableFee(
      "Ondo Stocks retains the difference between its investor quote and underlying execution price, plus any fees; holders also pay gas. No numeric all-in spread or fee ceiling is published.",
    ),
    v9RouteReviewTerms: {
      settlementModel: "immediate",
      minRedeemUsd: 1,
      scoringDisposition: "bounded-terms-gap",
      missingScoringFields: ["capacity", "settlement", "cost"],
      rationale:
        "Issuer terms describe instant redemption to USDon for eligible onboarded investors, but execution needs an authenticated signed attestation and current account/asset trading limits. The public materials do not establish executable capacity, an all-in quote cost, or an unconditional scored-notional completion deadline. USDC conversion is a separate whitelist- and swapper-liquidity-dependent leg and is not modeled as the unconditional output.",
      reviewedAt: "2026-10-09",
      docs: [
        sourceRef("Ondo Stocks redemption output, minimum and liquidity conditions", "https://docs.ondo.finance/ondo-stocks/investing-and-redeeming.md", ["route", "access", "settlement"]),
        sourceRef("Ondo Stocks investor quote spreads and gas", "https://docs.ondo.finance/ondo-stocks/fees-and-taxes.md", ["fees"]),
        sourceRef("Ondo Stocks authenticated attestation workflow", "https://docs.ondo.finance/api-reference/quickstart.md", ["route", "access"]),
        sourceRef("Ondo Stocks current account and asset limits", "https://docs.ondo.finance/api-reference/limits/get-trading-limits.md", ["route", "access", "capacity"]),
      ],
    },
    docs: [
      sourceRef("Ondo Stocks redemption output, minimum and liquidity conditions", "https://docs.ondo.finance/ondo-stocks/investing-and-redeeming.md", ["route", "access", "settlement"]),
      sourceRef("Ondo Stocks investor quote spreads and gas", "https://docs.ondo.finance/ondo-stocks/fees-and-taxes.md", ["fees"]),
      sourceRef("Ondo Stocks authenticated attestation workflow", "https://docs.ondo.finance/api-reference/quickstart.md", ["route", "access"]),
      sourceRef("Ondo Stocks current account and asset limits", "https://docs.ondo.finance/api-reference/limits/get-trading-limits.md", ["route", "access", "capacity"]),
      sourceRef("Ondo Stocks eligibility restrictions", "https://docs.ondo.finance/ondo-stocks/eligibility.md", ["access"]),
    ],
    notes: [
      "Sol curation campaign 2026-10-09 (Lane05Ondo), observed 2026-10-09T10:35:23Z: exact issuer metadata identifies GLDon, IAUon and SLVon as Ondo Stocks trackers; this shared documented route grants no live same-notional capacity or quote-cost credit.",
      "USDon is the direct redemption output. Instant conversion to USDC requires sufficient USDC in the swapper and explicit whitelist access; bank-wire USD redemptions are not currently supported.",
      "Market/session closures, asset pauses, exposure limits and outstanding attestations restrict execution. The issuer's instant-processing description is retained without inventing an unconditional settlement SLA.",
    ],
  }),
  "gldon-ondo": {
    ...issuerBase,
    reviewedAt: "2026-10-09",
    holderEligibility: "verified-customer",
    settlementModel: "immediate",
    outputAssetType: "stable-single",
    outputAssets: ["usdon-ondo"],
    capacityModel: { kind: "unquantified" },
    costModel: documentedVariableFee(
      "Ondo Stocks retains the difference between its investor quote and underlying execution price, plus any fees; holders also pay gas. No numeric all-in spread or fee ceiling is published.",
    ),
    v9RouteReviewTerms: {
      settlementModel: "immediate",
      minRedeemUsd: 1,
      scoringDisposition: "bounded-terms-gap",
      missingScoringFields: ["capacity", "settlement", "cost"],
      rationale:
        "Issuer terms describe instant redemption to USDon for eligible onboarded investors, but execution needs an authenticated signed attestation and current account/asset trading limits. The public materials do not establish executable capacity, an all-in quote cost, or an unconditional scored-notional completion deadline. USDC conversion is a separate whitelist- and swapper-liquidity-dependent leg and is not modeled as the unconditional output.",
      reviewedAt: "2026-10-09",
      docs: [
        sourceRef("Ondo Stocks redemption output, minimum and liquidity conditions", "https://docs.ondo.finance/ondo-stocks/investing-and-redeeming.md", ["route", "access", "settlement"]),
        sourceRef("Ondo Stocks investor quote spreads and gas", "https://docs.ondo.finance/ondo-stocks/fees-and-taxes.md", ["fees"]),
        sourceRef("Ondo Stocks authenticated attestation workflow", "https://docs.ondo.finance/api-reference/quickstart.md", ["route", "access"]),
        sourceRef("Ondo Stocks current account and asset limits", "https://docs.ondo.finance/api-reference/limits/get-trading-limits.md", ["route", "access", "capacity"]),
        sourceRef("GLDon Final Terms: separate standard investor put", "https://cdn.sanity.io/files/8k2tqa6n/production/a598be5156bcda440276f01eea9258f82f851bd0.pdf", ["route", "fees", "access", "settlement"]),
      ],
    },
    docs: [
      sourceRef("Ondo Stocks redemption output, minimum and liquidity conditions", "https://docs.ondo.finance/ondo-stocks/investing-and-redeeming.md", ["route", "access", "settlement"]),
      sourceRef("Ondo Stocks investor quote spreads and gas", "https://docs.ondo.finance/ondo-stocks/fees-and-taxes.md", ["fees"]),
      sourceRef("Ondo Stocks authenticated attestation workflow", "https://docs.ondo.finance/api-reference/quickstart.md", ["route", "access"]),
      sourceRef("Ondo Stocks current account and asset limits", "https://docs.ondo.finance/api-reference/limits/get-trading-limits.md", ["route", "access", "capacity"]),
      sourceRef("Ondo Stocks eligibility restrictions", "https://docs.ondo.finance/ondo-stocks/eligibility.md", ["access"]),
      sourceRef("GLDon Final Terms: separate standard investor put", "https://cdn.sanity.io/files/8k2tqa6n/production/a598be5156bcda440276f01eea9258f82f851bd0.pdf", ["route", "fees", "access", "settlement"]),
      sourceRef("Ondo November 11, 2025 base prospectus: contextual standard put only", "https://www.mfsa.mt/wp-content/uploads/2025/12/Ondo-Global-Markets-BVI-Limited-Base-Prospectus-Document-dated-11-November-2025.pdf", ["route", "access", "settlement"]),
      sourceRef("Ondo August 28, 2026 supplement: contextual standard put only", "https://www.mfsa.mt/wp-content/uploads/2026/09/Ondo-Global-Markets-BVI-Limited-Supplement-Document-dated-28-August-2026.pdf", ["route"]),
      sourceRef("Ondo holder eligibility notes", "https://docs.ondo.finance/ondo-stocks/important-notes.md", ["access"]),
      sourceRef("Ondo Stocks issuer and swapper contract addresses", "https://docs.ondo.finance/addresses.md", ["route"]),
    ],
    notes: [
      "Sol curation campaign 2026-10-09 (Lane05Ondo), observed 2026-10-09T10:35:23Z: exact issuer metadata identifies GLDon as an Ondo Stocks tracker; this documented route grants no live same-notional capacity or quote-cost credit.",
      "USDon is the direct redemption output. Instant conversion to USDC requires sufficient USDC in the swapper and explicit whitelist access; bank-wire USD redemptions are not currently supported.",
      "Market/session closures, asset pauses, exposure limits and outstanding attestations restrict execution. The issuer's instant-processing description is retained without inventing an unconditional settlement SLA.",
      "Retained contextual review 2026-10-07: eligible onboarded investors must be outside the United States and satisfy additional jurisdictional restrictions; USDon/USDC swap access is separately whitelisted.",
      "Retained contextual review 2026-10-07: current operational docs state a $1 redemption minimum; the Final Terms' 0.01-USDC minimum subscription is a different scope.",
      "Retained contextual review 2026-10-07: GLDon Final Terms permit issuer issuance and redemption fees up to 0.1%, excluding transaction costs and gas. The separate standard USDC/USDT investor put permits underlying liquidation/payout instruction up to T+5 with postponements. Neither term establishes the selected instant USDon route's all-in cost, executable capacity or completed-settlement SLA.",
      "GLDon is a tracker, not a right to direct ownership or delivery of GLD ETF shares or physical gold. Conditional USDC conversion is not an equal-weight payout portfolio.",
      "Ondo separately documents GMIssuerManager redemption into underlying securities through Alpaca's Instant Tokenization Network: Ethereum 0xec8bBB0c90c0B5F4D8240D0F7b49DA3b0aA41f4E and BNB Chain 0x341f9e6463161F0C90037Cbc0150DC54e6d1e06e. Holder eligibility, execution capacity and binding GLDon in-kind rights are unestablished; this rail is recorded without adding an output or upgrading exit scoring.",
      "Capacity and settlement categories are diagnostic defaults only; no immediate ratio, funded USD capacity, guaranteed settlement duration or all-in zero cost is inferred.",
    ],
  },
  "thbill-theo": {
    ...issuerBase,
    ...reviewedDirectRedemptionSupplyFull,
    outputAssetType: "stable-basket",
    outputAssets: ["usdc-circle", "usdt-tether"],
    costModel: documentedVariableFee(
      "KYC/KYB-gated redemption pays USDC or USDT; current thBILL documents do not establish an all-in numeric redemption fee",
    ),
    docs: [
      sourceRef("Theo thBILL payout documentation (reviewed 2026-09-30)", "https://docs.theo.xyz/products/thbill/mint-and-redeem.md", ["route", "access"]),
      sourceRef("Theo thBILL product documentation: instant minting and T+1 redemption", "https://docs.theo.xyz/products/thbill.md", ["route", "access", "settlement"]),
      sourceRef("Theo thBILL product page: advertised T+0 settlement", "https://theo.xyz/thbill", ["route", "access", "settlement"]),
    ],
    notes: [
      "Payout identity reviewed 2026-09-30: Theo explicitly says holders receive USDC or USDT, not underlying fund units or Treasury securities.",
      "Direct minting and redemption require KYC/KYB. Current mint-and-redeem documentation confirms the stablecoin payout without promising fund-unit delivery.",
      "Timing source discrepancy reviewed 2026-10-09 by Sol curation campaign 2026-10-09 (Lane33Hyperithm): product documentation says redemption is T+1, while the product page advertises T+0 and 24/7 settlement. Neither is adopted as an unconditional exact-route SLA; no current primary support for the former T+4 underlying-settlement assertion was established.",
    ],
  },
  "rwausdi-multipli": {
    ...issuerBase,
    ...reviewedDirectRedemptionSupplyFull,
    settlementModel: "days",
    costModel: undisclosedReviewedFee(
      "No rwaUSDi-specific numeric redemption schedule published in reviewed Multipli docs",
    ),
    reviewedAt: "2026-10-07",
    v9RouteReviewTerms: {
      scoringDisposition: "bounded-terms-gap",
      missingScoringFields: ["cost", "settlement"],
      rationale:
        "Multipli isolates scheduled, periodic-NAV or bespoke-settlement assets into liquidity classes such as rwaUSDi. Current primary docs establish liquidity-class dependence, not an rwaUSDi-specific numeric fee or maximum completion time; no quarterly schedule is inferred.",
      reviewedAt: "2026-10-07",
      docs: [
        sourceRef("Multipli liquidity and redemption risk (reviewed 2026-10-07)", "https://docs.multipli.fi/risks/liquidity-and-redemption-risk", ["route", "settlement"]),
        sourceRef("Multipli how rwaUSD works (general liquidity-class context; reviewed 2026-10-07)", "https://docs.multipli.fi/rwausd/how-rwausd-works", ["route", "settlement"]),
      ],
    },
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
      sourceRef("Multipli liquidity and redemption risk (reviewed 2026-10-07)", "https://docs.multipli.fi/risks/liquidity-and-redemption-risk", ["route", "settlement"]),
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
      sourceRef(
        "EURCV white paper (notification date 2024-05-30; reviewed 2026-10-07)",
        "https://www.sgforge.com/wp-content/uploads/2025/10/EURCV-White-Paper_iXBRL_202510.html",
        ["route", "capacity", "access", "settlement"],
      ),
    ],
    notes: [
      "White paper describes issuer-side redemption subject to KYC/AML and permitted-transferee checks.",
      "The five-business-day deadline is acknowledgement, not payout. Transfer is due no later than the last Business Day of the month following successful compliance controls; those controls are not time-bounded. No guessed elapsed-second or fixed-business-day completion scalar is asserted.",
    ],
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
    routeStatus: "suspended",
    reviewedAt: "2026-10-07",
    routeSuspension: {
      routeId: "redemption:eurr-stablr:offchain-issuer",
      channel: "StablR direct issuer minting and redemption",
      suspendedAt: "2026-06-24",
      reason:
        "Issuer notice confirms EURR minting and redemption remained suspended as of 24 June 2026 following the security incident. This is the source-confirmed suspension-as-of date, not a claim about its original onset; no newer issuer reopening evidence was established in the 2026-10-07 review.",
      reviewer: "Pharos",
      reviewedAt: "2026-10-07",
      sources: [{
        url: "https://www.stablr.com/insights/notification-update-24-06-2025",
        quote: "Minting and redemption of EURR and USDR remain suspended as a precaution, and there has been no further unauthorised issuance.",
      }],
    },
    costModel: fixedFee(0, "StablR docs state qualified businesses can onramp and offramp EURR at no additional cost"),
    docs: [
      sourceRefRouteCapacityFees("What is EURR", "https://docs.stablr.com/docs/what-is-eurr"),
      sourceRefRouteCapacity("StablR overview", "https://docs.stablr.com/docs/overview"),
      sourceRef("StablR suspension update (rendered 24 June 2026; reviewed 2026-10-07)", "https://www.stablr.com/insights/notification-update-24-06-2025", ["route", "access"]),
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
    costModel: fixedFee(
      15,
      "Telcoin eXYZ Terms of Use section 24 (dated 2026-06-30; reviewed 2026-10-03): Telcoin LLC redeems eXYZs for their equivalent value minus a 0.15% redemption fee. This is the issuer fee only; wire, international-transfer, expedited-processing, and other partner charges are passed through and unquantified",
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
    ...documentedBoundSupplyFull("2026-10-09"),
    accessModel: "manual",
    settlementModel: "days",
    outputAssetType: "stable-single",
    unresolvedOutputAssetKeys: ["fiat:JPY"],
    unresolvedOutputDisposition: "reviewed-external",
    costModel: documentedVariableFee(
      "Direct issuer redemption costs 3,000 JPY plus applicable consumption tax per procedure; the holder also pays bank-transfer and blockchain gas/network charges, with no published all-in USD ceiling",
    ),
    holderEligibility: "verified-customer",
    routeExitCorrelation: "independent-issuer-rail",
    v9RouteReviewTerms: {
      settlementModel: "days",
      scoringDisposition: "bounded-terms-gap",
      missingScoringFields: ["capacity", "settlement", "cost"],
      rationale:
        "The direct issuer route is an application/email procedure, followed by identity and legality checks, transfer to the designated wallet, and JPY bank payment. Section 4(2) sets a standard of two Japanese bank business days after request acceptance but allows verification-related extensions. The no-amount-ceiling clause establishes a legal/eventual bound only; current executable capacity, an unconditional settlement SLA, and a scored-notional all-in USD cost are not established. Native JPY output remains explicitly unpriced.",
      reviewedAt: "2026-10-09",
      docs: [
        sourceRef(
          "SBI Shinsei Trust JPYSC direct procedure (reviewed 2026-10-09)",
          "https://www.shinseitrust.com/stablecoin/jpysc.html",
          ["route", "access", "settlement", "fees"],
        ),
        sourceRef(
          "JPYSC terms updated 2026-09-30, sections 2(2), 4(1)-(3), 4(11)-(12) (reviewed 2026-10-09)",
          "https://www.shinseitrust.com/stablecoin/pdf/jpysc_terms_20260930.pdf",
          ["route", "access", "settlement", "fees", "capacity"],
        ),
      ],
    },
    docs: [
      sourceRef("SBI Shinsei Trust JPYSC product page", "https://www.shinseitrust.com/stablecoin/jpysc.html", [
        "route",
        "access",
        "settlement",
        "fees",
      ]),
      sourceRef(
        "SBI Shinsei Trust JPYSC terms (updated 2026-09-30; reviewed 2026-10-07)",
        "https://www.shinseitrust.com/stablecoin/pdf/jpysc_terms_20260930.pdf",
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
      "Fee review 2026-10-07: the 2026-09-30 terms, sections 4(3)(ro) and 4(11)(ni), charge 3,000 JPY plus applicable consumption tax per direct redemption procedure; holder-borne bank transfer and network fees are separate. V9 has no fixed-maximum-in-JPY term, so no bps ceiling or invented USD conversion is added.",
      "Sol curation campaign 2026-10-09 (Lane09Ripio), observed 2026-10-09T10:38:55Z: the current governing terms specify two Japanese bank business days as a conditional standard after request acceptance. The direct email/application channel is manual, not the inherited issuer API/same-day route; checks can extend the period, and no Japan banking calendar or unconditional elapsed-seconds SLA is authored.",
    ],
  },
  "hlusd-hela": {
    ...issuerBase,
    accessModel: "manual",
    settlementModel: "days",
    executionModel: "opaque",
    outputAssetType: "stable-basket",
    outputAssets: ["usdc-circle", "usdt-tether"],
    capacityModel: { kind: "unquantified" },
    costModel: fixedFee(100, "StableHodl documents a 1% OTC fee for selling HLUSD"),
    holderEligibility: "unknown",
    reviewedAt: "2026-10-07",
    v9RouteReviewTerms: {
      scoringDisposition: "bounded-terms-gap",
      missingScoringFields: ["capacity", "settlement", "cost"],
      rationale:
        "HeLa's backing and 1:1 product claims do not establish StableHodl OTC inventory or a full-supply redemption obligation. The manual sell/claim rail publishes a 1% OTC fee but no executable size, completion maximum or all-in deductions; eligibility remains unknown.",
      reviewedAt: "2026-10-07",
      docs: [
        sourceRef("HeLa HLUSD minting/redemption (reviewed 2026-10-07)", "https://docs.helalabs.com/hlusd/minting-redemption-of-hlusd", ["route", "access"]),
        sourceRef("StableHodl HLUSD sell and claim guide (reviewed 2026-10-07)", "https://docs.stablehodl.com/product/trade-hlusd", ["route", "access", "fees", "settlement"]),
      ],
    },
    docs: [
      sourceRef("HeLa HLUSD documentation", "https://docs.helalabs.com/hlusd/editor", ["route", "access"]),
      sourceRef("HeLa HLUSD benefits", "https://docs.helalabs.com/hlusd/markdown", ["route"]),
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
      "Capacity is unquantified: neither HeLa collateral nor the 1:1 promise proves StableHodl cash-out inventory. StableHodl publishes no funded amount, processing-time SLA, geographic eligibility or current availability; days is diagnostic only.",
      "The documented OTC fee is 1%; wallet connection and a separate claim step remain part of the opaque execution flow, while DEX trading is excluded.",
    ],
  },
};
