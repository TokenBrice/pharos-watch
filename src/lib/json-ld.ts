import { SITE_ORIGIN as SITE_URL } from "@shared/lib/runtime-origins";
import { TELEGRAM_BOT_URL } from "@shared/lib/telegram-bot-registration";

/**
 * Escapes JSON-LD strings for safe embedding inside <script type="application/ld+json">.
 *
 * - `<` and `>` prevent malicious payloads from injecting parent script tags.
 * - `/` prevents `</script>` from terminating the JSON-LD block (the HTML parser
 *   does not know it is inside JSON, only that it is inside a <script> element).
 */
export function safeJsonLd(data: Record<string, unknown> | Record<string, unknown>[]): string {
  return JSON.stringify(data)
    .replace(/</g, "\\u003c")
    .replace(/>/g, "\\u003e")
    .replace(/\//g, "\\u002f");
}

const PHAROS_SITE_DESCRIPTION =
  "Pharos tracks stablecoins across supported chains with depeg alerts, liquidity scores, on-chain safety signals, dependency-risk scoring, and report-card-style risk summaries.";

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
  logo: `${SITE_URL}/pharos-mark.png`,
  description: PHAROS_SITE_DESCRIPTION,
  foundingDate: "2026-01-29",
  sameAs: [
    "https://x.com/PharosWatch",
    "https://github.com/TokenBrice/pharos-watch",
    "https://t.me/pharoswatch",
    TELEGRAM_BOT_URL,
    "https://t.me/pharoswatchers",
    "https://pharosville.pharos.watch/",
    "https://farcaster.xyz/tokenbrice",
  ],
  contactPoint: [
    {
      "@type": "ContactPoint",
      contactType: "corrections and data issues",
      url: "https://github.com/TokenBrice/pharos-watch/issues",
      availableLanguage: "en",
    },
    {
      "@type": "ContactPoint",
      contactType: "community and alerts",
      url: "https://t.me/pharoswatch",
      availableLanguage: "en",
    },
  ],
  ethicsPolicy: `${SITE_URL}/about/#principles`,
  correctionsPolicy: `${SITE_URL}/about/#corrections-policy`,
  funding: {
    "@type": "Grant",
    "@id": `${SITE_URL}/funding/#community-support`,
    name: "Pharos community funding ledger",
    url: `${SITE_URL}/funding/`,
    description:
      "Community support and future paid API access for heavy programmatic usage keep Pharos freely accessible.",
  },
  founder: { "@id": `${SITE_URL}#person-tokenbrice` },
} as const;

export function buildPharosOrganizationNode(siteUrl: string = SITE_URL) {
  if (siteUrl === SITE_URL) return PHAROS_ORG_NODE;

  return {
    ...PHAROS_ORG_NODE,
    "@id": `${siteUrl}#organization`,
    url: siteUrl,
    logo: `${siteUrl}/pharos-mark.png`,
    ethicsPolicy: `${siteUrl}/about/#principles`,
    correctionsPolicy: `${siteUrl}/about/#corrections-policy`,
    funding: {
      ...PHAROS_ORG_NODE.funding,
      "@id": `${siteUrl}/funding/#community-support`,
      url: `${siteUrl}/funding/`,
    },
    founder: { "@id": `${siteUrl}#person-tokenbrice` },
  };
}
