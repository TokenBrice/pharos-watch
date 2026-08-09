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

export function buildPharosOrganizationNode() {
  return PHAROS_ORG_NODE;
}

type JsonLdNode = Record<string, unknown>;

const SCHEMA_CONTEXT = "https://schema.org";

const PHAROS_ORG_REF = { "@id": `${SITE_URL}#organization` } as const;
const PHAROS_PERSON_REF = { "@id": `${SITE_URL}#person-tokenbrice` } as const;

export interface CollectionItemListJsonLdOptions {
  /** Absolute page URL, e.g. `${SITE_URL}/cemetery/`. */
  url: string;
  name: string;
  description?: string;
  /** Defaults to `${url}#collection`. */
  collectionId?: string;
  /** Defaults to `${url}#itemlist`. */
  itemListId?: string;
  /** Defaults to `name`. */
  itemListName?: string;
  itemListDescription?: string;
  itemListOrder?: string;
  inLanguage?: string;
  about?: JsonLdNode;
  datePublished?: string;
  dateModified?: string;
  /** Defaults to `entries.length`. */
  numberOfItems?: number;
  /**
   * Per-page mapped entries. Each object is merged into a `ListItem` wrapper
   * that supplies `@type` and `position`, so callers keep their own item shape
   * (`{ item: {...} }` for nested nodes, flat `name`/`url` for link indexes).
   */
  entries: readonly JsonLdNode[];
}

/**
 * Build the paired `CollectionPage` + `ItemList` nodes every Pharos hub route
 * emits. The `ItemList` is a sibling node referenced by `mainEntity` (rather
 * than nested), which is what the majority of hubs already did and what the
 * chain-profile structured-data tests pin.
 */
export function buildCollectionItemListJsonLd({
  url,
  name,
  description,
  collectionId = `${url}#collection`,
  itemListId = `${url}#itemlist`,
  itemListName = name,
  itemListDescription,
  itemListOrder,
  inLanguage,
  about,
  datePublished,
  dateModified,
  numberOfItems,
  entries,
}: CollectionItemListJsonLdOptions): [JsonLdNode, JsonLdNode] {
  return [
    {
      "@context": SCHEMA_CONTEXT,
      "@type": "CollectionPage",
      "@id": collectionId,
      name,
      ...(description ? { description } : {}),
      url,
      ...(inLanguage ? { inLanguage } : {}),
      isPartOf: { "@id": `${SITE_URL}#website` },
      mainEntity: { "@id": itemListId },
      ...(about ? { about } : {}),
      ...(datePublished ? { datePublished } : {}),
      ...(dateModified ? { dateModified } : {}),
    },
    {
      "@context": SCHEMA_CONTEXT,
      "@type": "ItemList",
      "@id": itemListId,
      name: itemListName,
      ...(itemListDescription ? { description: itemListDescription } : {}),
      ...(itemListOrder ? { itemListOrder } : {}),
      numberOfItems: numberOfItems ?? entries.length,
      itemListElement: entries.map((entry, index) => ({
        "@type": "ListItem",
        position: index + 1,
        ...entry,
      })),
    },
  ];
}

export type ArticleJsonLdType = "Article" | "BlogPosting" | "NewsArticle" | "TechArticle";

export interface ArticleJsonLdOptions {
  /** Schema.org Article subtype. Defaults to `Article`. */
  type?: ArticleJsonLdType;
  additionalType?: string;
  /** Node `@id`; omitted when absent. */
  id?: string;
  headline: string;
  description?: string;
  /** Absolute canonical URL of the page carrying the article. */
  mainEntityOfPage: string;
  /** Emitted as `url` when the node is also addressable on its own. */
  url?: string;
  image?: string | readonly string[];
  datePublished?: string;
  dateModified?: string;
  /**
   * Which Pharos node is credited as author. Both resolve to `@id` references
   * into the site-wide graph emitted by the root layout — never inline
   * duplicates of the Organization/Person nodes.
   */
  author?: "organization" | "person";
  keywords?: readonly string[];
  identifier?: readonly unknown[];
  inLanguage?: string;
  /** Long-tail fields owned by a single caller (citations, wordCount, …). */
  extra?: JsonLdNode;
}

/**
 * Build an Article-family node with the Pharos author/publisher graph wired by
 * reference. Article nodes never inline the Organization literal — the
 * canonical node ships once from the root layout (Dataset nodes are the
 * documented exception, see docs/architecture.md).
 */
export function buildArticleJsonLd({
  type = "Article",
  additionalType,
  id,
  headline,
  description,
  mainEntityOfPage,
  url,
  image,
  datePublished,
  dateModified,
  author = "organization",
  keywords,
  identifier,
  inLanguage,
  extra,
}: ArticleJsonLdOptions): JsonLdNode {
  return {
    "@context": SCHEMA_CONTEXT,
    "@type": type,
    ...(additionalType ? { additionalType } : {}),
    ...(id ? { "@id": id } : {}),
    headline,
    ...(description ? { description } : {}),
    ...(url ? { url } : {}),
    mainEntityOfPage,
    ...(image ? { image } : {}),
    ...(datePublished ? { datePublished } : {}),
    ...(dateModified ? { dateModified } : {}),
    author: author === "person" ? PHAROS_PERSON_REF : PHAROS_ORG_REF,
    publisher: PHAROS_ORG_REF,
    ...(inLanguage ? { inLanguage } : {}),
    ...(keywords ? { keywords } : {}),
    ...(identifier ? { identifier } : {}),
    ...extra,
  };
}
