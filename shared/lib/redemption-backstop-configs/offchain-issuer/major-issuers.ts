import {
  documentedBoundSupplyFull,
  documentedVariableFee,
  undisclosedReviewedFee,
  fixedFee,
  type RedemptionBackstopConfig,
  issuerBase,
  sourceRef,
  sourceRefFull,
  sourceRefRouteCapacity,
  sourceRefRouteCapacityAccess,
  sourceRefRouteCapacityFees,
} from "../shared";
import { reviewedDirectRedemptionSupplyFull } from "./shared";
import { REVIEWED_EXIT_CREDIT_AT, REVIEWED_WRAPPER_WAVE_AT } from "../review-dates";

/** Shared Quantoz issuer settings; EURQ's scoped terms review overrides defaults below. */
const quantozBase: RedemptionBackstopConfig = {
  ...issuerBase,
  ...reviewedDirectRedemptionSupplyFull,
  costModel: fixedFee(0, "Issuer docs describe redemption as free of charge; bank fees may still apply"),
  docs: [
    sourceRefRouteCapacity("Quantoz transparency", "https://www.quantoz.com/transparency"),
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
      sourceRefRouteCapacityFees("Paxos mint and redeem", "https://www.paxos.com/mint-and-redeem/"),
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
    costModel: undisclosedReviewedFee(
      "The publisher-branded FDUSD Webflow page advertises zero mint/redemption fees only when the client mints more than they redeem; it does not define the measurement period. The mirrored FD121 Account User Agreement allows changing or separately agreed fees and assigns bank/wallet charges to the client. No universally applicable numeric issuer-fee schedule or all-in cost ceiling was recovered.",
    ),
    v9RouteReviewTerms: {
      scoringDisposition: "bounded-terms-gap",
      missingScoringFields: ["cost", "settlement"],
      rationale:
        "ORCHESTRATOR-AUTHORIZED adverse-pin correction — owner review required. Retrieved 2026-10-20: the publisher-branded FD121 Account User Agreement, version August 1, 2025, sections 9.1-9.2 permits variable issuer fees and bank/wallet deductions, and section 19.3 expressly gives no representation or warranty about processing completion time. The conditional zero-fee product statement does not bound this modeled holder's all-in cost. Canonical legal pages remain Cloudflare-blocked, so current canonical-body equivalence is not claimed and the inherited same-day value is not admitted as an established final-payout SLA.",
      reviewedAt: "2026-10-20",
      docs: [
        sourceRef(
          "FD121 publisher-branded Account User Agreement sections 9 and 19.3 (retrieved 2026-10-20)",
          "https://firstdigitallabs.webflow.io/legal/fd121-account-user-agreement",
          ["route", "fees", "settlement"],
        ),
        sourceRef(
          "FDUSD publisher-branded conditional zero-fee statement (retrieved 2026-10-20)",
          "https://firstdigitallabs.webflow.io/fdusd",
          ["fees"],
        ),
      ],
    },
    docs: [
      sourceRefRouteCapacityAccess("First Digital Labs FDUSD", "https://www.firstdigitallabs.com/fdusd"),
      sourceRef(
        "FDUSD publisher-branded mirror: conditional fee statement (reviewed 2026-10-09)",
        "https://firstdigitallabs.webflow.io/fdusd",
        ["fees"],
      ),
      sourceRef(
        "FD121 Account User Agreement publisher-branded mirror: fees sections 9.1-9.2 (version 2025-08-01)",
        "https://firstdigitallabs.webflow.io/legal/fd121-account-user-agreement",
        ["fees"],
      ),
    ],
    notes: [
      "Fee-source recovery used publisher-branded Webflow bodies because canonical First Digital Labs pages returned HTTP 403. Current canonical-body equivalence has not been established; no zero-fee qualification is assumed for the modeled holder/request, and aggregate fee cost remains unresolved.",
    ],
  },
  "rlusd-ripple": {
    ...issuerBase,
    ...reviewedDirectRedemptionSupplyFull,
    reviewedAt: "2026-10-07",
    costModel: fixedFee(0, "Ripple Mint charges no mint or redeem fees; applicable Customer Agreement conditions and standard bank/payment costs remain separate"),
    docs: [
      sourceRefRouteCapacity("Ripple USD stablecoin", "https://ripple.com/solutions/stablecoin/"),
      sourceRef("Ripple Mint Features FAQ (reviewed 2026-10-07)", "https://ripple.com/products/stablecoin/features/", ["fees"]),
      sourceRef("Ripple stablecoin terms: Customer Agreement conditions", "https://ripple.com/legal/stablecoin/", ["route", "access", "fees", "settlement"]),
    ],
    notes: ["Zero is the disclosed Ripple Mint issuer fee only, not a zero all-in bank/payment-cost guarantee; governing Customer Agreement conditions remain applicable. No access, capacity or completion SLA is inferred from the FAQ."],
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
      sourceRefRouteCapacity("Bridge issuance overview", "https://apidocs.bridge.xyz/platform/issuance/overview"),
      sourceRef("Bridge reserve management", "https://apidocs.bridge.xyz/platform/issuance/reserve-management", [
        "capacity",
      ]),
    ],
    notes: [
      "Bridge reserve docs describe API-gated issuer redemption and reserve management; Pharos models current support as documented eventual primary-market redeemability, not an independently measured instant buffer",
    ],
  },
  "ousd-open-standard": {
    ...issuerBase,
    ...documentedBoundSupplyFull("2026-10-01"),
    holderEligibility: "verified-customer",
    settlementModel: "days",
    routeStatus: "open",
    costModel: fixedFee(
      0,
      "Bridge states it will not charge fees for OUSD minting or redemption; bank, partner-service, and network charges may still apply",
    ),
    docs: [
      sourceRef("Open Standard introduces Open USD", "https://joinopenstandard.com/blog/introducing-open-usd", ["route", "capacity", "fees"]),
      sourceRef("Open Standard OUSD is live (reviewed 2026-10-01)", "https://joinopenstandard.com/blog/ousd-is-live", ["route", "capacity", "fees"]),
      sourceRef("Bridge OUSD issuer fee commitment (reviewed 2026-10-01)", "https://www.bridge.xyz/blog/ousd-is-live-issued-by-bridge", ["route", "access", "fees"]),
      sourceRef("Tempo OUSD partner redemption (reviewed 2026-10-01)", "https://tempo.xyz/developers/docs/guide/ousd", ["route", "capacity", "access", "fees"]),
      sourceRef("Bridge stablecoin terms", "https://www.bridge.xyz/legal/bridge-stablecoin-terms/bridge-building-inc", ["route", "capacity", "access", "settlement"]),
      sourceRef("Bridge US user terms", "https://www.bridge.xyz/legal/us-terms/bridge-building-inc", ["access", "settlement", "fees"]),
      sourceRef("Bridge minting and burning", "https://apidocs.bridge.xyz/platform/issuance/minting-and-burning", ["route"]),
      sourceRef("Bridge stablecoins FAQ", "https://apidocs.bridge.xyz/platform/issuance/faq", ["route", "capacity"]),
      sourceRef("Bridge OUSD reserves", "https://reserves.bridge.xyz/ousd", ["capacity"]),
      sourceRef("Bridge redemption portal", "https://redeem.bridge.xyz/", ["access", "settlement"]),
    ],
    notes: [
      "Reviewed 2026-10-01: businesses redeem through Bridge-integrated partners subject to account onboarding, identity verification, jurisdiction restrictions, and compliance approval. Bridge terms extend redemption rights to subsequent holders only if they become eligible Users; permissionless retail access is not established.",
      "The modeled terminal output is USD under Bridge stablecoin terms. Generic Bridge docs also allow applicable stablecoin payouts, but no complete OUSD-specific crypto output set was verified, so USDC or USDT is not assumed.",
      "Bridge burns received tokens and releases equivalent fiat value through its API. Its OUSD reserve page lists Tempo, Ethereum, Base, and Solana deployments; a chain-specific redemption intake/burn rail list was not verified. The public redemption portal lists USDH, DKUSD, and EURR, not OUSD.",
      "Capacity remains documented full-supply eventual redeemability. Bridge's live cash and Treasury balances are self-reported backing, not measured executable capacity. Open Standard promises monthly attestations, but no independent OUSD reserve report was published at review; the 25% major-issuer hot-buffer precedent requires independently attested highly liquid reserves.",
      "Open Standard states no artificial volume limits; Bridge user terms still permit risk-based amount and frequency limits. No numeric OUSD minimum or daily cap was verified.",
      "Settlement remains days with no reviewed completion SLA. Bridge stablecoin terms Section 3 commits only to processing an Order within two business days after Bridge determines it compliant, unless delayed by factors outside its reasonable control; it does not bound when the USD payout completes, and the compliance-determination start is itself unbounded. Unlike Noon's terms, which define processing as transferring the redemption value, this is not a settlement-completion bound, so V9 keeps the `days` default horizon. Open status records the documented partner route, not public-portal support or live telemetry.",
      "Bridge's OUSD-specific launch statement says it will not charge minting or redemption fees, and Open Standard says all integration paths support 1:1 mint and burn at no cost. The fixed zero issuer fee follows the Paxos/Gemini precedent; Bridge User Terms Section 7.1 still requires review of partner-account fees, and third-party bank, partner-service, and network charges are not promised to be zero.",
      "Tempo DEX exchange liquidity is secondary-market liquidity, outside this direct-redemption registry; no OUSD/pathUSD protocol redemption or PSM is modeled.",
    ],
  },
  "brlv-crown": {
    ...issuerBase,
    ...documentedBoundSupplyFull("2026-04-20"),
    settlementModel: "days",
    v9RouteReviewTerms: {
      businessDayTerms: {
        businessDays: 3, calendarId: "brazil-b3-national",
        cutoff: { time: null, timezone: "America/Sao_Paulo" },
        assurance: "target", conditional: true,
        conditions: ["Approved user's verified bank account", "Banking constraints", "Reserve-asset liquidation; T+1 before noon, T+2 before local market close, T+3 after close are targets"],
        startEvent: "Approved standard redemption request; local market-close cutoff has no reviewed numeric time",
      },
      reviewedAt: "2026-10-05",
      docs: [sourceRef("Crown binding terms, section III.A (2026-09-18)", "https://dfg4lo8c2lfcn.cloudfront.net/Crown_Termos_Plataforma_ENG_aa655faffc.pdf", ["settlement"])],
    },
    routeStatus: "open",
    costModel: documentedVariableFee(
      "Crown terms describe standard and instant BRL redemption routes, but public materials reviewed do not expose a machine-readable fixed fee schedule",
    ),
    docs: [
      sourceRef("Crown BRLV website", "https://www.crown-brlv.com/en/", ["route"]),
      sourceRef("Crown BRLV transparency", "https://crown-brlv.com/en/transparency/", ["capacity"]),
      sourceRefRouteCapacity("Crown BRLV whitepaper", "https://crown-2b36dce9.mintlify.app/whitepaper"),
    ],
    notes: [
      "Crown's binding terms updated September 18, 2026 describe standard BRL redemption for approved users with cutoff-dependent T+1, T+2, or T+3 business-day targets and final settlement up to three business days, subject to banking and reserve-liquidation constraints. Pharos retains the conservative 14-day modeled route horizon; these terms do not establish atomic liquidity or measured same-notional execution capacity.",
    ],
  },
  "usdglo-glo": {
    ...issuerBase,
    ...documentedBoundSupplyFull("2026-04-20"),
    routeStatus: "open",
    costModel: fixedFee(
      0,
      "Glo Dollar's offramp guide lists Brale Business Account 1:1 USDGLO redemption by US wire or ACH as free, and Brale pricing charges 0 bps on standard money movement. This is the issuer fee for eligible US Brale Business Account holders only; Brale's per-transfer rail charges (published at $0.25 per ACH and $20 per wire), network gas, and third-party costs are not included",
    ),
    docs: [
      sourceRefRouteCapacity("Glo Dollar contracts and reserves", "https://www.glodollar.org/articles/smart-contract-addresses"),
      sourceRef("Brale USDGLO", "https://brale.xyz/stablecoins/USDGLO", ["capacity"]),
      sourceRef("Brale pricing (reviewed 2026-10-03)", "https://brale.xyz/pricing", ["fees"]),
      sourceRef("Glo Dollar offramp guide (reviewed 2026-10-03)", "https://www.glodollar.org/articles/offramping-glo-dollars", [
        "route",
        "fees",
        "access",
      ]),
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
      sourceRefRouteCapacity("AUDM product", "https://www.macropod.com/product/audm"),
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
      sourceRefRouteCapacityFees("Forte PDS", "https://www.forteaud.com/s/AUDF_PDS.pdf"),
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
    v9RouteCostTerms: { feeBpsMax: 10 },
    docs: [
      sourceRef("Circle Mint", "https://www.circle.com/circle-mint", ["route", "capacity", "access", "settlement"]),
      sourceRefRouteCapacity("Circle EURC", "https://www.circle.com/eurc"),
      sourceRef("Circle redemption structure (effective March 15, 2026)", "https://help.circle.com/support/en/usdc-eurc-redemption-structure?id=kb_article_view&sysparm_article=KB0010644", ["fees"]),
      sourceRef("Circle published KB0010644 direct Knowledge API (reviewed 2026-10-07)", "https://help.circle.com/api/sn_km_api/knowledge/articles/KB0010644?fields=number%2Cshort_description%2Ctext%2Cworkflow_state%2Csys_updated_on", ["fees"]),
      sourceRef("Circle product fee schedule", "https://help.circle.com/support/en/circle-product-fee-schedule?id=kb_article_view&sysparm_article=KB0010626", ["fees"]),
    ],
    notes: [
      "Sol unknown-resolver wave 2026-10-07 (EXIT_ROUTE_3): the Circle USDC/EURC redemption structure effective March 15, 2026 has at most 5 bps daily base fee plus 5 bps marginal monthly net-redemption overage. The V9-only 10 bps issuer-fee ceiling is conservative across the published tiers; it does not assert that the zero-burn-fee EEA cohort pays 10 bps or assume fee credits.",
      "Circle and its banking partners charge no outgoing redemption-wire fee; any receiving-bank fee is a third-party cost outside the issuer-fee ceiling, not asserted zero. No capacity, holder cohort or settlement promise changes. Fresh producer evidence is required to replace captured undisclosed fee evidence.",
      "Basic has no daily fee but marginal monthly overage; Standard has a $2M/day allowance and 5 bps on net redemptions; Institutional charges 5 bps on gross redemption plus up to 5 bps marginal monthly overage. EEA zero-burn-fee scope and conditional credits do not establish universal fee zero. The KB's near-instant labels describe processing, not guaranteed completed payout.",
    ],
  },
  "usdc-circle": {
    ...issuerBase,
    ...reviewedDirectRedemptionSupplyFull,
    capacityModel: { kind: "supply-ratio", ratio: 0.07, confidence: "documented-bound", basis: "hot-buffer" },
    reviewedAt: "2026-05-17",
    costModel: documentedVariableFee("1:1 via Circle Mint; EEA burn fee is 0 bps, other Circle fees may vary"),
    v9RouteCostTerms: { feeBpsMax: 10 },
    docs: [
      sourceRef("Circle Transparency", "https://www.circle.com/transparency", ["capacity"]),
      sourceRef("Circle USDC terms", "https://www.circle.com/legal/usdc-terms", [
        "route",
        "capacity",
        "access",
        "fees",
      ]),
      sourceRef("Circle redemption structure (effective March 15, 2026)", "https://help.circle.com/support/en/usdc-eurc-redemption-structure?id=kb_article_view&sysparm_article=KB0010644", ["fees"]),
      sourceRef("Circle published KB0010644 direct Knowledge API (reviewed 2026-10-07)", "https://help.circle.com/api/sn_km_api/knowledge/articles/KB0010644?fields=number%2Cshort_description%2Ctext%2Cworkflow_state%2Csys_updated_on", ["fees"]),
      sourceRef("Circle product fee schedule", "https://help.circle.com/support/en/circle-product-fee-schedule?id=kb_article_view&sysparm_article=KB0010626", ["fees"]),
    ],
    notes: [
      "Tracked USDC metadata records a 7% cash-deposit reserve slice; Pharos uses that cash slice as the documented hot-buffer lower bound and does not promote the unvalidated 20% proposal.",
      "Sol unknown-resolver wave 2026-10-07 (EXIT_ROUTE_3): Circle's redemption structure effective March 15, 2026 caps the institutional daily gross-redemption charge at 5 bps, plus at most 5 bps marginal monthly net-redemption overage. The V9-only 10 bps issuer-fee ceiling covers the additive maximum without assuming fee credits, unused monthly allowances, or eligibility for a lower-fee tier.",
      "Circle and its banking partners do not charge an outgoing redemption-wire fee. Receiving-bank charges are third-party costs outside this issuer-fee ceiling, not asserted zero. The Standard tier's gross-redemption cap does not constrain the modeled Institutional route; no captured capacity or settlement term is increased by this cost review.",
      "Basic has no daily fee but marginal monthly overage; Standard's $2M/day free allowance is tier-specific, and Institutional's base fee is on gross redemption. EEA zero burn fees and optional credits are not a universal exemption. Near-instant processing does not establish final bank-receipt timing.",
    ],
  },
  "usdp-paxos": {
    ...issuerBase,
    ...reviewedDirectRedemptionSupplyFull,
    capacityModel: { kind: "supply-ratio", ratio: 0.25, confidence: "documented-bound", basis: "hot-buffer" },
    reviewedAt: "2026-06-10",
    costModel: fixedFee(0, "Paxos states it does not charge a USDP redemption fee"),
    docs: [
      sourceRefRouteCapacityFees("Paxos mint and redeem", "https://www.paxos.com/mint-and-redeem/"),
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
      sourceRefRouteCapacityFees("Paxos mint and redeem", "https://www.paxos.com/mint-and-redeem/"),
      sourceRefRouteCapacity("Paxos USDG overview", "https://docs.paxos.com/stablecoin/usdg"),
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
      sourceRefRouteCapacity("HT Digital Assets USDX", "https://www.htdigitalassets.com/"),
      sourceRef("HT Digital Assets disclaimer", "https://www.htdigitalassets.com/disclaimer", ["route", "access"]),
    ],
  },
  "xusd-straitsx": {
    ...issuerBase,
    ...reviewedDirectRedemptionSupplyFull,
    v9RouteReviewTerms: {
      settlementModel: "days",
      scoringDisposition: "bounded-terms-gap",
      missingScoringFields: ["cost", "settlement"],
      rationale: "The July 18, 2026 terms start the five-business-day bank-transfer period only after verification and processing and permit risk-review delays. No unconditional initial-request-to-final-payout maximum is established. The published USD 40 withdrawal charge and S$1 administrative fee exclude blockchain and intermediary/receiving-bank fees; the support article's typical USD 10-50 receiving-bank range is not an all-in ceiling.",
      reviewedAt: "2026-10-20",
      docs: [
        sourceRef(
          "StraitsX purchasing and redemption terms (effective 2026-07-18; retrieved 2026-10-20)",
          "https://www.straitsx.com/legal/purchasing-and-redemption",
          ["route", "fees", "settlement"],
        ),
        sourceRef("StraitsX USD deposit and withdrawal service fee (modified 2025-10-04; retrieved 2026-10-20)", "https://support.straitsx.com/support/solutions/articles/157000366277-usd-deposit-withdrawal-service-fee", ["fees"]),
      ],
    },
    costModel: documentedVariableFee(
      "StraitsX terms require the prevailing website redemption fee plus an S$1 administrative fee and applicable network fees",
    ),
    docs: [
      sourceRefRouteCapacityFees(
        "StraitsX XUSD overview",
        "https://support.straitsx.com/support/solutions/articles/157000366324-what-is-xusd-",
      ),
    ],
  },
  "xsgd-straitsx": {
    ...issuerBase,
    ...reviewedDirectRedemptionSupplyFull,
    costModel: documentedVariableFee("No platform conversion fee; bank or network fees may apply"),
    docs: [
      sourceRefRouteCapacityFees(
        "StraitsX XSGD overview",
        "https://support.straitsx.com/support/solutions/articles/157000363433-what-is-xsgd-",
      ),
    ],
  },
  "euri-banking-circle": {
    ...issuerBase,
    ...reviewedDirectRedemptionSupplyFull,
    settlementModel: "days",
    holderEligibility: "verified-customer",
    costModel: fixedFee(0, "Issuer docs describe EURI redemption as fee-free at par"),
    v9RouteReviewTerms: {
      businessDayTerms: {
        businessDays: 5, calendarId: "luxembourg-banking-target",
        cutoff: { time: null, timezone: "Europe/Luxembourg", basis: "receipt-day" },
        assurance: "binding-guarantee", conditional: false,
        conditions: [],
        accessPrerequisites: ["Completed Tokenholder KYC to Banking Circle's satisfaction", "Receipt of EURI in the Banking Circle Burn Wallet; unresolved KYC is ineligible and may suspend redemption"],
        startEvent: "Received Redemption Request with completed KYC and burn-wallet delivery; condition 13.1 deems notice received on that day",
      },
      reviewedAt: "2026-10-10",
      docs: [sourceRef("EURI governing terms, conditions 1.2, 7.1 and 13.1; reviewed by Sol curation campaign 2026-10-11 (K4ExitTermsModel)", "https://www.eurite.com/wp-content/uploads/2024/07/EUR-TCs-Final-clean.pdf", ["settlement", "access"])],
    },
    docs: [
      sourceRefRouteCapacityFees("EURI white paper", "https://www.eurite.com/wp-content/uploads/2024/08/EURI-white-paper.html"),
    ],
    notes: [
      "Five Luxembourg Business Days after receipt applies only to a completed-KYC holder whose EURI reached the burn wallet. Condition 13.1 specifies receipt-day notice, not an undisclosed intraday cutoff. Calendar admission takes the maximum end-of-day completion over the full reviewed 365-day horizon, including weekends, holidays and DST; no bound is claimed for initial requests with unresolved prerequisites.",
    ],
  },
  "usdq-quantoz": {
    ...quantozBase,
    accessModel: "manual",
    settlementModel: "days",
    holderEligibility: "verified-customer",
    costModel: documentedVariableFee(
      "Standard issuer redemption is free, but network costs, non-SEPA bank charges and the non-registered holder's EUR 0.01 verification transfer remain separate. No complete USDQ all-in ceiling is published.",
      "formula",
    ),
    v9RouteReviewTerms: {
      scoringDisposition: "bounded-terms-gap",
      missingScoringFields: ["cost", "settlement"],
      rationale:
        "ORCHESTRATOR-AUTHORIZED adverse-pin correction — owner review required. Researched 2026-10-20, retaining the original March 23 review start: the token terms dated 30 April 2026, sections 24.3-24.4 and 27, require up to one week of post-receipt compliance checks before amount-tiered business-day processing, with notice periods and exceptions up to six months. Processing does not establish a same-day completed bank-credit maximum. Sections 25.4 and 28.4 and the current redemption FAQ leave verification, blockchain and non-SEPA charges outside free issuer redemption; USD bank payout cannot inherit a zero all-in cost. The original eventual full-supply legal claim is unchanged and is not funded instant liquidity.",
      reviewedAt: "2026-10-20",
      docs: [
        sourceRef(
          "Quantoz token terms dated 30 April 2026, sections 24-28 (retrieved 2026-10-20)",
          "https://www.quantoz.com/documents/terms-of-service-q-s-30-4-2026.pdf",
          ["route", "access", "settlement", "fees"],
        ),
        sourceRef(
          "Quantoz direct token redemption and FAQ (retrieved 2026-10-20)",
          "https://www.quantoz.com/token-redemption/",
          ["route", "access", "settlement", "fees"],
        ),
      ],
    },
    docs: [
      ...(quantozBase.docs ?? []),
      sourceRef(
        "Quantoz token terms dated 30 April 2026",
        "https://www.quantoz.com/documents/terms-of-service-q-s-30-4-2026.pdf",
        ["route", "access", "settlement", "fees", "capacity"],
      ),
      sourceRef(
        "Quantoz direct token redemption",
        "https://www.quantoz.com/token-redemption/",
        ["route", "access", "settlement", "fees"],
      ),
    ],
    notes: [
      "ORCHESTRATOR-AUTHORIZED adverse-pin correction — owner review required. On 2026-10-20 the current primary terms did not support the inherited same-day settlement and complete zero-cost datums. Only those unsupported datums are withheld; the original full-supply capacity review and its start remain unchanged.",
      "A pre-existing token account is not required to submit a request. Verification of identity, token ownership, source of funds and a same-name bank account remains mandatory; direct service requires an EEA, UK or Swiss address and bank account.",
      "The USDQ whitepaper's narrower account-holder eligibility and the current direct-redemption webpage are not fully reconciled. This entry does not grant permissionless or unrestricted holder access.",
    ],
  },
  "eurq-quantoz": {
    ...quantozBase,
    accessModel: "manual",
    settlementModel: "days",
    holderEligibility: "verified-customer",
    costModel: documentedVariableFee(
      "Standard issuer redemption is free, but blockchain costs, the non-registered holder's EUR 0.01 verification transfer and non-SEPA bank charges are separate; no complete all-in ceiling is published.",
      "formula",
    ),
    v9RouteReviewTerms: {
      scoringDisposition: "bounded-terms-gap",
      missingScoringFields: ["cost", "settlement"],
      rationale:
        "The 30 April 2026 token terms, sections 24.3-24.4 and 27, require post-receipt compliance checks that may take one week, followed by amount-tiered business-day processing and applicable notice periods; exceptions can take up to six months. Processing is not an unconditional completed bank-credit maximum. Sections 25.4 and 28.4 and the current redemption FAQ retain verification, network and non-SEPA charges, so free issuer redemption is not zero all-in cost. The original full-supply eventual capacity review is retained, without asserting funded instantaneous liquidity.",
      reviewedAt: "2026-10-20",
      docs: [
        sourceRef(
          "Quantoz token terms dated 30 April 2026, sections 24-28 (retrieved 2026-10-20)",
          "https://www.quantoz.com/documents/terms-of-service-q-s-30-4-2026.pdf",
          ["route", "access", "settlement", "fees"],
        ),
        sourceRef(
          "Quantoz direct token redemption and FAQ (retrieved 2026-10-20)",
          "https://www.quantoz.com/token-redemption/",
          ["route", "access", "settlement", "fees"],
        ),
      ],
    },
    docs: [
      ...(quantozBase.docs ?? []),
      sourceRef(
        "Quantoz token terms dated 30 April 2026",
        "https://www.quantoz.com/documents/terms-of-service-q-s-30-4-2026.pdf",
        ["route", "access", "settlement", "fees", "capacity"],
      ),
      sourceRef(
        "Quantoz direct token redemption",
        "https://www.quantoz.com/token-redemption/",
        ["route", "access", "settlement", "fees"],
      ),
    ],
    notes: [
      "2026-10-20 source-scoped correction: same-day settlement and zero complete cost were unsupported inherited defaults, not measured EURQ execution. Prior capacity evidence and its original review start are unchanged; owner review is required.",
      "An existing Quantoz account is not required to initiate redemption, but identity, token ownership, source-of-funds and same-name bank verification remain required. The direct service requires an EEA, UK or Swiss address and bank account.",
    ],
  },
  "usd1-world-liberty-financial": {
    ...issuerBase,
    settlementModel: "days",
    ...reviewedDirectRedemptionSupplyFull,
    v9RouteReviewTerms: {
      scoringDisposition: "bounded-terms-gap",
      missingScoringFields: ["capacity", "settlement", "cost"],
      rationale:
        "BitGo's terms last updated 2026-03-25 describe two-business-day processing only as a target estimate, expressly not a service-level commitment, and allow delay for bank, payment-rail, network, outage, liquidity, or legal reasons; no binding end-to-end settlement SLA, executable capacity, or public client-platform fee bound is available.",
      reviewedAt: "2026-09-04",
      docs: [
        sourceRef(
          "BitGo coin minting and redemption services terms (last updated 2026-03-25)",
          "https://www.bitgo.com/legal/bitgo-coin-minting-services-terms/",
          ["route", "capacity", "fees", "settlement"],
        ),
      ],
    },
    costModel: undisclosedReviewedFee(),
    docs: [sourceRefRouteCapacity("World Liberty Financial USD1", "https://worldlibertyfinancial.com/usd1")],
  },
  "ausd-agora": {
    ...issuerBase,
    ...reviewedDirectRedemptionSupplyFull,
    costModel: fixedFee(
      0,
      "Agora's Stablecoin API page states no fees on AUSD to and from USD. This is the issuer fee only: the terms reserve a platform fee schedule, and bank, network, and third-party charges are not promised to be zero",
    ),
    docs: [
      sourceRef("Agora Bermuda terms of use", "https://static.agora.finance/termsofuse.pdf", [
        "route",
        "capacity",
        "access",
        "settlement",
      ]),
      sourceRef("Agora Stablecoin API (reviewed 2026-10-03)", "https://www.agora.finance/product/stablecoin-api", ["fees"]),
    ],
  },
  "usdo-openeden": {
    ...issuerBase,
    ...reviewedDirectRedemptionSupplyFull,
    outputAssets: ["usdc-circle"],
    reviewedAt: "2026-10-20",
    costModel: fixedFee(10, "OpenEden docs list a 10 bps redemption fee"),
    v9RouteReviewTerms: {
      scoringDisposition: "bounded-terms-gap",
      missingScoringFields: ["cost", "settlement"],
      rationale: "Reviewed 2026-10-20 against the issuer-linked User Agreement dated 2026-10-14. Schedule 1 section 2.4.7(c) provides a conditional T+2 US-business-day transmission target after processing acceptance, not an unconditional request-to-completed-USDC-credit maximum; section 2.3 permits a liquidity-dependent redemption queue. Section 10 assigns holder network, gas and bridge charges in addition to displayed issuer fees. The documented 10 bps issuer fee is retained but is not an all-in same-notional cost bound. These are researched terms gaps, not measured slow settlement, expensive execution or a finding that redemption is closed.",
      reviewedAt: "2026-10-20",
      docs: [
        sourceRef("USDO legal page linking User Agreement dated 2026-10-14 (retrieved 2026-10-20)", "https://docs.openeden.com/usdo/legal/user-agreement", ["route", "access", "settlement", "fees"]),
      ],
    },
    docs: [
      sourceRefRouteCapacityFees("OpenEden Transparency", "https://openeden.com/usdo/transparency"),
      sourceRef("USDO redemption guide (reviewed 2026-09-30)", "https://docs.openeden.com/usdo/guides/usdo-redemption-via-etherscan", ["route"]),
      sourceRef("USDO User Agreement dated 2026-10-14 (retrieved 2026-10-20)", "https://docs.openeden.com/usdo/legal/user-agreement", ["route", "access", "settlement", "fees"]),
    ],
    notes: [
      "Payout identity reviewed 2026-09-30: OpenEden's redemption guide specifies USDC for both instant and manual redemptions; Treasury backing is not the holder payout.",
      "The October 14 User Agreement preserves segregated-account contractual recourse but not ownership of reserve assets; conditional transmission targets and issuer-fee quotations do not establish an all-in executed same-notional route.",
      "Live reserve-sync capacity telemetry remains suspended: a 2026-08-13 re-enable probe confirmed prod-gw.openeden.com serves ordinary clients but returns HTTP 500 to all Cloudflare Worker fetch strategies (first production cron, 2026-08-14). Falls back to documented 1:1 USDC redemption until the issuer unblocks Worker egress",
    ],
  },
  "usdm-moneta": {
    ...issuerBase,
    ...reviewedDirectRedemptionSupplyFull,
    reviewedAt: "2026-10-11",
    accessModel: "manual",
    holderEligibility: "whitelisted-primary",
    settlementModel: "days",
    capacityModel: { kind: "unquantified" },
    costModel: {
      ...documentedVariableFee(
        "Moneta's issuer burning fee is 0.1%, with a USD 50 minimum and USD 5,000 maximum, including Cardano network fees. Independent bank charges remain unbounded.",
        "formula",
      ),
      feeComponents: [{ currency: "USD", terms: { feeBps: 10, minAmount: 50, maxAmount: 5_000 } }],
    },
    v9RouteReviewTerms: {
      scoringDisposition: "bounded-terms-gap",
      missingScoringFields: ["capacity", "settlement", "cost"],
      rationale: "The current FAQ restricts the live manual-wire rail to KYB-approved institutions and states a default $10,000 daily mint/burn account limit, with higher limits requiring contact. An account limit is not guaranteed funded capacity, a whole-token redemption partition, or a final USD settlement SLA. The issuer fee is represented exactly by a capped/minimum USD component, but independent bank charges remain unbounded, so no all-in cost ceiling is asserted. Moneta's terms do not establish redemption of NBX-attributable issuance from Moneta's reserve book.",
      reviewedAt: "2026-10-09",
      docs: [
        sourceRef("Moneta FAQ: current institutional access, account limit and capped burning formula", "https://moneta.global/resources/faq/", ["route", "access", "capacity", "fees"]),
      ],
    },
    docs: [
      sourceRefRouteCapacity("USDM litepaper", "https://moneta.global/resources/litepaper/"),
      sourceRef("USDM retail launch", "https://moneta.global/retail-launch/", ["route", "settlement"]),
      sourceRef("Moneta FAQ: current institutional access, account limit and capped burning formula", "https://moneta.global/resources/faq/", ["route", "access", "capacity", "fees"]),
    ],
    notes: [
      "Current FAQ review 2026-10-09: linked-bank-account redemption for KYC-verified individuals is described as coming soon; the currently available manual-wire rail is limited to KYB-approved institutions.",
      "The default daily mint/burn account limit does not prove a global rail cap or guaranteed throughput. Contact-based higher limits are not funded capacity.",
      "The historical 1-3 business day processing description does not establish a binding completed-payout SLA.",
      "Re-reviewed 2026-10-09: the capped/minimum USD component represents only the issuer burning fee, not independent bank charges. The omitted feeBpsMax keeps all-in cost unresolved. Do not substitute fixedFee(10), add 10 bps again, omit the cap or treat bank charges as zero.",
      "Moneta and NBX issue the same Cardano token against separate reserve books; source terms for one issuer do not prove a complete whole-token route or interchangeable issuer access.",
      "Access reviewed 2026-10-11T08:41:18Z by Sol curation campaign 2026-10-11 (G62USDA): the rendered current FAQ explicitly limits the live mint/redemption rail to KYB-approved institutions; linked-bank-account redemption for KYC-verified individuals is coming soon. This manual Moneta rail does not establish eligibility for NBX issuance, funded same-notional capacity, a completed-payout SLA or a complete cost bound.",
    ],
  },
  "usdh-native-markets": {
    ...issuerBase,
    ...reviewedDirectRedemptionSupplyFull,
    costModel: fixedFee(0, "USDH docs state onboarded institutions can mint and redeem 1:1 with no fees"),
    docs: [
      sourceRefRouteCapacityFees("USDH minting and redeeming", "https://docs.usdh.com/usdh/minting"),
      sourceRef("USDH transparency", "https://www.usdh.com/transparency", ["capacity"]),
    ],
  },
  "fidd-fidelity": {
    ...issuerBase,
    ...reviewedDirectRedemptionSupplyFull,
    costModel: fixedFee(
      0,
      "FIDD terms: FDA does not charge fees for purchasing FIDD from FDA or for redeeming FIDD with FDA. This is the issuer fee only; Crypto Account Agreement fees, bank or third-party funds-transfer fees, and network gas are not promised to be zero",
    ),
    docs: [
      sourceRefRouteCapacity("Fidelity Digital Dollar overview", "https://www.fidelitydigitalassets.com/stablecoin"),
      sourceRef("FIDD terms and conditions (dated 2026-04-13; reviewed 2026-10-03)", "https://www.fidelitydigitalassets.com/fidd-terms", [
        "route",
        "capacity",
        "fees",
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
      sourceRefRouteCapacity("SG-FORGE CoinVertible", "https://www.sgforge.com/product/coinvertible/"),
      sourceRefRouteCapacity(
        "USDCV white paper",
        "https://www.sgforge.com/wp-content/uploads/2025/06/USDCV-White-Paper_iXBRL-1.html",
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
    v9RouteReviewTerms: {
      scoringDisposition: "bounded-terms-gap",
      missingScoringFields: ["cost", "settlement"],
      rationale: "ORCHESTRATOR-AUTHORIZED adverse-pin correction — owner review required, verified 2026-10-20: the issuer-authored BUIDL STEP application describes same-day wire processing before the New York cutoff and payment generally on the Redemption Date. That is not an unconditional maximum for completed bank receipt. The separate Circle USDC sale facility is expressly discretionary and not guaranteed. Securitize's current broker-dealer fee table lists route-dependent wire/conversion charges and variable gas, but does not establish the complete BUIDL primary-redemption tariff; preserve the researched cost gap. Retain the original qualified-investor and eventual full-supply terms without manufacturing a one-day completion bound.",
      reviewedAt: "2026-10-20",
      docs: [
        sourceRef("Securitize issuer-authored BUIDL STEP application: conditional processing and Circle facility", "https://forum.arbitrum.foundation/t/securitize-markets-buidl-step-application/23652", ["route", "access", "settlement"]),
        sourceRef("Securitize broker-dealer Fee Schedule 2026 (not an exact complete BUIDL primary-redemption tariff)", "https://securitize.io/fee-schedule-table", ["fees"]),
      ],
    },
    docs: [
      sourceRefRouteCapacityAccess(
        "BlackRock BUIDL press release",
        "https://www.blackrock.com/corporate/newsroom/press-releases/article/corporate-one/press-releases/blackrock-introduces-buidl-the-blackrock-usd-institutional-digital-liquidity-fund",
      ),
      sourceRefRouteCapacityAccess("Securitize BUIDL", "https://securitize.io/blackrock/buidl"),
    ],
    notes: ["Restricted to qualified purchasers under SEC Reg D; redemptions processed through Securitize platform"],
  },
  "tusd-trueusd": {
    ...issuerBase,
    ...reviewedDirectRedemptionSupplyFull,
    reviewedAt: "2026-10-07",
    settlementModel: "days",
    costModel: fixedFee(0, "TrueUSD charges no issuer mint/redemption fee; bank, wire and blockchain charges may be deducted and are not bounded here"),
    v9RouteCostTerms: { feeBpsMax: 0 },
    v9RouteReviewTerms: {
      settlementModel: "days",
      scoringDisposition: "bounded-terms-gap",
      missingScoringFields: ["cost", "settlement"],
      rationale: "TrueUSD's zero issuer charge does not bound bank/wire deductions or blockchain costs and the terms expressly do not guarantee redemption rights. The FAQ's general one-business-day processing target is not a completed-payout guarantee.",
      reviewedAt: "2026-10-07",
      docs: [sourceRef("TrueUSD governing Terms of Use (modified 2024-01-11; reviewed 2026-10-07)", "https://app.tusd.io/terms-of-use", ["route", "fees", "settlement"])],
    },
    docs: [
      sourceRefFull("TrueUSD mint and redeem", "https://www.tusd.io/"),
      sourceRef(
        "TrueUSD Terms of Use, Fees (modified 2024-01-11; reviewed 2026-10-07)",
        "https://app.tusd.io/terms-of-use",
        ["route", "fees", "settlement"],
      ),
    ],
    notes: [
      "The Terms of Use Fees section states that the Company does not charge fees for minting or redeeming TrueUSD. The V9 ceiling covers issuer-charged redemption fees only; third-party bank/wire fees may be deducted before transfer and blockchain transaction costs remain holder-borne. The terms expressly do not guarantee redemption rights; a general one-business-day processing target is not a final-payment SLA.",
    ],
  },
  "eurs-stasis": {
    ...issuerBase,
    ...reviewedDirectRedemptionSupplyFull,
    costModel: fixedFee(
      0,
      "STASIS Terms of Business section 8.8: no fees apply to redemption transactions and each EURS is redeemed at its EUR 1 par value. This is the issuer fee only; network transaction fees are separate",
    ),
    docs: [
      sourceRefRouteCapacity("STASIS transparency", "https://stasis.net/transparency"),
      sourceRef("STASIS website", "https://stasis.net/", ["route"]),
      sourceRef("STASIS Terms of Business, section 8.8 (reviewed 2026-10-03)", "https://stasis.net/terms", ["route", "fees"]),
    ],
  },
  "brz-transfero": {
    ...issuerBase,
    ...reviewedDirectRedemptionSupplyFull,
    costModel: fixedFee(100, "Transfero documents a 1% redemption fee in Brazil"),
    docs: [
      sourceRefRouteCapacityAccess(
        "Transfero BRZ stablecoin",
        "https://transferopayments.zendesk.com/hc/en-001/articles/42892203357587-BRZ-The-Brazilian-Real-BRL-Stablecoin",
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
    settlementModel: "days",
    v9RouteReviewTerms: {
      settlementModel: "days",
      scoringDisposition: "bounded-terms-gap",
      missingScoringFields: ["settlement"],
      rationale: "The August 6, 2026 prospectus supplement permits surrender processing to exceed 24 hours for congestion or technological reasons. Wire/ACH may take up to five days and stablecoin conversion/transfer may take up to ten days; these staged conditional statements do not establish an unconditional initial-request-to-completed-payout maximum.",
      reviewedAt: "2026-10-09",
      docs: [
        sourceRef("Figure Certificate Company August 6, 2026 surrender supplement (reviewed 2026-10-09)", "https://cdn.figure.com/docs/markets/fcc-prospectus.pdf", ["route", "settlement"]),
      ],
    },
    costModel: fixedFee(
      0,
      "FCC imposes no surrender charge. Actual ACH pass-through fees are deducted from proceeds and unquantified; FCC or its affiliates pay blockchain charges for approved wallets, while invalid non-approved-wallet transfers remain holder-borne.",
    ),
    docs: [
      sourceRef("Figure YLDS overview", "https://www.figuremarkets.com/c/learn/ylds", [
        "route",
        "capacity",
        "access",
        "settlement",
      ]),
      sourceRefFull("Figure Certificate Company disclosures", "https://www.figuremarkets.com/disclosures/"),
      sourceRef(
        "Figure issuer-hosted prospectus and August 6, 2026 supplement (reviewed 2026-10-07)",
        "https://cdn.figure.com/docs/markets/fcc-prospectus.pdf",
        ["fees", "settlement"],
      ),
    ],
    notes: [
      "Zero describes the FCC surrender-charge component, not ACH net proceeds. FCC pays approved-wallet blockchain transaction charges; invalid transfers involving non-approved wallets are a separate cost scope.",
      "End-to-end payout remains coarse days. The 24-hour processing wording has technological exceptions; wire/ACH may take five days and stablecoin conversion/transfer may take ten days. These staged conditional statements are not unconditional completion scalars.",
    ],
  },
  "usdtb-ethena": {
    ...issuerBase,
    ...reviewedDirectRedemptionSupplyFull,
    capacityModel: { kind: "supply-ratio", ratio: 0.1, confidence: "documented-bound", basis: "hot-buffer" },
    costModel: fixedFee(
      0,
      "Anchorage Covered Stablecoin Service Fee Schedule (2026-08-25): no Covered Stablecoin Service Fees are charged in connection with USDtb. This is the issuer fee only; holders remain responsible for gas or network fees",
    ),
    reviewedAt: "2026-05-17",
    docs: [
      sourceRefRouteCapacity("USDtb docs", "https://docs.usdtb.money/"),
      sourceRef("USDtb reserve attestations", "https://www.anchorage.com/platform/usdtb-reserve-attestations", [
        "capacity",
      ]),
      sourceRef(
        "Anchorage Covered Stablecoin Service Fee Schedule (dated 2026-08-25; reviewed 2026-10-03)",
        "https://www.anchorage.com/anchorage-digital-bank-n-a-covered-stablecoin-service-fee-schedule",
        ["fees"],
      ),
    ],
    notes: [
      "Tracked USDtb metadata records a 10% USDC redemption reserve; Pharos uses that reserve slice as the documented hot-buffer lower bound and does not promote the unvalidated 30% proposal.",
    ],
  },
  "pusd-plume": {
    ...issuerBase,
    ...reviewedDirectRedemptionSupplyFull,
    outputAssets: ["usdc-circle"],
    costModel: fixedFee(0, "Zero-fee mint/redeem at 1:1 for USDC per Plume documentation"),
    docs: [
      sourceRefRouteCapacityFees("Plume pUSD docs", "https://docs.plume.org/plume/tokens/plume-usd"),
      sourceRef("Plume pUSD page", "https://plume.org/pusd", ["route"]),
    ],
    notes: [
      "Payout identity reviewed 2026-09-30: Plume's pUSD docs specify native USDC redemption and no fiat conversion within Plume.",
      "Route is modeled as the documented 1:1 issuer redemption rail into USDC; the single-asset reserve adapter remains reserve-detail telemetry only and is no longer treated as live redeemable-capacity evidence",
    ],
  },
  "usdpt-western-union": {
    ...issuerBase,
    ...documentedBoundSupplyFull(REVIEWED_EXIT_CREDIT_AT),
    settlementModel: "days",
    costModel: fixedFee(
      0,
      "Anchorage Covered Stablecoin Service Fee Schedule (2026-08-25): no Covered Stablecoin Service Fees are charged in connection with USDPT. This is the issuer fee only; network, Western Union cash-out, and other third-party charges are separate",
    ),
    docs: [
      sourceRefFull(
        "Anchorage Digital Bank covered stablecoin terms",
        "https://www.anchorage.com/anchorage-digital-bank-n-a-covered-stablecoin-terms",
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
      sourceRef(
        "Anchorage Covered Stablecoin Service Fee Schedule (dated 2026-08-25; reviewed 2026-10-03)",
        "https://www.anchorage.com/anchorage-digital-bank-n-a-covered-stablecoin-service-fee-schedule",
        ["fees"],
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
      sourceRefRouteCapacity("GMO Trust stablecoin docs", "https://stablecoin.z.com/what-are-gyen-and-zusd/"),
      sourceRef("GMO Trust attestation", "https://stablecoin.z.com/attestation/", ["capacity"]),
    ],
  },
};
