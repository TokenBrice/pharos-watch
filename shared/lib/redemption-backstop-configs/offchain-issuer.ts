import type { RedemptionBackstopConfig } from "./shared";
import {
  commodityIssuerBase,
  documentedBoundSupplyFull,
  documentedVariableFee,
  expandIds,
  fixedFee,
  issuerBase,
  NO_PUBLIC_NUMERIC_REDEMPTION_FEE,
  sourceRef,
} from "./shared";

const REVIEWED_DIRECT_REDEMPTION_AT = "2026-03-23";
const reviewedDirectRedemptionSupplyFull = documentedBoundSupplyFull(
  REVIEWED_DIRECT_REDEMPTION_AT,
);

export const OFFCHAIN_ISSUER_BACKSTOP_CONFIGS: Record<string, RedemptionBackstopConfig> = {
  ...expandIds(
    [
      "usdt-tether",
      "usdc-circle",
      "pyusd-paypal",
      "fdusd-first-digital",
      "rlusd-ripple",
      "eurc-circle",
      "usdp-paxos",
      "gusd-gemini",
      "usdg-paxos",
      "usdx-hex-trust",
      "xusd-straitsx",
      "xsgd-straitsx",
      "euri-banking-circle",
      "usdq-quantoz",
      "eurq-quantoz",
      "usd1-world-liberty-financial",
      "ausd-agora",
      "usdo-openeden",
      "usdm-moneta",
      "usdcv-societe-generale-forge",
      "usdh-native-markets",
      "fidd-fidelity",
      "usdgo-osl",
      "wusd-worldwide",
      "sbc-brale",
      "m-m0",
      "usda-anzens",
      "eurcv-societe-generale-forge",
      "aeur-anchored-coins",
      "eure-monerium",
      "usdr-stablr",
      "eurr-stablr",
      "europ-schuman",
      "eurau-allunity",
      "tusd-trueusd",
      "eurs-stasis",
      "gyen-gyen",
      "brz-transfero",
      "tryb-bilira",
      "idrt-rupiah-token",
      "jpyc-jpyc",
      "cadc-cad-coin",
      "tgbp-tokenised",
      "veur-vnx",
      "vchf-vnx",
      "vgbp-vnx",
      "zarp-zarp",
      "audd-novatti",
      "axcnh-anchorx",
      "mnee-mnee",
      "cash-phantom",
      "musd-metamask",
      "a7a5-old-vector",
      "ylds-figure",
      "usat-tether",
      "usdtb-ethena",
      "pusd-plume",
      "pusd-pleasing",
      "gusd-gate",
      "usyc-hashnote",
      "ustb-superstate",
      "tbill-openeden",
      "cetes-etherfuse",
      "usdn-noble",
    ],
    issuerBase,
  ),
  ...expandIds(
    ["usyc-hashnote", "ustb-superstate", "a7a5-old-vector", "gusd-gate"],
    {
      ...issuerBase,
      ...reviewedDirectRedemptionSupplyFull,
    },
  ),
  "usdt-tether": {
    ...issuerBase,
    ...reviewedDirectRedemptionSupplyFull,
    costModel: documentedVariableFee("0.10% with a $1,000 minimum"),
  },
  "usdc-circle": {
    ...issuerBase,
    ...reviewedDirectRedemptionSupplyFull,
    costModel: documentedVariableFee("1:1 via Circle Mint; EEA burn fee is 0 bps, other Circle fees may vary"),
  },
  "pyusd-paypal": {
    ...issuerBase,
    ...reviewedDirectRedemptionSupplyFull,
    costModel: fixedFee(
      0,
      "Paxos states it does not charge a PYUSD redemption fee; bank or network fees may still apply",
    ),
  },
  "fdusd-first-digital": {
    ...issuerBase,
    ...reviewedDirectRedemptionSupplyFull,
    costModel: documentedVariableFee("Redeemable 1:1; public fee schedule not disclosed"),
  },
  "rlusd-ripple": {
    ...issuerBase,
    ...reviewedDirectRedemptionSupplyFull,
    costModel: documentedVariableFee("Redeemable 1:1 less fees; public fee schedule not disclosed"),
  },
  "eurc-circle": {
    ...issuerBase,
    ...reviewedDirectRedemptionSupplyFull,
    costModel: documentedVariableFee("EEA burn fee is 0 bps; other Circle redemption fees may vary"),
  },
  "usdp-paxos": {
    ...issuerBase,
    ...reviewedDirectRedemptionSupplyFull,
    costModel: fixedFee(0, "Paxos states it does not charge a USDP redemption fee"),
    docs: [
      sourceRef("Paxos mint and redeem", "https://www.paxos.com/mint-and-redeem", ["route", "capacity", "fees"]),
    ],
  },
  "gusd-gemini": {
    ...issuerBase,
    ...reviewedDirectRedemptionSupplyFull,
    costModel: fixedFee(0, "Gemini describes GUSD conversion and redemption as fee-free"),
    docs: [
      sourceRef("Gemini Dollar overview", "https://www.gemini.com/dollar", ["route", "capacity"]),
      sourceRef(
        "Gemini GUSD buy and sell guide",
        "https://support.gemini.com/hc/en-us/articles/360001352466-How-do-I-buy-or-sell-my-Gemini-dollar-GUSD",
        ["route", "fees"],
      ),
    ],
  },
  "usdg-paxos": {
    ...issuerBase,
    ...reviewedDirectRedemptionSupplyFull,
    costModel: fixedFee(0, "Paxos states it does not charge a USDG redemption fee"),
  },
  "usdx-hex-trust": {
    ...issuerBase,
    ...reviewedDirectRedemptionSupplyFull,
    costModel: documentedVariableFee("Redeemable through approved parties; public fee schedule not disclosed"),
    docs: [
      sourceRef("HT Digital Assets USDX", "https://www.htdigitalassets.com/", ["route", "capacity"]),
      sourceRef("HT Digital Assets disclaimer", "https://www.htdigitalassets.com/disclaimer", ["route", "access"]),
    ],
  },
  "xusd-straitsx": {
    ...issuerBase,
    ...reviewedDirectRedemptionSupplyFull,
    costModel: documentedVariableFee("No platform conversion fee; bank or network fees may apply"),
    docs: [
      sourceRef(
        "StraitsX XUSD overview",
        "https://support.straitsx.com/hc/en-us/articles/40297191431961-What-is-XUSD",
        ["route", "capacity", "fees"],
      ),
    ],
  },
  "xsgd-straitsx": {
    ...issuerBase,
    ...reviewedDirectRedemptionSupplyFull,
    costModel: documentedVariableFee("No platform conversion fee; bank or network fees may apply"),
    docs: [
      sourceRef(
        "StraitsX XSGD overview",
        "https://support.straitsx.com/support/solutions/articles/157000363433-what-is-xsgd-",
        ["route", "capacity", "fees"],
      ),
    ],
  },
  "euri-banking-circle": {
    ...issuerBase,
    ...reviewedDirectRedemptionSupplyFull,
    settlementModel: "days",
    costModel: fixedFee(0, "Issuer docs describe EURI redemption as fee-free at par"),
    docs: [
      sourceRef(
        "EURI white paper",
        "https://www.eurite.com/wp-content/uploads/2024/08/EURI-white-paper.html",
        ["route", "capacity", "fees"],
      ),
    ],
    notes: ["Banking Circle documents redemption at par within five business days after the request and required checks"],
  },
  "usdq-quantoz": {
    ...issuerBase,
    ...reviewedDirectRedemptionSupplyFull,
    costModel: fixedFee(0, "Issuer docs describe redemption as free of charge; bank fees may still apply"),
    docs: [
      sourceRef("Quantoz transparency", "https://www.quantoz.com/transparency", ["route", "capacity"]),
      sourceRef("Quantoz fees", "https://www.quantoz.com/fees", ["fees"]),
    ],
  },
  "eurq-quantoz": {
    ...issuerBase,
    ...reviewedDirectRedemptionSupplyFull,
    costModel: fixedFee(0, "Issuer docs describe redemption as free of charge; bank fees may still apply"),
    docs: [
      sourceRef("Quantoz transparency", "https://www.quantoz.com/transparency", ["route", "capacity"]),
      sourceRef("Quantoz fees", "https://www.quantoz.com/fees", ["fees"]),
    ],
  },
  "usd1-world-liberty-financial": {
    ...issuerBase,
    ...reviewedDirectRedemptionSupplyFull,
    costModel: documentedVariableFee(NO_PUBLIC_NUMERIC_REDEMPTION_FEE),
  },
  "ausd-agora": {
    ...issuerBase,
    ...reviewedDirectRedemptionSupplyFull,
    costModel: documentedVariableFee("Fees may apply; public docs do not publish a fixed redemption rate"),
  },
  "usdo-openeden": {
    ...issuerBase,
    capacityModel: { kind: "reserve-sync-metadata" },
    costModel: fixedFee(10, "OpenEden docs list a 10 bps redemption fee"),
    reviewedAt: "2026-03-22",
    docs: [
      sourceRef("OpenEden Transparency", "https://openeden.com/usdo/transparency", ["route", "capacity", "fees"]),
    ],
  },
  "usdm-moneta": {
    ...issuerBase,
    ...reviewedDirectRedemptionSupplyFull,
    settlementModel: "days",
    costModel: documentedVariableFee("Eligible users can redeem USDM 1:1 for USD; public fee schedule not disclosed"),
    docs: [
      sourceRef("USDM litepaper", "https://moneta.global/resources/litepaper/", ["route", "capacity"]),
      sourceRef("USDM retail launch", "https://moneta.global/retail-launch/", ["route", "settlement"]),
    ],
    notes: ["Retail exchange documentation describes 1-3 business day processing driven by bank-transfer timing"],
  },
  "usdh-native-markets": {
    ...issuerBase,
    ...reviewedDirectRedemptionSupplyFull,
    costModel: fixedFee(0, "USDH docs state onboarded institutions can mint and redeem 1:1 with no fees"),
    docs: [
      sourceRef("USDH minting and redeeming", "https://docs.usdh.com/usdh/minting", ["route", "capacity", "fees"]),
      sourceRef("USDH transparency", "https://www.usdh.com/transparency", ["capacity"]),
    ],
  },
  "fidd-fidelity": {
    ...issuerBase,
    ...reviewedDirectRedemptionSupplyFull,
    costModel: documentedVariableFee(
      "Eligible Fidelity clients can buy, sell, and redeem FIDD at a guaranteed $1 price; public fee schedule not disclosed",
    ),
    docs: [
      sourceRef("Fidelity Digital Dollar overview", "https://www.fidelitydigitalassets.com/stablecoin", ["route", "capacity"]),
      sourceRef("FIDD terms and conditions", "https://www.fidelitydigitalassets.com/fidd-terms", ["route", "capacity", "access"]),
    ],
  },
  "usdcv-societe-generale-forge": {
    ...issuerBase,
    ...reviewedDirectRedemptionSupplyFull,
    settlementModel: "days",
    costModel: documentedVariableFee(
      "Redeemable 1:1 in USD directly with SG-FORGE; public fee schedule not disclosed",
    ),
    docs: [
      sourceRef("SG-FORGE CoinVertible", "https://www.sgforge.com/product/coinvertible/", ["route", "capacity"]),
      sourceRef(
        "USDCV white paper",
        "https://www.sgforge.com/wp-content/uploads/2025/06/USDCV-White-Paper_iXBRL-1.html",
        ["route", "capacity"],
      ),
    ],
    notes: ["White paper describes issuer-side redemption subject to KYC/AML and permitted-transferee checks"],
  },
  "buidl-blackrock": {
    ...issuerBase,
    ...reviewedDirectRedemptionSupplyFull,
    costModel: documentedVariableFee(
      "Redeemable at NAV through Securitize; public docs do not publish a separate redemption fee (50 bps annual management fee is charged separately)",
    ),
    notes: ["Restricted to qualified purchasers under SEC Reg D; redemptions processed through Securitize platform"],
  },
  "tusd-trueusd": {
    ...issuerBase,
    ...reviewedDirectRedemptionSupplyFull,
    costModel: documentedVariableFee("Redeemable 1:1 through Techteryx; minting gated by Chainlink Proof of Reserve"),
  },
  "eurs-stasis": {
    ...issuerBase,
    costModel: documentedVariableFee("1:1 redemption through STSS (Malta) Limited; public fee schedule not disclosed"),
  },
  "brz-transfero": {
    ...issuerBase,
    ...reviewedDirectRedemptionSupplyFull,
    costModel: fixedFee(100, "Transfero documents a 1% redemption fee in Brazil"),
  },
  "ylds-figure": {
    ...issuerBase,
    ...reviewedDirectRedemptionSupplyFull,
    costModel: documentedVariableFee(
      "Fixed $1.00 face-amount certificate; 1:1 mint/redeem through Figure Certificate Company; registered security",
    ),
  },
  "usdtb-ethena": {
    ...issuerBase,
    ...reviewedDirectRedemptionSupplyFull,
    costModel: documentedVariableFee(
      "Direct 1:1 mint and redemption; BUIDL shares redeemable 24/7 via atomic swap with Securitize",
    ),
  },
  "pusd-plume": {
    ...issuerBase,
    costModel: fixedFee(0, "Zero-fee mint/redeem at 1:1 for USDC per Plume documentation"),
  },
  "pusd-pleasing": {
    ...issuerBase,
    ...reviewedDirectRedemptionSupplyFull,
    settlementModel: "days",
    costModel: documentedVariableFee(
      "Pleasing docs describe PUSD as redeemable 1:1 into USDT after security screening, with quote-based trading fees embedded in the spot flow and gas charged separately",
    ),
    docs: [
      sourceRef(
        "Pleasing spot trading",
        "https://pleasing.gitbook.io/docs/solutions/interactive-blocks",
        ["route", "settlement", "fees"],
      ),
      sourceRef(
        "Pleasing AML/CFT policy",
        "https://pleasing.gitbook.io/docs/legal/aml-cft-and-sanctions-policy",
        ["access"],
      ),
    ],
    notes: ["The modeled backstop is Pleasing's documented PUSD-to-USDT off-ramp, which settles only after source-of-funds and compliance screening rather than as an instant onchain swap"],
  },
  "cash-phantom": {
    ...issuerBase,
    ...reviewedDirectRedemptionSupplyFull,
    costModel: documentedVariableFee(
      "CASH is minted 1:1 from USD deposits via Bridge and redeemed into USD or supported stablecoins; public issuer fee schedule not disclosed",
    ),
    docs: [
      sourceRef("CASH overview", "https://www.usecash.xyz/", ["route", "capacity"]),
      sourceRef("Bridge issuance FAQ", "https://apidocs.bridge.xyz/platform/issuance/faq", ["route", "capacity", "fees"]),
    ],
  },
  "mnee-mnee": {
    ...issuerBase,
    ...reviewedDirectRedemptionSupplyFull,
    costModel: documentedVariableFee(
      "Fiat and in-kind redemptions require at least US$100,000 and charge the greater of US$5,000 or 0.5%, with additional bank or network fees possible",
    ),
    docs: [
      sourceRef("MNEE terms", "https://www.mnee.io/terms", ["route", "capacity", "fees"]),
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
    notes: ["Base $M liquidity is institution-facing; most end users access M0 liquidity through branded extensions and integrations rather than direct M redemption"],
  },
  "musd-metamask": {
    ...issuerBase,
    ...reviewedDirectRedemptionSupplyFull,
    costModel: documentedVariableFee(
      "MetaMask USD is issued 1:1 by Bridge on top of M0 reserve infrastructure; public redemption fees are not disclosed",
    ),
    docs: [
      sourceRef("MetaMask USD introduction", "https://musd.to/blog", ["route", "capacity"]),
      sourceRef("Bridge issuance FAQ", "https://apidocs.bridge.xyz/platform/issuance/faq", ["route", "capacity", "fees"]),
      sourceRef("M0 FAQ", "https://www.m0.org/faq", ["capacity", "access"]),
    ],
    notes: ["Modeled as MetaMask's documented Bridge issuer rail on top of M0 reserve infrastructure rather than as a continuously measured live cash-buffer route"],
  },
  "mtbill-midas": {
    ...issuerBase,
    ...reviewedDirectRedemptionSupplyFull,
    settlementModel: "days",
    costModel: fixedFee(7, "Midas documents a 0.07% redemption fee"),
    docs: [
      sourceRef("Midas mTBILL atomic redemptions", "https://docs.midas.app/tokens/mtbill/atomic-redemptions", ["route", "capacity", "settlement"]),
      sourceRef("Midas prospectus documents", "https://docs.midas.app/resources/legal-documents/prospectus-documents", ["fees"]),
      sourceRef("Midas transparency", "https://midas.app/transparency", ["capacity"]),
    ],
    notes: [
      "Midas documents atomic USDC redemptions when protocol liquidity is available, while standard processing completes within two business days in normal conditions and up to seven business days in stressed cases",
      "Current model scores reviewed eventual redeemability rather than claiming a separately measured live instant buffer from the transparency page",
    ],
  },
  "usdy-ondo-finance": {
    ...issuerBase,
    ...reviewedDirectRedemptionSupplyFull,
    settlementModel: "days",
    costModel: documentedVariableFee("Bank wire redemption at NAV-based price; public fee schedule not disclosed"),
  },
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
    notes: ["Direct minting and redemption require KYC; Theo describes optimistic issuance against USDC while issuer settlement completes asynchronously"],
  },
  "rwausdi-multipli": {
    ...issuerBase,
    ...reviewedDirectRedemptionSupplyFull,
    settlementModel: "days",
    costModel: documentedVariableFee(
      "NAV-based valuation; KYB-gated 1:1 minting and redemption restricted to verified institutional counterparties",
    ),
    docs: [
      sourceRef("Multipli unwind and peg module", "https://docs.multipli.fi/technical-architecture/unwind-and-peg-module", ["route", "capacity"]),
      sourceRef("Multipli issuer, custody & operational risk", "https://docs.multipli.fi/risks/issuer-custody-and-operational-risk", ["access", "settlement", "capacity"]),
      sourceRef("AFI verification", "https://verification.afiprotocol.xyz/multipli", ["capacity"]),
    ],
    notes: ["Multipli documents an institution-only primary redemption rail into underlying liquidity-class assets, so the route remains a delayed issuer exit rather than an instant public stablecoin off-ramp"],
  },
  "usdn-noble": {
    ...issuerBase,
    ...reviewedDirectRedemptionSupplyFull,
    costModel: documentedVariableFee(
      "USDN users mint and redeem via USDC through Noble Express; public redemption fees are not disclosed",
    ),
    docs: [
      sourceRef("USDN overview", "https://docs.noble.xyz/learn/usdn/overview/", ["route", "capacity"]),
      sourceRef("USDN architecture", "https://docs.noble.xyz/learn/usdn/architecture/", ["route", "capacity"]),
      sourceRef("M0 Dashboard", "https://dashboard.m0.org/", ["capacity"]),
    ],
    notes: ["Current model scores the documented Noble Express USDC mint-and-redeem rail as eventual issuer redemption rather than a separately measured live cash buffer"],
  },
  "aeur-anchored-coins": {
    ...issuerBase,
    ...reviewedDirectRedemptionSupplyFull,
    settlementModel: "days",
    costModel: documentedVariableFee(
      "Direct redemption is available through Anchored Coins AG for amounts of at least AEUR 250,000; public fee schedule not disclosed",
    ),
    docs: [
      sourceRef("Anchored Coins AEUR redemption", "https://www.anchoredcoins.com/en/landing/aeur", ["route", "capacity"]),
      sourceRef(
        "Anchored Coins white paper",
        "https://static.anchoredcoins.com/static/cloud/anchoredcoins/static/images/admin_mgs_image_upload/whitepaper_for_launch.pdf",
        ["route", "capacity"],
      ),
    ],
    notes: ["Redemption timing depends on customer due diligence, banking-partner review, and payment-processing timelines"],
  },
  "eurcv-societe-generale-forge": {
    ...issuerBase,
    ...reviewedDirectRedemptionSupplyFull,
    settlementModel: "days",
    costModel: documentedVariableFee(
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
  "tbill-openeden": {
    ...issuerBase,
    ...reviewedDirectRedemptionSupplyFull,
    settlementModel: "days",
    costModel: fixedFee(5, "OpenEden TBILL FAQ lists a 5 bps redemption transaction fee"),
    docs: [
      sourceRef("OpenEden TBILL redemptions", "https://docs.openeden.com/tbill/redemptions", ["route", "capacity"]),
      sourceRef("OpenEden TBILL FAQ", "https://docs.openeden.com/tbill/faq", ["fees"]),
    ],
    notes: ["Redemptions are queued FIFO and are typically processed on the next 1 U.S. business day"],
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
  "paxg-paxos": {
    ...commodityIssuerBase,
    ...reviewedDirectRedemptionSupplyFull,
    costModel: documentedVariableFee(
      "1:1 physical gold or cash equivalent through Paxos Trust Company; public fee schedule not disclosed",
    ),
  },
  "xaut-tether": {
    ...commodityIssuerBase,
    ...reviewedDirectRedemptionSupplyFull,
    costModel: documentedVariableFee(
      "Physical gold through TG Commodities; minimum 430 XAUt for a full bar; physical delivery to Switzerland only",
    ),
  },
  "xaum-matrixdock": {
    ...commodityIssuerBase,
    ...reviewedDirectRedemptionSupplyFull,
    costModel: fixedFee(25, "Matrixdock FAQ lists a 0.25% redemption fee"),
    docs: [
      sourceRef(
        "XAUm token features",
        "https://matrixdock.gitbook.io/matrixdock-docs/english/gold-token-xaum/token-features",
        ["route", "capacity", "access"],
      ),
      sourceRef(
        "XAUm FAQ",
        "https://matrixdock.gitbook.io/matrixdock-docs/english/gold-token-xaum/faq",
        ["route", "capacity", "fees", "settlement"],
      ),
    ],
    notes: [
      "Primary minting and redemption into USDC or USD fiat require KYC, settle within T+3 days, and physical gold redemption currently starts at one 1 kg LBMA bar (32.148 XAUm)",
    ],
  },
  ...expandIds(
    ["kau-kinesis", "kag-kinesis"],
    {
      ...commodityIssuerBase,
      ...reviewedDirectRedemptionSupplyFull,
    },
  ),
  "cgo-comtech": {
    ...commodityIssuerBase,
    costModel: documentedVariableFee("Physical gold coins via ComTech Gold app; minimum 10 grams in 1-gram multiples"),
  },
  "dgld-gold-token-sa": {
    ...commodityIssuerBase,
    costModel: fixedFee(0, "No custody or transfer fees per Gold Token SA; minimum 1 gram"),
  },
  "wusd-worldwide": {
    ...issuerBase,
    ...reviewedDirectRedemptionSupplyFull,
    costModel: documentedVariableFee(
      "Corporate-account redemptions convert WUSD to USD at a 1:1 rate; WSPN docs say the platform conversion has no handling fee, while bank or network fees may still apply",
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
      sourceRef("AUDD product disclosure statement", "https://www.audd.digital/wp-content/uploads/2026/02/202602_AUDD-PDS.pdf", ["route", "capacity", "fees"]),
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
      sourceRef(
        "PGOLD token features",
        "https://pleasing.gitbook.io/docs/pleasing-gold-pgold/token-features",
        ["route", "capacity", "access", "fees"],
      ),
      sourceRef(
        "Pleasing AML/CFT policy",
        "https://pleasing.gitbook.io/docs/legal/aml-cft-and-sanctions-policy",
        ["access"],
      ),
    ],
    notes: ["The modeled backstop is the documented physical-delivery redemption rail; spot trading and secondary transfers remain separate, faster paths that do not exercise issuer redemption"],
  },
  "dusd-standx": {
    ...issuerBase,
    capacityModel: { kind: "supply-ratio", ratio: 0.15 },
    costModel: documentedVariableFee(
      "Delta-neutral hedging on centralized exchanges; 1:1 USDT/USDC redemption; public fee schedule not disclosed",
    ),
    notes: ["Estimated 15% capacity ratio pending protocol-specific liquidity research"],
  },
  "usat-tether": {
    ...issuerBase,
    ...reviewedDirectRedemptionSupplyFull,
    costModel: documentedVariableFee(
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
};
