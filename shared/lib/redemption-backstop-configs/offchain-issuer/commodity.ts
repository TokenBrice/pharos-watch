import type { RedemptionBackstopConfig } from "../shared";
import {
  documentedBoundSupplyFull,
  documentedVariableFee,
  undisclosedReviewedFee,
  fixedFee,
  issuerBase,
  commodityIssuerBase,
  sourceRef,
  sourceRefFull,
  sourceRefRouteCapacity,
  sourceRefRouteCapacityAccess,
  sourceRefRouteCapacityFees,
} from "../shared";
import { reviewedDirectRedemptionSupplyFull, REVIEWED_COVERAGE_EXPANSION_AT } from "./shared";

export const COMMODITY_OFFCHAIN_CONFIGS: Record<string, RedemptionBackstopConfig> = {
  "paxg-paxos": {
    ...commodityIssuerBase,
    ...reviewedDirectRedemptionSupplyFull,
    reviewedAt: "2026-09-21",
    outputAssetType: "physical-commodity-delivery",
    physicalCommodityDelivery: {
      commodity: "XAU", deliverableOuncesPerToken: 1, minimumDeliveryTokens: 430,
      deliveryTermsUnbounded: true,
      feeModel: { bps: 0, flatUsd: 0, deliveryUsd: 0 }, sameNotionalEligible: false,
    },
    costModel: undisclosedReviewedFee(
      "1:1 physical gold or cash equivalent through Paxos Trust Company; public fee schedule not disclosed",
    ),
    docs: [
      sourceRefFull("PAXG physical terms; unpublished fee and delivery charges", "https://www.paxos.com/terms-and-conditions/pax-gold-terms-conditions"),
      sourceRefRouteCapacity("Paxos Pax Gold", "https://www.paxos.com/pax-gold"),
      sourceRef(
        "Paxos PAXG buy/sell/redeem",
        "https://help.paxos.com/hc/en-us/articles/360041903332-How-to-Buy-Sell-Redeem-PAX-Gold",
        ["route", "fees", "access", "settlement"],
      ),
    ],
  },
  "xaut-tether": {
    ...commodityIssuerBase,
    ...reviewedDirectRedemptionSupplyFull,
    reviewedAt: "2026-09-21",
    outputAssetType: "physical-commodity-delivery",
    physicalCommodityDelivery: {
      commodity: "XAU", deliverableOuncesPerToken: 1, minimumDeliveryTokens: 430,
      deliveryTermsUnbounded: true,
      feeModel: { bps: 25, flatUsd: 0, deliveryUsd: 0 }, sameNotionalEligible: false,
    },
    costModel: documentedVariableFee(
      "Physical gold through TG Commodities; minimum 430 XAUt for a full bar; physical delivery to Switzerland only",
    ),
    docs: [
      sourceRefFull("Tether Gold RID: 430-token deposit and 25 bps redemption fee", "https://gold.tether.to/Relevant%20Information%20Document%20-%20TG%20Commodities,%20S.A.%20de%20C.V.%20(ENG).pdf"),
      sourceRefFull("Tether Gold FAQ", "https://gold.tether.to/faq"),
      sourceRef("Tether Gold terms", "https://gold.tether.to/legal", ["route", "access"]),
    ],
    notes: [
      "430 XAUt is the documented conservative deposit threshold, not a fixed delivered bar weight: full bars vary and excess tokens are returned. Switzerland delivery is additional and unpriced.",
    ],
  },
  "xnk-kinka": {
    ...commodityIssuerBase,
    ...documentedBoundSupplyFull("2026-05-14"),
    costModel: undisclosedReviewedFee(
      "Kinka terms require AML/KYC and issuer approval for exchange; whitepaper describes physical exchange from 321.5 XNK / ten 1 kg bars; public docs reviewed do not publish one fixed redemption fee",
    ),
    docs: [
      sourceRef("Kinka terms", "https://kinka-gold.com/wp-content/uploads/2022/12/Kinka_Terms-of-Use_ver1.pdf", [
        "route",
        "fees",
        "access",
        "settlement",
      ]),
      sourceRefRouteCapacityAccess("Kinka whitepaper", "https://kinka-gold.com/wp-content/uploads/2024/01/Kinka_white-paper_ver2.pdf"),
    ],
    notes: [
      "Modeled route is issuer/GM LLC exchange for physical gold through storage-company desks, not ordinary secondary-market liquidity.",
      "Reserve coverage remains self-reported plus a weak-live-probe total-supply check unless a public independent attestation feed is found.",
    ],
  },
  "xaum-matrixdock": {
    ...commodityIssuerBase,
    ...reviewedDirectRedemptionSupplyFull,
    reviewedAt: "2026-09-21",
    outputAssetType: "physical-commodity-delivery",
    physicalCommodityDelivery: {
      commodity: "XAU", deliverableOuncesPerToken: 1, minimumDeliveryTokens: 32.148,
      deliveryTermsUnbounded: true,
      feeModel: { bps: 25, flatUsd: 0, deliveryUsd: 0 }, sameNotionalEligible: false,
    },
    costModel: fixedFee(25, "Matrixdock FAQ lists a 0.25% redemption fee"),
    docs: [
      sourceRefFull("XAUm physical minimum and delivery terms", "https://matrixdock.gitbook.io/matrixdock-docs/english/gold-token-xaum/minting-and-redeeming"),
      sourceRefRouteCapacityAccess(
        "XAUm token features",
        "https://matrixdock.gitbook.io/matrixdock-docs/english/gold-token-xaum/token-features",
      ),
      sourceRef("XAUm FAQ", "https://matrixdock.gitbook.io/matrixdock-docs/english/gold-token-xaum/faq", [
        "route",
        "capacity",
        "fees",
        "settlement",
      ]),
    ],
    notes: [
      "Primary minting and redemption into USDC or USD fiat require KYC, settle within T+3 days, and physical gold redemption currently starts at one 1 kg LBMA bar (32.148 XAUm)",
    ],
  },
  "gldy-streamex": {
    ...commodityIssuerBase,
    ...documentedBoundSupplyFull(REVIEWED_COVERAGE_EXPANSION_AT),
    costModel: fixedFee(
      200,
      "RWA.xyz primary-market terms list a 2% redemption fee; physical gold delivery can involve additional fabrication, shipping, or custody costs",
    ),
    docs: [
      sourceRefRouteCapacityAccess("Streamex GLDY", "https://www.streamex.com/GLDY"),
      sourceRefFull("RWA.xyz GLDY", "https://app.rwa.xyz/assets/GLDY"),
      sourceRef("Chainlink GLDY Reserves", "https://data.chain.link/feeds/base/base/gldy-reserves", ["capacity"]),
    ],
    notes: [
      "Modeled route is the source-reviewed eligible-investor primary-market redemption path, not ordinary secondary-market sale liquidity",
      "GLDY distributes gold-leasing yield, so redemption quality depends on both gold backing and the issuer's leasing/custody program staying current",
    ],
  },
  "gldt-gold-dao": {
    ...commodityIssuerBase,
    ...documentedBoundSupplyFull("2026-05-24"),
    reviewedAt: "2026-09-21",
    outputAssetType: "physical-commodity-delivery",
    physicalCommodityDelivery: {
      commodity: "XAU", deliverableOuncesPerToken: 0.01 / 31.1034768, minimumDeliveryTokens: 100,
      deliveryTermsUnbounded: true,
      feeModel: { bps: 0, flatUsd: 0, deliveryUsd: 0 }, sameNotionalEligible: false,
    },
    executionModel: "rules-based-nav",
    costModel: undisclosedReviewedFee(
      "Gold DAO materials describe reverse swapping GLDT into GLD NFTs at the published gold-denomination ratio; public materials reviewed do not publish one fixed redemption fee",
    ),
    docs: [
      sourceRefFull("Gold DAO physical redemption and reverse swap", "https://docs.gold-dao.org/how-to/redeem-physical-gold"),
      sourceRefFull("Bity vault pickup: CHF 300 per visit", "https://help.bity.com/en/articles/9680077-how-can-i-redeem-the-physical-gold-bar-from-my-nfts"),
    ],
    notes: [
      "Modeled route is GLDT's documented reverse-swap path into GLD NFT gold-denomination backing, not ordinary secondary-market liquidity.",
      "Physical gold custody and delivery remain upstream of the GLD NFT system, so Pharos keeps the route in the delayed commodity issuer family.",
      "The published CHF 300 Zurich vault pickup charge is a delivery term, not a USD flat redemption fee. Ruling B does not invent an FX conversion or deduct unbounded delivery; reverse-swap fees remain unpublished and output quality is capped at 55.",
    ],
  },
  "vnxau-vnx": {
    ...commodityIssuerBase,
    ...documentedBoundSupplyFull(REVIEWED_COVERAGE_EXPANSION_AT),
    costModel: documentedVariableFee(
      "VNX platform supports sell/redemption and physical collection or delivery from one-kilogram gold bars; public materials reviewed do not expose one fixed VNXAU redemption fee",
    ),
    docs: [
      sourceRefRouteCapacityAccess("VNX Gold executive summary", "https://vnx.gitbook.io/vnx-platform/vnx-gold/executive-summary"),
      sourceRefRouteCapacityFees("VNX Gold token details", "https://vnx.gitbook.io/vnx-platform/vnx-gold/token-details"),
      sourceRef(
        "VNX Gold operations",
        "https://vnx.gitbook.io/vnx-platform/vnx-gold/operations-with-vnx-gold-on-vnx-platform",
        ["route", "fees", "access", "settlement"],
      ),
      sourceRef(
        "VNXAU AREVA report",
        "https://vnx.li/wp-content/uploads/2026/03/VNX_Examination_on_Management_Assertions_VNXAU_31_12_2025_signiert.pdf",
        ["capacity"],
      ),
    ],
    notes: [
      "Primary route is VNX platform redemption or physical gold collection/delivery for verified users; physical delivery minimums make the backstop operationally slower than spot exchange liquidity",
    ],
  },
  "xagm-matrixdock": {
    ...commodityIssuerBase,
    ...documentedBoundSupplyFull(REVIEWED_COVERAGE_EXPANSION_AT),
    reviewedAt: "2026-09-21",
    outputAssetType: "physical-commodity-delivery",
    physicalCommodityDelivery: {
      commodity: "XAG", deliverableOuncesPerToken: 0.998463014, minimumDeliveryTokens: 2100,
      deliveryTermsUnbounded: true,
      feeModel: { bps: 50, flatUsd: 0, deliveryUsd: 0 }, sameNotionalEligible: false,
    },
    costModel: documentedVariableFee(
      "Matrixdock mint/redeem route is available for KYC users and follows the issuer's XAGm silver-per-token framework; public materials reviewed do not expose one global fixed XAGm redemption fee",
    ),
    docs: [
      sourceRefFull("XAGm physical redemption terms", "https://matrixdock.gitbook.io/matrixdock-docs/english/silver-token-xagm/minting-and-redeeming"),
      sourceRefFull("Matrixdock XAGm", "https://www.matrixdock.com/xagm"),
      sourceRefRouteCapacityAccess(
        "Matrixdock XAGm announcement",
        "https://www.matrixdock.com/blog/announcements/matrixdock-launches-xagm-bringing-lbma-good-delivery-silver-on-chain",
      ),
    ],
    notes: [
      "XAGm redemption value follows Matrixdock's published silver-per-token mechanics, so Pharos treats the route as documented but not a fixed-fee public commodity exit",
    ],
  },
  "ggbr-goldfish-gold": {
    ...commodityIssuerBase,
    ...documentedBoundSupplyFull("2026-08-09"),
    reviewedAt: "2026-09-21",
    outputAssetType: "physical-commodity-delivery",
    physicalCommodityDelivery: {
      commodity: "XAU", deliverableOuncesPerToken: 0.001, minimumDeliveryTokens: 13500,
      deliveryTermsUnbounded: true,
      feeModel: { bps: 300, flatUsd: 0, deliveryUsd: 0 }, sameNotionalEligible: false,
    },
    routeStatus: "open",
    costModel: {
      ...documentedVariableFee(
        "Current redemption app: minimum 13,500 GGBR, 3% redemption fee, additional shipping and insurance unpriced",
      ),
      feeBpsMin: 300,
      feeBpsMax: 300,
    },
    docs: [
      sourceRef("Goldfish redemption app", "https://app.goldfishgold.com/redemption", [
        "route",
        "capacity",
        "access",
        "settlement",
      ]),
      sourceRef("Goldfish support and redemption FAQ", "https://goldfishgold.com/support", [
        "route",
        "capacity",
        "fees",
        "access",
      ]),
      sourceRefRouteCapacity("Goldfish whitepaper", "https://goldfishgold.com/whitepaper"),
    ],
    notes: [
      "Current app minimum 13,500 GGBR and 3% fee supersede the older support FAQ's 8,818.49 GGBR minimum and 2%-3% processing/delivery range; additional shipping and insurance remain unbounded.",
      "Settlement timing and eligible jurisdictions are not published on Goldfish's public pages; the earlier five-to-seven-business-day figure came from the sign-in-gated redemption dashboard and could not be re-verified from public sources on 2026-08-09.",
    ],
  },
  "euroe-membrane": {
    ...issuerBase,
    ...documentedBoundSupplyFull(REVIEWED_COVERAGE_EXPANSION_AT),
    costModel: documentedVariableFee(
      "EUROe is redeemable 1:1 through Membrane's verified-customer platform; public materials reviewed do not expose one global fixed redemption fee",
    ),
    docs: [
      sourceRef("EUROe transparency", "https://www.euroe.com/transparency-and-regulation", ["capacity", "access"]),
      sourceRefFull("Terms of Membrane Platform", "https://www.euroe.com/legal/terms-of-membrane-platform"),
      sourceRef("Get EUROe", "https://www.euroe.com/get-euroe", ["route", "access", "settlement"]),
    ],
    notes: ["Modeled route is Membrane's account-gated EUR issue/redeem platform, not secondary-market euro liquidity"],
  },
};
