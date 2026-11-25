import type { RedemptionBackstopConfig } from "../shared";
import {
  documentedBoundSupplyFull,
  documentedVariableFee,
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

/** Current VNX Global institutional route; VCHF adds its published CHF fee
 *  components independently below. */
const vnxGitbookBase: RedemptionBackstopConfig = {
  ...issuerBase,
  ...reviewedDirectRedemptionSupplyFull,
  reviewedAt: "2026-10-17",
  holderEligibility: "whitelisted-primary",
  settlementModel: "days",
  costModel: undisclosedReviewedFee(
    "At-par redemption through VNX Global Ltd. for verified institutional customers; the reviewed product pages do not establish an all-in redemption cost for VGBP",
  ),
  docs: [
    sourceRef(
      "VNX Global institutional minting and redemption (reviewed 2026-10-17)",
      "https://vnx.gitbook.io/vnx-global/institutional/products/minting-and-redemption",
      ["route", "capacity", "access", "settlement"],
    ),
    sourceRef(
      "VNX Global stablecoins and conditional at-par redemption",
      "https://vnx.gitbook.io/vnx-global/institutional/products/stablecoins",
      ["route", "capacity", "access", "settlement"],
    ),
    sourceRef("VNX Global website", "https://vnx.io/", ["route"]),
  ],
  v9RouteReviewTerms: {
    settlementModel: "days",
    scoringDisposition: "bounded-terms-gap",
    missingScoringFields: ["capacity", "settlement", "cost"],
    rationale:
      "The institutional product pages establish verified-customer access and a CHF/GBP 100,000 minimum transaction threshold, but no executable same-notional capacity floor or complete all-in cost. Fiat to the customer bank averages approximately one business day; eligibility, AML/ATF checks, operational controls and liquidity conditions still apply. An average is not a binding completion maximum or an unconditional settlement SLA.",
    reviewedAt: "2026-10-17",
    docs: [
      sourceRef(
        "VNX Global institutional minting and redemption",
        "https://vnx.gitbook.io/vnx-global/institutional/products/minting-and-redemption",
        ["route", "capacity", "access", "settlement"],
      ),
      sourceRef(
        "VNX Global stablecoins: governing terms and liquidity conditions",
        "https://vnx.gitbook.io/vnx-global/institutional/products/stablecoins",
        ["route", "capacity", "access", "settlement"],
      ),
    ],
  },
  notes: [
    "Pharos VNX correction review (issue #1462), 2026-10-17: VNX Global Ltd. is the current Bermuda-licensed issuer. The institutional route is for verified institutional customers only; VCHF and VGBP have minimum transaction thresholds of CHF 100,000 and GBP 100,000 respectively. The config schema supports only a USD numeric minimum, so no native-currency threshold is relabelled as minRedeemUsd.",
    "Redemption is customer-initiated at face value, through direct cancellation against reserves or buyback into VNX's liquidity pool. Fiat to the customer's bank averages approximately one business day. Optional external-provider crypto conversion is a separate approximately three-hour leg, not the modeled fiat endpoint or an unconditional completion guarantee.",
    "Conditional eligibility, AML/ATF and liquidity controls remain operative. Daily redemptions above 10% of supply trigger liquidity-position review and emergency reserve-tranche access; that threshold is not a redemption capacity ceiling or funded executable liquidity. Supply-full remains an eventual issuer-term model only, with capacity, settlement and all-in cost withheld from scoring until separately bound.",
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
  "itry-brix": {
    ...issuerBase,
    capacityModel: { kind: "unquantified" },
    reviewedAt: "2026-11-15",
    holderEligibility: "whitelisted-primary",
    settlementModel: "days",
    executionModel: "opaque",
    outputAssetType: "mixed-collateral",
    unresolvedOutputDisposition: "issuer-undisclosed",
    costModel: undisclosedReviewedFee("iTRY Token Terms section 15 permits request-specific fees and changes; no complete numeric all-in redemption fee schedule is published."),
    v9RouteReviewTerms: {
      scoringDisposition: "bounded-terms-gap",
      missingScoringFields: ["capacity", "settlement", "cost"],
      rationale: "Eligible whitelisted customers may redeem for one TRY notional in issuer-selected supported digital assets. No exact funded same-notional capacity, complete payout identity set, unconditional completed-receipt maximum or all-in fee bound is established. Operational delays and issuer suspension remain possible.",
      reviewedAt: "2026-11-15",
      docs: [
        sourceRef("iTRY Token Terms sections 5, 7 and 15", "https://docs.brix.money/resources/terms-and-policies/itry-token-terms.md", ["route", "access", "fees", "settlement"]),
      ],
    },
    docs: [
      sourceRef("iTRY Token Terms sections 5, 7 and 15", "https://docs.brix.money/resources/terms-and-policies/itry-token-terms.md", ["route", "access", "fees", "settlement"]),
      sourceRef("Brix primary-market eligibility", "https://docs.brix.money/itry/eligibility.md", ["route", "access"]),
      sourceRef("Brix mint and redemption interface", "https://docs.brix.money/itry/mint-and-redemption.md", ["route", "access"]),
      sourceRef("Brix collateral management: limited fast buffer and larger-redemption delays", "https://docs.brix.money/technical/collateral-management.md", ["capacity", "settlement"]),
    ],
    notes: [
      "KYC/AML approval and onchain whitelisting are required. Payout is supported digital assets at a TRY notional, not a guaranteed TRY bank payment; the complete current output set remains unknown.",
      "The Company may decline or suspend redemption for compliance, operational, risk or solvency reasons. The days category is diagnostic, not an unconditional completion bound.",
      "The disclosed Fast Access Vault is a routine buffer, not proved whole-book capacity. Its observed zero available balance does not establish exhaustion of other issuer resources.",
    ],
  },
  "copm-minteo": {
    ...issuerBase,
    reviewedAt: "2026-11-15",
    accessModel: "issuer-api",
    holderEligibility: "verified-customer",
    settlementModel: "days",
    routeStatus: "unknown",
    routeExitCorrelation: "independent-issuer-rail",
    unresolvedOutputAssetKeys: ["fiat:COP"],
    unresolvedOutputDisposition: "reviewed-external",
    capacityModel: { kind: "unquantified" },
    costModel: documentedVariableFee(
      "Minteo discloses customer-specific local tax withholding before each redemption. Customers pay outgoing wallet gas and their own outgoing bank fees; no complete issuer, bank, tax or network cost ceiling is published.",
      "documented-variable",
    ),
    v9RouteReviewTerms: {
      settlementModel: "days",
      scoringDisposition: "bounded-terms-gap",
      missingScoringFields: ["capacity", "settlement", "cost"],
      rationale:
        "Minteo's public documentation establishes manually approved business AML/KYC access, gross 1:1 COPM redemption, and API orders from the customer's own wallet to the customer's own bank account. The COP 10,000 minimum is a native-currency threshold, not a USD amount. No current executable capacity, unconditional completed bank-credit deadline or complete all-in redemption cost is established. The days category is conservative diagnostic metadata rather than a settlement SLA; fiat:COP requires admitted captured FX for valuation.",
      reviewedAt: "2026-11-15",
      docs: [
        sourceRef("Minteo tokenization and redemption, reviewed November 15 2026", "https://transparency.minteo.com/tokenizationAndRedemtion", ["route", "access", "fees"]),
        sourceRef("Minteo Create an Order API: customer wallet to own bank account, COPM minimum", "https://docs.minteo.com/orders/create-order", ["route", "access", "settlement"]),
      ],
    },
    docs: [
      sourceRef("Minteo tokenization and redemption, reviewed November 15 2026", "https://transparency.minteo.com/tokenizationAndRedemtion", ["route", "access", "fees"]),
      sourceRef("Minteo Create an Order API: customer wallet to own bank account, COPM minimum", "https://docs.minteo.com/orders/create-order", ["route", "access", "settlement"]),
    ],
    notes: [
      "Businesses request manual onboarding and must pass Minteo's AML/KYC approval. The API supports redemption only from the customer's own wallet to the customer's own bank account; third-party payouts are a separate service.",
      "The published minimum for both tokenization and redemption is COP 10,000. No static minRedeemUsd conversion is authored, and gross 1:1 COP redemption does not imply a dollar payout or a zero-cost route.",
      "The reserve report corroborates historical backing, not immediately executable redemption inventory. Capacity remains unquantified, current openness unknown, and bank-credit timing and all-in fees unbounded.",
    ],
  },
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
  "vgbp-vnx": {
    ...vnxGitbookBase,
    reviewedAt: "2026-10-20",
    costModel: {
      ...documentedVariableFee(
        "VNX Global Terms Annex III(C) charges GBP 30 for a GBP SWIFT withdrawal from the platform account. The separate 3% unused-funds charge depends on cumulative account funding above USD 100,000-equivalent and less than 75% usage; Annex III(A)'s 2% conversion fee applies to a separate instructed service. Account-history, payout-rail, network and third-party charges remain scenario-dependent and unbounded.",
        "formula",
      ),
      feeComponents: [{ currency: "GBP", terms: { flatAmount: 30 } }],
    },
    docs: [
      ...vnxGitbookBase.docs!,
      sourceRef(
        "VNX Global Terms Annex III(C), GBP SWIFT fee reviewed 2026-10-20",
        "https://prod-global-terms.s3.sa-east-1.amazonaws.com/VNX-Global-Terms.pdf",
        ["route", "fees", "access", "settlement"],
      ),
    ],
    notes: [
      ...vnxGitbookBase.notes!,
      "Fee-component review, 2026-10-20: GBP 30 binds one GBP SWIFT platform-account withdrawal only. The separate 3% unused-funds charge is account-history-dependent; payout count and other applicable charges are unbound. Preserve all capacity, settlement and cost scoring gaps and the October 17 terms-gap review; no all-in fee ceiling or completed bank-credit SLA is established.",
    ],
  },
  "vchf-vnx": {
    ...vnxGitbookBase,
    reviewedAt: "2026-10-17",
    costModel: {
      ...documentedVariableFee(
        "VNX Global Terms Annex III(C) charges CHF 30 for a CHF SWIFT withdrawal from the platform account. The separate 3% unused-funds charge depends on cumulative account funding above USD 100,000-equivalent and less than 75% usage; Annex III(A)'s 2% conversion fee applies to a separate instructed service. Account-history, payout-rail, network and third-party charges remain scenario-dependent and unbounded.",
        "formula",
      ),
      feeComponents: [{ currency: "CHF", terms: { flatAmount: 30 } }],
    },
    docs: [
      ...vnxGitbookBase.docs!,
      sourceRef(
        "VNX Global current VCHF terms and fee schedule (fee review retained 2026-10-09)",
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
      ...vnxGitbookBase.notes!,
      "Pharos VNX correction review (issue #1462), 2026-10-17: the current institutional documentation complements the governing VNX Global terms, previously reviewed 2026-10-09. Those terms permit reserve-related delay and in-kind redemption. No unconditional settlement SLA, complete cash output or currently executable capacity is inferred.",
      "Fee review retained 2026-10-09: the CHF 30 component binds one CHF SWIFT account withdrawal, not every possible VCHF payout rail. The separate 3% unused-funds charge remains account-history-dependent. No feeBpsMax, minFeeUsd, gasOrBridgeCostUsd or all-in ceiling is authored; the account history, rail, payout count and remaining charges are unbound.",
    ],
  },
  "tryb-bilira": {
    ...issuerBase,
    ...reviewedDirectRedemptionSupplyFull,
    costModel: documentedVariableFee(
      "BiLira Kripto's published deposit/withdrawal tariff lists Banka Transferi as Ücretsiz (free) for both directions, reviewed 2026-10-05. The known zero applies only to that issuer-platform bank-transfer leg, not the complete TRYB redemption: crypto withdrawal charges vary by network, and holder gas, conversion applicability, third-party commissions and taxes remain separate and unquantified. No all-in zero fee or route-wide ceiling is asserted.", "documented-variable",
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
      sourceRef("JPYC pre-contract disclosure revised 2026-09-24", "https://jpyc.co.jp/legal/pre-contract-disclosure.pdf", ["route", "access", "fees", "settlement"]),
      sourceRef("JPYC funds-transfer terms", "https://jpyc.co.jp/legal/terms.pdf", ["route", "access", "fees", "settlement"]),
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
    accessModel: "issuer-api",
    holderEligibility: "whitelisted-primary",
    settlementModel: "days",
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
      sourceRef("AnchorX served Terms, sections 2-4: Professional Investors under SFO Schedule 1 Part 1 only, age 18 or older, account credentials (undated; access reviewed 2026-11-06)", "https://anchorx.org/assets/index-58bf9fd6.js", ["access"]),
      sourceRef("AnchorX authenticated subscription/redemption portal (undated; access reviewed 2026-11-06)", "https://onlineportal.anchorx.org/login", ["access"]),
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
      feeComponents: [{ currency: "IDR", terms: { flatAmount: 6_500 } }],
    },
    docs: [
      sourceRefRouteCapacity("Rupiah Token website", "https://www.rupiahtoken.com/"),
      sourceRef(
        "Rupiah Token IDRT-to-IDR withdrawal fee FAQ",
        "https://rupiahtoken.com/faq/berapa-biaya-pencairan-idrt-ke-idr",
        ["fees"],
      ),
      sourceRef(
        "IDRT verified-customer withdrawal process",
        "https://rupiahtoken.com/faq/bagaimana-cara-withdraw-idrt-yang-saya-miliki-di-rupiahtoken-com",
        ["route", "access"],
      ),
      sourceRef(
        "IDRT queue-dependent bank receipt",
        "https://rupiahtoken.com/faq/berapa-waktu-yang-dibutuhkan-hingga-rupiah-masuk-ke-rekening-bank-saya",
        ["settlement"],
      ),
      sourceRef(
        "IDRT business hours and national-holiday closure",
        "https://rupiahtoken.com/faq/apakah-layanan-pencairan-idrt-aktif-24-jam",
        ["settlement"],
      ),
    ],
    notes: [
      "Re-reviewed 2026-10-09: the issuer fee FAQ binds 0.5% plus IDR 6,500 for a bank transfer when applicable. The component conservatively includes that conditional charge for one transfer; it does not assert that every scored request uses exactly one payout.",
      "The retained 50 bps minimum is a floor, not an all-in ceiling. No feeBpsMax, minFeeUsd or gasOrBridgeCostUsd is invented. Captured IDR/USD conversion is supported, but payout cardinality, charge applicability and any remaining bank charges are not bound; cost stays unresolved. Capacity, settlement and holder eligibility are unchanged.",
    ],
  },
  "idrx-idrx": {
    ...issuerBase,
    ...reviewedIssuerApiExpansionSupplyFull,
    costModel: {
      ...documentedVariableFee(
        "IDRX's published bank-rail base tariff is IDR 5,000 below IDR 250,000,000 via BI-FAST and IDR 35,000 at or above it via RTGS; bank-specific limits can select RTGS earlier. The component conservatively uses IDR 35,000 for one bank payout, not an all-in ceiling; additional bank/amount-dependent fees and payout cardinality remain unbounded.",
        "formula",
      ),
      feeComponents: [{ currency: "IDR", terms: { flatAmount: 35_000 } }],
    },
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
      sourceRef(
        "IDRX additional redemption fees depend on receiving bank and amount",
        "https://docs.idrx.co/api/transaction-api/get-api-transaction-get-additional-fees",
        ["fees"],
      ),
    ],
    notes: [
      "Primary modeled route is the issuer's direct burn-to-bank-account redemption flow for IDRX rather than the separate partner-mediated other-stablecoin off-ramp",
      "The fee table states BI-FAST below Rp250,000,000 is real-time, 24/7, while RTGS at or above that threshold operates Monday–Friday, 08:00–15:00 WIB. Bank-specific lower BI-FAST limits may force RTGS earlier; no unconditional calendar-time bank-credit bound is inferred from that office-hours window.",
      "Fee re-review 2026-10-09: the additional-fees API documentation discloses bank/amount-dependent charges and uses a conflicting exact-IDR-250,000,000 boundary. Its sample payment-gateway amount is not a live quote. IDR 35,000 bounds only the published base tariff for one of the named bank rails; no complete bank/e-wallet schedule or single-payout guarantee is established, so feeBpsMax remains absent.",
    ],
  },
  "mxnb-juno": {
    ...issuerBase,
    ...reviewedIssuerApiExpansionSupplyFull,
    outputAssetType: "stable-basket",
    outputAssets: ["usdc-circle", "usdt-tether"],
    holderEligibility: "unknown",
    settlementModel: "days",
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
    accessModel: "manual",
    holderEligibility: "verified-customer",
    costModel: fixedFee(
      0,
      "EURØP tokens can be redeemed and exchanged for the underlying legal tender currency at any time, as described in the Right to Redemption above, without fees.",
    ),
    docs: [
      sourceRefRouteCapacity("EUROP white paper", "https://schuman.io/wp-content/uploads/2025/02/EUROP-White-Paper_1.3.pdf"),
      sourceRef("EUROP white paper v1.7", "https://schuman.io/wp-content/uploads/EUROP-White-Paper.pdf", ["fees"]),
      sourceRef("Schuman reserve audits", "https://schuman.io/reserve-attestations/", ["capacity"]),
      sourceRef(
        "Schuman current Redemption Policy and token/platform terms (retrieved 2026-10-20)",
        "https://schuman.io/legal-center/",
        ["route", "access", "settlement", "fees"],
      ),
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
  "usdrf-realfi": {
    ...issuerBase,
    reviewedAt: "2026-11-15",
    accessModel: "manual",
    holderEligibility: "whitelisted-primary",
    settlementModel: "queued",
    capacityModel: { kind: "unquantified" },
    costModel: undisclosedReviewedFee(
      "RealFi Reserve's Institutional Minting Agreement section 7 says it currently charges no fee of its own but may charge fees disclosed when an order is initiated. Cardano network, wallet and bank charges are separate. No fee schedule or all-in cost ceiling is published.",
    ),
    v9RouteReviewTerms: {
      scoringDisposition: "bounded-terms-gap",
      missingScoringFields: ["capacity", "settlement", "cost"],
      rationale:
        "The July 23, 2026 Institutional Minting Agreement limits direct redemption to whitelisted institutional Mint Users of RealFi Reserve Ltd. at one U.S. dollar, or an equivalent Eligible Asset, per USDrf less applicable fees. RealFi's redemption FAQ describes a human-approved first-in-first-out queue under daily and monthly throttle limits whose amounts are unpublished; timing depends on queue position and reserve composition and is not guaranteed within any window. Section 8 promises only commercially reasonable processing efforts and permits suspension on a reserve adequacy or liquidity breach, and section 9 lets the issuer set or change limits at its discretion. No executable same-notional capacity, completed-payout maximum or all-in cost bound is established.",
      reviewedAt: "2026-11-15",
      docs: [
        sourceRef("RealFi FAQ: How can I redeem USDrf?", "https://docs.realfi.co/frequently-asked-questions/how-can-i-redeem-usdrf", ["route", "access", "capacity", "settlement"]),
        sourceRef("USDrf Institutional Minting Agreement, July 23, 2026, sections 7-9", "https://docs.realfi.co/essential-policies/usdrf-institutional-minting-agreement", ["route", "access", "capacity", "settlement", "fees"]),
      ],
    },
    docs: [
      sourceRef("RealFi FAQ: How can I redeem USDrf?", "https://docs.realfi.co/frequently-asked-questions/how-can-i-redeem-usdrf", ["route", "access", "capacity", "settlement"]),
      sourceRef("USDrf Institutional Minting Agreement, July 23, 2026, sections 1-2 and 6-10", "https://docs.realfi.co/essential-policies/usdrf-institutional-minting-agreement", ["route", "access", "capacity", "settlement", "fees"]),
      sourceRef("USDrf Terms, July 23, 2026, sections 2 and 4: no direct redemption claim without an issuer account", "https://docs.realfi.co/essential-policies/usdrf-terms-of-use", ["access"]),
      sourceRef("RealFi peg stability: queued institutional path, market-maker PSM and circuit breakers", "https://docs.realfi.co/glass-box-approach/peg-stability", ["route", "capacity", "settlement"]),
    ],
    notes: [
      "Only legal entities onboarded through KYB as Mint Users, with a whitelisted Cardano address, can redeem; U.S. and EU entities are ineligible. The USDrf Terms give holders without an issuer account no direct redemption claim, and whitelisting may be denied, suspended or revoked. Retail holders exit through Cardano DEX liquidity, which this issuer route does not model.",
      "Mint Users choose the Eligible Asset for each Redeem Order: U.S. dollars to a connected bank account, USDC, or other assets the issuer accepts from time to time. The fiat USD output follows the base redemption obligation; no stablecoin payout identity is asserted.",
      "The daily and monthly throttle limits are unpublished, and RealFi says automated circuit breakers will slow redemptions as liquidity coverage approaches minimum thresholds. Throttles, discretionary limits and suspension rights leave capacity unquantified.",
      "RealFi's stated buffer of 10-20% of TVL in Treasuries and money market funds, its 10% floor and its target of liquid reserves covering 120% of expected 7-day net redemptions are unverified reserve policy. No attestation was published by 2026-11-15, so these targets establish no executable capacity.",
      "The peg-stability page also describes a PSM that market makers use for near-instant swaps under limits. No contract, access terms, fees or capacity are published for it, so it is not modeled as a holder route.",
    ],
  },
  "cash-phantom": {
    ...issuerBase,
    ...reviewedDirectRedemptionSupplyFull,
    costModel: {
      ...documentedVariableFee("Swap from Cash account into other stablecoins on Solana (USDT, USDG, PYUSD): 0.85%", "documented-variable"),
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
    accessModel: "issuer-api",
    holderEligibility: "verified-customer",
    settlementModel: "days",
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
      sourceRef("Brale Business User Agreement, May 27, 2026, sections 2.1-2.5 and 3.2: accepted and verified incorporated US businesses where authorized; individuals and sole proprietors excluded (access reviewed 2026-11-06)", "https://brale.xyz/legal/business-user-agreement", ["access"]),
      sourceRef("Brale API Services Schedule, May 27, 2026: opted-in Program Partners use authenticated API or Portal (access reviewed 2026-11-06)", "https://brale.xyz/legal/api-services-schedule", ["access"]),
    ],
  },
  "m-m0": {
    ...issuerBase,
    ...reviewedDirectRedemptionSupplyFull,
    costModel: documentedVariableFee(
      "MXON's public service terms require separate written counterparty agreements, and M0's primary-market liquidity guide requires issuer onboarding; neither retrieved disclosure publishes a binding direct M institutional redemption fee or all-in cost maximum. SwapFacility no-trading-fee extension conversions and onchain minter-debt burns are different routes", "documented-variable",
    ),
    docs: [
      sourceRefRouteCapacityAccess("M0 FAQ", "https://www.m0.org/faq"),
      sourceRef("M0 Dashboard", "https://dashboard.m0.org/", ["capacity"]),
      sourceRef("MXON website terms: separate counterparty service agreements (observed 2026-10-10T23:34:49Z; L31M)", "https://www.mxon.co/terms-of-use", ["fees", "access"]),
      sourceRef("M0 primary-market issuer onboarding and distinct SwapFacility conversions (observed 2026-10-10T23:34:49Z; L31M)", "https://docs.m0.org/build/accessing-liquidity", ["fees", "access"]),
    ],
    notes: [
      "Base $M liquidity is institution-facing; most end users access M0 liquidity through branded extensions and integrations rather than direct M redemption",
      "Cost-only disclosure review observed 2026-10-10T23:34:49Z by Sol curation campaign 2026-10-11 (L31M): MXON Website Terms of Use section 2 places services under separate written agreements. The terms print Last updated: March 2026, without an exact day; no precise evidence date or fee value is inferred. This review does not refresh capacity, settlement, access configuration or the older composed-wrap checkpoint",
      "The prior direct-wrapper composition is removed because the reviewed current WrappedMToken entrypoints are facility-only; no ordinary-holder native-M facility permission or current exact composite execution receipt was established.",
    ],
  },
  "fusd-finchain": {
    ...issuerBase,
    ...documentedBoundSupplyFull("2026-05-24"),
    outputAssets: ["usdt-tether"],
    settlementModel: "days",
    v9RouteReviewTerms: {
      businessDayTerms: {
        businessDays: 3, calendarId: "hong-kong-banking",
        cutoff: { time: "08:00", timezone: "Asia/Hong_Kong" },
        assurance: "target", conditional: true,
        conditions: ["Universal FUSD-to-USDT redemption is described as typically completed within one business day but may take up to three business days (UTC+8); this is an operational timing statement, not a binding unconditional payment guarantee"],
        accessPrerequisites: ["Completed KYC/KYB and all account settings, including upgrading the wallet to FinPass ID if needed", "Redemption order created and FUSD payment completed"],
        startEvent: "FUSD-paid universal redemption order included in Hong Kong business-day processing; requests after 08:00 Hong Kong time roll to the next business day",
      },
      reviewedAt: "2026-10-11",
      docs: [
        sourceRef("FinChain universal FUSD-to-USDT redemption: KYC/KYB, funded order and operational one-to-three-business-day timing; reviewed by Sol curation campaign 2026-10-11 (P7MidasFusdSettlement)", "https://finchain.gitbook.io/finchain-docs/en/fusd/fusd-token/redeem.md", ["settlement", "access"]),
        sourceRef("FinChain Hong Kong business-day processing, 08:00 cutoff and next-business-day rollover; reviewed by Sol curation campaign 2026-10-11 (P7MidasFusdSettlement)", "https://finchain.gitbook.io/finchain-docs/en/fusd/fusd-token/cut-off-time.md", ["settlement"]),
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
  "thbill-theo": {
    ...issuerBase,
    ...reviewedDirectRedemptionSupplyFull,
    outputAssetType: "stable-basket",
    outputAssets: ["usdc-circle", "usdt-tether"],
    costModel: documentedVariableFee(
      "KYC/KYB-gated redemption pays USDC or USDT; current thBILL documents do not establish an all-in numeric redemption fee", "documented-variable",
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
    v9RouteReviewTerms: {
      scoringDisposition: "bounded-terms-gap",
      missingScoringFields: ["settlement"],
      rationale: "The September 30, 2026 white paper I.07 grants EEA-resident holders redemption at par. Five Business Days bounds acknowledgement only. After successful KYC/AML, sanctions and other controls and applicable token delivery, the issuer will transfer Euro to the holder's cash account no later than the last Business Day of the month following the month controls completed. Controls have no published completion maximum. This conditional month-end payment commitment cannot be represented by a fixed businessDays or elapsed-second value; no scalar or unconditional request-to-completion guarantee is inferred.",
      reviewedAt: "2026-11-06",
      docs: [sourceRef("EURCV white paper v2.2, September 30, 2026, I.07: conditional month-end cash-account payment", "https://www.sgforge.com/wp-content/uploads/2026/09/EURCV-WP-Ethereum_Solana_XRPL_Stellar_Canton_2026-09-30.pdf", ["route", "access", "settlement"])],
    },
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
    costModel: fixedFee(
      0,
      "Monerium's October 15, 2026 EURe SEPA disclosure states zero Monerium fees, but explicitly leaves third-party and onchain transaction costs outside that issuer fee",
    ),
    docs: [
      sourceRefRouteCapacity("EURe MiCA white paper", "https://monerium.com/whitepapers/eure-whitepaper.xhtml"),
      sourceRef(
        "Monerium EURe SEPA fees and third-party-cost disclosure, October 15, 2026",
        "https://monerium.com/blog/2026/supply-and-borrow-regulated-euros-on-arbitrum-with-eure/",
        ["route", "fees", "settlement"],
      ),
      sourceRef(
        "Monerium Business Terms, sections 4 and 14",
        "https://monerium.com/policies/business-terms-of-service/",
        ["route", "access", "fees", "settlement"],
      ),
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
