import type { RedemptionBackstopConfig } from "../shared";
import {
  documentedBoundSupplyFull,
  documentedVariableFee,
  undisclosedReviewedFee,
  fixedFee,
  issuerBase,
  commodityIssuerBase,
  sourceRef,
  sourceRefRouteCapacity,
  sourceRefRouteCapacityAccess,
  sourceRefRouteCapacityFees,
} from "../shared";
import {
  reviewedDirectRedemptionSupplyFull,
  REVIEWED_DIRECT_REDEMPTION_AT,
  REVIEWED_FOLLOWUP_REMEDIATION_AT,
  REVIEWED_REMEDIATION_AT,
} from "./shared";

export const REMEDIATION_AND_LATE_AUDIT_OFFCHAIN_CONFIGS: Record<string, RedemptionBackstopConfig> = {
  "kau-kinesis": {
    ...commodityIssuerBase,
    ...reviewedDirectRedemptionSupplyFull,
    reviewedAt: "2026-09-21",
    outputAssetType: "physical-commodity-delivery",
    physicalCommodityDelivery: {
      commodity: "XAU",
      deliverableOuncesPerToken: 1 / 31.1034768,
      minimumDeliveryTokens: 100,
      deliveryTermsUnbounded: true,
      feeModel: { bps: 45, flatUsd: 100, deliveryUsd: 0 }, sameNotionalEligible: false,
    },
    physicalToUsd: {
      metal: "XAU", fineTroyOuncesPerToken: 0.03215074656862798,
      lot: { minimumTokens: 100, incrementTokens: 100, bars: [] },
      vaultLocations: ["london", "zurich", "singapore", "hong-kong", "other"], barClass: "small-bar-or-coin",
      saleLocation: "delivered", deliveryScope: "cross-border", fineness: 0.9999,
      eligibility: "verified-customer",
      fees: { issuerFeeBps: 45, issuerFixedUsd: 100, deliveryUsdPerLot: null, insuranceBps: null, assayUsdPerLot: null, taxBps: null, conversionBps: null },
      settlementLegs: [
        { leg: "issuer-request-contact-only", maximumBusinessDays: 2, typicalBusinessDays: null },
        { leg: "issuer-acceptance-and-bullion-release", maximumBusinessDays: "unbounded", typicalBusinessDays: null },
        { leg: "bullion-delivery", maximumBusinessDays: null, typicalBusinessDays: null },
      ],
      bestEffortIssuerCashOut: {
        operatingProcess: "Verified customers sell KAU on the Kinesis platform for C1USD, convert C1USD to USD cash, then withdraw to their linked bank. This is platform trading, not guaranteed bullion repurchase.",
        lot: { minimumTokens: null, incrementTokens: null, bars: [] },
        fees: { issuerFeeBps: 22, issuerFixedUsd: 25, deliveryUsdPerLot: 0, insuranceBps: 0, assayUsdPerLot: 0, taxBps: null, conversionBps: null },
        settlementLegs: [
          { leg: "platform-sale-order-execution", maximumBusinessDays: "unbounded", typicalBusinessDays: null },
          { leg: "c1usd-to-usd-conversion", maximumBusinessDays: null, typicalBusinessDays: null },
          { leg: "usd-bank-withdrawal", maximumBusinessDays: null, typicalBusinessDays: null },
        ],
      },
      reviewedAt: "2026-10-01", reviewExpiresAt: "2026-12-30",
      evidence: [
        { url: "https://kinesis.money/gold/", quote: "1 gold (KAU) = 1 gram of gold" },
        { url: "https://kinesis.money/about-us/fees/", quote: "KAU | 0.45% + $100 + delivery fee* | 100g gold. Coins or bars with a fine weight of 100g of .9999 gold. Buy or sell gold (KAU) and silver (KAG) bullion at the quoted market price, via the Kinesis dashboard or the Kinesis Exchange: | 0.22% fee. US | $25 | $100" },
        { url: "https://support.kinesis.money/hc/en-gb/articles/12439302237085-How-to-redeem-physical-gold-and-silver", quote: "Redemptions of gold and silver can only be made in increments of 100 KAU or 200 KAG. Your request will be sent to the Kinesis operations team, who will contact you with the next steps within 1-2 working days. Follow these simple steps to get physical gold and silver delivered to your door, anywhere in the world." },
        { url: "https://support.kinesis.money/hc/en-gb/articles/12357060901789-How-are-my-gold-and-silver-stored-and-secured", quote: "The physical precious metal backing the Kinesis gold (KAU) and silver (KAG) currencies, is stored within fully insured, world-class vaulting facilities across the globe, across Dubai, Hong Kong, Istanbul, Vaduz, London, New York, Singapore, Sydney, Toronto, Zurich, Panama City, Batam and Brisbane." },
        { url: "https://kinesis.money/about-us/documents/terms-of-use/", quote: "If Kinesis agrees to accept a requested Redemption of Kinesis Currency, it shall be on the basis that you will be required to comply with the terms and undertakings of this Clause 8. You acknowledge and agree that when placing an order, it may be executed in part. If part of an order is not executed, it will remain open until such time as it is executed or you cancel it in Kinesis Exchange." },
        { url: "https://support.kinesis.money/hc/en-gb/articles/35218102923293-Convert-between-Currency-One-Stablecoins-and-cash", quote: "Convert between cash and supported Currency One stablecoins with a 0% conversion fee (spreads or minimums may apply). Use the convert function to move Currency One stablecoins back into their corresponding fiat currencies. Navigate to your fiat currency tile under Assets. Select Withdraw and follow the prompts to send funds to your linked bank account." },
        { url: "https://support.kinesis.money/hc/en-gb/articles/12398056853661-Sending-and-receiving-assets", quote: "Users must fully KYC-verify their accounts to buy and sell through on the Kinesis platform." },
      ],
    },
    costModel: {
      ...documentedVariableFee("KAU: 0.45% + $100 + delivery fee; KAG: 0.45% + $100 + delivery fee"),
      feeBpsMax: 45,
    },
    docs: [
      sourceRefRouteCapacityFees("Kinesis fees", "https://kinesis.money/about-us/fees/"),
      sourceRef(
        "Kinesis physical redemption guide",
        "https://support.kinesis.money/hc/en-gb/articles/12439302237085-How-to-redeem-physical-gold-and-silver-bullion",
        ["route", "capacity", "access", "settlement"],
      ),
    ],
  },
  "kag-kinesis": {
    ...commodityIssuerBase,
    ...reviewedDirectRedemptionSupplyFull,
    reviewedAt: "2026-09-21",
    outputAssetType: "physical-commodity-delivery",
    physicalCommodityDelivery: {
      commodity: "XAG",
      deliverableOuncesPerToken: 1,
      minimumDeliveryTokens: 200,
      deliveryTermsUnbounded: true,
      feeModel: { bps: 45, flatUsd: 100, deliveryUsd: 0 }, sameNotionalEligible: false,
    },
    physicalToUsd: {
      metal: "XAG", fineTroyOuncesPerToken: 1,
      lot: { minimumTokens: 200, incrementTokens: 200, bars: [] },
      vaultLocations: ["london", "zurich", "singapore", "hong-kong", "other"], barClass: "small-bar-or-coin",
      saleLocation: "delivered", deliveryScope: "cross-border", fineness: 0.999,
      eligibility: "verified-customer",
      fees: { issuerFeeBps: 45, issuerFixedUsd: 100, deliveryUsdPerLot: null, insuranceBps: null, assayUsdPerLot: null, taxBps: null, conversionBps: null },
      settlementLegs: [
        { leg: "issuer-request-contact-only", maximumBusinessDays: 2, typicalBusinessDays: null },
        { leg: "issuer-acceptance-and-bullion-release", maximumBusinessDays: "unbounded", typicalBusinessDays: null },
        { leg: "bullion-delivery", maximumBusinessDays: null, typicalBusinessDays: null },
      ],
      bestEffortIssuerCashOut: {
        operatingProcess: "Verified customers sell KAG on the Kinesis platform for C1USD, convert C1USD to USD cash, then withdraw to their linked bank. This is platform trading, not guaranteed bullion repurchase.",
        lot: { minimumTokens: null, incrementTokens: null, bars: [] },
        fees: { issuerFeeBps: 22, issuerFixedUsd: 25, deliveryUsdPerLot: 0, insuranceBps: 0, assayUsdPerLot: 0, taxBps: null, conversionBps: null },
        settlementLegs: [
          { leg: "platform-sale-order-execution", maximumBusinessDays: "unbounded", typicalBusinessDays: null },
          { leg: "c1usd-to-usd-conversion", maximumBusinessDays: null, typicalBusinessDays: null },
          { leg: "usd-bank-withdrawal", maximumBusinessDays: null, typicalBusinessDays: null },
        ],
      },
      reviewedAt: "2026-10-01", reviewExpiresAt: "2026-12-30",
      evidence: [
        { url: "https://kinesis.money/silver/", quote: "1 silver (KAG) = 1 ounce of silver" },
        { url: "https://kinesis.money/about-us/fees/", quote: "KAG | 0.45% + $100 + delivery fee* | 200oz silver. Coins or bars with a fine weight of 200oz of .999 silver. Buy or sell gold (KAU) and silver (KAG) bullion at the quoted market price, via the Kinesis dashboard or the Kinesis Exchange: | 0.22% fee. US | $25 | $100" },
        { url: "https://support.kinesis.money/hc/en-gb/articles/12439302237085-How-to-redeem-physical-gold-and-silver", quote: "Redemptions of gold and silver can only be made in increments of 100 KAU or 200 KAG. Your request will be sent to the Kinesis operations team, who will contact you with the next steps within 1-2 working days. Follow these simple steps to get physical gold and silver delivered to your door, anywhere in the world." },
        { url: "https://support.kinesis.money/hc/en-gb/articles/12357060901789-How-are-my-gold-and-silver-stored-and-secured", quote: "The physical precious metal backing the Kinesis gold (KAU) and silver (KAG) currencies, is stored within fully insured, world-class vaulting facilities across the globe, across Dubai, Hong Kong, Istanbul, Vaduz, London, New York, Singapore, Sydney, Toronto, Zurich, Panama City, Batam and Brisbane." },
        { url: "https://kinesis.money/about-us/documents/terms-of-use/", quote: "If Kinesis agrees to accept a requested Redemption of Kinesis Currency, it shall be on the basis that you will be required to comply with the terms and undertakings of this Clause 8. You acknowledge and agree that when placing an order, it may be executed in part. If part of an order is not executed, it will remain open until such time as it is executed or you cancel it in Kinesis Exchange." },
        { url: "https://support.kinesis.money/hc/en-gb/articles/35218102923293-Convert-between-Currency-One-Stablecoins-and-cash", quote: "Convert between cash and supported Currency One stablecoins with a 0% conversion fee (spreads or minimums may apply). Use the convert function to move Currency One stablecoins back into their corresponding fiat currencies. Navigate to your fiat currency tile under Assets. Select Withdraw and follow the prompts to send funds to your linked bank account." },
        { url: "https://support.kinesis.money/hc/en-gb/articles/12398056853661-Sending-and-receiving-assets", quote: "Users must fully KYC-verify their accounts to buy and sell through on the Kinesis platform." },
      ],
    },
    costModel: {
      ...documentedVariableFee("KAU: 0.45% + $100 + delivery fee; KAG: 0.45% + $100 + delivery fee"),
      feeBpsMax: 45,
    },
    docs: [
      sourceRefRouteCapacityFees("Kinesis fees", "https://kinesis.money/about-us/fees/"),
      sourceRef(
        "Kinesis physical redemption guide",
        "https://support.kinesis.money/hc/en-gb/articles/12439302237085-How-to-redeem-physical-gold-and-silver-bullion",
        ["route", "capacity", "access", "settlement"],
      ),
    ],
  },
  "cgo-comtech": {
    ...commodityIssuerBase,
    ...documentedBoundSupplyFull(REVIEWED_REMEDIATION_AT),
    reviewedAt: "2026-09-21",
    outputAssetType: "physical-commodity-delivery",
    physicalCommodityDelivery: {
      commodity: "XAU", deliverableOuncesPerToken: 1 / 31.1034768, minimumDeliveryTokens: 1000,
      deliveryTermsUnbounded: true,
      feeModel: { bps: 0, flatUsd: 0, deliveryUsd: 0 }, sameNotionalEligible: false,
    },
    physicalToUsd: {
      metal: "XAU", fineTroyOuncesPerToken: 0.03211859582205935,
      lot: { minimumTokens: 1000, incrementTokens: 1000, bars: [{ barId: "contractual-one-kilogram-999-minimum-purity", fineTroyOunces: 32.118595822059355 }] },
      vaultLocations: ["other"], barClass: "kilobar",
      saleLocation: "in-vault", deliveryScope: "same-jurisdiction", fineness: 0.999,
      eligibility: "verified-customer",
      fees: { issuerFeeBps: 100, issuerFixedUsd: null, deliveryUsdPerLot: null, insuranceBps: 0, assayUsdPerLot: null, taxBps: null, conversionBps: null },
      settlementLegs: [{ leg: "issuer-release-and-vault-collection", maximumBusinessDays: null, typicalBusinessDays: null }],
      bestEffortIssuerCashOut: {
        operatingProcess: "ComTech app publishes a sell quote during international market hours; holder places a sell order and receives funds into the trading-platform account. Bank withdrawal and spendable USD endpoint are undocumented.",
        lot: { minimumTokens: null, incrementTokens: null, bars: [] },
        fees: { issuerFeeBps: null, issuerFixedUsd: null, deliveryUsdPerLot: 0, insuranceBps: 0, assayUsdPerLot: 0, taxBps: null, conversionBps: null },
        settlementLegs: [
          { leg: "app-sell-order-execution", maximumBusinessDays: null, typicalBusinessDays: null },
          { leg: "platform-funds-to-spendable-usd", maximumBusinessDays: null, typicalBusinessDays: null },
        ],
      },
      reviewedAt: "2026-10-01", reviewExpiresAt: "2026-12-30",
      evidence: [
        { url: "https://cgold.ae/assets/pdf/Terms_and_Conditions.pdf", quote: "Each Digital Gold unit represents undivided ownership and specific interest in one (1) gram of at least 999 purity gold in the Gold Reserves. The physical Gold Reserves will be of standardised 1 kg bars of 999 purity from internationally accepted refineries. You may instruct the Digitization Entity to convert Digital Gold to physical gold from the Gold Reserves of a minimum quantity of one kilogram and in further denominations of one kilogram each" },
        { url: "https://cgold.ae/assets/pdf/Terms_and_Conditions.pdf", quote: "The Digitization Entity shall procure the release of the underlying Gold Reserves of the Redeemed Digital Gold Units (\"Redeemed Gold Bars\"), less applicable fees, and to procure Your collection of the Redeemed Gold Bars in person in the Vault or request delivery of the Commodity to You at Your own cost and expense (certain limitations apply) on the terms and conditions set out herein. The Digitization Entity shall store the Gold Reserves with custodians of international repute in the UAE or elsewhere operating specialized high-security storage facilities" },
        { url: "https://cgold.ae/Digitalgold", quote: "Transaction Fees: Nil. Custody Fees: Nil. Insurance Fees: Nil. Transfer Fees: 0.50%. Physical Gold Redemption Fees: 0.50%" },
        { url: "https://comtechgold.com/assets/pdf/ComTech_Gold_FAQ_Final.pdf", quote: "ComTech Gold provides a sell price quote on their ComTech Gold app during international market hours You can choose to sell any amount to a maximum of the amount of gold that you own. Retail Customers are required to provide us with the requisite KYC documents and enter the basic personal information" },
      ],
    },
    costModel: documentedVariableFee("Contractual 1,000 CGO minimum is used conservatively over the FAQ's 10 CGO; making, delivery and applicable storage remain unpriced"),
    docs: [
      sourceRef("CGO FAQ: 10 CGO minimum", "https://comtechgold.com/assets/pdf/ComTech_Gold_FAQ_Final.pdf", ["route", "access", "fees"]),
      sourceRef("CGO contractual terms: 1,000 CGO minimum", "https://comtechgold.com/assets/pdf/Terms_and_Conditions.pdf", ["route", "access", "fees"]),
      sourceRefRouteCapacityFees("ComTech Gold digital gold", "https://comtechgold.com/Digitalgold"),
      sourceRefRouteCapacityAccess("ComTech Gold terms", "https://comtechgold.com/Termsandconditions"),
    ],
  },
  "dgld-gold-token-sa": {
    ...commodityIssuerBase,
    ...documentedBoundSupplyFull(REVIEWED_REMEDIATION_AT),
    reviewedAt: "2026-09-21",
    outputAssetType: "physical-commodity-delivery",
    physicalCommodityDelivery: {
      commodity: "XAU", deliverableOuncesPerToken: 1, minimumDeliveryTokens: 1 / 31.1034768,
      deliveryTermsUnbounded: true,
      feeModel: { bps: 0, flatUsd: 0, deliveryUsd: 0 }, sameNotionalEligible: false,
    },
    physicalToUsd: {
      metal: "XAU", fineTroyOuncesPerToken: 1,
      lot: { minimumTokens: 0.03215074656862798, incrementTokens: null, bars: [{ barId: "gold-avenue-pamp-lady-fortuna-one-gram", fineTroyOunces: 0.03214753149397112 }] },
      vaultLocations: ["other"], barClass: "small-bar-or-coin",
      saleLocation: "delivered", deliveryScope: "cross-border", fineness: 0.9999,
      eligibility: "verified-customer",
      fees: { issuerFeeBps: 0, issuerFixedUsd: null, deliveryUsdPerLot: null, insuranceBps: null, assayUsdPerLot: null, taxBps: null, conversionBps: null },
      settlementLegs: [
        { leg: "gold-avenue-quote-and-compliance", maximumBusinessDays: null, typicalBusinessDays: null },
        { leg: "europe-shipping-after-order-acceptance", maximumBusinessDays: null, typicalBusinessDays: 7 },
      ],
      reviewedAt: "2026-10-01", reviewExpiresAt: "2026-12-30",
      evidence: [
        { url: "https://dgld.ch/docs/terms", quote: "Each fungible DGLD token represents co-ownership rights corresponding to one fine troy ounce of LBMA Certified Gold. The Gold is held in segregated, secure and insured vault in Switzerland, under the custody of MKS PAMP, as part of the Services performed by GTSA (see Section 5.2 and 5.3). Any persons involved must comply with KYC, AML/CFT and sanctions-related requirements when requested by GTSA." },
        { url: "https://dgld.ch/docs/terms", quote: "No Burning Fee shall apply where Delivery is effected pursuant to Section 8.2.2 unless expressly provided otherwise. The Tokenholder shall bear all premiums, fees, charges and expenses imposed by the approved third-party provider in connection with the Delivery, including any fabrication premium, logistics, handling, transportation, insurance, customs duties, taxes and any other applicable costs." },
        { url: "https://dgld.ch/news/dgld-complete-step-by-step-guide-november-2025", quote: "Decide how many grams you want (minimum 1 g). Bars: sealed PAMP Lady Fortuna, 999.9 fine. Europe: 3–7 business days, insured post" },
      ],
    },
    costModel: fixedFee(0, "No custody or transfer fees per Gold Token SA; minimum 1 gram"),
    docs: [
      sourceRefRouteCapacity("DGLD homepage", "https://dgld.ch/"),
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
      sourceRefRouteCapacity("About WUSD", "https://developer.wspn.io/5768563m0"),
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
      sourceRefRouteCapacityFees(
        "OSL StableHub launch",
        "https://www.osl.com/en/announcement/osl-stablehub-grand-launch-multi-stablecoin-and-usd-seamless-1-1-exchange",
      ),
      sourceRefRouteCapacity(
        "OSL USDGO launch",
        "https://www.osl.com/hk-en/press-release/osl-group-officially-launches-regulated-enterprise-stablecoin-usdgo",
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
      sourceRefRouteCapacity("AUDD home", "https://www.audd.digital/"),
      sourceRefRouteCapacityFees(
        "AUDD product disclosure statement",
        "https://www.audd.digital/wp-content/uploads/2026/02/202602_AUDD-PDS.pdf",
      ),
    ],
  },
  "usdr-stablr": {
    ...issuerBase,
    ...reviewedDirectRedemptionSupplyFull,
    costModel: fixedFee(0, "StablR docs state qualified businesses can onramp and offramp USDR at no additional cost"),
    docs: [
      sourceRefRouteCapacityFees("What is USDR", "https://docs.stablr.com/docs/what-is-eurr-copy"),
      sourceRefRouteCapacity("StablR overview", "https://docs.stablr.com/docs/overview"),
    ],
  },
  "pgold-pleasing": {
    ...commodityIssuerBase,
    ...reviewedDirectRedemptionSupplyFull,
    reviewedAt: "2026-09-21",
    outputAssetType: "physical-commodity-delivery",
    physicalCommodityDelivery: {
      commodity: "XAU", deliverableOuncesPerToken: 1, minimumDeliveryTokens: 32.15,
      deliveryTermsUnbounded: true,
      feeModel: { bps: 50, flatUsd: 0, deliveryUsd: 0 }, sameNotionalEligible: false,
    },
    physicalToUsd: {
      metal: "XAU", fineTroyOuncesPerToken: 0.9999,
      lot: { minimumTokens: 32.15, incrementTokens: null, bars: [] },
      vaultLocations: ["hong-kong"], barClass: "small-bar-or-coin",
      saleLocation: "delivered", deliveryScope: "same-jurisdiction", fineness: 0.9999,
      eligibility: "verified-customer",
      fees: { issuerFeeBps: null, issuerFixedUsd: null, deliveryUsdPerLot: null, insuranceBps: null, assayUsdPerLot: null, taxBps: null, conversionBps: null },
      settlementLegs: [{ leg: "issuer-redemption-and-offline-pickup", maximumBusinessDays: "unbounded", typicalBusinessDays: null }],
      reviewedAt: "2026-10-01", reviewExpiresAt: "2026-12-30",
      evidence: [
        { url: "https://pleasing.gitbook.io/docs/user-guide/redeem-physical-gold", quote: "Enter the PGOLD amount on the left (minimum 32.15 PGOLD per redemption). The right side shows the quantity of physical gold you will receive. The swap is always at 1 PGOLD = 1 ounce of 99.99% pure gold. Wait for customer support to contact you for the subsequent offline pickup." },
        { url: "https://pleasing.gitbook.io/docs/legal/terms-of-sale-and-service", quote: "Eligible KYC/KYB-verified holders may request redemption. Initial physical delivery/collection supported in Hong Kong (expanded APAC coverage may follow). Bar sizes, minimum redemption thresholds, lead times, and logistics constraints apply. Redemption, handling, insurance, and delivery fees per the Fee Schedule. We use commercially reasonable efforts; delays may occur due to market/liquidity, logistics, regulatory, or force-majeure events. We may refuse, suspend, or terminate Token Services at any time to comply with law, risk, or operational requirements." },
      ],
    },
    executionModel: "opaque",
    costModel: documentedVariableFee(
      "Physical gold redemption requires KYC and compliance checks, with additional fees, minimums, and logistics that vary by jurisdiction and program terms",
    ),
    docs: [
      sourceRef("PGOLD physical redemption minimum and fee", "https://pleasing.gitbook.io/docs/user-guide/redeem-physical-gold", ["route", "fees", "access"]),
      sourceRef("PGOLD additional handling, insurance and delivery terms", "https://pleasing.gitbook.io/docs/legal/terms-of-sale-and-service", ["route", "fees"]),
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
    outputAssetType: "stable-basket",
    outputAssets: ["usdc-circle", "usdt-tether"],
    capacityModel: { kind: "supply-ratio", ratio: 0.05, confidence: "documented-bound" },
    costModel: fixedFee(
      10,
      "StandX User Terms: the redemption pricing quote includes a 10 bps reimbursement charge covering hedge execution and blockchain gas; the product FAQ agrees that redeeming DUSD incurs a 0.1% fee",
    ),
    reviewedAt: REVIEWED_DIRECT_REDEMPTION_AT,
    docs: [
      sourceRef("StandX payout FAQ (reviewed 2026-09-30; fee re-read 2026-10-03)", "https://docs.standx.com/docs/dusd-overview/product-faq", ["route", "fees"]),
      sourceRef("StandX user terms and conditions (reviewed 2026-10-03)", "https://docs.standx.com/docs/resources/user-terms-conditions", ["fees"]),
      sourceRefRouteCapacity("StandX docs", "https://docs.standx.com/"),
      sourceRef("StandX website", "https://www.standx.com/", ["route"]),
    ],
    notes: [
      "Payout identity reviewed 2026-09-30: StandX's product FAQ says holders get back USDT/USDC after redemption; the multi-output route retains conservative stable-basket semantics.",
      "Tracked metadata describes 1:1 USDT and USDC redemption from a delta-neutral strategy wrapper",
      "The reviewed 5% bound matches the tracked stability-reserve stablecoin fund rather than assuming the full hedged book is instantly withdrawable",
      "Fee reviewed 2026-10-03: the governing User Terms fix the redemption reimbursement charge at 10 bps and the product FAQ agrees; separate product redemption prose describing a market-variable fee is inconsistent with both and is not given precedence over the legal terms.",
    ],
  },
  "brla-brla-digital": {
    ...issuerBase,
    ...documentedBoundSupplyFull("2026-04-16"),
    costModel: undisclosedReviewedFee(
      "Avenia (formerly BRLA Digital) documents 1:1 BRLA mint and redemption against BRL after KYC; public docs reviewed do not publish a fixed numeric redemption fee",
    ),
    v9RouteReviewTerms: {
      scoringDisposition: "bounded-terms-gap",
      missingScoringFields: ["capacity", "settlement", "cost"],
      rationale:
        "Avenia establishes a KYC-gated BRLA redemption mechanism, but its quote/ticket documentation re-opened on 2026-09-04 provides illustrative fee fields rather than a dated binding BRLA-to-BRL limit, bank settlement SLA, or all-in route cost.",
      reviewedAt: "2026-09-04",
      docs: [
        sourceRef("Avenia documentation", "https://docs.avenia.io/", ["route", "access"]),
        sourceRefRouteCapacityFees(
          "Avenia quotes and tickets",
          "https://integration-guide.avenia.io/docs/Operations/quotesAndTickets/",
        ),
      ],
    },
    docs: [
      sourceRefRouteCapacity("BRLA Digital", "https://brla.digital/"),
      sourceRef("Avenia documentation", "https://docs.avenia.io/", ["route", "access"]),
    ],
    notes: ["Native multichain fiat-backed BRL stablecoin; KYC-gated primary mint and redeem rail via Avenia"],
  },
  "ctusd-citrea": {
    ...issuerBase,
    capacityModel: { kind: "reserve-sync-metadata" },
    costModel: fixedFee(
      0,
      "MoonPay Stablecoin Terms section 4.1: MoonPay does not currently charge fees for redeeming Stablecoins. This is the issuer fee only; bank, processor, network, and ecosystem charges may still apply",
    ),
    reviewedAt: "2026-08-31",
    docs: [
      sourceRefRouteCapacity("Citrea", "https://citrea.xyz/"),
      sourceRef("Citrea documentation", "https://docs.citrea.xyz/", ["route"]),
      sourceRef("MoonPay Stablecoin Terms (reviewed 2026-10-03)", "https://www.moonpay.com/legal/stablecoin_terms", ["fees"]),
    ],
    notes: [
      "Fiat-backed via MoonPay; reserves cryptographically attested on-chain by M0 Validators before minting",
      "Fresh live reserve metadata reads the current M balance held by the ctUSD extension and verifies the configured M0 SwapFacility path before admitting redemption capacity.",
    ],
  },
  "xo-exodus": {
    ...issuerBase,
    ...documentedBoundSupplyFull("2026-04-16"),
    costModel: fixedFee(
      0,
      "MoonPay currently charges no fee for stablecoin redemption; bank, wallet, processing, network, ecosystem, or pass-through banking fees may still apply",
    ),
    v9RouteReviewTerms: {
      scoringDisposition: "bounded-terms-gap",
      missingScoringFields: ["settlement"],
      rationale:
        "MoonPay Stablecoin Terms retain the documented 0 bps redemption charge but refer to an unpublished redemption schedule and expose no publication/update date; the 2026-09-04 re-open found no dated end-to-end settlement SLA, so settlement remains withheld.",
      reviewedAt: "2026-09-04",
      docs: [
        sourceRef("MoonPay Stablecoin Terms", "https://www.moonpay.com/legal/stablecoin_terms", [
          "route",
          "fees",
          "settlement",
        ]),
      ],
    },
    docs: [
      sourceRefRouteCapacity("Exodus Pay", "https://www.exodus.com/exodus-pay"),
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
      sourceRefRouteCapacity("KAST documentation", "https://docs.kast.finance/"),
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
      sourceRefRouteCapacity("Ethena USDtb", "https://ethena.fi/usdtb"),
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
    docs: [sourceRefRouteCapacity("Gold Dollar USDKG", "https://usdkg.com/")],
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
      sourceRefRouteCapacity("USA₮ homepage", "https://usat.io/"),
      sourceRefRouteCapacityAccess(
        "USA₮ first reserve report",
        "https://usat.io/news/usat-establishes-transparency-benchmark-with-first-reserve-report/",
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
      sourceRefRouteCapacityAccess("MoveUSD overview", "https://docs.moveusd.com/docs/what-is-moveusd"),
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
