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
    physicalToUsd: {
      metal: "XAU",
      fineTroyOuncesPerToken: 1,
      lot: { minimumTokens: 430, incrementTokens: null, bars: [{ barId: "london-good-delivery-variable-weight", fineTroyOunces: 350, maximumFineTroyOunces: 430 }] },
      vaultLocations: ["london"],
      barClass: "good-delivery",
      saleLocation: "in-vault",
      deliveryScope: "same-jurisdiction",
      fineness: 0.995,
      eligibility: "verified-customer",
      fees: { issuerFeeBps: null, issuerFixedUsd: null, deliveryUsdPerLot: null, insuranceBps: null, assayUsdPerLot: null, taxBps: null, conversionBps: 0 },
      settlementLegs: [{ leg: "issuer-release-in-vault", maximumBusinessDays: null, typicalBusinessDays: "several-business-days" }],
      bestEffortIssuerCashOut: {
        operatingProcess: "Paxos platform five-second PAXG/USD conversion quote followed by withdrawal to the customer's own bank account.",
        lot: { minimumTokens: null, incrementTokens: null, bars: [] },
        fees: { issuerFeeBps: null, issuerFixedUsd: null, deliveryUsdPerLot: 0, insuranceBps: 0, assayUsdPerLot: 0, taxBps: null, conversionBps: null },
        settlementLegs: [{ leg: "platform-conversion", maximumBusinessDays: "unbounded" }, { leg: "bank-withdrawal-large-requests", maximumBusinessDays: "unbounded" }],
      },
      reviewedAt: "2026-10-01",
      reviewExpiresAt: "2026-12-30",
      evidence: [
        { url: "https://www.paxos.com/terms-and-conditions/pax-gold-terms-conditions", quote: "§4.2 one fine troy ounce; §4.11 only verified Customers; §11.4 minimum 430 PAXG plus fee per variable-weight London Good Delivery bar, excess refunded, holder responsible for delivery; §11.5 commercially reasonable efforts; §12.3 larger withdrawals may take substantially longer; §15 fees in User Guide/private Pricing Supplement." },
        { url: "https://www.lbma.org.uk/publications/good-delivery-rules/technical-specifications", quote: "Gold Good Delivery bars contain 350–430 fine troy ounces; conservative deposit uses 430 and delivered capacity uses 350, with excess tokens refunded." },
        { url: "https://www.bullionbypost.co.uk/sell-to-us/", quote: "Currently processing deliveries within 2 working days; once metals arrive and are checked, payment is made directly to the customer's bank. Used as modelled dealer-sale typical time, not an issuer delivery SLA." },
      ],
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
    physicalToUsd: {
      metal: "XAU", fineTroyOuncesPerToken: 1,
      lot: { minimumTokens: 430, incrementTokens: 430, bars: [{ barId: "switzerland-london-good-delivery-variable-weight", fineTroyOunces: 350, maximumFineTroyOunces: 430 }] },
      vaultLocations: ["other"], barClass: "good-delivery",
      saleLocation: "delivered", deliveryScope: "same-jurisdiction", fineness: 0.995,
      eligibility: "verified-customer",
      fees: { issuerFeeBps: 25, issuerFixedUsd: null, deliveryUsdPerLot: null, insuranceBps: null, assayUsdPerLot: null, taxBps: null, conversionBps: null },
      settlementLegs: [{ leg: "issuer-redemption-and-physical-delivery-in-switzerland", maximumBusinessDays: null, typicalBusinessDays: "several-business-days" }],
      bestEffortIssuerCashOut: {
        operatingProcess: "After full-bar redemption, Tether Gold or its representative attempts sale to a relationship Swiss gold dealer or broker. Successful sale proceeds less fees are remitted in USD by wire; no repurchase obligation or sale/wire deadline is documented.",
        lot: { minimumTokens: 430, incrementTokens: 430, bars: [{ barId: "switzerland-london-good-delivery-variable-weight", fineTroyOunces: 350, maximumFineTroyOunces: 430 }] },
        fees: { issuerFeeBps: 25, issuerFixedUsd: null, deliveryUsdPerLot: null, insuranceBps: null, assayUsdPerLot: null, taxBps: null, conversionBps: null },
        settlementLegs: [
          { leg: "issuer-full-bar-redemption", maximumBusinessDays: null, typicalBusinessDays: "several-business-days" },
          { leg: "best-effort-swiss-gold-sale", maximumBusinessDays: "unbounded", typicalBusinessDays: null },
          { leg: "fiat-wire-to-usable-usd", maximumBusinessDays: null, typicalBusinessDays: null },
        ],
      },
      reviewedAt: "2026-10-01", reviewExpiresAt: "2026-12-30",
      evidence: [
        { url: "https://gold.tether.to/legal", quote: "Each Gold Token reflects ownership of an undivided specific interest in one fine troy ounce of gold in the Gold Reserves. In order to purchase Gold Tokens from Tether Gold and to have them redeemed through orders submitted through the Site, you must be a verified customer of Tether Gold. However, it may take several business days for any redemption to be completed." },
        { url: "https://gold.tether.to/legal/feeschedule", quote: "Redemption of Gold Tokens: .25% plus applicable fees. Redemption of Gold Tokens for underlying gold can be effecutated in increments of 430 tokens. If a delivered bullion bar is smaller than 430 ounces, the number of Gold Tokens redeemed will be reduced accordingly to match bar size, to 3 decimal places." },
        { url: "https://gold.tether.to/faq", quote: "If you request physical delivery from TG Commodities, S.A. de C.V. for your gold bar(s), the company will arrange for its secure transit to the delivery address in Switzerland specified by you. TG Commodities, S.A. de C.V. will charge 25 basis points on the gold price in the Swiss gold market at the time of redemption of the XAU₮ tokens, plus the cost of delivery." },
        { url: "https://gold.tether.to/legal", quote: "Tether Gold or its representative will attempt to sell the user’s gold bar to a gold dealer or broker with whom Tether Gold or such representative has a relationship. Tether Gold and its Affiliates have no obligation to repurchase any Gold Tokens or any bullion bars." },
        { url: "https://gold.tether.to/Relevant%20Information%20Document%20-%20TG%20Commodities,%20S.A.%20de%20C.V.%20(ENG).pdf", quote: "The Gold Reserves are held by the custodian in a vault in Switzerland. If the gold bar is successfully sold, Tether Gold will provide the KYC Verified Customer with the fiat money in US Dollars received in exchange for the gold, less the 25 bps fee for redemption of the Tether Gold Tokens described above." },
        { url: "https://www.lbma.org.uk/publications/good-delivery-rules/technical-specifications", quote: "Minimum gold content: 350 fine troy ounces (approximately 10.9 kilograms). Maximum gold content: 430 fine troy ounces (approximately 13.4 kilograms)." },
      ],
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
    physicalToUsd: {
      metal: "XAU", fineTroyOuncesPerToken: 1,
      lot: { minimumTokens: 32.148, incrementTokens: null, bars: [{ barId: "lbma-kilobar-9999-fineness", fineTroyOunces: 32.147531493971115 }] },
      vaultLocations: ["singapore", "hong-kong"], barClass: "kilobar",
      saleLocation: "in-vault", deliveryScope: "same-jurisdiction", fineness: 0.9999,
      eligibility: "verified-customer",
      fees: { issuerFeeBps: 25, issuerFixedUsd: null, deliveryUsdPerLot: null, insuranceBps: null, assayUsdPerLot: null, taxBps: null, conversionBps: null },
      settlementLegs: [{ leg: "issuer-release-to-holder-vault-account", maximumBusinessDays: null, typicalBusinessDays: null }],
      bestEffortIssuerCashOut: {
        operatingProcess: "Verified customers submit XAUm with maximum slippage; Matrixdock sells physical bars and sends supported USDC or USDT within T+3 after execution. Out-of-slippage orders are cancelled for a new quote or refund; no cash minimum or pre-execution deadline is documented.",
        lot: { minimumTokens: null, incrementTokens: null, bars: [] },
        fees: { issuerFeeBps: 25, issuerFixedUsd: null, deliveryUsdPerLot: null, insuranceBps: null, assayUsdPerLot: null, taxBps: null, conversionBps: null },
        settlementLegs: [
          { leg: "quote-acceptance-to-execution", maximumBusinessDays: null, typicalBusinessDays: null },
          { leg: "executed-order-to-supported-stablecoin-receipt", maximumBusinessDays: 3, typicalBusinessDays: null },
        ],
      },
      reviewedAt: "2026-10-01", reviewExpiresAt: "2026-12-30",
      evidence: [
        { url: "https://matrixdock.gitbook.io/matrixdock-docs/english/gold-token-xaum/what-is-xaum", quote: "In the ERC-20/BEP-20 token form, 1 XAUm is backed by 1 fine troy ounce LBMA gold." },
        { url: "https://matrixdock.gitbook.io/matrixdock-docs/english/gold-token-xaum/minting-and-redeeming", quote: "Redeeming XAUm for physical LBMA gold is at a minimum of 32.148 XAUm, equivalent to a 1kg gold bar. It can be collected via customer pickup or secured delivery. After order execution, Matrixdock will provide you with the final transaction price and the corresponding stablecoin amount. The stablecoins will be sent within T+3." },
        { url: "https://matrixdock.gitbook.io/matrixdock-docs/english/gold-token-xaum/faq", quote: "A fee of 0.25% will be charged for each redemption order. You are able to redeem XAUm directly with Matrixdock into supported stablecoins such as USDC and USDT. Matrixdock will perform the sale of physical bars and transfer the stablecoins to your wallet." },
        { url: "https://matrixdock.gitbook.io/matrixdock-docs/english/gold-token-xaum/physical-gold-custody", quote: "The physical gold backing XAUm tokens is securely stored in vaults located in Singapore and Hong Kong." },
        { url: "https://matrixdock.gitbook.io/matrixdock-docs/english/silver-token-xagm/physical-silver-vault-audit", quote: "1KG – 0.9999 Fineness POINT GOLD Gold Bar" },
        { url: "https://2505056629-files.gitbook.io/~/files/v0/b/gitbook-x-prod.appspot.com/o/spaces%2FZx9GNWaNV9JB3JZlW74D%2Fuploads%2Foa3Zaj3t7Mic13UuT1ph%2FXAUm%20Token%20Terms%20and%20Conditions.docx.pdf?alt=media&token=3cad87ae-7846-4bfe-ba2e-411fbf166f60", quote: "Once you accept a Quote and the Token Issuer receives the XAUm Tokens intended to be redeemed, the Token Issuer will, in a timely manner, remove from circulation or “burn” such XAUm Tokens and either, as applicable, instruct a Matrix Entity to (a) deliver to a vault account in your name at a Vault Provider a corresponding amount of LBMA Gold;" },
      ],
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
    physicalToUsd: {
      metal: "XAU", fineTroyOuncesPerToken: 0.0003214753149397112,
      lot: { minimumTokens: 100, incrementTokens: 100, bars: [{ barId: "gld-nft-one-gram-metalor", fineTroyOunces: 0.03214753149397112 }] },
      vaultLocations: ["zurich"], barClass: "small-bar-or-coin",
      saleLocation: "delivered", deliveryScope: "same-jurisdiction", fineness: 0.9999,
      eligibility: "verified-customer",
      // CHF300 is published, but no captured CHF/USD conversion bounds it in USD.
      fees: { issuerFeeBps: 100, issuerFixedUsd: null, deliveryUsdPerLot: "unbounded", insuranceBps: null, assayUsdPerLot: null, taxBps: null, conversionBps: null },
      settlementLegs: [
        { leg: "gldt-reverse-swap-to-specific-gld-nft", maximumBusinessDays: null, typicalBusinessDays: null },
        { leg: "bity-kyc-and-zurich-vault-pickup-appointment", maximumBusinessDays: null, typicalBusinessDays: null },
      ],
      bestEffortIssuerCashOut: {
        operatingProcess: "Reverse-swap into a specific GLD NFT, complete Bity KYC and accept a 24-hour LBMA quote less 3%; Bity sends USDT after NFT transaction confirmation. USD conversion remains undocumented.",
        lot: { minimumTokens: 100, incrementTokens: 100, bars: [{ barId: "gld-nft-one-gram-metalor", fineTroyOunces: 0.03214753149397112 }] },
        fees: { issuerFeeBps: 400, issuerFixedUsd: null, deliveryUsdPerLot: 0, insuranceBps: 0, assayUsdPerLot: 0, taxBps: null, conversionBps: null },
        settlementLegs: [
          { leg: "gldt-reverse-swap-to-specific-gld-nft", maximumBusinessDays: null, typicalBusinessDays: null },
          { leg: "bity-nft-buyback-to-usdt", maximumBusinessDays: null, typicalBusinessDays: null },
          { leg: "usdt-to-spendable-usd", maximumBusinessDays: null, typicalBusinessDays: null },
        ],
      },
      reviewedAt: "2026-10-01", reviewExpiresAt: "2026-12-30",
      evidence: [
        { url: "https://docs.gold-dao.org/how-to/redeem-physical-gold", quote: "Since GLDT is a fungible token representing fractional ownership (where 100 GLDT = 1g of gold), the core requirement is to perform a reverse swap via the GLDT Swap platform to reclaim a GLD NFT. They will guide you through the necessary KYC (Know Your Customer) protocols and coordinate the pickup of the specific bullion bars linked to your NFT." },
        { url: "https://gldt.org/", quote: "For reverse swapping from GLDT to GLD NFT, a fee of 1 GLDT is charged for every GLD NFT that is unlocked from the swap canister. For example, if 500 GLDT are swapped to 5x 1g GLD NFT, 5x 1 GLDT fee are applied." },
        { url: "https://bity.com/en/gold/", quote: "Bity Gold offers an innovative solution by tokenizing physical gold, offering seamless access to LBMA gold bars (highest standard, 999.9 purity) without any extra fees." },
        { url: "https://help.bity.com/en/articles/9680077-how-can-i-redeem-the-physical-gold-bar-from-my-nfts", quote: "After sending your NFT to the provided address, you will receive another address to pay the CHF 300 fee (operational fees charged by the vault). This fee applies regardless of the size or quantity of gold. At present, physical gold can only be redeemed in Zurich, Switzerland." },
        { url: "https://help.bity.com/en/articles/9680058-how-can-i-resell-my-gld-nft", quote: "Bity will provide a price based on the LBMA spot gold price, fixed for the next 24 hours, minus a 3% fee. The price will be quoted in USDT. Once the transaction is confirmed, we will send the agreed USDT amount to your specified address." },
      ],
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
    reviewedAt: "2026-10-02",
    routeStatus: "unknown",
    unresolvedOutputDisposition: "issuer-undisclosed",
    costModel: documentedVariableFee(
      "The historical VNX platform offered sell/redemption and physical collection or delivery from one-kilogram gold bars; current VNXAU-specific payout terms and a fixed redemption fee are not established after the platform suspension",
    ),
    docs: [
      sourceRef(
        "VNX platform suspension notice",
        "https://vnx.li/blog",
        ["route", "access", "settlement"],
      ),
      sourceRefRouteCapacityAccess("VNX Gold executive summary", "https://vnx.gitbook.io/vnx-platform/vnx-gold/executive-summary"),
      sourceRefRouteCapacityFees("VNX Gold token details", "https://vnx.gitbook.io/vnx-platform/vnx-gold/token-details"),
      sourceRef(
        "VNX Gold operations",
        "https://vnx.gitbook.io/vnx-platform/vnx-gold/operations-with-vnx-gold-on-vnx-platform",
        ["route", "fees", "access", "settlement"],
      ),
      sourceRef(
        "VNXAU AREVA report",
        "https://vnx.li/uploads/2026/03/VNX_Examination_on_Management_Assertions_VNXAU_31_12_2025_signiert.pdf",
        ["capacity"],
      ),
      sourceRef(
        "VNXAU current service and contractual-rights disclosure",
        "https://vnx.li/vnxau",
        ["route", "access", "settlement"],
      ),
      sourceRef(
        "VNXAU current transparency and report inventory",
        "https://vnx.li/vnxau-transparency",
        ["capacity"],
      ),
      sourceRef(
        "VNX Global current terms: commodity-token proprietary exchange",
        "https://prod-global-terms.s3.sa-east-1.amazonaws.com/VNX-Global-Terms.pdf",
        ["route", "access", "settlement"],
      ),
      sourceRef(
        "Metals.io physical gold FAQ: legacy issuer contact, no release timeline",
        "https://help.metals.io/en/articles/14129282-how-can-i-redeem-physical-gold",
        ["route", "access", "settlement"],
      ),
      sourceRef(
        "Metals.io current Etherlink VNXAU market interface",
        "https://app.metals.io/en/VNXAU",
        ["route"],
      ),
    ],
    notes: [
      "The historical VNX platform route offered fiat or supported cryptocurrency sale proceeds and physical bars starting at 1 kg; this is not a fixed complete payout basket or an atomic stablecoin redemption.",
      "Re-reviewed 2026-10-02: VNX's current primary notice suspends platform exchange operations from June 30, 2026 and ends the remaining-balance withdrawal window on July 31. The current VNXAU page states that purchase, sale, exchange, custody and trading services are not provided, while existing holder rights remain governed by contractual arrangements. Route status remains unknown because the config has no suspended state; no maintained physical-release or fully specified issuer cash-out route is established for admission here.",
      "Historical physical collection/delivery starts at 1 kg in kilogram multiples. The historical one-business-day statement applies to purchase/sale transactions, not bullion release or delivery, so it cannot supply a physicalToUsd settlement leg. Unpriced cross-border logistics remain unavailable. No physicalToUsd block is admitted from these suspended-platform disclosures.",
      "The current transparency page still links only the December 31, 2025 AREVA AUP. Its historical 13,100 gross grams and non-assured holder-rights notes do not establish current bar inventory, release throughput, purity-adjusted weight or currently available holder service.",
      "VNX Global's current terms separately permit proprietary exchange of Commodity Tokens, including VNXAU, for fiat or other digital assets. Section 6 makes that service resource-dependent, discretionary and not guaranteed. This successor venue is not a physical redemption obligation and does not establish a complete payout set, current same-notional execution capacity or settlement maximum. The old issuer-platform suspension is not evidence that all VNXAU market exits have ceased.",
      "Independent verification found that Metals.io still directs physical-redemption requests in 1 kg multiples to support@vnx.li, without publishing a release timeline or evidence that the issuer service resumed. Its current Etherlink VNXAU market interface separately returned an indicative 1,000-token sale quote in USDC, subject to sign-in and execution. This is a secondary-market diagnostic, not physical redemption, measured same-notional capacity or proof that every holder can execute."
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
    physicalToUsd: {
      metal: "XAG", fineTroyOuncesPerToken: 0.998380822,
      lot: { minimumTokens: 2100, incrementTokens: null, bars: [{ barId: "lbma-good-delivery-silver-variable-weight", fineTroyOunces: null }] },
      vaultLocations: ["singapore", "hong-kong"], barClass: "good-delivery",
      saleLocation: "in-vault", deliveryScope: "same-jurisdiction", fineness: 0.999,
      eligibility: "verified-customer",
      fees: { issuerFeeBps: 50, issuerFixedUsd: null, deliveryUsdPerLot: null, insuranceBps: null, assayUsdPerLot: null, taxBps: null, conversionBps: null },
      settlementLegs: [{ leg: "issuer-release-to-holder-vault-collection", maximumBusinessDays: null, typicalBusinessDays: null }],
      bestEffortIssuerCashOut: {
        operatingProcess: "Verified customers submit XAGm with maximum slippage; Matrixdock sells physical silver through silver partners and sends USDC or USDT within T+3 after execution. Out-of-slippage orders are cancelled for a new quote or refund; cash minimum and pre-execution deadline are not documented.",
        lot: { minimumTokens: null, incrementTokens: null, bars: [] },
        fees: { issuerFeeBps: 50, issuerFixedUsd: null, deliveryUsdPerLot: null, insuranceBps: null, assayUsdPerLot: null, taxBps: null, conversionBps: null },
        settlementLegs: [
          { leg: "quote-acceptance-to-execution", maximumBusinessDays: null, typicalBusinessDays: null },
          { leg: "executed-order-to-supported-stablecoin-receipt", maximumBusinessDays: 3, typicalBusinessDays: null },
        ],
      },
      reviewedAt: "2026-10-01", reviewExpiresAt: "2026-12-30",
      evidence: [
        { url: "https://www.matrixdock.com/xagm", quote: "Current Troy Ounce Per Token: 0.998380822. The ozPerToken value starts at 1 and reduces daily according to an annual 0.3% custody fee." },
        { url: "https://matrixdock.gitbook.io/matrixdock-docs/english/silver-token-xagm/minting-and-redeeming", quote: "Redeeming XAGm for physical LBMA silver is at a minimum of 2100 XAGm. The final silver amount will be determined based on the applicable ozPerToken ratio at the time of redemption. It can be collected via customer pickup or secured delivery. After order execution, Matrixdock will provide you with the final transaction price and the corresponding stablecoin amount. The stablecoins will be sent within T+3." },
        { url: "https://matrixdock.gitbook.io/matrixdock-docs/english/silver-token-xagm/faq", quote: "A fee of 0.50% will be charged for each redemption order. You are able to redeem XAGm directly with Matrixdock into supported stablecoins such as USDC and USDT. Matrixdock will perform the sale of physical bars and transfer the stablecoins to your wallet." },
        { url: "https://2505056629-files.gitbook.io/~/files/v0/b/gitbook-x-prod.appspot.com/o/spaces%2FZx9GNWaNV9JB3JZlW74D%2Fuploads%2FTRQNUC7Hw1k5EyWrxUrR%2FMatrixdock%20Silver%20XAGm%20Whitepaper.pdf?alt=media&token=cad709b6-47f1-427d-ad14-443fa5cd76e1", quote: "Physical LBMA silver bars are following the LBMA Good Delivery standard, which accepts a range of approximately 100 troy oz. above/below the 1000 oz. fine weight specification. When redeeming into a physical LBMA silver bar, a request has to be made to the Matrixdock Silver operator to seek confirmation on the time, location of collection and other relevant details." },
        { url: "https://2505056629-files.gitbook.io/~/files/v0/b/gitbook-x-prod.appspot.com/o/spaces%2FZx9GNWaNV9JB3JZlW74D%2Fuploads%2Frlo39Pv6A1ZIVdLEROOh%2FMatrixdock%20Silver%20Bureau%20Veritas%20Audit%20Jul%202026.pdf?alt=media&token=d5a97752-ca3b-46d3-9077-16ac2bc11ee8", quote: "HERAEUS Silver Bar 1000 toz – 999.0 Fineness | 64 PCS | BRINK’S HK. HERAEUS Silver Bar 1000 toz – 999.0 Fineness | 2 PCS | MALCA-AMIT SG" },
      ],
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
    reviewedAt: "2026-10-01",
    outputAssetType: "physical-commodity-delivery",
    physicalCommodityDelivery: {
      commodity: "XAU", deliverableOuncesPerToken: 0.001, minimumDeliveryTokens: 13500,
      deliveryTermsUnbounded: true,
      feeModel: { bps: 300, flatUsd: 0, deliveryUsd: 0 }, sameNotionalEligible: false,
    },
    physicalToUsd: {
      metal: "XAU", fineTroyOuncesPerToken: 0.001,
      lot: { minimumTokens: 13500, incrementTokens: null, bars: [] },
      vaultLocations: ["other"], barClass: "small-bar-or-coin",
      saleLocation: "in-vault", deliveryScope: "same-jurisdiction", fineness: null,
      eligibility: "verified-customer",
      fees: { issuerFeeBps: 300, issuerFixedUsd: null, deliveryUsdPerLot: null, insuranceBps: null, assayUsdPerLot: null, taxBps: null, conversionBps: null },
      settlementLegs: [
        { leg: "issuer-processing", maximumBusinessDays: null, typicalBusinessDays: 7 },
        { leg: "physical-gold-release-in-vault", maximumBusinessDays: null, typicalBusinessDays: null },
      ],
      reviewedAt: "2026-10-01", reviewExpiresAt: "2026-12-30",
      evidence: [
        { url: "https://app.goldfishgold.com/redemption", quote: "Minimum Redemption: 13500.00 GGBR. Redemption Fee: 3%. Processing Time: 5-7 Business Days. Delivery Options: Vault Storage / Physical Delivery. Note: Physical gold redemption requires KYC verification and may incur additional shipping and insurance fees." },
        { url: "https://goldfishgold.com/", quote: "By design, these tokens are engineered to track the live spot price of gold with one token representing exactly 1/1000th of a troy ounce, giving users a transparent, fractional, and highly liquid way to digitally own gold." },
        { url: "https://goldfishgold.com/support", quote: "Goldfish utilizes an \"in-situ\" (unmined) collateral model. The gold backing GGBR is fully verified, measured, and legally secured, but it remains in the ground at the Happy 2 claims." },
      ],
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
      "Re-reviewed 2026-10-01: the public redemption app now displays 'Processing Time 5-7 Business Days' alongside the 13,500 GGBR minimum and 3% fee. Processing time is not a final physical-delivery SLA or proof of a same-notional USD payout; eligible jurisdictions and additional delivery costs remain unbounded.",
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
