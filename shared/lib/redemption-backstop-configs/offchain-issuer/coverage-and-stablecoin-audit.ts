import type { RedemptionBackstopConfig, RedemptionV9RouteReviewTerms, ReviewedRedemptionTerms } from "../shared";
import { defineConfigFamily } from "../factory";
import {
  documentedBoundSupplyFull,
  documentedVariableFee,
  fixedFee,
  undisclosedReviewedFee,
  issuerBase,
  sourceRef,
  sourceRefFull,
  sourceRefRouteCapacity,
  sourceRefRouteCapacityAccess,
} from "../shared";
import {
  reviewedDirectRedemptionSupplyFull,
  REVIEWED_COVERAGE_EXPANSION_AT,
  REVIEWED_MAJOR_ISSUER_REDEMPTION_AT,
  REVIEWED_STABLECOIN_AUDIT_AT,
} from "./shared";

function assertKnownTableKeys(
  label: string,
  ids: readonly string[],
  table: Readonly<Record<string, unknown>>,
): void {
  const knownIds = new Set(ids);
  const unexpected = Object.keys(table).filter((id) => !knownIds.has(id));
  if (unexpected.length > 0) {
    throw new Error(`${label} contains unknown stablecoin ids: ${unexpected.join(", ")}`);
  }
}

function assertExactTableKeys(
  label: string,
  ids: readonly string[],
  table: Readonly<Record<string, unknown>>,
): void {
  assertKnownTableKeys(label, ids, table);
  const missing = ids.filter((id) => !Object.prototype.hasOwnProperty.call(table, id));
  if (missing.length > 0) {
    throw new Error(`${label} is missing stablecoin ids: ${missing.join(", ")}`);
  }
}


/** Midas liquid-yield-token (LYT) vaults share an identical issuer-API NAV-redemption
 *  shape, settlement, and the standard `liquid-yield-token` doc; they differ only in the
 *  fee/note token name and the per-product page URL. */
const midasLytBase: RedemptionBackstopConfig = {
  ...issuerBase,
  ...documentedBoundSupplyFull("2026-05-14"),
  settlementModel: "days",
  outputAssetType: "nav",
  costModel: undisclosedReviewedFee(),
  docs: [
    sourceRef("Midas token docs", "https://docs.midas.app/liquid-yield-token", ["route", "access", "settlement"]),
  ],
};

type MidasLytTermsGap = Required<
  Pick<RedemptionV9RouteReviewTerms, "missingScoringFields" | "rationale">
>;

const MIDAS_LYT_VAULTS: readonly {
  id: string;
  ticker: string;
  productUrl: string;
  feeDisclosure?: { statement: string; feeBpsMax: number; label: string; url: string };
  termsGap?: MidasLytTermsGap;
}[] = [
  {
    id: "mf-one-midas", ticker: "mF-ONE", productUrl: "https://midas.app/mfone",
    feeDisclosure: {
      statement: "Standard Redemption: This is a fee-free exit option.",
      feeBpsMax: 0,
      label: "Midas Open Liquidity Architecture",
      url: "https://docs.midas.app/liquidity-and-composability/open-liquidity-architecture",
    },
    termsGap: {
      missingScoringFields: ["capacity", "settlement"],
      rationale:
        "The reviewed standard-redemption fee is retained. At Ethereum block 26103201 on 2026-10-02, the official mF-ONE vault is unpaused but greenlist-gated, charges 100 bps for instant redemption, and can source USDC through its mTBILL holdings and the upstream mTBILL vault. Those balances and a 30-million-mToken daily limit do not prove executable capacity for an authorized holder at the scoring notional. The recovered issuer documentation describes a queued fallback without product-specific binding calendar-day settlement or holdback-release terms, so capacity and settlement remain withheld.",
    },
  },
  {
    id: "mglobal-midas-fasanara", ticker: "mGLOBAL", productUrl: "https://midas.app/mglobal",
    feeDisclosure: {
      statement:
        "Standard redemption, settled monthly at the official NAV with no fee; this does not apply to instant-liquidity routes.",
      feeBpsMax: 0,
      label: "Midas mGLOBAL Aave Horizon launch (2026-06-23; reviewed 2026-10-03)",
      url: "https://blog.midas.app/mglobal-is-now-live-on-the-aave-horizon-rwa-market/",
    },
  },
];

const MIDAS_LYT_CONFIGS = defineConfigFamily(
  MIDAS_LYT_VAULTS,
  ({ ticker, productUrl, feeDisclosure, termsGap }) => {
    const docs = [
      sourceRefFull(`Midas ${ticker}`, productUrl),
      ...(feeDisclosure ? [sourceRef(feeDisclosure.label, feeDisclosure.url, ["fees"])] : []),
      ...midasLytBase.docs!,
    ];
    return {
      ...midasLytBase,
      costModel: feeDisclosure
        ? feeDisclosure.feeBpsMax === 0
          ? fixedFee(0, feeDisclosure.statement)
          : {
              ...documentedVariableFee(feeDisclosure.statement, "documented-variable"),
              feeBpsMax: feeDisclosure.feeBpsMax,
            }
        : undisclosedReviewedFee(
            `Midas token docs describe primary-market redemption through Midas rails; public materials reviewed do not publish one fixed ${ticker} redemption fee`,
          ),
      docs,
      ...(termsGap ? {
        v9RouteReviewTerms: {
          scoringDisposition: "bounded-terms-gap" as const,
          missingScoringFields: termsGap.missingScoringFields,
          rationale: termsGap.rationale,
          reviewedAt: "2026-09-04",
          docs: [...docs],
        },
      } : {}),
      notes: [
        `${ticker} is a NAV-accreting Midas strategy token, so the route is modeled as issuer/platform NAV redemption rather than stablecoin par liquidity.`,
      ],
    };
  },
);

