import type { RedemptionBackstopConfig } from "../shared";
import {
  documentedBoundSupplyFull,
  documentedVariableFee,
  undisclosedReviewedFee,
  expandIds,
  fixedFee,
  issuerBase,
  commodityIssuerBase,
  sourceRef,
} from "../shared";
import {
  reviewedDirectRedemptionSupplyFull,
  REVIEWED_DIRECT_REDEMPTION_AT,
  REVIEWED_FOLLOWUP_REMEDIATION_AT,
  REVIEWED_REMEDIATION_AT,
} from "./shared";

export const REMEDIATION_AND_LATE_AUDIT_OFFCHAIN_CONFIGS: Record<string, RedemptionBackstopConfig> = {
  ...expandIds(["kau-kinesis", "kag-kinesis"], {
    ...commodityIssuerBase,
    ...reviewedDirectRedemptionSupplyFull,
    costModel: {
      ...documentedVariableFee("KAU: 0.45% + $100 + delivery fee; KAG: 0.45% + $100 + delivery fee"),
      feeBpsMax: 45,
    },
    docs: [
      sourceRef("Kinesis fees", "https://kinesis.money/about-us/fees/", ["route", "capacity", "fees"]),
      sourceRef(
        "Kinesis physical redemption guide",
        "https://support.kinesis.money/hc/en-gb/articles/12439302237085-How-to-redeem-physical-gold-and-silver-bullion",
        ["route", "capacity", "access", "settlement"],
      ),
    ],
  }),
  "cgo-comtech": {
    ...commodityIssuerBase,
    ...documentedBoundSupplyFull(REVIEWED_REMEDIATION_AT),
    costModel: documentedVariableFee("Physical gold coins via ComTech Gold app; minimum 10 grams in 1-gram multiples"),
    docs: [
      sourceRef("ComTech Gold digital gold", "https://comtechgold.com/Digitalgold", ["route", "capacity", "fees"]),
      sourceRef("ComTech Gold terms", "https://comtechgold.com/Termsandconditions", ["route", "capacity", "access"]),
    ],
  },
  "dgld-gold-token-sa": {
    ...commodityIssuerBase,
    ...documentedBoundSupplyFull(REVIEWED_REMEDIATION_AT),
    costModel: fixedFee(0, "No custody or transfer fees per Gold Token SA; minimum 1 gram"),
    docs: [
      sourceRef("DGLD homepage", "https://dgld.ch/", ["route", "capacity"]),
      sourceRef("DGLD Swiss redemptions", "https://dgld.ch/news/dgld-european-swiss-redemptions", [
        "route",
        "capacity",
        "access",
        "settlement",
      ]),
    ],
  },
  // Re-reviewed 2026-08-19 (issue #865). The issuer route itself is unchanged
  // and still documented, but the prior 2026-03-23 stamp predated the events
  // that made it the *only* route: WUSD lost every CEX venue between 07-25 and
  // 08-04 and circulating fell ~94% (9.99M to 0.61M). A holder who cannot open
  // a WSPN corporate account now has no exit at par, so the eligibility gate is
  // named explicitly rather than left to the access model alone.
  "wusd-worldwide": {
    ...issuerBase,
    ...documentedBoundSupplyFull("2026-08-19"),
    costModel: documentedVariableFee(
      "Redemption is limited to WSPN corporate accounts, which qualified businesses must apply and be verified for; there is no retail redemption path. Approved accounts convert WUSD to USD at a 1:1 rate and WSPN docs say the platform conversion has no handling fee, while bank or network fees may still apply",
    ),
    docs: [
      sourceRef("About WUSD", "https://developer.wspn.io/5768563m0", ["route", "capacity"]),
      sourceRef("WSPN getting started", "https://developer.wspn.io/5778215m0", ["route", "fees"]),
    ],
  },
  "usdgo-osl": {
    ...issuerBase,
    ...reviewedDirectRedemptionSupplyFull,
    costModel: fixedFee(
      0,
      "OSL StableHub launch states USDGO/USD and USDGO/USDC 1:1 exchange rails are zero-fee on platform",
    ),
    docs: [
      sourceRef(
        "OSL StableHub launch",
        "https://www.osl.com/en/announcement/osl-stablehub-grand-launch-multi-stablecoin-and-usd-seamless-1-1-exchange",
        ["route", "capacity", "fees"],
      ),
      sourceRef(
        "OSL USDGO launch",
        "https://www.osl.com/hk-en/press-release/osl-group-officially-launches-regulated-enterprise-stablecoin-usdgo",
        ["route", "capacity"],
      ),
    ],
  },
  "audd-novatti": {
    ...issuerBase,
    ...reviewedDirectRedemptionSupplyFull,
    costModel: documentedVariableFee(
      "AUDC redeems AUDD 1:1; the issuer says minting and redemption are fee-free, but distributors or external bank-account payouts can impose additional charges",
    ),
    docs: [
      sourceRef("AUDD home", "https://www.audd.digital/", ["route", "capacity"]),
      sourceRef(
        "AUDD product disclosure statement",
        "https://www.audd.digital/wp-content/uploads/2026/02/202602_AUDD-PDS.pdf",
        ["route", "capacity", "fees"],
      ),
    ],
  },
  "usdr-stablr": {
    ...issuerBase,
    ...reviewedDirectRedemptionSupplyFull,
    costModel: fixedFee(0, "StablR docs state qualified businesses can onramp and offramp USDR at no additional cost"),
    docs: [
      sourceRef("What is USDR", "https://docs.stablr.com/docs/what-is-eurr-copy", ["route", "capacity", "fees"]),
      sourceRef("StablR overview", "https://docs.stablr.com/docs/overview", ["route", "capacity"]),
    ],
  },
  "pgold-pleasing": {
    ...commodityIssuerBase,
    ...reviewedDirectRedemptionSupplyFull,
    executionModel: "opaque",
    costModel: documentedVariableFee(
      "Physical gold redemption requires KYC and compliance checks, with additional fees, minimums, and logistics that vary by jurisdiction and program terms",
    ),
    docs: [
      sourceRef("PGOLD token features", "https://pleasing.gitbook.io/docs/pleasing-gold-pgold/token-features", [
        "route",
        "capacity",
        "access",
        "fees",
      ]),
      sourceRef("Pleasing AML/CFT policy", "https://pleasing.gitbook.io/docs/legal/aml-cft-and-sanctions-policy", [
        "access",
      ]),
    ],
    notes: [
      "The modeled backstop is the documented physical-delivery redemption rail; spot trading and secondary transfers remain separate, faster paths that do not exercise issuer redemption",
    ],
  },
  "dusd-standx": {
    ...issuerBase,
    capacityModel: { kind: "supply-ratio", ratio: 0.05, confidence: "documented-bound" },
    costModel: undisclosedReviewedFee(
      "Delta-neutral hedging on centralized exchanges; 1:1 USDT/USDC redemption; public fee schedule not disclosed",
    ),
    reviewedAt: REVIEWED_DIRECT_REDEMPTION_AT,
    docs: [
      sourceRef("StandX docs", "https://docs.standx.com/", ["route", "capacity"]),
      sourceRef("StandX website", "https://www.standx.com/", ["route"]),
    ],
    notes: [
      "Tracked metadata describes 1:1 USDT and USDC redemption from a delta-neutral strategy wrapper",
      "The reviewed 5% bound matches the tracked stability-reserve stablecoin fund rather than assuming the full hedged book is instantly withdrawable",
    ],
  },
  "brla-brla-digital": {
    ...issuerBase,
    ...documentedBoundSupplyFull("2026-04-16"),
    costModel: undisclosedReviewedFee(
      "Avenia (formerly BRLA Digital) documents 1:1 BRLA mint and redemption against BRL after KYC; public docs reviewed do not publish a fixed numeric redemption fee",
    ),
    docs: [
      sourceRef("BRLA Digital", "https://brla.digital/", ["route", "capacity"]),
      sourceRef("Avenia documentation", "https://docs.avenia.io/", ["route", "access"]),
    ],
    notes: ["Native multichain fiat-backed BRL stablecoin; KYC-gated primary mint and redeem rail via Avenia"],
  },
  "ctusd-citrea": {
    ...issuerBase,
    ...documentedBoundSupplyFull("2026-04-16"),
    costModel: undisclosedReviewedFee(
      "Citrea documents 1:1 fiat mint and redemption via MoonPay using M0 Protocol infrastructure; MoonPay fiat-ramp fees apply while public docs reviewed do not publish a separate Citrea protocol redemption fee",
    ),
    docs: [
      sourceRef("Citrea", "https://citrea.xyz/", ["route", "capacity"]),
      sourceRef("Citrea documentation", "https://docs.citrea.xyz/", ["route"]),
    ],
    notes: ["Fiat-backed via MoonPay; reserves cryptographically attested on-chain by M0 Validators before minting"],
  },
  "xo-exodus": {
    ...issuerBase,
    ...documentedBoundSupplyFull("2026-04-16"),
    costModel: fixedFee(
      0,
      "MoonPay currently charges no fee for stablecoin redemption; bank, wallet, processing, network, ecosystem, or pass-through banking fees may still apply",
    ),
    docs: [
      sourceRef("Exodus Pay", "https://www.exodus.com/exodus-pay", ["route", "capacity"]),
      sourceRef("MoonPay Stablecoin Terms", "https://www.moonpay.com/legal/stablecoin_terms", ["route", "fees"]),
    ],
    notes: [
      "Solana SPL Token-2022 mint with pausable, permanent-delegate, and transfer-hook authorities held by MoonPay",
    ],
  },
  "usdk-kast": {
    ...issuerBase,
    ...documentedBoundSupplyFull("2026-04-16"),
    costModel: documentedVariableFee(
      "KAST documents 1:1 mint by wrapping M (M0), and redemption by unwrapping; the fiat on/off-ramp is mediated by licensed partners (Tazapay, BitGo, Fireblocks) whose fees apply separately",
    ),
    docs: [
      sourceRef("KAST documentation", "https://docs.kast.finance/", ["route", "capacity"]),
      sourceRef("M0 Dashboard", "https://dashboard.m0.org/", ["capacity"]),
    ],
    notes: ["Solana SPL Token-2022 wrapper around M (M0); mint/redeem gated by KAST app and licensed payment partners"],
  },
  "usdm-mega": {
    ...issuerBase,
    ...documentedBoundSupplyFull("2026-04-16"),
    costModel: undisclosedReviewedFee(
      "USDM is issued on Ethena's USDtb rails; primary redemption follows USDtb's documented issuer rail and is KYC-gated; public USDM-specific redemption fees are not published",
    ),
    docs: [
      sourceRef("MegaETH", "https://www.megaeth.com/", ["route"]),
      sourceRef("Ethena USDtb", "https://ethena.fi/usdtb", ["route", "capacity"]),
    ],
    notes: ["USDM reuses Ethena's USDtb issuer redemption rail; reserve yield funds MegaETH sequencer costs"],
  },
  "usdkg-gold-dollar": {
    ...issuerBase,
    ...documentedBoundSupplyFull("2026-04-16"),
    settlementModel: "days",
    costModel: undisclosedReviewedFee(
      "Gold Dollar documents 1:1 USDKG mint and redemption against USD, KGS, physical gold, or approved cryptocurrencies after KYC/AML; public docs reviewed do not publish a fixed numeric redemption fee",
    ),
    docs: [sourceRef("Gold Dollar USDKG", "https://usdkg.com/", ["route", "capacity"])],
    notes: [
      "Licensed under Kyrgyz Republic Law on Virtual Assets (2022) / Cabinet Resolution No. 514; multiple redemption outputs supported (USD, KGS, physical gold, or approved crypto)",
    ],
  },
  "usat-tether": {
    ...issuerBase,
    ...reviewedDirectRedemptionSupplyFull,
    costModel: undisclosedReviewedFee(
      "USA₮ issuer materials state issued tokens are redeemable 1:1 in U.S. dollars pursuant to Anchorage Digital Bank's terms; public redemption fee schedule is not disclosed",
    ),
    docs: [
      sourceRef("USA₮ homepage", "https://usat.io/", ["route", "capacity"]),
      sourceRef(
        "USA₮ first reserve report",
        "https://usat.io/news/usat-establishes-transparency-benchmark-with-first-reserve-report/",
        ["route", "capacity", "access"],
      ),
      sourceRef("USA₮ website terms", "https://usat.io/terms/", ["access"]),
    ],
  },
  "moveusd-cfx": {
    ...issuerBase,
    ...documentedBoundSupplyFull(REVIEWED_FOLLOWUP_REMEDIATION_AT),
    costModel: documentedVariableFee(
      "CFX documents 1:1 MOVEUSD redemption through designated channels; fees, currency conversions, and account-maintenance charges may apply, and no single fixed public redemption fee is published",
    ),
    docs: [
      sourceRef("MoveUSD overview", "https://docs.moveusd.com/docs/what-is-moveusd", ["route", "capacity", "access"]),
      sourceRef("MoveUSD disclosures", "https://docs.moveusd.com/docs/disclosures-disclaimers", [
        "route",
        "access",
        "fees",
        "settlement",
      ]),
    ],
    notes: [
      "Modeled as CFX's verified-customer designated-channel redemption rail, not secondary-market Perena or Solana liquidity.",
      "Docs state redemptions can use designated bank accounts, authorized OTC partners, or direct transfer mechanisms, with KYC/AML and good-standing account requirements.",
    ],
  },
};
