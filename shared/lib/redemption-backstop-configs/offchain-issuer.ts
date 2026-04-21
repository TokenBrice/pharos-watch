import type { RedemptionBackstopConfig } from "./shared";
import {
  applyTrackedReviewedDocs,
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
const REVIEWED_REMEDIATION_AT = "2026-03-30";
const REVIEWED_ISSUER_API_EXPANSION_AT = "2026-04-03";
const REVIEWED_MAJOR_ISSUER_REDEMPTION_AT = "2026-04-16";
const reviewedDirectRedemptionSupplyFull = documentedBoundSupplyFull(
  REVIEWED_DIRECT_REDEMPTION_AT,
);
const reviewedIssuerApiExpansionSupplyFull = documentedBoundSupplyFull(
  REVIEWED_ISSUER_API_EXPANSION_AT,
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
      "chfau-allunity",
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
    reviewedAt: REVIEWED_MAJOR_ISSUER_REDEMPTION_AT,
    costModel: documentedVariableFee("0.10% with a $1,000 minimum"),
    docs: [
      sourceRef("Tether Transparency", "https://tether.to/en/transparency", ["capacity"]),
      sourceRef("Tether legal terms", "https://tether.to/en/legal/", ["route", "capacity", "access"]),
      sourceRef("Tether fees", "https://tether.to/en/fees/", ["fees", "access"]),
    ],
  },
  "usdc-circle": {
    ...issuerBase,
    ...reviewedDirectRedemptionSupplyFull,
    reviewedAt: REVIEWED_MAJOR_ISSUER_REDEMPTION_AT,
    costModel: documentedVariableFee("1:1 via Circle Mint; EEA burn fee is 0 bps, other Circle fees may vary"),
    docs: [
      sourceRef("Circle Transparency", "https://www.circle.com/transparency", ["capacity"]),
      sourceRef("Circle USDC terms", "https://www.circle.com/legal/usdc-terms", ["route", "capacity", "access", "fees"]),
    ],
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
  "usdon-ondo": {
    ...issuerBase,
    ...documentedBoundSupplyFull("2026-04-20"),
    routeStatus: "open",
    costModel: documentedVariableFee(
      "Ondo Global Markets docs describe 1:1 USDC <-> USDon platform conversion when swapper liquidity is available; public materials reviewed do not publish a standalone fixed USDon redemption fee",
    ),
    docs: [
      sourceRef("Ondo available assets", "https://docs.ondo.finance/ondo-global-markets/available-assets", ["route", "capacity"]),
      sourceRef("Ondo investing and redeeming", "https://docs.ondo.finance/ondo-global-markets/investing-and-redeeming", ["route", "settlement"]),
      sourceRef("Ondo trust and transparency", "https://docs.ondo.finance/ondo-global-markets/trust-and-transparency", ["capacity"]),
    ],
    notes: [
      "Modeled as a whitelisted Ondo Global Markets settlement-cash route; current instant USDC output can depend on swapper liquidity, so this remains documented-bound eventual capacity rather than live immediate liquidity",
    ],
  },
  "usdsui-sui": {
    ...issuerBase,
    ...documentedBoundSupplyFull("2026-04-20"),
    settlementModel: "days",
    costModel: documentedVariableFee(
      "Bridge Open Issuance docs describe mint/burn rails and reserve redemption; public materials reviewed do not publish a USDsui-specific fixed redemption fee schedule",
    ),
    docs: [
      sourceRef("Sui Dollar launch", "https://blog.sui.io/sui-dollar-launch-bridge/", ["route"]),
      sourceRef("Bridge issuance overview", "https://apidocs.bridge.xyz/platform/issuance/overview", ["route", "capacity"]),
      sourceRef("Bridge reserve management", "https://apidocs.bridge.xyz/platform/issuance/reserve-management", ["capacity"]),
    ],
    notes: [
      "Bridge reserve docs describe API-gated issuer redemption and reserve management; Pharos models current support as documented eventual primary-market redeemability, not an independently measured instant buffer",
    ],
  },
  "brlv-crown": {
    ...issuerBase,
    ...documentedBoundSupplyFull("2026-04-20"),
    settlementModel: "days",
    routeStatus: "open",
    costModel: documentedVariableFee(
      "Crown terms describe standard and instant BRL redemption routes, but public materials reviewed do not expose a machine-readable fixed fee schedule",
    ),
    docs: [
      sourceRef("Crown BRLV website", "https://www.crown-brlv.com/en/", ["route"]),
      sourceRef("Crown BRLV transparency", "https://crown-brlv.com/en/transparency/", ["capacity"]),
      sourceRef("Crown BRLV whitepaper", "https://crown-2b36dce9.mintlify.app/whitepaper", ["route", "capacity"]),
    ],
    notes: [
      "Modeled against documented BRL issuer redemption for approved users; standard settlement can extend to T+3, so the route remains offchain-issuer rather than instant stablecoin swap capacity",
    ],
  },
  "usdglo-glo": {
    ...issuerBase,
    ...documentedBoundSupplyFull("2026-04-20"),
    routeStatus: "open",
    costModel: documentedVariableFee(
      "Brale pricing includes 1:1 stablecoin swaps for platform users; bank payout rails can still carry fixed processing fees",
    ),
    docs: [
      sourceRef("Glo Dollar contracts and reserves", "https://www.glodollar.org/articles/smart-contract-addresses", ["route", "capacity"]),
      sourceRef("Brale USDGLO", "https://brale.xyz/stablecoins/USDGLO", ["capacity"]),
      sourceRef("Brale pricing", "https://brale.xyz/pricing", ["fees"]),
    ],
    notes: [
      "USDGLO uses Brale issuer rails; Pharos treats this as documented full-supply eventual redeemability rather than measured immediate redemption capacity",
    ],
  },
  "audm-macropod": {
    ...issuerBase,
    ...documentedBoundSupplyFull("2026-04-20"),
    settlementModel: "days",
    routeStatus: "open",
    costModel: fixedFee(
      0,
      "Macropod states it charges no fee to purchase or redeem AUDM; non-NPP bank/payment fees and gas may still apply",
    ),
    docs: [
      sourceRef("AUDM product", "https://www.macropod.com/product/audm", ["route", "capacity"]),
      sourceRef("AUDM reserves", "https://www.macropod.com/transparency/reserves", ["capacity"]),
      sourceRef("AUDM legal", "https://www.macropod.com/transparency/legal", ["route", "fees", "access"]),
    ],
    notes: [
      "Macropod legal materials describe AUD bank-account redemption for approved clients; manual processing can use best efforts for next-business-day ADI instruction when instant rails are unavailable",
    ],
  },
  "audf-forte": {
    ...issuerBase,
    ...documentedBoundSupplyFull("2026-04-21"),
    settlementModel: "days",
    routeStatus: "open",
    costModel: documentedVariableFee(
      "Forte documents 1:1 AUDF issuance and redemption for eligible users, but the reviewed public materials do not publish a standalone numeric redemption fee schedule",
    ),
    docs: [
      sourceRef("Forte home", "https://www.forteaud.com/", ["route"]),
      sourceRef("Forte reserve reports", "https://www.forteaud.com/new-page", ["capacity"]),
      sourceRef("Forte PDS", "https://www.forteaud.com/s/AUDF_PDS.pdf", ["route", "capacity", "fees"]),
      sourceRef("Forte terms", "https://www.forteaud.com/s/ForteAUDTermsofUseJanuary2026.pdf", ["route", "access", "fees"]),
    ],
    notes: [
      "Forte documents 1:1 minting and redemption into Australian dollars for approved account holders, with payouts directed to verified bank accounts rather than through an instant onchain rail",
      "Reserve reports are published as static monthly PDFs, so Pharos treats AUDF as documented-bound eventual issuer redeemability rather than a live measured buffer",
    ],
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
  "ustb-superstate": {
    ...issuerBase,
    capacityModel: { kind: "reserve-sync-metadata" },
    costModel: documentedVariableFee("Daily NAV redemption through Superstate; public materials do not publish one universal fixed redemption fee"),
    reviewedAt: "2026-04-15",
    docs: [
      sourceRef("Superstate USTB", "https://superstate.com/assets/ustb", ["route", "capacity"]),
      sourceRef("Superstate liquidity API", "https://api.superstate.com/v1/funds/liquidity", ["capacity"]),
      sourceRef("Superstate docs", "https://docs.superstate.com/ustb", ["route"]),
    ],
    notes: [
      "Fresh live reserve telemetry uses Superstate's current USTB Circle USD available amount plus USDC RedemptionIdle balance as the bounded current liquidity capacity",
      "NAV/AUM remains reserve evidence only and is not used as immediate redemption capacity",
    ],
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
    ...reviewedDirectRedemptionSupplyFull,
    costModel: documentedVariableFee("1:1 redemption through STSS (Malta) Limited; public fee schedule not disclosed"),
    docs: [
      sourceRef("STASIS transparency", "https://stasis.net/transparency", ["route", "capacity"]),
      sourceRef("STASIS website", "https://stasis.net/", ["route"]),
    ],
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
    ...reviewedDirectRedemptionSupplyFull,
    costModel: fixedFee(0, "Zero-fee mint/redeem at 1:1 for USDC per Plume documentation"),
    docs: [
      sourceRef("Plume pUSD docs", "https://docs.plume.org/plume/tokens/plume-usd", ["route", "capacity", "fees"]),
      sourceRef("Plume pUSD page", "https://plume.org/pusd", ["route"]),
    ],
    notes: [
      "Route is modeled as the documented 1:1 issuer redemption rail into USDC; the single-asset reserve adapter remains reserve-detail telemetry only and is no longer treated as live redeemable-capacity evidence",
    ],
  },
  "gyen-gyen": {
    ...issuerBase,
    ...reviewedDirectRedemptionSupplyFull,
    costModel: documentedVariableFee(
      "Direct 1:1 redemption through GMO Trust; public fee schedule not disclosed",
    ),
    docs: [
      sourceRef("GMO Trust stablecoin docs", "https://stablecoin.z.com/what-are-gyen-and-zusd/", ["route", "capacity"]),
      sourceRef("GMO Trust attestation", "https://stablecoin.z.com/attestation/", ["capacity"]),
    ],
  },
  "cadc-cad-coin": {
    ...issuerBase,
    ...reviewedDirectRedemptionSupplyFull,
    costModel: documentedVariableFee(
      "Direct 1:1 redemption for CAD through Loon / PayTrie; public fee schedule not disclosed",
    ),
    docs: [
      sourceRef("CADC FAQ", "https://faq.paytrie.com/col/cadc-faqs", ["route", "capacity"]),
      sourceRef("Loon website", "https://loon.finance/", ["route"]),
    ],
  },
  "veur-vnx": {
    ...issuerBase,
    ...reviewedDirectRedemptionSupplyFull,
    costModel: documentedVariableFee(
      "Direct 1:1 redemption through VNX Commodities AG for verified users; public fee schedule not disclosed",
    ),
    docs: [
      sourceRef("VNX transparency", "https://vnx.li/transparency/", ["route", "capacity"]),
      sourceRef("VNX website", "https://vnx.li/", ["route"]),
    ],
  },
  "vchf-vnx": {
    ...issuerBase,
    ...reviewedDirectRedemptionSupplyFull,
    costModel: documentedVariableFee(
      "Direct 1:1 redemption through VNX Commodities AG for verified users; public fee schedule not disclosed",
    ),
    docs: [
      sourceRef("VNX docs", "https://vnx.gitbook.io/vnx-platform/", ["route", "capacity"]),
      sourceRef("VNX website", "https://vnx.li/", ["route"]),
    ],
  },
  "vgbp-vnx": {
    ...issuerBase,
    ...reviewedDirectRedemptionSupplyFull,
    costModel: documentedVariableFee(
      "Direct 1:1 redemption through VNX Commodities AG for verified users; public fee schedule not disclosed",
    ),
    docs: [
      sourceRef("VNX docs", "https://vnx.gitbook.io/vnx-platform/", ["route", "capacity"]),
      sourceRef("VNX website", "https://vnx.li/", ["route"]),
    ],
  },
  "tryb-bilira": {
    ...issuerBase,
    ...reviewedDirectRedemptionSupplyFull,
    costModel: documentedVariableFee(
      "Direct 1:1 issuance and redemption through BiLira; public fee schedule not disclosed",
    ),
    docs: [
      sourceRef("BiLira TRYB page", "https://www.bilira.co/en/product/tryb-stablecoin", ["route", "capacity"]),
    ],
  },
  "tgbp-tokenised": {
    ...issuerBase,
    ...reviewedDirectRedemptionSupplyFull,
    settlementModel: "days",
    costModel: documentedVariableFee(
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
    costModel: documentedVariableFee(
      "Direct 1:1 redemption through JPYC EX after KYC and bank transfer verification; public fee schedule not disclosed",
    ),
    docs: [
      sourceRef("JPYC website", "https://jpyc.co.jp/", ["route", "capacity"]),
    ],
  },
  "axcnh-anchorx": {
    ...issuerBase,
    ...reviewedDirectRedemptionSupplyFull,
    costModel: documentedVariableFee(
      "Direct 1:1 issuance and redemption through AnchorX for CNH transfers; public fee schedule not disclosed",
    ),
    docs: [
      sourceRef("AnchorX website", "https://www.anchorx.org/", ["route", "capacity"]),
    ],
  },
  "idrt-rupiah-token": {
    ...issuerBase,
    ...reviewedDirectRedemptionSupplyFull,
    costModel: documentedVariableFee(
      "Direct 1:1 issuance and redemption through PT Rupiah Token Indonesia after KYC; public fee schedule not disclosed",
    ),
    docs: [
      sourceRef("Rupiah Token website", "https://www.rupiahtoken.com/", ["route", "capacity"]),
    ],
  },
  "idrx-idrx": {
    ...issuerBase,
    ...reviewedIssuerApiExpansionSupplyFull,
    costModel: documentedVariableFee(
      "IDRX redemption fees are flat IDR charges that depend on redemption size (Rp5,000 up to Rp250,000,000; Rp35,000 above that during office hours), so the effective bps varies by ticket size",
    ),
    docs: [
      sourceRef("IDRX redeem IDR guide", "https://docs.idrx.co/services/redeem-idr", ["route", "capacity", "settlement"]),
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
    costModel: documentedVariableFee(
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
    costModel: documentedVariableFee(
      "Direct 1:1 redemption through Schuman Financial; public fee schedule not disclosed",
    ),
    docs: [
      sourceRef("EUROP white paper", "https://schuman.io/wp-content/uploads/2025/02/EUROP-White-Paper_1.3.pdf", ["route", "capacity"]),
      sourceRef("Schuman reserve audits", "https://schuman.io/reserve-audits/", ["capacity"]),
    ],
  },
  "eurau-allunity": {
    ...issuerBase,
    ...reviewedDirectRedemptionSupplyFull,
    costModel: documentedVariableFee(
      "Direct 1:1 redemption through AllUnity; public fee schedule not disclosed",
    ),
    docs: [
      sourceRef("AllUnity whitepaper", "https://allunity.com/whitepaper/", ["route", "capacity"]),
      sourceRef("AllUnity trust center", "https://allunity.com/trust-center/", ["capacity"]),
    ],
  },
  "chfau-allunity": {
    ...issuerBase,
    ...reviewedDirectRedemptionSupplyFull,
    costModel: documentedVariableFee(
      "Direct 1:1 redemption through AllUnity; public fee schedule not disclosed",
    ),
    docs: [
      sourceRef("AllUnity whitepaper", "https://allunity.com/whitepaper/", ["route", "capacity"]),
      sourceRef("AllUnity trust center", "https://allunity.com/trust-center/", ["capacity"]),
    ],
  },
  "usda-anzens": {
    ...issuerBase,
    ...reviewedDirectRedemptionSupplyFull,
    settlementModel: "days",
    costModel: documentedVariableFee(
      "Tracked issuer materials describe direct 1:1 USDA redemption into USD through KYC-verified banking rails; public fee schedule not disclosed",
    ),
    docs: [
      sourceRef("Anzens website", "https://www.anzens.com/", ["route", "capacity", "settlement"]),
    ],
    notes: ["Tracked metadata describes redemption through bank transfers rather than an instant onchain stablecoin withdrawal rail"],
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
    capacityModel: { kind: "supply-ratio", ratio: 0.05, confidence: "documented-bound" },
    costModel: documentedVariableFee(
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
    costModel: documentedVariableFee(
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
    costModel: documentedVariableFee(
      "Citrea documents 1:1 fiat mint and redemption via MoonPay using M0 Protocol infrastructure; MoonPay fiat-ramp fees apply while public docs reviewed do not publish a separate Citrea protocol redemption fee",
    ),
    docs: [
      sourceRef("Citrea", "https://citrea.xyz/", ["route", "capacity"]),
      sourceRef("Citrea documentation", "https://docs.citrea.xyz/", ["route"]),
    ],
    notes: [
      "Fiat-backed via MoonPay; reserves cryptographically attested on-chain by M0 Validators before minting",
    ],
  },
  "xo-exodus": {
    ...issuerBase,
    ...documentedBoundSupplyFull("2026-04-16"),
    costModel: documentedVariableFee(
      "Exodus XO documents 1:1 fiat mint and redemption via MoonPay using M0 Protocol infrastructure; MoonPay fiat-ramp fees apply while public docs reviewed do not publish a separate XO protocol redemption fee",
    ),
    docs: [
      sourceRef("Exodus Pay", "https://www.exodus.com/exodus-pay", ["route", "capacity"]),
      sourceRef("MoonPay", "https://www.moonpay.com/", ["route"]),
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
    notes: [
      "Solana SPL Token-2022 wrapper around M (M0); mint/redeem gated by KAST app and licensed payment partners",
    ],
  },
  "usdm-mega": {
    ...issuerBase,
    ...documentedBoundSupplyFull("2026-04-16"),
    costModel: documentedVariableFee(
      "USDM is issued on Ethena's USDtb rails; primary redemption follows USDtb's documented issuer rail and is KYC-gated; public USDM-specific redemption fees are not published",
    ),
    docs: [
      sourceRef("MegaETH", "https://www.megaeth.com/", ["route"]),
      sourceRef("Ethena USDtb", "https://ethena.fi/usdtb", ["route", "capacity"]),
    ],
    notes: [
      "USDM reuses Ethena's USDtb issuer redemption rail; reserve yield funds MegaETH sequencer costs",
    ],
  },
  "usdkg-gold-dollar": {
    ...issuerBase,
    ...documentedBoundSupplyFull("2026-04-16"),
    settlementModel: "days",
    costModel: documentedVariableFee(
      "Gold Dollar documents 1:1 USDKG mint and redemption against USD, KGS, physical gold, or approved cryptocurrencies after KYC/AML; public docs reviewed do not publish a fixed numeric redemption fee",
    ),
    docs: [
      sourceRef("Gold Dollar USDKG", "https://usdkg.com/", ["route", "capacity"]),
    ],
    notes: [
      "Licensed under Kyrgyz Republic Law on Virtual Assets (2022) / Cabinet Resolution No. 514; multiple redemption outputs supported (USD, KGS, physical gold, or approved crypto)",
    ],
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

applyTrackedReviewedDocs(OFFCHAIN_ISSUER_BACKSTOP_CONFIGS, [
  "usdt-tether",
  "usdc-circle",
  "pyusd-paypal",
  "fdusd-first-digital",
  "rlusd-ripple",
  "eurc-circle",
  "usdg-paxos",
  "usd1-world-liberty-financial",
  "ausd-agora",
  "tusd-trueusd",
  "brz-transfero",
  "a7a5-old-vector",
  "ylds-figure",
  "usdtb-ethena",
  "gusd-gate",
  "usyc-hashnote",
  "ustb-superstate",
  "buidl-blackrock",
  "usdy-ondo-finance",
  "paxg-paxos",
  "xaut-tether",
  "kau-kinesis",
  "kag-kinesis",
]);

applyTrackedReviewedDocs(OFFCHAIN_ISSUER_BACKSTOP_CONFIGS, [
  "zarp-zarp",
  "cetes-etherfuse",
  "cgo-comtech",
  "dgld-gold-token-sa",
], REVIEWED_REMEDIATION_AT);
