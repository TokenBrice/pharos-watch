import { defineBatch, type RedemptionBackstopRegistryEntry } from "../factory";
import {
  documentedBoundSupplyFull,
  documentedVariableFee,
  fixedFee,
  issuerBase,
  sourceRef,
  sourceRefFull,
  sourceRefRouteCapacity,
  sourceRefRouteCapacityAccess,
  sourceRefRouteCapacityFees,
} from "../shared";
import { reviewedDirectRedemptionSupplyFull, REVIEWED_NON_USD_BATCH_AT, REVIEWED_REMEDIATION_AT } from "./shared";

const SOURCE_FILE_PATH = "shared/lib/redemption-backstop-configs/offchain-issuer/base-batches.ts";

type RedemptionDocs = NonNullable<RedemptionBackstopRegistryEntry["config"]["docs"]>;
type RedemptionV9RouteReviewTerms = NonNullable<
  RedemptionBackstopRegistryEntry["config"]["v9RouteReviewTerms"]
>;

const WARS_BOUNDED_TERMS_GAP: RedemptionV9RouteReviewTerms = {
  scoringDisposition: "bounded-terms-gap",
  missingScoringFields: ["capacity", "settlement", "cost"],
  rationale:
    "Ripio documents the 1:1 local-currency mechanism, but the current page's dated 2026-03-31 wARS attestation is reserve evidence rather than an executable capacity, bank settlement SLA, or all-in redemption-cost term; the 2026-09-04 review found no newer binding terms.",
  reviewedAt: "2026-09-04",
  docs: [
    sourceRef("Ripio local stablecoins", "https://www.ripio.com/en/cryptos/local-stablecoins", ["route", "access"]),
    sourceRef(
      "Independent public accountant certification for wARS (published 2026-03-31)",
      "https://action.ripio.com/hubfs/2026/wFIAT/ATTESTATION/20260331_wARS_Certification.pdf",
    ),
  ],
};

const DOCUMENTED_BOUND_SOURCE_REFS: Partial<Record<string, RedemptionDocs>> = {
  "a7a5-old-vector": [
    sourceRef("A7A5 Official", "https://www.a7a5.io/", ["capacity"]),
    sourceRef("A7A5 FAQ", "https://docs.a7a5.io/help/faq", ["route", "access"]),
    sourceRef("A7A5 transparency", "https://docs.a7a5.io/legal/transparency", ["capacity"]),
  ],
  "audx-aussie-dollar-token": [
    sourceRefFull(
      "AUDX White Paper v1.8 and Terms of Token Sale",
      "https://www.audxtoken.com/_files/ugd/539754_29d0472241a840e6a2fb2c58512c50d7.pdf",
    ),
  ],
  "brl1-brl1": [sourceRefRouteCapacityAccess("BRL1 how it works", "https://brl1.io/en/como_funciona")],
  "cetes-etherfuse": [
    sourceRef("Etherfuse PoR", "https://app.etherfuse.com/legal/proof-of-reserves", ["capacity"]),
    sourceRef("Etherfuse Stablebonds overview", "https://docs.etherfuse.com/stablebonds/cetes-or-mexico", [
      "route",
      "capacity",
      "fees",
      "access",
    ]),
    sourceRef("Etherfuse Ramp orders", "https://docs.etherfuse.com/api-reference/orders/create-a-new-order", [
      "route",
      "access",
      "settlement",
    ]),
  ],
  "cngn-compliant-naira": [
    sourceRef("cNGN terms and conditions", "https://cngn.co/terms-and-condition", [
      "route",
      "capacity",
      "fees",
      "access",
    ]),
  ],
  "eusd-telcoin": [
    sourceRefFull("Telcoin Digital Asset Bank terms", "https://bank.telco.in/terms-of-use"),
  ],
  "gusd-gate": [
    sourceRef("Gate GUSD product", "https://www.gate.com/staking/USDT?isDebtType=1&pid=33", [
      "route",
      "fees",
      "access",
      "settlement",
    ]),
    sourceRefFull("Gate GUSD minting and redemption guide", "https://www.gate.com/help/lend/staking/46831"),
    sourceRef(
      "Gate GUSD Flexible US Treasury upgrade announcement (2026-07-27)",
      "https://www.gate.com/announcements/article/100840",
      ["route", "fees", "access", "settlement"],
    ),
    sourceRefRouteCapacityFees("Gate GUSD overview", "https://www.gate.com/gusd"),
    sourceRef(
      "Gate Learn GUSD redemption fees (last updated 2026-03-29; reviewed 2026-10-03)",
      "https://www.gate.com/learn/articles/gusd-redemption-flexible-exit-options-for-stable-and-transparent-yield/11559",
      ["fees", "settlement"],
    ),
  ],
  "reur-royal-euro": [sourceRefRouteCapacityAccess("REUR", "https://www.rcoins.digital/REUR.html")],
  "rusd-royal-dollar": [sourceRefRouteCapacityAccess("RUSD", "https://www.rcoins.digital/RUSD.html")],
  "usyc-hashnote": [
    sourceRef("Hashnote", "https://usyc.hashnote.com/", ["capacity"]),
    sourceRef(
      "USYC subscription and redemption",
      "https://usyc.docs.hashnote.com/overview/subscription-and-redemption",
      ["route", "access", "settlement"],
    ),
    sourceRef("USYC product structuring", "https://usyc.docs.hashnote.com/overview/product-structuring", [
      "route",
      "capacity",
      "access",
      "settlement",
    ]),
    sourceRef("Circle USYC", "https://www.circle.com/usyc", ["capacity", "fees", "access", "settlement"]),
  ],
  "wars-argentine-peso": [
    sourceRef("Ripio local stablecoins", "https://www.ripio.com/en/cryptos/local-stablecoins", [
      "route",
      "capacity",
      "fees",
      "access",
    ]),
  ],
  "zarp-zarp": [
    sourceRefRouteCapacity("ZARP Stablecoin", "https://www.zarpstablecoin.com/"),
    sourceRef("ZARP partners", "https://docs.zarpstablecoin.com/zarp-stablecoin/zarp-partners", ["route", "access"]),
    sourceRefRouteCapacity("ZARP transparency", "https://www.zarpstablecoin.com/transparency/"),
  ],
} satisfies Partial<Record<string, RedemptionDocs>>;

