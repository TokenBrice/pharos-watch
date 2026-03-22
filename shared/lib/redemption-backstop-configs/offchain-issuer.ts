import type { RedemptionBackstopConfig } from "./shared";
import {
  commodityIssuerBase,
  documentedVariableFee,
  expandIds,
  fixedFee,
  issuerBase,
  NO_PUBLIC_NUMERIC_REDEMPTION_FEE,
} from "./shared";

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
  "usdt-tether": {
    ...issuerBase,
    costModel: documentedVariableFee("0.10% with a $1,000 minimum"),
  },
  "usdc-circle": {
    ...issuerBase,
    costModel: documentedVariableFee("1:1 via Circle Mint; EEA burn fee is 0 bps, other Circle fees may vary"),
  },
  "pyusd-paypal": {
    ...issuerBase,
    costModel: fixedFee(
      0,
      "Paxos states it does not charge a PYUSD redemption fee; bank or network fees may still apply",
    ),
  },
  "fdusd-first-digital": {
    ...issuerBase,
    costModel: documentedVariableFee("Redeemable 1:1; public fee schedule not disclosed"),
  },
  "rlusd-ripple": {
    ...issuerBase,
    costModel: documentedVariableFee("Redeemable 1:1 less fees; public fee schedule not disclosed"),
  },
  "eurc-circle": {
    ...issuerBase,
    costModel: documentedVariableFee("EEA burn fee is 0 bps; other Circle redemption fees may vary"),
  },
  "usdp-paxos": {
    ...issuerBase,
    costModel: fixedFee(0, "Paxos states it does not charge a USDP redemption fee"),
  },
  "gusd-gemini": {
    ...issuerBase,
    costModel: fixedFee(0, "Gemini describes GUSD conversion and redemption as fee-free"),
  },
  "usdg-paxos": {
    ...issuerBase,
    costModel: fixedFee(0, "Paxos states it does not charge a USDG redemption fee"),
  },
  "usdx-hex-trust": {
    ...issuerBase,
    costModel: documentedVariableFee("Redeemable through approved parties; public fee schedule not disclosed"),
  },
  "xusd-straitsx": {
    ...issuerBase,
    costModel: documentedVariableFee("No platform conversion fee; bank or network fees may apply"),
  },
  "xsgd-straitsx": {
    ...issuerBase,
    costModel: documentedVariableFee("No platform conversion fee; bank or network fees may apply"),
  },
  "euri-banking-circle": {
    ...issuerBase,
    costModel: fixedFee(0, "Issuer docs describe EURI redemption as fee-free at par"),
  },
  "usdq-quantoz": {
    ...issuerBase,
    costModel: fixedFee(0, "Issuer docs describe redemption as free of charge; bank fees may still apply"),
  },
  "eurq-quantoz": {
    ...issuerBase,
    costModel: fixedFee(0, "Issuer docs describe redemption as free of charge; bank fees may still apply"),
  },
  "usd1-world-liberty-financial": {
    ...issuerBase,
    costModel: documentedVariableFee(NO_PUBLIC_NUMERIC_REDEMPTION_FEE),
  },
  "ausd-agora": {
    ...issuerBase,
    costModel: documentedVariableFee("Fees may apply; public docs do not publish a fixed redemption rate"),
  },
  "usdo-openeden": {
    ...issuerBase,
    costModel: fixedFee(10, "OpenEden docs list a 10 bps redemption fee"),
  },
  "usdm-moneta": {
    ...issuerBase,
    costModel: documentedVariableFee("Redeemable 1:1; public fee schedule not disclosed"),
  },
  "buidl-blackrock": {
    ...issuerBase,
    costModel: documentedVariableFee(
      "Redeemable at NAV through Securitize; public docs do not publish a separate redemption fee (50 bps annual management fee is charged separately)",
    ),
    notes: ["Restricted to qualified purchasers under SEC Reg D; redemptions processed through Securitize platform"],
  },
  "tusd-trueusd": {
    ...issuerBase,
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
    costModel: fixedFee(100, "Transfero documents a 1% redemption fee in Brazil"),
  },
  "ylds-figure": {
    ...issuerBase,
    costModel: documentedVariableFee(
      "Fixed $1.00 face-amount certificate; 1:1 mint/redeem through Figure Certificate Company; registered security",
    ),
  },
  "usdtb-ethena": {
    ...issuerBase,
    costModel: documentedVariableFee(
      "Direct 1:1 mint and redemption; BUIDL shares redeemable 24/7 via atomic swap with Securitize",
    ),
  },
  "pusd-plume": {
    ...issuerBase,
    costModel: fixedFee(0, "Zero-fee mint/redeem at 1:1 for USDC per Plume documentation"),
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
  "paxg-paxos": {
    ...commodityIssuerBase,
    costModel: documentedVariableFee(
      "1:1 physical gold or cash equivalent through Paxos Trust Company; public fee schedule not disclosed",
    ),
  },
  "xaut-tether": {
    ...commodityIssuerBase,
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
  ...expandIds(["kau-kinesis", "kag-kinesis"], commodityIssuerBase),
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
