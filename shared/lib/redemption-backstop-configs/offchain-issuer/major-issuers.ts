import type { RedemptionBackstopConfig } from "../shared";
import {
  documentedBoundSupplyFull,
  documentedVariableFee,
  expandIds,
  undisclosedReviewedFee,
  fixedFee,
  issuerBase,
  sourceRef,
} from "../shared";
import { reviewedDirectRedemptionSupplyFull } from "./shared";
import { REVIEWED_EXIT_CREDIT_WAVE3_AT, REVIEWED_WRAPPER_WAVE_AT } from "../review-dates";

/** usdq-quantoz and eurq-quantoz are byte-identical (same base, cost, docs). */
const quantozBase: RedemptionBackstopConfig = {
  ...issuerBase,
  ...reviewedDirectRedemptionSupplyFull,
  costModel: fixedFee(0, "Issuer docs describe redemption as free of charge; bank fees may still apply"),
  docs: [
    sourceRef("Quantoz transparency", "https://www.quantoz.com/transparency", ["route", "capacity"]),
    sourceRef("Quantoz fees", "https://www.quantoz.com/fees", ["fees"]),
  ],
};

export const MAJOR_ISSUER_OFFCHAIN_CONFIGS: Record<string, RedemptionBackstopConfig> = {
  "pyusd-paypal": {
    ...issuerBase,
    ...reviewedDirectRedemptionSupplyFull,
    capacityModel: { kind: "supply-ratio", ratio: 0.25, confidence: "documented-bound", basis: "hot-buffer" },
    reviewedAt: "2026-06-10",
    costModel: fixedFee(
      0,
      "Paxos states it does not charge a PYUSD redemption fee; bank or network fees may still apply",
    ),
    docs: [
      sourceRef("Paxos mint and redeem", "https://www.paxos.com/mint-and-redeem/", ["route", "capacity", "fees"]),
      sourceRef(
        "Paxos USD stablecoin terms",
        "https://www.paxos.com/terms-and-conditions/stablecoin-terms-conditions",
        ["route", "access", "settlement", "fees"],
      ),
      sourceRef("Paxos PYUSD transparency", "https://www.paxos.com/pyusd-transparency", ["capacity"]),
    ],
    notes: [
      "Paxos terms document free 1:1 redemption for fully verified customers with always-available on-platform USD conversion, and monthly attested reserves are held entirely in cash deposits, short-dated US Treasury bills, overnight reverse repos, and government money market funds; Pharos applies the uniform 75% major-issuer haircut to that ~100% attested highly liquid share for a 25% documented immediate hot-buffer floor",
    ],
  },
  "fdusd-first-digital": {
    ...issuerBase,
    ...reviewedDirectRedemptionSupplyFull,
    costModel: undisclosedReviewedFee("Redeemable 1:1; public fee schedule not disclosed"),
    docs: [
      sourceRef("First Digital Labs FDUSD", "https://www.firstdigitallabs.com/fdusd", ["route", "capacity", "access"]),
    ],
  },
  "rlusd-ripple": {
    ...issuerBase,
    ...reviewedDirectRedemptionSupplyFull,
    costModel: undisclosedReviewedFee("Redeemable 1:1 less fees; public fee schedule not disclosed"),
    docs: [sourceRef("Ripple USD stablecoin", "https://ripple.com/solutions/stablecoin/", ["route", "capacity"])],
  },
  "usdon-ondo": {
    ...issuerBase,
    ...documentedBoundSupplyFull("2026-04-20"),
    routeStatus: "open",
    costModel: undisclosedReviewedFee(
      "Ondo Global Markets docs describe 1:1 USDC <-> USDon platform conversion when swapper liquidity is available; public materials reviewed do not publish a standalone fixed USDon redemption fee",
    ),
    docs: [
      sourceRef("Ondo available assets", "https://docs.ondo.finance/ondo-global-markets/available-assets", [
        "route",
        "capacity",
      ]),
      sourceRef(
        "Ondo investing and redeeming",
        "https://docs.ondo.finance/ondo-global-markets/investing-and-redeeming",
        ["route", "settlement"],
      ),
      sourceRef("Ondo trust and transparency", "https://docs.ondo.finance/ondo-global-markets/trust-and-transparency", [
        "capacity",
      ]),
    ],
    notes: [
      "Modeled as a whitelisted Ondo Global Markets settlement-cash route; current instant USDC output can depend on swapper liquidity, so this remains documented-bound eventual capacity rather than live immediate liquidity",
    ],
  },
  "usdsui-sui": {
    ...issuerBase,
    ...documentedBoundSupplyFull("2026-04-20"),
    settlementModel: "days",
    costModel: undisclosedReviewedFee(
      "Bridge Open Issuance docs describe mint/burn rails and reserve redemption; public materials reviewed do not publish a USDsui-specific fixed redemption fee schedule",
    ),
    docs: [
      sourceRef("Sui Dollar launch", "https://blog.sui.io/sui-dollar-launch-bridge/", ["route"]),
      sourceRef("Bridge issuance overview", "https://apidocs.bridge.xyz/platform/issuance/overview", [
        "route",
        "capacity",
      ]),
      sourceRef("Bridge reserve management", "https://apidocs.bridge.xyz/platform/issuance/reserve-management", [
        "capacity",
      ]),
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
      sourceRef("Glo Dollar contracts and reserves", "https://www.glodollar.org/articles/smart-contract-addresses", [
        "route",
        "capacity",
      ]),
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
    ...documentedBoundSupplyFull(REVIEWED_WRAPPER_WAVE_AT),
    settlementModel: "days",
    routeStatus: "open",
    costModel: undisclosedReviewedFee(
      "Forte documents 1:1 AUDF issuance and redemption for eligible users, but the reviewed public materials do not publish a standalone numeric redemption fee schedule",
    ),
    docs: [
      sourceRef("Forte home", "https://www.forteaud.com/", ["route"]),
      sourceRef("Forte reserve reports", "https://www.forteaud.com/new-page", ["capacity"]),
      sourceRef("Forte PDS", "https://www.forteaud.com/s/AUDF_PDS.pdf", ["route", "capacity", "fees"]),
      sourceRef("Forte terms", "https://www.forteaud.com/s/ForteAUDTermsofUseJanuary2026.pdf", [
        "route",
        "access",
        "fees",
      ]),
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
    docs: [
      sourceRef("Circle Mint", "https://www.circle.com/circle-mint", ["route", "capacity", "access", "settlement"]),
      sourceRef("Circle EURC", "https://www.circle.com/eurc", ["route", "capacity"]),
    ],
  },
  "usdc-circle": {
    ...issuerBase,
    ...reviewedDirectRedemptionSupplyFull,
    capacityModel: { kind: "supply-ratio", ratio: 0.07, confidence: "documented-bound", basis: "hot-buffer" },
    reviewedAt: "2026-05-17",
    costModel: documentedVariableFee("1:1 via Circle Mint; EEA burn fee is 0 bps, other Circle fees may vary"),
    docs: [
      sourceRef("Circle Transparency", "https://www.circle.com/transparency", ["capacity"]),
      sourceRef("Circle USDC terms", "https://www.circle.com/legal/usdc-terms", [
        "route",
        "capacity",
        "access",
        "fees",
      ]),
    ],
    notes: [
      "Tracked USDC metadata records a 7% cash-deposit reserve slice; Pharos uses that cash slice as the documented hot-buffer lower bound and does not promote the unvalidated 20% proposal.",
    ],
  },
  "usdp-paxos": {
    ...issuerBase,
    ...reviewedDirectRedemptionSupplyFull,
    capacityModel: { kind: "supply-ratio", ratio: 0.25, confidence: "documented-bound", basis: "hot-buffer" },
    reviewedAt: "2026-06-10",
    costModel: fixedFee(0, "Paxos states it does not charge a USDP redemption fee"),
    docs: [
      sourceRef("Paxos mint and redeem", "https://www.paxos.com/mint-and-redeem/", ["route", "capacity", "fees"]),
      sourceRef(
        "Paxos USD stablecoin terms",
        "https://www.paxos.com/terms-and-conditions/stablecoin-terms-conditions",
        ["route", "access", "settlement", "fees"],
      ),
      sourceRef("Paxos USDP transparency", "https://www.paxos.com/usdp-transparency", ["capacity"]),
    ],
    notes: [
      "Paxos terms document free 1:1 redemption for fully verified customers with always-available on-platform USD conversion, and monthly attested NYDFS-eligible reserves are held entirely in cash deposits, short-dated US Treasury bills, overnight reverse repos, and government money market funds; Pharos applies the uniform 75% major-issuer haircut to that ~100% attested highly liquid share for a 25% documented immediate hot-buffer floor",
    ],
  },
  "gusd-gemini": {
    ...issuerBase,
    ...reviewedDirectRedemptionSupplyFull,
    capacityModel: { kind: "supply-ratio", ratio: 0.25, confidence: "documented-bound", basis: "hot-buffer" },
    reviewedAt: "2026-06-10",
    costModel: fixedFee(0, "Gemini describes GUSD conversion and redemption as fee-free"),
    docs: [
      sourceRef("Gemini Dollar overview", "https://www.gemini.com/dollar", ["route", "capacity", "access", "settlement"]),
      sourceRef(
        "Gemini GUSD buy and sell guide",
        "https://support.gemini.com/hc/en-us/articles/360001352466-How-do-I-buy-or-sell-my-Gemini-dollar-GUSD",
        ["route", "fees"],
      ),
      sourceRef("Gemini GUSD attestation reports", "https://www.gemini.com/legal/gusd-attestations", ["capacity"]),
    ],
    notes: [
      "Gemini documents that customers can always redeem 1 GUSD for $1 on Gemini at any time via fee-free in-app conversion, and monthly BPM attestations cover reserves held entirely in FDIC-insured bank deposits, Treasury-only money market funds, and US Treasury obligations; Pharos applies the uniform 75% major-issuer haircut to that ~100% attested highly liquid share for a 25% documented immediate hot-buffer floor",
    ],
  },
  "usdg-paxos": {
    ...issuerBase,
    ...reviewedDirectRedemptionSupplyFull,
    capacityModel: { kind: "supply-ratio", ratio: 0.25, confidence: "documented-bound", basis: "hot-buffer" },
    reviewedAt: "2026-06-10",
    costModel: fixedFee(0, "Paxos states it does not charge a USDG redemption fee"),
    docs: [
      sourceRef("Paxos mint and redeem", "https://www.paxos.com/mint-and-redeem/", ["route", "capacity", "fees"]),
      sourceRef("Paxos USDG overview", "https://docs.paxos.com/stablecoin/usdg", ["route", "capacity"]),
      sourceRef(
        "Paxos USD stablecoin terms",
        "https://www.paxos.com/terms-and-conditions/stablecoin-terms-conditions",
        ["route", "access", "settlement", "fees"],
      ),
      sourceRef("Paxos USDG transparency", "https://www.paxos.com/usdg-transparency", ["capacity"]),
    ],
    notes: [
      "Paxos terms document free 1:1 redemption for fully verified customers with always-available on-platform USD conversion, and Paxos states USDG reserves are held 100% in US dollar deposits, US treasuries, and cash equivalents with monthly attestations; Pharos applies the uniform 75% major-issuer haircut to that ~100% attested highly liquid share for a 25% documented immediate hot-buffer floor",
    ],
  },
  "usdx-hex-trust": {
    ...issuerBase,
    ...reviewedDirectRedemptionSupplyFull,
    costModel: undisclosedReviewedFee("Redeemable through approved parties; public fee schedule not disclosed"),
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
      sourceRef("EURI white paper", "https://www.eurite.com/wp-content/uploads/2024/08/EURI-white-paper.html", [
        "route",
        "capacity",
        "fees",
      ]),
    ],
    notes: [
      "Banking Circle documents redemption at par within five business days after the request and required checks",
    ],
  },
  ...expandIds(["usdq-quantoz", "eurq-quantoz"], quantozBase),
  "usd1-world-liberty-financial": {
    ...issuerBase,
    ...reviewedDirectRedemptionSupplyFull,
    costModel: undisclosedReviewedFee(),
    docs: [sourceRef("World Liberty Financial USD1", "https://worldlibertyfinancial.com/usd1", ["route", "capacity"])],
  },
  "ausd-agora": {
    ...issuerBase,
    ...reviewedDirectRedemptionSupplyFull,
    costModel: undisclosedReviewedFee("Fees may apply; public docs do not publish a fixed redemption rate"),
    docs: [
      sourceRef("Agora Bermuda terms of use", "https://static.agora.finance/termsofuse.pdf", [
        "route",
        "capacity",
        "access",
        "settlement",
      ]),
    ],
  },
  "usdo-openeden": {
    ...issuerBase,
    ...reviewedDirectRedemptionSupplyFull,
    reviewedAt: "2026-08-14",
    costModel: fixedFee(10, "OpenEden docs list a 10 bps redemption fee"),
    docs: [sourceRef("OpenEden Transparency", "https://openeden.com/usdo/transparency", ["route", "capacity", "fees"])],
    notes: [
      "Live reserve-sync capacity telemetry remains suspended: a 2026-08-13 re-enable probe confirmed prod-gw.openeden.com serves ordinary clients but returns HTTP 500 to all Cloudflare Worker fetch strategies (first production cron, 2026-08-14). Falls back to documented 1:1 USDC redemption until the issuer unblocks Worker egress",
    ],
  },
  "usdm-moneta": {
    ...issuerBase,
    ...reviewedDirectRedemptionSupplyFull,
    settlementModel: "days",
    costModel: undisclosedReviewedFee("Eligible users can redeem USDM 1:1 for USD; public fee schedule not disclosed"),
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
    costModel: undisclosedReviewedFee(
      "Eligible Fidelity clients can buy, sell, and redeem FIDD at a guaranteed $1 price; public fee schedule not disclosed",
    ),
    docs: [
      sourceRef("Fidelity Digital Dollar overview", "https://www.fidelitydigitalassets.com/stablecoin", [
        "route",
        "capacity",
      ]),
      sourceRef("FIDD terms and conditions", "https://www.fidelitydigitalassets.com/fidd-terms", [
        "route",
        "capacity",
        "access",
      ]),
    ],
  },
  "usdcv-societe-generale-forge": {
    ...issuerBase,
    ...reviewedDirectRedemptionSupplyFull,
    settlementModel: "days",
    costModel: undisclosedReviewedFee(
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
    costModel: undisclosedReviewedFee(
      "Redeemable at NAV through Securitize; public docs do not publish a separate redemption fee (50 bps annual management fee is charged separately)",
    ),
    docs: [
      sourceRef(
        "BlackRock BUIDL press release",
        "https://www.blackrock.com/corporate/newsroom/press-releases/article/corporate-one/press-releases/blackrock-introduces-buidl-the-blackrock-usd-institutional-digital-liquidity-fund",
        ["route", "capacity", "access"],
      ),
      sourceRef("Securitize BUIDL", "https://securitize.io/blackrock/buidl", ["route", "capacity", "access"]),
    ],
    notes: ["Restricted to qualified purchasers under SEC Reg D; redemptions processed through Securitize platform"],
  },
  "tusd-trueusd": {
    ...issuerBase,
    ...reviewedDirectRedemptionSupplyFull,
    costModel: documentedVariableFee("Redeemable 1:1 through Techteryx; minting gated by Chainlink Proof of Reserve"),
    docs: [
      sourceRef("TrueUSD mint and redeem", "https://www.tusd.io/", [
        "route",
        "capacity",
        "fees",
        "access",
        "settlement",
      ]),
    ],
  },
  "eurs-stasis": {
    ...issuerBase,
    ...reviewedDirectRedemptionSupplyFull,
    costModel: undisclosedReviewedFee("1:1 redemption through STSS (Malta) Limited; public fee schedule not disclosed"),
    docs: [
      sourceRef("STASIS transparency", "https://stasis.net/transparency", ["route", "capacity"]),
      sourceRef("STASIS website", "https://stasis.net/", ["route"]),
    ],
  },
  "brz-transfero": {
    ...issuerBase,
    ...reviewedDirectRedemptionSupplyFull,
    costModel: fixedFee(100, "Transfero documents a 1% redemption fee in Brazil"),
    docs: [
      sourceRef(
        "Transfero BRZ stablecoin",
        "https://transferopayments.zendesk.com/hc/en-001/articles/42892203357587-BRZ-The-Brazilian-Real-BRL-Stablecoin",
        ["route", "capacity", "access"],
      ),
      sourceRef(
        "BRZ deposit and withdrawal fees",
        "https://brz.zendesk.com/hc/pt-br/articles/1500009567522-Quais-os-limites-e-taxas-para-dep%C3%B3sito-e-retirada",
        ["route", "fees", "access", "settlement"],
      ),
    ],
  },
  "ylds-figure": {
    ...issuerBase,
    ...reviewedDirectRedemptionSupplyFull,
    costModel: {
      ...documentedVariableFee(
        "FCC does not charge holders of Figure Transferable Certificates any fees or expenses in connection with the issuance or surrender of Figure Transferable Certificates.",
      ),
      feeBpsMax: 0,
    },
    docs: [
      sourceRef("Figure YLDS overview", "https://www.figuremarkets.com/c/learn/ylds", [
        "route",
        "capacity",
        "access",
        "settlement",
      ]),
      sourceRef("Figure Certificate Company disclosures", "https://www.figuremarkets.com/disclosures/", [
        "route",
        "capacity",
        "fees",
        "access",
        "settlement",
      ]),
      sourceRef(
        "Figure Certificate Company prospectus",
        "https://www.sec.gov/Archives/edgar/data/1974395/000149315226018903/form497.htm",
        ["fees"],
      ),
    ],
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
      sourceRef("USDtb reserve attestations", "https://www.anchorage.com/platform/usdtb-reserve-attestations", [
        "capacity",
      ]),
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
  "usdpt-western-union": {
    ...issuerBase,
    ...documentedBoundSupplyFull(REVIEWED_EXIT_CREDIT_WAVE3_AT),
    settlementModel: "days",
    costModel: undisclosedReviewedFee(
      "Anchorage redeems at Par Value net of any applicable fees disclosed in its Covered Stablecoin Fee Schedule, which is not published publicly",
    ),
    docs: [
      sourceRef(
        "Anchorage Digital Bank covered stablecoin terms",
        "https://www.anchorage.com/anchorage-digital-bank-n-a-covered-stablecoin-terms",
        ["route", "capacity", "fees", "access", "settlement"],
      ),
      sourceRef("Anchorage stablecoin issuance", "https://www.anchorage.com/platform/stablecoin-issuance", ["route"]),
      sourceRef(
        "Anchorage USDPT reserve attestations",
        "https://www.anchorage.com/platform/usdpt-reserve-attestations-anchorage-digital",
        ["capacity"],
      ),
      sourceRef(
        "Anchorage and Western Union launch USDPT",
        "https://www.anchorage.com/insights/anchorage-digital-western-union-partner-launch-usdpt-federally-regulated-stablecoin-solana",
        ["route"],
      ),
    ],
    notes: [
      "Configured 2026-08-12: Anchorage Digital Bank N.A. is the federally regulated issuer that mints and redeems USDPT, and its Covered Stablecoin Terms state that presented tokens are redeemed at Par Value, so the issuer rail is the modeled holder exit rather than Solana secondary liquidity.",
      "Access is client-gated, not open: the terms state ADB 'redeems Covered Stablecoins exclusively from Clients' and 'does not redeem Covered Stablecoins from Non-Clients', so an ordinary Solana holder must first onboard to Anchorage.",
      "Settlement is modeled as days rather than the same-day issuer default because the terms commit only to 'commercially reasonable efforts to process redemption requests promptly' and publish no timeframe; the terms also let ADB 'refuse, suspend, or limit any redemption request in its discretion', including for liquidity management.",
      "Capacity stays documented-bound on full supply: the monthly Deloitte reserve attestations evidence backing but not immediately executable settlement liquidity, and no public API or on-chain view exposes a per-token redemption buffer.",
    ],
  },
  "gyen-gyen": {
    ...issuerBase,
    ...reviewedDirectRedemptionSupplyFull,
    costModel: undisclosedReviewedFee("Direct 1:1 redemption through GMO Trust; public fee schedule not disclosed"),
    docs: [
      sourceRef("GMO Trust stablecoin docs", "https://stablecoin.z.com/what-are-gyen-and-zusd/", ["route", "capacity"]),
      sourceRef("GMO Trust attestation", "https://stablecoin.z.com/attestation/", ["capacity"]),
    ],
  },
};