/** Spiko fund redemptions share the current withdrawal recipe and SICAV prospectus.
 *  Only EUTBL has documented instant-withdrawal eligibility; this is
 *  investor/bank/day scope, not coin-wide liquidity or a currency-based capability. */
const spikoDepositsRef = () =>
  sourceRef(
    "Spiko deposits and withdrawals",
    "https://docs.spiko.io/documentation/account_management/deposits_withdrawals",
    ["route", "fees", "access", "settlement"],
  );
const spikoBaseDocs = () => [
  spikoDepositsRef(),
  sourceRef(
    "Spiko withdrawal recipe",
    "https://docs.spiko.io/direct/recipes/withdrawal",
    ["route", "access", "settlement"],
  ),
];
const spikoInstantBaseDocs = () => [
  ...spikoBaseDocs(),
  sourceRef(
    "Spiko instant withdrawal eligibility (investor, bank and day scoped)",
    "https://docs.spiko.io/developers/distributor_api/reference/withdrawal-orders-get-instant-withdrawal-eligibility",
    ["route", "access"],
  ),
];
const spikoProspectus = () =>
  sourceRef("Spiko SICAV prospectus", "https://cdn.spiko.finance/legal_docs/EN/Prospectus_Spiko_SICAV_EN.pdf", [
    "capacity",
    "fees",
    "access",
    "settlement",
  ]);
const spikoProspectusSettlementReview = (): RedemptionV9RouteReviewTerms => ({
  settlementModel: "days",
  scoringDisposition: "bounded-terms-gap",
  missingScoringFields: ["settlement"],
  rationale: "Order centralization and ordinary D+1 business-day fund settlement are conditional on market opening, gates and suspensions; they do not establish an unconditional elapsed-second maximum to final bank receipt.",
  reviewedAt: "2026-10-07",
  docs: [
    sourceRef(
      "Spiko SICAV prospectus",
      "https://cdn.spiko.finance/legal_docs/EN/Prospectus_Spiko_SICAV_EN.pdf",
      ["route", "settlement"],
    ),
  ],
});

const SPIKO_FEE_DISCLOSURES: Record<string, { statement: string; url: string }> = {
  "eutbl-spiko": {
    statement: "There are no exit costs for this Product. EUR 0",
    url: "https://cdn.spiko.finance/legal_docs/EN/KID_EUTBL_EN.pdf",
  },
  "ustbl-spiko": {
    statement: "There are no exit costs for this Product. USD 0",
    url: "https://cdn.spiko.finance/legal_docs/EN/KID_USTBL_EN.pdf",
  },
};

/** Two Spiko funds retain documented eventual-only NAV redemption and zero fund
 *  exit fees. Instant eligibility is explicitly class-scoped, never inferred from
 *  EUR denomination. Each fund keeps its product references and independent review. */
const SPIKO_FUNDS: readonly {
  id: string;
  ticker: string;
  shareClassId: string;
  note: string;
  settlementReview: () => RedemptionV9RouteReviewTerms;
}[] = [
  {
    id: "ustbl-spiko",
    ticker: "USTBL",
    shareClassId: "USTBL",
    note: "Modeled as account-gated fund-share redemption at NAV; cutoff times and bank rails make the backstop slower than on-chain stablecoin liquidity.",
    settlementReview: () => ({
      ...spikoProspectusSettlementReview(),
      rationale: "The September 1, 2026 SICAV prospectus p21 settles USTBL redemptions on D for registered-share orders cleared before 11:30 Paris time; later orders roll to the next business day. France/US holidays and Paris/New York exchange closures defer clearing/NAV. Electronic-money-token transfer may not start on centralization day and may be refused in favor of bank transfer. The discretionary 10% net-assets gate and suspensions can defer requests; unexecuted orders carry forward without priority. Ordinary D settlement is conditional, and no matching reviewed calendar or unconditional final-receipt scalar is established.",
      reviewedAt: "2026-11-06",
      docs: [sourceRef("Spiko SICAV prospectus, September 1, 2026, pp21-23: USTBL settlement and gates", "https://cdn.spiko.finance/legal_docs/EN/Prospectus_Spiko_SICAV_EN.pdf", ["route", "settlement"])],
    }),
  },
  {
    id: "eutbl-spiko",
    ticker: "EUTBL",
    shareClassId: "EUTBL",
    note: "Modeled as account-gated fund-share redemption at NAV; instant withdrawals are eligibility-limited and standard withdrawals remain bank-rail dependent.",
    settlementReview: spikoProspectusSettlementReview,
  },
];
assertExactTableKeys(
  "SPIKO_FEE_DISCLOSURES",
  SPIKO_FUNDS.map(({ id }) => id),
  SPIKO_FEE_DISCLOSURES,
);


