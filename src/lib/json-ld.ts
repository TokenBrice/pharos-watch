import { SITE_ORIGIN as SITE_URL } from "@shared/lib/runtime-origins";

/** Safely serialize data for embedding in a <script type="application/ld+json"> tag. */
export function safeJsonLd(data: Record<string, unknown> | Record<string, unknown>[]): string {
  return JSON.stringify(data)
    .replace(/</g, "\\u003c")
    .replace(/>/g, "\\u003e")
    .replace(/\//g, "\\u002f");
}

const PHAROS_SITE_DESCRIPTION =
  "Pharos tracks stablecoins across major chains with depeg alerts, liquidity scores, on-chain safety signals, dependency-risk scoring, and report-card-style risk summaries.";

export const PHAROS_PERSON_TOKENBRICE_NODE = {
  "@type": "Person",
  "@id": `${SITE_URL}#person-tokenbrice`,
  name: "TokenBrice",
  url: "https://tokenbrice.xyz",
  image: `${SITE_URL}/tokenbrice.png`,
  sameAs: [
    "https://x.com/TokenBrice",
    "https://github.com/TokenBrice",
    "https://farcaster.xyz/tokenbrice",
  ],
  knowsAbout: ["stablecoins", "DeFi risk", "tokenomics", "pegged assets", "on-chain analytics"],
  affiliation: { "@id": `${SITE_URL}#organization` },
} as const;

export const PHAROS_ORG_NODE = {
  "@type": "Organization",
  "@id": `${SITE_URL}#organization`,
  name: "Pharos",
  url: SITE_URL,
  logo: `${SITE_URL}/pharos-icon.png`,
  description: PHAROS_SITE_DESCRIPTION,
  sameAs: [
    "https://x.com/PharosWatch",
    "https://github.com/TokenBrice/stablecoin-dashboard",
    "https://t.me/pharoswatch",
    "https://t.me/PharosWatchBot",
    "https://t.me/pharoswatchers",
  ],
  founder: { "@id": `${SITE_URL}#person-tokenbrice` },
} as const;
