import { defineBatch, type RedemptionBackstopRegistryEntry } from "../factory";
import { documentedBoundSupplyFull, documentedVariableFee, issuerBase, sourceRef } from "../shared";
import { reviewedDirectRedemptionSupplyFull, REVIEWED_NON_USD_BATCH_AT, REVIEWED_REMEDIATION_AT } from "./shared";

const SOURCE_FILE_PATH = "shared/lib/redemption-backstop-configs/offchain-issuer/base-batches.ts";

type RedemptionDocs = NonNullable<RedemptionBackstopRegistryEntry["config"]["docs"]>;

const DOCUMENTED_BOUND_SOURCE_REFS: Partial<Record<string, RedemptionDocs>> = {
  "a7a5-old-vector": [
    sourceRef("A7A5 Official", "https://www.a7a5.io/", ["capacity"]),
    sourceRef("A7A5 FAQ", "https://docs.a7a5.io/help/faq", ["route", "access"]),
    sourceRef("A7A5 transparency", "https://docs.a7a5.io/legal/transparency", ["capacity"]),
  ],
  "audx-aussie-dollar-token": [
    sourceRef("AUDX", "https://www.audxtoken.com/", ["route", "capacity", "fees", "settlement"]),
  ],
  "brl1-brl1": [sourceRef("BRL1 how it works", "https://brl1.io/en/como_funciona", ["route", "capacity", "access"])],
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
    sourceRef("Telcoin Digital Asset Bank terms", "https://bank.telco.in/terms-of-use", [
      "route",
      "capacity",
      "fees",
      "access",
      "settlement",
    ]),
  ],
  "gusd-gate": [sourceRef("Gate GUSD", "https://www.gate.com/gusd", ["route", "capacity"])],
  "reur-royal-euro": [sourceRef("REUR", "https://www.rcoins.digital/REUR.html", ["route", "capacity", "access"])],
  "rusd-royal-dollar": [sourceRef("RUSD", "https://www.rcoins.digital/RUSD.html", ["route", "capacity", "access"])],
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
    sourceRef("ZARP Stablecoin", "https://www.zarpstablecoin.com/", ["route", "capacity"]),
    sourceRef("ZARP partners", "https://docs.zarpstablecoin.com/zarp-stablecoin/zarp-partners", ["route", "access"]),
    sourceRef("ZARP transparency", "https://www.zarpstablecoin.com/transparency/", ["route", "capacity"]),
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
        sourceRef("Brale MXNe", "https://brale.xyz/stablecoins/MXNe", [
          "route",
          "capacity",
          "fees",
          "access",
          "settlement",
        ]),
        sourceRef(
          "Etherfuse MXNe launch",
          "https://www.etherfuse.com/blogs/etherfuse-r-introduces-real-mxn-mxne-stablecoin-on-solana-base-and-stellar",
          ["route", "capacity"],
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
        sourceRef("Ripio local stablecoins", "https://www.ripio.com/en/cryptos/local-stablecoins", [
          "route",
          "capacity",
          "fees",
          "access",
          "settlement",
        ]),
      ],
      notes: [
        "Reviewed as a heuristic issuer route because current tracked materials describe 1:1 local-currency backing and selected attestations, but do not publish a hard immediate redemption-capacity source for all five Ripio wFIAT entries.",
      ],
    },
    { sourceFilePath: SOURCE_FILE_PATH },
  ),
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
        "kgst-kyrgyz-som",
        "reur-royal-euro",
        "wars-argentine-peso",
        "eusd-telcoin",
        "jpyc-jpyc-v1",
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
            costModel: {
              ...documentedVariableFee("Redemption fee 0.03%"),
              feeBpsMax: 3,
            },
          }
        : entry.config,
    overrideReason: "Direct-redemption review cohort upgrades issuer defaults to documented-bound capacity.",
  })),
];
