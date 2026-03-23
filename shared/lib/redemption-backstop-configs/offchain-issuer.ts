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
      "usda-anzens",
      "eurcv-societe-generale-forge",
      "aeur-anchored-coins",
      "eure-monerium",
      "usdr-stablr",
      "eurr-stablr",
      "europ-schuman",
      "eurau-allunity",
      "tusd-trueusd",
      "frxusd-frax",
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
    costModel: documentedVariableFee("Redeemable through approved parties; public fee schedule not disclosed"),
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
    costModel: documentedVariableFee("Redeemable 1:1; public fee schedule not disclosed"),
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
  "frxusd-frax": {
    ...issuerBase,
    costModel: documentedVariableFee(
      "1:1 mint and redemption through governance-approved enshrined custodians; public fee schedule not disclosed",
    ),
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
  "mtbill-midas": {
    ...issuerBase,
    capacityModel: { kind: "supply-ratio", ratio: 0.11 },
    costModel: fixedFee(7, "Midas documents a 0.07% redemption fee"),
    notes: [
      "Instant USDC redemption limited to on-chain liquidity buffer (~11% of supply per transparency page); overflow enters 1–7 business day queue with up to 3 business days to replenish",
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
    costModel: documentedVariableFee(
      "KYC-gated mint/redemption processed instantly in USDC; underlying collateral settled within T+4 business days",
    ),
    notes: ["Restricted to institutional and non-U.S. accredited investors"],
  },
  "rwausdi-multipli": {
    ...issuerBase,
    settlementModel: "days",
    costModel: documentedVariableFee(
      "NAV-based valuation; KYB-gated 1:1 minting and redemption restricted to verified institutional counterparties",
    ),
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
    costModel: documentedVariableFee(
      "Physical gold through Matrixdock; minimum 32.148 XAUm (1 kg bar); KYC-verified accredited investors only",
    ),
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
  "pgold-pleasing": {
    ...commodityIssuerBase,
    executionModel: "opaque",
    costModel: documentedVariableFee("Physical gold via Pleasing platform; subject to KYC and size requirements"),
  },
  "dusd-standx": {
    ...issuerBase,
    capacityModel: { kind: "supply-ratio", ratio: 0.15 },
    costModel: documentedVariableFee(
      "Delta-neutral hedging on centralized exchanges; 1:1 USDT/USDC redemption; public fee schedule not disclosed",
    ),
    notes: ["Estimated 15% capacity ratio pending protocol-specific liquidity research"],
  },
};