const SPIKO_FUND_CONFIGS = defineConfigFamily(
  SPIKO_FUNDS,
  ({ id, ticker, shareClassId, note, settlementReview }) => {
    const baseDocs = shareClassId === "EUTBL" ? spikoInstantBaseDocs() : spikoBaseDocs();
    const feeDisclosure = SPIKO_FEE_DISCLOSURES[id];
    return {
      ...issuerBase,
      ...documentedBoundSupplyFull(REVIEWED_STABLECOIN_AUDIT_AT),
      settlementModel: "days",
      outputAssetType: "nav",
      costModel: fixedFee(0, feeDisclosure.statement),
      v9RouteReviewTerms: settlementReview(),
      docs: [
        ...baseDocs,
        sourceRef(`Spiko ${ticker} KID`, feeDisclosure.url, ["fees"]),
        spikoProspectus(),
      ],
      notes: [
        note,
        "Capacity is documented eventual-only redeemability. NAV, class totals and dated gross bank-cash positions are backing diagnostics, not funded withdrawal commitments. Authenticated instant availableAmount is investor/bank/day scoped, was not observed here and cannot be multiplied across holders or treated as coin-wide capacity; bankSupportsInstant without an actual bank ID is not bank confirmation, and EUR amounts require contemporaneous admitted FX.",
      ],
    };
  },
);

/** bIB01 Backed sourceRefs (the redemption docs and the product-structure page). */
const backedRedemptionRef = () =>
  sourceRefFull("Backed redemption docs", "https://docs.backed.fi/backed-platform/issuance-and-redemption/redemption");
const backedProductStructureRef = () =>
  sourceRef("Backed product structure", "https://assets.backed.fi/structure", ["capacity", "access"]);

// Keep the percentage distinct from its fee minimum, and that minimum
// distinct from the $100,000 redemption minimum.
export const USDT_REVIEWED_REDEMPTION_TERMS: ReviewedRedemptionTerms = {
  compactFeeBasis: {
    feeBasis: "0.10%, with a minimum fee of $1,000",
    termsClock: "config",
  },
  config: {
    ...issuerBase,
    ...reviewedDirectRedemptionSupplyFull,
    reviewedAt: REVIEWED_MAJOR_ISSUER_REDEMPTION_AT,
    costModel: {
      ...documentedVariableFee("0.10% with a $1,000 minimum", "documented-variable"),
      // T1: the issuer fee page states the redemption fee outright — 0.10%
      // (greater of that or $1,000) — a citable documented ceiling.
      feeBpsMax: 10,
    },
    v9RouteCostTerms: { minFeeUsd: 1_000 },
    v9RouteReviewTerms: {
      minRedeemUsd: 100_000,
      settlementModel: "days",
    },
    docs: [
      sourceRef("Tether Transparency", "https://tether.to/en/transparency", ["capacity"]),
      sourceRefRouteCapacityAccess("Tether legal terms", "https://tether.to/en/legal/"),
      sourceRef("Tether fees", "https://tether.to/en/fees/", ["fees", "access"]),
    ],
  },
};

