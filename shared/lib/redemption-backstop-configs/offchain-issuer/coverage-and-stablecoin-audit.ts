import type { RedemptionDocSource } from "../../../types";
import type { RedemptionBackstopConfig, RedemptionV9RouteReviewTerms } from "../shared";
import {
  cloneRedemptionBackstopConfig,
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

function midasBusinessDayReview(businessDays: 6 | 10): RedemptionV9RouteReviewTerms {
  return {
    businessDayTerms: {
      businessDays, calendarId: "frankfurt-banking-target",
      cutoff: { time: businessDays === 6 ? "23:59" : null, timezone: "Europe/Berlin" },
      assurance: "binding-guarantee", conditional: true,
      conditions: businessDays === 6
        ? ["15% per-settlement-day redemption gate", "Market-disruption valuation/payment deferrals and qualified subordination; instant holdback is not standard-route capacity"]
        : ["Greenlisting and issuer notice of order receipt after token delivery", "Market-disruption/underlying-illiquidity postponements (base conditions 6 and 7)"],
      startEvent: businessDays === 6 ? "Accepted standard redemption after applicable gates" : "Issuer notice of receipt of the Tokenholder Order Request Form",
      ...(businessDays === 6 ? { stages: [{ name: "realisation", businessDays: 1 }, { name: "payment-after-realisation", businessDays: 5 }] } : {}),
    },
    reviewedAt: "2026-10-05",
    docs: businessDays === 6 ? [
      sourceRef("Signed July 17, 2026 mHYPER final terms: 23:59 CET/CEST cutoff, one-day realisation and 15% gate", "https://3475141875-files.gitbook.io/~/files/v0/b/gitbook-x-prod.appspot.com/o/spaces%2FMndxFHqGeA4nzBBeKDTV%2Fuploads%2FMgKVyFHWPLrKpyKjdQqL%2F20260714_mHYPER_FT_signed_final.pdf?alt=media&token=b06233b0-229f-47ce-b622-127fb63f231f", ["settlement"]),
      sourceRef("Midas 2026 base, conditions 8.3(c) and 12", "https://3475141875-files.gitbook.io/~/files/v0/b/gitbook-x-prod.appspot.com/o/spaces%2FMndxFHqGeA4nzBBeKDTV%2Fuploads%2FqYMbXAF5ckgGOgrqYF9N%2FMidas%20Software%20GmbH%20Base%20Prospectus%202026.pdf?alt=media&token=58c911b9-1ab7-495c-97ba-d379fe9c4e5e", ["settlement"]),
    ] : [sourceRef("Midas governing 2025 base, Business Day and redemption/deferral clauses", "https://3475141875-files.gitbook.io/~/files/v0/b/gitbook-x-prod.appspot.com/o/spaces%2FMndxFHqGeA4nzBBeKDTV%2Fuploads%2FhkJf4UxNukH071S6e4GA%2FMidas_Prospectus_Update_2025%20(1).pdf?alt=media&token=9bfe7105-c648-406b-b51c-b9c4431bc335", ["settlement"])],
  };
}
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
 *  fee/note token name and the per-product page URL. mre7yield-midas diverges (different
 *  reviewed date, `smart-contracts` doc, and note) and stays inline below. */
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

const MIDAS_LYT_VAULTS: readonly [id: string, ticker: string, productUrl: string][] = [
  ["mf-one-midas", "mF-ONE", "https://midas.app/mfone"],
  ["mglobal-midas-fasanara", "mGLOBAL", "https://midas.app/mglobal"],
  ["mhyper-midas", "mHYPER", "https://midas.app/mhyper"],
  ["mmev-midas", "mMEV", "https://docs.midas.app/tokens/mmev"],
  ["mapollo-midas", "mAPOLLO", "https://midas.app/mapollo"],
];

const MIDAS_LYT_FEE_DISCLOSURES: Partial<
  Record<string, { statement: string; feeBpsMax: number; label: string; url: string }>
> = {
  "mf-one-midas": {
    statement: "Standard Redemption: This is a fee-free exit option.",
    feeBpsMax: 0,
    label: "Midas Open Liquidity Architecture",
    url: "https://docs.midas.app/liquidity-and-composability/open-liquidity-architecture",
  },
  "mglobal-midas-fasanara": {
    statement:
      "Standard redemption, settled monthly at the official NAV with no fee; this does not apply to instant-liquidity routes.",
    feeBpsMax: 0,
    label: "Midas mGLOBAL Aave Horizon launch (2026-06-23; reviewed 2026-10-03)",
    url: "https://blog.midas.app/mglobal-is-now-live-on-the-aave-horizon-rwa-market/",
  },
  "mhyper-midas": {
    statement: "Tokenholder Fee 0.50 percent redemption fee and 10 percent interest fee",
    feeBpsMax: 50,
    label: "Midas mHYPER Final Terms",
    url: "https://content.gitbook.com/content/MndxFHqGeA4nzBBeKDTV/blobs/Rh0tXsofDB8UQWaklyuE/Midas_Final_Terms_mHYPER_2025.pdf",
  },
  "mmev-midas": {
    statement: "Tokenholder Fee 0.50 percent redemption fee and 10 percent interest fee",
    feeBpsMax: 50,
    label: "Midas mMEV Final Terms",
    url: "https://2732961456-files.gitbook.io/~/files/v0/b/gitbook-x-prod.appspot.com/o/spaces%2FsPjk0ggBxEJCCnVFFkDR%2Fuploads%2FEoSLAqc1ZoCEV1LBkiup%2FMidas_Final_Terms_mMEV_Update_2025.pdf?alt=media&token=d58efef6-7d01-4889-9af7-3c86f1a9e932",
  },
  "mapollo-midas": {
    statement:
      "mAPOLLO Final Terms signed July 17, 2026 list Redemption Fees 0% for standard redemption; the separate Instant Redemption Fee of 0.5% does not apply to this route, and all-in transaction cost is not asserted zero.",
    feeBpsMax: 0,
    label: "Midas mAPOLLO Final Terms (signed 2026-07-17; reviewed 2026-10-03)",
    url: "https://3475141875-files.gitbook.io/~/files/v0/b/gitbook-x-prod.appspot.com/o/spaces%2FMndxFHqGeA4nzBBeKDTV%2Fuploads%2F7sSYvDMJYrWvBsvKGQFI%2F20260714_mAPOLLO_FT_signed_final.pdf?alt=media",
  },
};
assertKnownTableKeys(
  "MIDAS_LYT_FEE_DISCLOSURES",
  MIDAS_LYT_VAULTS.map(([id]) => id),
  MIDAS_LYT_FEE_DISCLOSURES,
);


type MidasLytTermsGap = Required<
  Pick<RedemptionV9RouteReviewTerms, "missingScoringFields" | "rationale">
>;

const MIDAS_LYT_TERMS_GAPS: Partial<Record<string, MidasLytTermsGap>> = {
  "mf-one-midas": {
    missingScoringFields: ["capacity", "settlement"],
    rationale:
      "The reviewed standard-redemption fee is retained. At Ethereum block 26103201 on 2026-10-02, the official mF-ONE vault is unpaused but greenlist-gated, charges 100 bps for instant redemption, and can source USDC through its mTBILL holdings and the upstream mTBILL vault. Those balances and a 30-million-mToken daily limit do not prove executable capacity for an authorized holder at the scoring notional. The recovered issuer documentation describes a queued fallback without product-specific binding calendar-day settlement or holdback-release terms, so capacity and settlement remain withheld.",
  },
  "mhyper-midas": {
    missingScoringFields: ["capacity", "settlement"],
    rationale:
      "The captured fee and vault observations remain unchanged; daily limits alone are not funded capacity. Signed July 17, 2026 mHYPER terms specify one Business Day realisation plus five Business Days payment, a 23:59 CET/CEST cutoff and 15% per-settlement-day gate. Market-disruption valuation/payment deferrals and qualified subordination remain, so the six-business-day normal window is not an unconditional same-notional completion guarantee.",
  },
  "mmev-midas": {
    missingScoringFields: ["capacity", "settlement", "cost"],
    rationale:
      "The product was discontinued, and the reviewed materials checked on 2026-09-04 do not establish which residual mMEV route remains executable or its post-retirement capacity, settlement SLA, and all-in cost.",
  },
  "mapollo-midas": {
    missingScoringFields: ["capacity", "settlement"],
    rationale:
      "The reviewed standard-redemption fee is retained: the mAPOLLO Final Terms signed July 17, 2026 list Redemption Fees 0% and a separate 0.5% Instant Redemption Fee. The shared Midas liquidity architecture establishes a redemption mechanism, but the mAPOLLO materials publish no current executable capacity or binding calendar-day fallback SLA, so capacity and settlement remain withheld.",
  },
};
assertKnownTableKeys(
  "MIDAS_LYT_TERMS_GAPS",
  MIDAS_LYT_VAULTS.map(([id]) => id),
  MIDAS_LYT_TERMS_GAPS,
);


const MIDAS_LYT_CONFIGS: Record<string, RedemptionBackstopConfig> = Object.fromEntries(
  MIDAS_LYT_VAULTS.map(([id, ticker, productUrl]) => {
    const config = cloneRedemptionBackstopConfig(midasLytBase);
    const feeDisclosure = MIDAS_LYT_FEE_DISCLOSURES[id];
    config.costModel = feeDisclosure
      ? feeDisclosure.feeBpsMax === 0
        ? fixedFee(0, feeDisclosure.statement)
        : {
            ...documentedVariableFee(feeDisclosure.statement),
            feeBpsMax: feeDisclosure.feeBpsMax,
          }
      : undisclosedReviewedFee(
          `Midas token docs describe primary-market redemption through Midas rails; public materials reviewed do not publish one fixed ${ticker} redemption fee`,
        );
    config.docs = [
      sourceRefFull(`Midas ${ticker}`, productUrl),
      ...(feeDisclosure ? [sourceRef(feeDisclosure.label, feeDisclosure.url, ["fees"])] : []),
      ...config.docs!,
    ];
    const termsGap = MIDAS_LYT_TERMS_GAPS[id];
    if (termsGap) {
      config.v9RouteReviewTerms = {
        scoringDisposition: "bounded-terms-gap",
        missingScoringFields: termsGap.missingScoringFields,
        rationale: termsGap.rationale,
        reviewedAt: "2026-09-04",
        docs: [...config.docs],
      };
      if (id === "mhyper-midas" || id === "mmev-midas") {
        const calendarReview = midasBusinessDayReview(id === "mhyper-midas" ? 6 : 10);
        config.v9RouteReviewTerms = {
          ...config.v9RouteReviewTerms, ...calendarReview,
          docs: [...config.v9RouteReviewTerms.docs!, ...calendarReview.docs!],
        };
      }
    }
    config.notes = [
      `${ticker} is a NAV-accreting Midas strategy token, so the route is modeled as issuer/platform NAV redemption rather than stablecoin par liquidity.`,
    ];
    return [id, config];
  }),
);

/** Spiko fund redemptions share the same "deposits and withdrawals" doc plus the
 *  SICAV prospectus; USD/GBP funds reference the standard redemption-order API while
 *  the EUR funds reference the instant-redemption-order API. Each entry appends its
 *  own product-page ref (some funds lack one) before the prospectus. Returned as fresh
 *  arrays/objects so no doc reference is shared across entries. */
const spikoDepositsRef = () =>
  sourceRef(
    "Spiko deposits and withdrawals",
    "https://docs.spiko.io/documentation/account_management/deposits_withdrawals",
    ["route", "fees", "access", "settlement"],
  );
const spikoBaseDocs = () => [
  spikoDepositsRef(),
  sourceRef(
    "Spiko investor redemption API",
    "https://docs.spiko.io/developers/investor_api/reference/redemption-orders-create-redemption-order",
    ["route", "access", "settlement"],
  ),
];
const spikoEurBaseDocs = () => [
  spikoDepositsRef(),
  sourceRef(
    "Spiko instant redemption API",
    "https://docs.spiko.io/developers/investor_api/reference/redemption-orders-create-instant-redemption-order",
    ["route", "access", "settlement"],
  ),
];
const spikoProspectus = () =>
  sourceRef("Spiko SICAV prospectus", "https://cdn.spiko.finance/legal_docs/EN/Prospectus_Spiko_SICAV_EN.pdf", [
    "capacity",
    "fees",
    "access",
    "settlement",
  ]);
const spikoProspectusSettlementReview = (
  settlementDelaySec: number,
  settlementModel?: "same-day",
): RedemptionV9RouteReviewTerms => ({
  ...(settlementModel ? { settlementModel } : {}),
  settlementDelaySec,
  reviewedAt: "2026-07-29",
  docs: [
    sourceRef(
      "Spiko SICAV prospectus",
      "https://cdn.spiko.finance/legal_docs/EN/Prospectus_Spiko_SICAV_EN.pdf",
      ["route"],
    ),
  ],
});
const spikoCashAndCarrySettlementReview = (): RedemptionV9RouteReviewTerms => ({
  settlementDelaySec: 172_800,
  reviewedAt: "2026-08-11",
  docs: [
    sourceRef(
      "Spiko Cash & Carry product article",
      "https://www.spiko.io/blog/spiko-cash-carry-everything-you-need-to-know-about-our-new-product",
      ["route"],
    ),
  ],
});

const SPIKO_FEE_DISCLOSURES: Record<string, { statement: string; url: string }> = {
  "eutbl-spiko": {
    statement: "There are no exit costs for this Product. EUR 0",
    url: "https://cdn.spiko.finance/legal_docs/EN/KID_EUTBL_EN.pdf",
  },
  "eursafo-spiko": {
    statement: "No exit cost applies to this Product. 0 EUR",
    url: "https://cdn.spiko.finance/legal_docs/EN/KID_eurSAFO_EN.pdf",
  },
  "ustbl-spiko": {
    statement: "There are no exit costs for this Product. USD 0",
    url: "https://cdn.spiko.finance/legal_docs/EN/KID_USTBL_EN.pdf",
  },
  "safo-spiko-usd": {
    statement: "No exit costs apply to this Product. USD 0",
    url: "https://cdn.spiko.finance/legal_docs/EN/KID_SAFO_EN.pdf",
  },
  "gbpsafo-spiko": {
    statement: "No exit costs apply to this Product. GBP 0",
    url: "https://cdn.spiko.finance/legal_docs/EN/KID_gbpSAFO_EN.pdf",
  },
  "uktbl-spiko": {
    statement: "There are no exit costs applicable to this Product. GBP 0",
    url: "https://cdn.spiko.finance/legal_docs/EN/KID_UKTBL_EN.pdf",
  },
  "eurspkcc-spiko": {
    statement: "There are no exit costs for this Product. EUR 0",
    url: "https://cdn.spiko.finance/legal_docs/EN/KID_eurSPKCC_EN.pdf",
  },
  "spkcc-spiko": {
    statement: "There are no exit costs for this Product. USD 0",
    url: "https://cdn.spiko.finance/legal_docs/EN/KID_SPKCC_EN.pdf",
  },
};

/** Eight Spiko funds share the same issuer-API NAV-redemption base, product KID fee
 *  disclosure, and SICAV prospectus ref; EUR funds reference the instant-redemption API
 *  while USD/GBP funds reference the standard redemption API. Each fund appends its own
 *  product-page ref (some have none) and keeps its bespoke modeling note. */
const SPIKO_FUNDS: readonly [
  id: string,
  ticker: string,
  currency: "eur" | "non-eur",
  productRef: RedemptionDocSource | null,
  note: string,
  settlementReview: (() => RedemptionV9RouteReviewTerms) | null,
][] = [
  [
    "ustbl-spiko",
    "USTBL",
    "non-eur",
    null,
    "Modeled as account-gated fund-share redemption at NAV; cutoff times and bank rails make the backstop slower than on-chain stablecoin liquidity.",
    () => spikoProspectusSettlementReview(86_400, "same-day"),
  ],
  [
    "safo-spiko-usd",
    "SAFO",
    "non-eur",
    sourceRef("Spiko dollar fund", "https://www.spiko.io/spiko-dollar", ["capacity", "fees", "access"]),
    "Modeled as account-gated Spiko / Amundi fund-share redemption at NAV; cutoff times and bank rails make the backstop slower than on-chain stablecoin liquidity.",
    () => spikoProspectusSettlementReview(86_400, "same-day"),
  ],
  [
    "spkcc-spiko",
    "SPKCC",
    "non-eur",
    sourceRef("Spiko cash and carry fund", "https://www.spiko.io/spiko-cash-and-carry", ["capacity", "fees", "access"]),
    "Modeled as account-gated Spiko cash-and-carry fund-share redemption at NAV; cutoff times and bank rails make the backstop slower than on-chain stablecoin liquidity.",
    spikoCashAndCarrySettlementReview,
  ],
  [
    "uktbl-spiko",
    "UKTBL",
    "non-eur",
    sourceRef("Spiko UK Treasury bills fund", "https://www.spiko.io/spiko-treasury-bills-pound", [
      "capacity",
      "fees",
      "access",
    ]),
    "Modeled as account-gated GBP money-market fund-share redemption at NAV; cutoff times and bank rails make the backstop slower than on-chain stablecoin liquidity.",
    () => spikoProspectusSettlementReview(86_400, "same-day"),
  ],
  [
    "gbpsafo-spiko",
    "GBPSAFO",
    "non-eur",
    sourceRef("Spiko pound fund", "https://www.spiko.io/spiko-pound", ["capacity", "fees", "access"]),
    "Modeled as account-gated Spiko / Amundi GBP fund-share redemption at NAV; cutoff times and bank rails make the backstop slower than on-chain stablecoin liquidity.",
    () => ({
      settlementModel: "same-day",
      settlementDelaySec: 86_400,
      scoringDisposition: "bounded-terms-gap",
      missingScoringFields: ["capacity", "cost"],
      rationale:
        "The SICAV prospectus published 2026-09-01 specifies same-day NAV and settlement of redemption orders cleared by 11:30 a.m. Paris time, and its fee table lists no subscription or redemption fees. It also permits a redemption cap when net redemptions reach 10% of net assets, with deferred orders, so it is not a guaranteed stress-capacity lower bound; investor-paid DLT transaction fees and up to EUR 500 excluding VAT for technical wallet recovery leave all-in cost unbounded.",
      reviewedAt: "2026-09-04",
      docs: [
        sourceRef(
          "Spiko SICAV prospectus (published 2026-09-01)",
          "https://cdn.spiko.finance/legal_docs/EN/Prospectus_Spiko_SICAV_EN.pdf",
          ["route", "capacity", "settlement", "fees"],
        ),
        sourceRef(
          "Spiko GBPSAFO KID",
          "https://cdn.spiko.finance/legal_docs/EN/KID_gbpSAFO_EN.pdf",
          ["fees", "settlement"],
        ),
      ],
    }),
  ],
  [
    "eutbl-spiko",
    "EUTBL",
    "eur",
    null,
    "Modeled as account-gated fund-share redemption at NAV; instant withdrawals are eligibility-limited and standard withdrawals remain bank-rail dependent.",
    () => spikoProspectusSettlementReview(86_400, "same-day"),
  ],
  [
    "eursafo-spiko",
    "EURSAFO",
    "eur",
    sourceRef("Spiko euro fund", "https://www.spiko.io/spiko-euro", ["capacity", "fees", "access"]),
    "Modeled as account-gated Spiko / Amundi EUR fund-share redemption at NAV; instant withdrawals are eligibility-limited and standard withdrawals remain bank-rail dependent.",
    () => spikoProspectusSettlementReview(86_400, "same-day"),
  ],
  [
    "eurspkcc-spiko",
    "EURSPKCC",
    "eur",
    sourceRef("Spiko cash and carry fund", "https://www.spiko.io/spiko-cash-and-carry", ["capacity", "fees", "access"]),
    "Modeled as account-gated Spiko EUR cash-and-carry fund-share redemption at NAV; instant withdrawals are eligibility-limited and standard withdrawals remain bank-rail dependent.",
    spikoCashAndCarrySettlementReview,
  ],
];
assertExactTableKeys(
  "SPIKO_FEE_DISCLOSURES",
  SPIKO_FUNDS.map(([id]) => id),
  SPIKO_FEE_DISCLOSURES,
);


const SPIKO_FUND_CONFIGS: Record<string, RedemptionBackstopConfig> = Object.fromEntries(
  SPIKO_FUNDS.map(([id, ticker, currency, productRef, note, settlementReview]): [string, RedemptionBackstopConfig] => {
    const baseDocs = currency === "eur" ? spikoEurBaseDocs() : spikoBaseDocs();
    const feeDisclosure = SPIKO_FEE_DISCLOSURES[id];
    return [
      id,
      {
        ...issuerBase,
        ...documentedBoundSupplyFull(REVIEWED_STABLECOIN_AUDIT_AT),
        settlementModel: "days",
        outputAssetType: "nav",
        costModel: fixedFee(0, feeDisclosure.statement),
        ...(settlementReview ? { v9RouteReviewTerms: settlementReview() } : {}),
        docs: [
          ...baseDocs,
          ...(productRef ? [productRef] : []),
          sourceRef(`Spiko ${ticker} KID`, feeDisclosure.url, ["fees"]),
          spikoProspectus(),
        ],
        notes: [note],
      },
    ];
  }),
);

/** bIB01 and bC3M share these two Backed sourceRefs verbatim (the redemption docs and
 *  the product-structure page); each product keeps its own middle docRef, cost, and notes. */
const backedRedemptionRef = () =>
  sourceRefFull("Backed redemption docs", "https://docs.backed.fi/backed-platform/issuance-and-redemption/redemption");
const backedProductStructureRef = () =>
  sourceRef("Backed product structure", "https://assets.backed.fi/structure", ["capacity", "access"]);

export const COVERAGE_AND_STABLECOIN_AUDIT_OFFCHAIN_CONFIGS: Record<string, RedemptionBackstopConfig> = {
  "usdt-tether": {
    ...issuerBase,
    ...reviewedDirectRedemptionSupplyFull,
    reviewedAt: REVIEWED_MAJOR_ISSUER_REDEMPTION_AT,
    costModel: {
      ...documentedVariableFee("0.10% with a $1,000 minimum"),
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
  "bfusd-binance": {
    ...issuerBase,
    ...documentedBoundSupplyFull(REVIEWED_COVERAGE_EXPANSION_AT),
    settlementModel: "days",
    executionModel: "opaque",
    routeStatus: "open",
    costModel: documentedVariableFee(
      "Binance terms allow variable fees, delays, limits, and suspension rights for BFUSD purchase and redemption",
    ),
    docs: [
      sourceRef(
        "Binance BFUSD FAQ",
        "https://www.binance.com/en/support/faq/what-is-bfusd-and-how-to-get-started-with-bfusd-2bb2db6e81bd4958996307bb4b206d97",
        ["route", "access"],
      ),
      sourceRef(
        "Binance BFUSD product terms",
        "https://bin.bnbstatic.com/static/cms/cg08ou2ak0tn7mcplvfg/file/c1dd5e9f6a6191ca85b3cd256bd831884372530e3b4204b9006bf273650c6f5b.pdf",
        ["route", "capacity", "fees", "settlement"],
      ),
    ],
    notes: [
      "BFUSD is modeled as a Binance-account issuer route, not an on-chain token redemption path; Binance may delay or suspend redemption under its terms",
    ],
  },
  "pathusd-bridge": {
    ...issuerBase,
    ...documentedBoundSupplyFull(REVIEWED_COVERAGE_EXPANSION_AT),
    outputAssets: ["usdc-circle"],
    settlementModel: "same-day",
    routeStatus: "open",
    costModel: undisclosedReviewedFee(
      "Bridge-supported pathUSD exchange/redemption uses Bridge rails; public materials reviewed do not publish one fixed pathUSD redemption fee",
    ),
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
    v9RouteReviewTerms: { settlementModel: "queued" },
    costModel: undisclosedReviewedFee(
      "Monerium fee schedule and terms govern bank-transfer redemption; public materials reviewed do not publish a single fixed GBPe redemption fee",
    ),
    docs: [
      sourceRef(
        "Monerium business terms",
        "https://monerium.com/policies/business-terms-of-service/",
        ["route", "access", "settlement"],
      ),
      sourceRefFull("Monerium financial information", "https://monerium.com/financial-information/"),
      sourceRef("Monerium fee schedule", "https://monerium.com/fee-schedule/", ["fees"]),
    ],
    notes: ["Modeled as regulated e-money redemption for onboarded Monerium customers through bank-transfer rails"],
  },
  "qcad-stablecorp": {
    ...issuerBase,
    ...documentedBoundSupplyFull(REVIEWED_COVERAGE_EXPANSION_AT),
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
  "mre7yield-midas": {
    ...issuerBase,
    ...documentedBoundSupplyFull(REVIEWED_STABLECOIN_AUDIT_AT),
    settlementModel: "days",
    v9RouteReviewTerms: midasBusinessDayReview(10),
    outputAssetType: "nav",
    costModel: {
      ...documentedVariableFee("Tokenholder Fee 0.50 percent redemption fee and 10 percent interest fee"),
      feeBpsMax: 50,
    },
    docs: [
      sourceRefFull("Midas mRe7YIELD", "https://docs.midas.app/tokens/mre7yield"),
      sourceRef("Midas smart contracts", "https://docs.midas.app/protocol-mechanics/smart-contracts", [
        "route",
        "access",
      ]),
      sourceRef(
        "Midas mRe7YIELD Final Terms",
        "https://2732961456-files.gitbook.io/~/files/v0/b/gitbook-x-prod.appspot.com/o/spaces%2FsPjk0ggBxEJCCnVFFkDR%2Fuploads%2FYUqswmPoBMklqxjG6bwA%2FMidas_Final_Terms_mRE7YIELD_Update_2025.pdf?alt=media&token=d7c79079-7ed2-43a3-9eea-98250f51244a",
        ["fees"],
      ),
    ],
    notes: [
      "mRe7YIELD is a NAV-accreting strategy token, so the route is modeled as issuer/platform NAV redemption rather than same-day stablecoin par liquidity.",
    ],
  },
  ...MIDAS_LYT_CONFIGS,
  "benji-franklin-templeton": {
    ...issuerBase,
    ...documentedBoundSupplyFull(REVIEWED_STABLECOIN_AUDIT_AT),
    settlementModel: "days",
    costModel: undisclosedReviewedFee(
      "Franklin Templeton materials describe BENJI redemptions through the Benji app/platform; public materials reviewed do not publish one fixed redemption fee",
    ),
    docs: [
      sourceRefFull(
        "Franklin FOBXX prospectus",
        "https://www.franklintempleton.com/forms-literature/download-preview/9001-P",
      ),
      sourceRef(
        "Franklin FOBXX fund page",
        "https://www.franklintempleton.com/investments/options/money-market-funds/products/29380/SINGLCLASS/franklin-on-chain-u-s-government-money-fund/FOBXX",
        ["capacity", "access"],
      ),
      sourceRef("Benji app", "https://benji.franklintempleton.com/", ["route", "access"]),
    ],
    notes: [
      "Modeled as KYC-gated Benji platform redemption of fund shares, not as permissionless secondary-market liquidity.",
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
  "vbill-vaneck": {
    ...issuerBase,
    ...documentedBoundSupplyFull(REVIEWED_STABLECOIN_AUDIT_AT),
    outputAssetType: "nav",
    costModel: undisclosedReviewedFee(
      "Securitize materials describe VBILL subscription and redemption at fund NAV; public materials reviewed do not publish one fixed redemption fee",
    ),
    v9RouteReviewTerms: {
      scoringDisposition: "bounded-terms-gap",
      missingScoringFields: ["capacity", "settlement", "cost"],
      rationale:
        "The 2025-05-13 launch release and current Securitize VBILL page describe daily or real-time liquidity, but the 2026-09-04 re-open found no current dated governing terms for a guaranteed executable amount, maximum settlement SLA, or operative fee schedule; launch marketing is not a stress-capacity bound.",
      reviewedAt: "2026-09-04",
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
      ],
    },
    docs: [
      sourceRef("Securitize VBILL", "https://securitize.io/primary-market/vaneck-vbill", ["route", "access", "settlement"]),
      sourceRef(
        "VanEck VBILL launch (published 2025-05-13)",
        "https://www.prnewswire.com/news-releases/vaneck-launches-first-tokenized-fund-vbill-on-securitize-302453863.html",
        ["route", "access", "settlement"],
      ),
    ],
    notes: [
      "Modeled as qualified-investor Securitize primary-market redemption at NAV, not as secondary exchange liquidity.",
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
  "acrdx-anemoy-apollo": {
    ...issuerBase,
    ...documentedBoundSupplyFull(REVIEWED_STABLECOIN_AUDIT_AT),
    settlementModel: "queued",
    outputAssetType: "nav",
    costModel: fixedFee(
      0,
      "Anemoy's June 2026 ACRDX factsheet lists Entry/exit fees $0 for the USDC subscription/redemption rail. This is the issuer entry/exit fee only: brokerage, custody, banking, administration, audit, network gas and any separate stablecoin conversion or third-party charges are outside that zero. Quarterly repurchases remain queued and do not establish a completion SLA.",
    ),
    docs: [
      sourceRef("Anemoy ACRDX launch", "https://www.anemoy.io/news/acrdx-launched", [
        "route",
        "capacity",
        "access",
        "settlement",
      ]),
      sourceRefFull("RWA.xyz ACRDX profile", "https://app.rwa.xyz/assets/ACRDX"),
      sourceRef("Centrifuge investor docs", "https://docs.centrifuge.io/user/investor/", [
        "route",
        "access",
        "settlement",
      ]),
      sourceRef(
        "Anemoy ACRDX June 2026 factsheet, Key Facts (reviewed 2026-10-05)",
        "https://centrifuge-files.mypinata.cloud/ipfs/bafkreigpp4zkwecojcuipjnzyclrfgzaqe6tu5vedvujw6u73c3xfwbx5m",
        ["route", "fees"],
      ),
    ],
    notes: [
      "Modeled as qualified-investor NAV redemption through the Anemoy / Centrifuge issuer rail, mirroring the Apollo credit fund template while preserving queued private-credit settlement risk.",
    ],
  },
  ...SPIKO_FUND_CONFIGS,
  "stac-securitize": {
    ...issuerBase,
    ...documentedBoundSupplyFull(REVIEWED_STABLECOIN_AUDIT_AT),
    settlementModel: "queued",
    outputAssetType: "nav",
    costModel: undisclosedReviewedFee(
      "Securitize materials describe STAC subscriptions and redemptions at fund NAV; public materials reviewed do not publish one fixed STAC redemption fee",
    ),
    docs: [
      sourceRefFull("Securitize STAC", "https://securitize.io/primary-market/Securitize-BNY-CLO-Fund"),
      sourceRef(
        "Securitize STAC launch",
        "https://securitize.io/learn/press/Securitize-Launches-Tokenized-AAA-CLO-Fund-with-BNY",
        ["route", "capacity", "access", "settlement"],
      ),
    ],
    notes: [
      "Modeled as qualified-investor Securitize primary-market redemption at NAV, not as secondary exchange liquidity.",
    ],
  },
  "hlscope-hamilton-lane": {
    ...issuerBase,
    ...documentedBoundSupplyFull(REVIEWED_STABLECOIN_AUDIT_AT),
    settlementModel: "queued",
    outputAssetType: "nav",
    costModel: undisclosedReviewedFee(
      "Securitize / Hamilton Lane materials describe SCOPE feeder-fund redemption features; public materials reviewed do not publish one fixed HLSCOPE redemption fee",
    ),
    docs: [
      sourceRefFull("Securitize HLSCOPE", "https://securitize.io/primary-market/hl-scope"),
      sourceRef(
        "Hamilton Lane SCOPE via Securitize",
        "https://www.hamiltonlane.com/en-us/news/scope-available-via-securitize",
        ["route", "capacity", "access", "settlement"],
      ),
    ],
    notes: [
      "Modeled as a Securitize client redemption route for qualified Hamilton Lane SCOPE feeder-fund investors, preserving private-credit feeder settlement and access limits.",
    ],
  },
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
  "bc3m-backed": {
    ...issuerBase,
    ...documentedBoundSupplyFull(REVIEWED_STABLECOIN_AUDIT_AT),
    settlementModel: "days",
    outputAssetType: "nav",
    costModel: fixedFee(50, "Backed lists a 0.5% issuance/redemption fee for bC3M"),
    docs: [
      backedRedemptionRef(),
      sourceRef("Backed bC3M product", "https://assets.backed.fi/products/bc3m", ["capacity", "fees", "access"]),
      backedProductStructureRef(),
    ],
    notes: [
      "Modeled as Backed primary-market redemption for approved customers; bC3M remains a EUR-denominated NAV tracker rather than a euro stablecoin cash claim.",
    ],
  },
  "cadd-cad-digital": {
    ...issuerBase,
    ...documentedBoundSupplyFull(REVIEWED_STABLECOIN_AUDIT_AT),
    routeStatus: "open",
    costModel: {
      ...documentedVariableFee("Greater of C$50 or 0.25% of gross redemption proceeds, plus applicable taxes"),
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
    ],
    notes: ["Modeled as institutional BitGo/SoFi issuer redemption, not a retail self-service on-chain burn path."],
  },
};