function addDocumentedBoundSourceRefs(entries: RedemptionBackstopRegistryEntry[]): RedemptionBackstopRegistryEntry[] {
  return entries.map((entry) => {
    const docs = DOCUMENTED_BOUND_SOURCE_REFS[entry.id];
    if (!docs) return entry;
    return {
      ...entry,
      config: {
        ...entry.config,
        docs,
      },
    };
  });
}

export const BASE_OFFCHAIN_ISSUER_ENTRIES: RedemptionBackstopRegistryEntry[] = [
  ...defineBatch(
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
      "vchf-vnx",
      "vgbp-vnx",
      "audd-novatti",
      "axcnh-anchorx",
      "cash-phantom",
      "musd-metamask",
      "a7a5-old-vector",
      "ylds-figure",
      "usat-tether",
      "usdtb-ethena",
      "pusd-plume",
      "gusd-gate",
      "usyc-hashnote",
      "usdn-noble",
      "reur-royal-euro",
      "kgst-kyrgyz-som",
      "audx-aussie-dollar-token",
      "cngn-compliant-naira",
      "brl1-brl1",
      "wars-argentine-peso",
    ],
    issuerBase,
    { sourceFilePath: SOURCE_FILE_PATH },
  ),
  ...defineBatch(
    ["mxne-real-mxn"],
    {
      ...issuerBase,
      ...documentedBoundSupplyFull("2026-05-17"),
      docs: [
        sourceRefFull("Brale MXNe", "https://brale.xyz/stablecoins/MXNe"),
        sourceRefRouteCapacity(
          "Etherfuse MXNe launch",
          "https://www.etherfuse.com/blogs/etherfuse-r-introduces-real-mxn-mxne-stablecoin-on-solana-base-and-stellar",
        ),
      ],
    },
    { sourceFilePath: SOURCE_FILE_PATH },
  ),
  ...defineBatch(
    ["wbrl-ripio", "wclp-ripio", "wcop-ripio", "wpen-ripio", "wmxn-ripio"],
    {
      ...issuerBase,
      reviewedAt: "2026-05-17",
      docs: [
        sourceRefFull("Ripio local stablecoins", "https://www.ripio.com/en/cryptos/local-stablecoins"),
      ],
      notes: [
        "Reviewed as a heuristic issuer route because current tracked materials describe 1:1 local-currency backing and selected attestations, but do not publish a hard immediate redemption-capacity source for all five Ripio wFIAT entries.",
      ],
    },
    { sourceFilePath: SOURCE_FILE_PATH },
  ),
  // JPYC Prepaid v1 is deliberately excluded. The issuer's current notice
  // (re-read 2026-10-01) ends v1-to-v2 exchange and says cash refunds are not
  // planned; the separately tracked funds-transfer JPYC route is not this token.
  // https://corporate.jpyc.co.jp/news/posts/prepaid-important-notice
  ...defineBatch(
    ["kgst-kyrgyz-som"],
    {
      ...issuerBase,
      capacityModel: {
        kind: "supply-full",
        confidence: "heuristic",
      },
      holderEligibility: "unknown",
      routeStatus: "unknown",
      reviewedAt: REVIEWED_NON_USD_BATCH_AT,
      notes: [
        "Current primary issuer materials do not establish an ordinary-holder redemption route or a full-supply redemption obligation, so the route and capacity remain heuristic and unverified.",
      ],
    },
    { sourceFilePath: SOURCE_FILE_PATH },
  ).map((entry) => ({
    ...entry,
    overrideReason: "Primary-terms review downgrades unsupported documented-bound route and capacity claims.",
  })),
  ...addDocumentedBoundSourceRefs(
    defineBatch(
      ["zarp-zarp", "cetes-etherfuse"],
      {
        ...issuerBase,
        ...documentedBoundSupplyFull(REVIEWED_REMEDIATION_AT),
      },
      { sourceFilePath: SOURCE_FILE_PATH },
    ),
  ).map((entry) => ({
    ...entry,
    overrideReason: "Remediation review upgrades offchain issuer default to documented-bound capacity.",
  })),
  ...addDocumentedBoundSourceRefs(
    defineBatch(
      [
        "audx-aussie-dollar-token",
        "brl1-brl1",
        "cngn-compliant-naira",
        "reur-royal-euro",
        "wars-argentine-peso",
        "eusd-telcoin",
        "rusd-royal-dollar",
      ],
      {
        ...issuerBase,
        ...documentedBoundSupplyFull(REVIEWED_NON_USD_BATCH_AT),
      },
      { sourceFilePath: SOURCE_FILE_PATH },
    ),
  ).map((entry) => ({
    ...entry,
    config:
      entry.id === "audx-aussie-dollar-token"
        ? {
            ...entry.config,
            costModel: fixedFee(100, "AUDX Terms of Token Sale specify a 1% redemption fee"),
            v9RouteReviewTerms: { settlementModel: "days" as const },
          }
        : entry.id === "wars-argentine-peso"
          ? {
              ...entry.config,
              v9RouteReviewTerms: WARS_BOUNDED_TERMS_GAP,
            }
          : entry.id === "eusd-telcoin"
            ? {
                ...entry.config,
                costModel: fixedFee(
                  0,
                  "Telcoin Digital Asset Bank terms (dated 2026-06-15; reviewed 2026-10-03): no TDAB fee per eUSD redemption to third-party institutions. This is the issuer fee only; the receiving institutions may impose their own unquantified fees",
                ),
              }
            : entry.config,
    overrideReason: "Non-USD review cohort upgrades issuer defaults to documented-bound capacity.",
  })),
  ...addDocumentedBoundSourceRefs(
    defineBatch(
      ["usyc-hashnote", "a7a5-old-vector", "gusd-gate"],
      {
        ...issuerBase,
        ...reviewedDirectRedemptionSupplyFull,
      },
      { sourceFilePath: SOURCE_FILE_PATH },
    ),
  ).map((entry) => ({
    ...entry,
    config:
      entry.id === "usyc-hashnote"
        ? {
            ...entry.config,
            outputAssets: ["usdc-circle"],
            notes: [
              "Payout identity reviewed 2026-09-30: https://usyc.docs.hashnote.com/overview/subscription-and-redemption specifies that the modeled USYC Teller burns USYC and returns USDC; Private Liquidity Teller terms are separate.",
            ],
            costModel: {
              ...documentedVariableFee("Redemption fee 0.03%"),
              feeBpsMax: 3,
            },
          }
        : entry.id === "gusd-gate"
          ? {
              ...entry.config,
              ...documentedBoundSupplyFull("2026-08-18"),
              // Keep this wording clear of the `feeDescriptionLooksUndisclosed`
              // trigger list in ../shared.ts. The fee-free quota makes the
              // charge variable, so the model stays `documented-variable` with
              // Gate's published fast-redemption fee as the ceiling.
              costModel: {
                ...documentedVariableFee(
                  "Gate Learn (last updated 2026-03-29) prices GUSD redemption to USDC at 0.05% for standard redemption (credited D+3) and 0.1% for fast redemption (typically within 10 minutes). The modeled same-day route is the fast path, so the 10 bps fast fee is the ceiling; the July 2026 per-currency fee-free exit quota in the original subscription asset can lower the charge to zero, and the current authenticated redemption page remains the controlling quote",
                ),
                feeBpsMin: 0,
                feeBpsMax: 10,
              },
              notes: [
                "Gate's 2026-07-27 GUSD upgrade announcement advertises instant credit, and the help centre states fast redemption is typically credited within 5 minutes. Settlement is nonetheless retained at same-day because the current product-page FAQ defers the actual arrival time to the authenticated redemption page and documents a standard redemption path credited on D+3, so no public SLA bounds the full-supply capacity this route models.",
                "The 1:1 fee-free exit is conditional: it applies only in the original subscription asset and only within a per-currency fee-free exit quota whose size Gate has not published. The quota applies to both fast and standard redemption, so it bounds cost rather than speed.",
                "Access is Gate-account-internal and jurisdiction-gated: the announcement states that users in the UK and other restricted regions cannot access the service.",
                "Fee ceiling reviewed 2026-10-03 against Gate Learn's GUSD redemption article: 0.05% standard (D+3) and 0.1% fast. Pharos binds the 10 bps fast fee because this route keeps same-day settlement; pairing the cheaper standard fee with same-day settlement would mix the two exits.",
              ],
            }
        : entry.config,
    overrideReason: "Direct-redemption review cohort upgrades issuer defaults to documented-bound capacity.",
  })),
];