export const COVERAGE_AND_STABLECOIN_AUDIT_OFFCHAIN_CONFIGS: Record<string, RedemptionBackstopConfig> = {
  "usdt-tether": USDT_REVIEWED_REDEMPTION_TERMS.config,
  "pathusd-bridge": {
    ...issuerBase,
    ...documentedBoundSupplyFull(REVIEWED_COVERAGE_EXPANSION_AT),
    outputAssets: ["usdc-circle"],
    settlementModel: "days",
    routeStatus: "open",
    costModel: undisclosedReviewedFee(
      "Bridge-supported pathUSD exchange/redemption uses Bridge rails; public materials reviewed do not publish one fixed pathUSD redemption fee",
    ),
    v9RouteReviewTerms: {
      scoringDisposition: "bounded-terms-gap",
      missingScoringFields: ["capacity", "settlement", "cost"],
      rationale: "Eligible Bridge users have a documented USDC redemption route, but no funded same-notional amount or complete cost ceiling is established. Bridge's two-business-day processing term starts after compliance determination and does not guarantee completed USDC receipt. Neither same-day settlement nor a two-business-day completed-payout SLA is inferred.",
      reviewedAt: "2026-10-14",
      docs: [
        sourceRef("Bridge stablecoin terms, redemption processing after compliance (reviewed 2026-10-14; undated primary page)", "https://www.bridge.xyz/legal/bridge-stablecoin-terms/bridge-building-inc", ["route", "access", "settlement"]),
        sourceRef("Tempo pathUSD USDC redemption endpoint", "https://tempo.xyz/developers/docs/protocol/exchange/quote-tokens", ["route"]),
      ],
    },
    docs: [
      sourceRef("Tempo mainnet pathUSD payout (reviewed 2026-09-30)", "https://tempo.xyz/developers/docs/protocol/exchange/quote-tokens", ["route"]),
      sourceRef("Tempo pathUSD docs", "https://docs.tempo.xyz/protocol/exchange/pathUSD", ["route", "access", "fees"]),
      sourceRef("Bridge issuance FAQ", "https://apidocs.bridge.xyz/platform/issuance/faq", [
        "capacity",
        "settlement",
        "fees",
      ]),
    ],
    notes: [
      "Payout identity reviewed 2026-09-30: Tempo's mainnet quote-token documentation explicitly states pathUSD is redeemed to USDC through Bridge.",
      "Modeled as verified Bridge/Tempo primary-market redeemability into USDC rather than independently measured instant on-chain liquidity",
    ],
  },
  "gbpe-monerium": {
    ...issuerBase,
    ...documentedBoundSupplyFull(REVIEWED_COVERAGE_EXPANSION_AT),
    holderEligibility: "issuer-discretionary",
    v9RouteReviewTerms: { settlementModel: "queued" },
    costModel: undisclosedReviewedFee(
      "GBPe redemption requires an additional non-EUR contract; public business terms permit fees but publish no complete applicable GBP fee ceiling",
    ),
    docs: [
      sourceRef(
        "Monerium business terms",
        "https://monerium.com/policies/business-terms-of-service/",
        ["route", "access", "settlement", "fees"],
      ),
      sourceRefFull("Monerium financial information", "https://monerium.com/financial-information/"),
      sourceRef("Monerium GBPe knowledge base: GBP IBANs not currently offered", "https://help.monerium.com/article/12-gbpe-ibans", ["route", "access"]),
    ],
    notes: ["GBPe is not the generally available EUR/SEPA rail: direct non-EUR redemption requires Monerium's additional contractual agreement. The public GBP IBAN channel is unavailable; bespoke contractual redemption is not declared suspended or zero-capacity."],
  },
  "qcad-stablecorp": {
    ...issuerBase,
    ...documentedBoundSupplyFull(REVIEWED_COVERAGE_EXPANSION_AT),
    accessModel: "manual",
    holderEligibility: "verified-customer",
    settlementModel: "days",
    costModel: fixedFee(
      0,
      "QCAD Token Terms and Conditions, Article 7, Section 7.1: QCDT and the Servicer do not currently charge any fees to an Authorized Participant on Purchase or to a Redeemer in connection with a Redemption. The OSC decision dated 2025-11-20 (representation 11) states the same. This is the issuer-side fee only; Section 7.2 leaves the redeemer's own banking fees and any Authorized Participant brokerage commission separate, and Section 7.3 requires 30 days notice before any fee is introduced",
    ),
    v9RouteReviewTerms: {
      scoringDisposition: "bounded-terms-gap",
      missingScoringFields: ["capacity", "settlement"],
      rationale:
        "The regulator-filed QCAD Token Terms and Conditions (SEDAR+) and the OSC decision dated 2025-11-20 establish a zero issuer redemption fee and no minimum redemption size, so cost is no longer withheld. They still publish no executable redemption limit and no accepted-request-to-bank-credit SLA: redemption is conditioned on circumstances rendering a sale through a CTP impractical or impossible, and the terms name no payment deadline.",
      reviewedAt: "2026-10-07",
      docs: [
        sourceRef("Stablecorp", "https://stablecorp.ca/", ["route", "access"]),
        sourceRef("Stablecorp transparency (published 2026-08-21)", "https://stablecorp.ca/transparency", ["route"]),
        sourceRef(
          "QCAD Token Terms and Conditions, Article 7 (SEDAR+ filing)",
          "https://www.sedarplus.ca/csa-party/records/document.html?id=194b25dd3a2d2a8d59e108b3cf223b2fc41d68e33507899cbb350a659a9fea0a",
          ["fees", "access"],
        ),
        sourceRef(
          "OSC decision In the Matter of QCAD Digital Trust (November 20, 2025)",
          "https://www.osc.ca/en/securities-law/orders-rulings-decisions/qcad-digital-trust",
          ["route", "fees", "access"],
        ),
      ],
    },
    docs: [
      sourceRef(
        "QCAD filed Terms (undated), Sections 2.4-2.7 and 4.1-4.5: own-account institutional agreement or retail account, portal KYC application, Servicer approval and CAD account in Canada; manual redemption request (access reviewed 2026-11-06)",
        "https://www.sedarplus.ca/csa-party/records/document.html?id=194b25dd3a2d2a8d59e108b3cf223b2fc41d68e33507899cbb350a659a9fea0a",
        ["access"],
      ),
      sourceRef(
        "OSC QCAD decision (2025-11-20), definitions and representations 24-25: institutional and retail Qualified Holders only; direct redemption remains conditional on CTP sale being impractical or impossible (access reviewed 2026-11-06)",
        "https://www.osc.ca/en/securities-law/orders-rulings-decisions/qcad-digital-trust",
        ["access"],
      ),
      sourceRefFull("Stablecorp transparency", "https://stablecorp.ca/transparency"),
      sourceRef("Stablecorp balances API", "https://api.sdc.stablecorp.ca/reports/balances?type=unformatted_json", [
        "capacity",
      ]),
      sourceRef(
        "QCAD Token Terms and Conditions, Article 7 (SEDAR+ filing)",
        "https://www.sedarplus.ca/csa-party/records/document.html?id=194b25dd3a2d2a8d59e108b3cf223b2fc41d68e33507899cbb350a659a9fea0a",
        ["fees", "access"],
      ),
    ],
    notes: [
      "Modeled as issuer redemption for qualified holders under QCAD Digital Trust and authorized partner rails",
      "Fee reviewed 2026-10-07 from the regulator record: Terms and Conditions Section 7.1 charges no purchase or redemption fee and there is no minimum redemption size; OSC decision representation 11 confirms the Servicer receives no purchase/redemption fees. Holder-side banking charges, Authorized Participant commissions (representation 23) and network gas stay outside this issuer fee.",
    ],
  },
  "dusd-fluid": {
    ...issuerBase,
    ...documentedBoundSupplyFull(REVIEWED_STABLECOIN_AUDIT_AT),
    settlementModel: "days",
    routeStatus: "open",
    costModel: undisclosedReviewedFee(
      "Fluid materials describe bank-account mint/redeem flows for DUSD; public materials reviewed do not publish one fixed redemption fee",
    ),
    docs: [
      sourceRefFull("Fluid DUSD", "https://fluid.ch/dusd/"),
      sourceRefFull(
        "Fluid app mint/redeem guide",
        "https://medium.com/fluidfi/how-to-use-the-web-app-and-mint-redeem-digitaldollar-dusd-5183c8dcfb6",
      ),
    ],
    notes: [
      "Modeled as verified-user bank-rail redemption, not as an on-chain permissionless stablecoin swap; reserve visibility still depends on Fluid's self-reported on-chain treasury balance.",
    ],
  },
  ...MIDAS_LYT_CONFIGS,
  "mglo-midas-fasanara": {
    ...issuerBase,
    reviewedAt: "2026-11-27",
    capacityModel: { kind: "unquantified" },
    settlementModel: "days",
    outputAssetType: "nav",
    unresolvedOutputAssetKeys: ["usdc-circle", "usdg-paxos"],
    costModel: undisclosedReviewedFee(
      "On-chain mGLO RedemptionVaultSwappers on Base, Ethereum, and Robinhood Chain pause fiat redemption (fnPaused(redeemFiatRequest)=true; configured fiatAdditionalFee=10 bps plus 30 mGLO flat fee) while leaving standard token requests unpaused with 0 bps configured token fee (USDC on Base/Ethereum, USDG on Robinhood Chain) and 50 bps instant fee; no offering prospectus establishing binding all-in fees or settlement deadlines was recovered because Midas web pages returned HTTP 403.",
    ),
    v9RouteReviewTerms: {
      scoringDisposition: "bounded-terms-gap",
      missingScoringFields: ["capacity", "settlement", "cost"],
      rationale:
        "Live pinned reads on Base (block 62994714), Ethereum (block 26507108), and Robinhood Chain (block 124312872) confirm fnPaused(redeemFiatRequest(uint256)) = true on the issuer-registered mGLO redemption vaults (with fiatAdditionalFee = 10 bps and fiatFlatFee = 30 mGLO), while standard token requests remain unpaused with 0 bps configured token fee (paying USDC on Base/Ethereum and USDG on Robinhood Chain) and 50 bps instant fee. Because Midas web product and legal documentation returned HTTP 403 and no offering prospectus establishing binding settlement deadlines, capacity limits, or complete fees was recovered, capacity, settlement, cost, and unified payout identity remain withheld.",
      reviewedAt: "2026-11-27",
      docs: [
        sourceRef("Midas contracts deployment registry", "https://github.com/midas-apps/contracts/blob/main/config/constants/addresses.ts", ["route", "access"]),
        sourceRef("Midas PoR v2 canonical token registry", "https://raw.githubusercontent.com/midas-apps/midas-por-v2/main/tokens.json", ["route", "capacity"]),
        sourceRef("Midas mGLO November 25, 2026 SAVE attestation", "https://gateway.pinata.cloud/ipfs/QmeNwyuVyhM5HvEFfKZH9j7zCCvGrLwCBf1hYeWsTocMt1", ["capacity", "settlement"]),
        sourceRef("Base mGLO RedemptionVaultSwapper", "https://base.blockscout.com/address/0xa80f9bffff91cbc13314fefd05560032af018f18", ["route", "fees", "access"]),
        sourceRef("Ethereum mGLO RedemptionVaultSwapper", "https://eth.blockscout.com/address/0x55f3ab43e49ffb6b1fff5e2b310c21278bdaf0f5", ["route", "fees", "access"]),
      ],
    },
    docs: [
      sourceRef("Midas contracts deployment registry", "https://github.com/midas-apps/contracts/blob/main/config/constants/addresses.ts", ["route", "access"]),
      sourceRef("Midas PoR v2 canonical token registry", "https://raw.githubusercontent.com/midas-apps/midas-por-v2/main/tokens.json", ["route", "capacity"]),
      sourceRef("Midas mGLO November 25, 2026 SAVE attestation", "https://gateway.pinata.cloud/ipfs/QmeNwyuVyhM5HvEFfKZH9j7zCCvGrLwCBf1hYeWsTocMt1", ["capacity", "settlement"]),
      sourceRef("Base mGLO RedemptionVaultSwapper", "https://base.blockscout.com/address/0xa80f9bffff91cbc13314fefd05560032af018f18", ["route", "fees", "access"]),
      sourceRef("Ethereum mGLO RedemptionVaultSwapper", "https://eth.blockscout.com/address/0x55f3ab43e49ffb6b1fff5e2b310c21278bdaf0f5", ["route", "fees", "access"]),
    ],
    notes: [
      "mGLO is a NAV-accreting Midas strategy certificate whose on-chain RedemptionVaultSwappers keep fiat redemption paused while exposing chain-specific token redemption requests (USDC on Base and Ethereum, USDG on Robinhood Chain). Because no single unified payout token or readable offering prospectus establishes binding settlement, capacity, and all-in fee terms, the payout identity stays unresolved rather than defaulting to fiat USD.",
    ],
  },
  "wtgxx-wisdomtree": {
    ...issuerBase,
    ...documentedBoundSupplyFull(REVIEWED_STABLECOIN_AUDIT_AT),
    routeStatus: "open",
    costModel: undisclosedReviewedFee(
      "WisdomTree Connect supports subscriptions and redemptions through USD wires or stablecoin conversion; public materials reviewed do not publish one fixed redemption fee",
    ),
    docs: [
      sourceRefFull("WisdomTree Connect", "https://www.wisdomtreeconnect.com/"),
      sourceRef("WTGXX fund page", "https://www.wisdomtree.com/investments/digital-funds/money-market/wtgxx", [
        "capacity",
        "fees",
      ]),
    ],
    notes: [
      "Same-day settlement depends on U.S. trading-day cutoffs; 24/7 dealer settlement is modeled as platform primary-market access, not independent on-chain liquidity.",
    ],
  },
  "tbill-openeden": {
    ...issuerBase,
    ...documentedBoundSupplyFull("2026-11-27"),
    settlementModel: "days",
    outputAssetType: "stable-single",
    outputAssets: ["usdc-circle"],
    routeStatus: "open",
    costModel: fixedFee(
      5,
      "OpenEden TBILL docs publish a 5 bps transaction fee on subscriptions and redemptions (paid in USDC); annualized 35 bps TER accrues separately in NAV.",
    ),
    docs: [
      sourceRef("OpenEden TBILL Redemptions", "https://docs.openeden.com/tbill/redemptions", [
        "route",
        "capacity",
        "settlement",
      ]),
      sourceRef("OpenEden TBILL Fees", "https://docs.openeden.com/tbill/fees", ["fees"]),
      sourceRef("OpenEden TBILL FAQ", "https://docs.openeden.com/tbill/faq", [
        "capacity",
        "fees",
        "access",
        "settlement",
      ]),
      sourceRef("OpenEden TBILL Investor Onboarding", "https://docs.openeden.com/tbill/investor-onboarding", [
        "access",
      ]),
    ],
    notes: [
      "KYC-whitelisted accredited/professional investors redeem TBILL for USDC via the FIFO vault redemption queue (minimum 1 USDC), typically processed on the next U.S. business day at prevailing NAV net of the 5 bps transaction fee.",
    ],
  },
  "vbill-vaneck": {
    ...issuerBase,
    ...documentedBoundSupplyFull(REVIEWED_STABLECOIN_AUDIT_AT),
    outputAssetType: "nav",
    holderEligibility: "unknown",
    settlementModel: "days",
    costModel: undisclosedReviewedFee(
      "The current VBILL page publishes a 0.2% total unitary fund fee, not an all-in redemption tariff. Securitize's 2026 broker schedule separately lists conversion, outgoing-wire and variable gas charges without establishing the complete exact fund-redemption deductions.",
    ),
    v9RouteReviewTerms: {
      scoringDisposition: "bounded-terms-gap",
      missingScoringFields: ["capacity", "settlement", "cost"],
      rationale:
        "The fully rendered issuer product page was re-reviewed on 2026-10-20: direct fund redemptions are daily, third-party instant swaps are only potentially available, market or blockchain delays are explicit, and tokens cannot be transferred or redeemed for 72 hours after issuance. Neither that eligibility hold nor the 2pm ET liquidity cutoff is a maximum final-payout SLA. The public 0.2% unitary fee is a fund expense, not a complete holder redemption cost. The separate 2026 broker schedule has variable gas and route-dependent conversion/wire costs. No guaranteed same-notional executable amount, complete all-in cost bound or unconditional completed-settlement maximum is established; preserve all three gaps.",
      reviewedAt: "2026-10-20",
      docs: [
        sourceRef("Securitize VBILL", "https://securitize.io/primary-market/vaneck-vbill", [
          "route",
          "access",
          "settlement",
        ]),
        sourceRef(
          "VanEck VBILL launch (published 2025-05-13)",
          "https://www.prnewswire.com/news-releases/vaneck-launches-first-tokenized-fund-vbill-on-securitize-302453863.html",
          ["route", "access", "settlement"],
        ),
        sourceRef("Securitize broker-dealer fee schedule 2026 (not a complete VBILL redemption tariff)", "https://securitize.io/fee-schedule-table", ["fees"]),
      ],
    },
    docs: [
      sourceRef("Securitize VBILL", "https://securitize.io/primary-market/vaneck-vbill", ["route", "access", "settlement"]),
      sourceRef(
        "VanEck VBILL launch (published 2025-05-13)",
        "https://www.prnewswire.com/news-releases/vaneck-launches-first-tokenized-fund-vbill-on-securitize-302453863.html",
        ["route", "access", "settlement"],
      ),
      sourceRef("Securitize broker-dealer fee schedule 2026", "https://securitize.io/fee-schedule-table", ["fees"]),
    ],
    notes: [
      "Modeled as qualified-investor Securitize primary-market redemption at NAV, not as secondary exchange liquidity.",
      "Current public terms impose a 72-hour postissuance transfer/redemption hold. This is an eligibility condition, not a 72-hour settlement guarantee; potential third-party smart-contract liquidity is not funded same-notional capacity.",
    ],
  },
  "jtrsy-anemoy": {
    ...issuerBase,
    ...documentedBoundSupplyFull(REVIEWED_STABLECOIN_AUDIT_AT),
    outputAssetType: "nav",
    costModel: fixedFee(
      0,
      "Standard redemptions are free, for instant redemptions, please see the section about the Anemoy Liquidity Network (ALN).",
    ),
    docs: [
      sourceRefFull("Centrifuge JTRSY pool", "https://centrifuge.io/pools/jtrsy"),
      sourceRef("Centrifuge investor docs", "https://docs.centrifuge.io/user/investor/", [
        "route",
        "access",
        "settlement",
      ]),
      sourceRef(
        "Centrifuge JTRSY STEP II application",
        "https://forum.arbitrum.foundation/t/centrifuge-janus-henderson-anemoy-treasury-fund-jtrsy-step-ii-application/23496",
        ["fees"],
      ),
    ],
    notes: [
      "Modeled as whitelisted Professional Investor redemption through the Centrifuge issuer rail; async vault processing can delay settlement.",
    ],
  },
  "jaaa-janus-henderson-anemoy": {
    ...issuerBase,
    ...documentedBoundSupplyFull(REVIEWED_STABLECOIN_AUDIT_AT),
    outputAssetType: "nav",
    holderEligibility: "unknown",
    settlementModel: "days",
    costModel: undisclosedReviewedFee(
      "Anemoy materials describe subscriptions and redemptions in stablecoins; public materials reviewed do not publish one fixed JAAA redemption fee",
    ),
    v9RouteReviewTerms: {
      scoringDisposition: "bounded-terms-gap",
      missingScoringFields: ["capacity", "settlement", "cost"],
      rationale:
        "Anemoy's JAAA page and the dated 2025-06-05 launch announcement describe daily access and institutional liquidity, but the 2026-09-04 re-open found no dated governing terms establishing the scored notional's executable capacity, maximum settlement SLA, gates, or holder-paid charges.",
      reviewedAt: "2026-09-04",
      docs: [
        sourceRef("Anemoy JAAA fund", "https://www.anemoy.io/funds/jaaa", ["route", "access", "settlement"]),
        sourceRef(
          "Anemoy JAAA launch (published 2025-06-05)",
          "https://www.anemoy.io/news/janus-henderson-anemoy-aaa-clo-onchain",
          ["route", "access"],
        ),
      ],
    },
    docs: [
      sourceRef("Anemoy JAAA fund", "https://www.anemoy.io/funds/jaaa", ["route", "access", "settlement"]),
      sourceRef("Centrifuge investor docs", "https://docs.centrifuge.io/user/investor/", [
        "route",
        "access",
        "settlement",
      ]),
    ],
    notes: [
      "Modeled as whitelisted professional-investor redemption through the Anemoy / Centrifuge fund rail; tokenized CLO-fund NAV processing is slower and more access-limited than on-chain stablecoin liquidity.",
    ],
  },
  ...SPIKO_FUND_CONFIGS,
  "bib01-backed": {
    ...issuerBase,
    ...documentedBoundSupplyFull(REVIEWED_STABLECOIN_AUDIT_AT),
    settlementModel: "days",
    outputAssetType: "nav",
    costModel: undisclosedReviewedFee(
      "Backed documents bToken redemption into stablecoins or cash within T+3; public materials reviewed do not publish one fixed bIB01 redemption fee",
    ),
    docs: [
      backedRedemptionRef(),
      sourceRef("Backed bIB01 product", "https://assets.backed.fi/products/bib01", ["capacity", "fees", "access"]),
      backedProductStructureRef(),
    ],
    notes: [
      "Modeled as Backed primary-market redemption for approved customers; T+3 processing and market-hours execution make it slower than secondary DEX exits.",
    ],
  },
  "cadd-cad-digital": {
    ...issuerBase,
    ...documentedBoundSupplyFull(REVIEWED_STABLECOIN_AUDIT_AT),
    routeStatus: "open",
    costModel: {
      ...documentedVariableFee("Greater of C$50 or 0.25% of gross redemption proceeds, plus applicable taxes", "documented-variable"),
      feeBpsMax: 25,
    },
    docs: [
      sourceRef("CADD terms and conditions", "https://tetradg.com/cadd-terms-and-conditions/", [
        "route",
        "fees",
        "access",
        "settlement",
      ]),
      sourceRefFull("CADD trust indenture", "https://tetradg.com/tetra-trust-indenture/"),
      sourceRef("CADD reserve attestations", "https://tetradg.com/cadd-reserve-attestations/", ["capacity", "fees"]),
      sourceRef("CADD stablecoin page", "https://tetradg.com/cadd-stablecoin/", ["route", "access"]),
    ],
    notes: [
      "Modeled as CAD Digital issuer redemption to approved participant or registered end-user bank accounts, not as permissionless on-chain CAD liquidity.",
    ],
  },
  "myrc-blox": {
    ...issuerBase,
    ...documentedBoundSupplyFull(REVIEWED_STABLECOIN_AUDIT_AT),
    settlementModel: "days",
    routeStatus: "open",
    costModel: fixedFee(
      0,
      "BLOX transaction fee structure (effective 2025-07-14) clause 2.2: all Service Fees are absorbed by the Company and no charges are imposed on Users for Platform transactions. This is the issuer service fee only; separately incurred bank, network, and third-party costs are not promised to be zero, and the Company may revise fees",
    ),
    docs: [
      sourceRefFull("Blox MYRC", "https://www.blox.my/myrc"),
      sourceRefRouteCapacity("Blox MYRC transparency", "https://www.blox.my/myrc/transparency"),
      sourceRef("Blox product term sheet", "https://www.blox.my/policies/product-term-sheet", [
        "route",
        "fees",
        "access",
      ]),
      sourceRef(
        "BLOX transaction fee structure (effective 2025-07-14; reviewed 2026-10-03)",
        "https://www.blox.my/policies/transaction-fee-structure",
        ["fees"],
      ),
    ],
    notes: [
      "Modeled as Malaysian eKYC and bank-account redemption through Blox/FPX rails; the route is jurisdiction- and account-limited.",
    ],
  },
  "krwq-iq": {
    ...issuerBase,
    ...documentedBoundSupplyFull(REVIEWED_STABLECOIN_AUDIT_AT),
    routeStatus: "open",
    executionModel: "opaque",
    costModel: undisclosedReviewedFee(
      "KRWQ materials expose a Mint/Redeem flow and KYC-gated institutional controls; public materials reviewed do not publish one fixed redemption fee",
    ),
    docs: [
      sourceRefFull("KRWQ homepage", "https://www.krwq.cash/"),
      sourceRef("KRWQ mint/redeem", "https://www.krwq.cash/mint", ["route", "access"]),
      sourceRef("KRWQ whitepaper", "https://www.krwq.cash/whitepaper.pdf", ["capacity", "fees", "access"]),
    ],
    notes: [
      "Modeled as KYC-gated KRWQ platform redemption; public materials still point to future formal attestations, so reserve transparency remains separate from route existence.",
    ],
  },
  "sofid-sofi": {
    ...issuerBase,
    ...documentedBoundSupplyFull(REVIEWED_STABLECOIN_AUDIT_AT),
    routeStatus: "open",
    settlementModel: "days",
    v9RouteReviewTerms: {
      settlementModel: "days",
      scoringDisposition: "bounded-terms-gap",
      missingScoringFields: ["cost", "settlement"],
      rationale: "The current SoFiUSD terms authorize fees but establish neither a numeric issuer fee maximum nor an unconditional completed-payout deadline. Fee authority is not a zero-fee schedule or proof of access or funded capacity.",
      reviewedAt: "2026-10-07",
      docs: [
        sourceRef("SOFID Terms of Use (effective 2026-05-27; reviewed 2026-10-07)", "https://d32ijn7u0aqfv4.cloudfront.net/wp/wp-content/uploads/raw/SOFID-Terms-of-Use-1.pdf", ["fees", "settlement"]),
      ],
    },
    costModel: undisclosedReviewedFee(
      "BitGo Mint supports native SoFiUSD minting and redemption for institutions; public materials reviewed do not publish one fixed redemption fee",
    ),
    docs: [
      sourceRefFull("SoFiUSD", "https://www.sofi.com/crypto/sofiusd/"),
      sourceRef(
        "BitGo Mint launch",
        "https://investors.bitgo.com/news/news-details/2026/BitGo-Launches-BitGo-Mint-Native-Stablecoin-Minting-and-Redemption-for-Institutions/default.aspx",
        ["route", "access", "settlement"],
      ),
      sourceRefRouteCapacityAccess(
        "BitGo SoFiUSD infrastructure",
        "https://www.bitgo.com/resources/blog/bitgo-selected-by-sofi-to-provide-stablecoin-infrastructure/",
      ),
      sourceRef("SOFID Terms of Use: fee authority only (reviewed 2026-10-07)", "https://d32ijn7u0aqfv4.cloudfront.net/wp/wp-content/uploads/raw/SOFID-Terms-of-Use-1.pdf", ["fees"]),
    ],
    notes: ["Modeled as institutional BitGo/SoFi issuer redemption, not a retail self-service on-chain burn path."],
  },
};
