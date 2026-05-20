import type { RedemptionBackstopConfig } from "../shared";
import {
  documentedBoundSupplyFull,
  documentedVariableFee,
  fixedFee,
  issuerBase,
  NO_PUBLIC_NUMERIC_REDEMPTION_FEE,
  sourceRef,
} from "../shared";
import {
  reviewedDirectRedemptionSupplyFull,
} from "./shared";

export const MAJOR_ISSUER_OFFCHAIN_CONFIGS: Record<string, RedemptionBackstopConfig> = {
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
  "usdc-circle": {
    ...issuerBase,
    ...reviewedDirectRedemptionSupplyFull,
    capacityModel: { kind: "supply-ratio", ratio: 0.07, confidence: "documented-bound", basis: "hot-buffer" },
    reviewedAt: "2026-05-17",
    costModel: documentedVariableFee("1:1 via Circle Mint; EEA burn fee is 0 bps, other Circle fees may vary"),
    docs: [
      sourceRef("Circle Transparency", "https://www.circle.com/transparency", ["capacity"]),
      sourceRef("Circle USDC terms", "https://www.circle.com/legal/usdc-terms", ["route", "capacity", "access", "fees"]),
    ],
    notes: [
      "Tracked USDC metadata records a 7% cash-deposit reserve slice; Pharos uses that cash slice as the documented hot-buffer lower bound and does not promote the unvalidated 20% proposal.",
    ],
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
    capacityModel: { kind: "supply-ratio", ratio: 0.1, confidence: "documented-bound", basis: "hot-buffer" },
    costModel: documentedVariableFee(
      "Direct 1:1 mint and redemption; BUIDL shares redeemable 24/7 via atomic swap with Securitize",
    ),
    reviewedAt: "2026-05-17",
    docs: [
      sourceRef("USDtb docs", "https://docs.usdtb.money/", ["route", "capacity"]),
      sourceRef("USDtb reserve attestations", "https://www.anchorage.com/platform/usdtb-reserve-attestations", ["capacity"]),
    ],
    notes: [
      "Tracked USDtb metadata records a 10% USDC redemption reserve; Pharos uses that reserve slice as the documented hot-buffer lower bound and does not promote the unvalidated 30% proposal.",
    ],
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
};
