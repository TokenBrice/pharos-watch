import type { Metadata } from "next";
import sitemapDates from "@/generated/sitemap-dates.json";
import {
  BACKING_PROSE_LABELS,
  GOVERNANCE_PROSE_LABELS,
  PEG_LABELS_SHORT,
  getProfilePegLabel,
  getMechanismArchetypeLabel,
  getMechanismArchetypeOneLiner,
  getMechanismExplainerPath,
} from "@shared/lib/classification";
import { API_ORIGIN, SITE_ORIGIN } from "@shared/lib/runtime-origins";
import { API_PATHS } from "@shared/lib/api-endpoints";
import { TRACKED_META_BY_ID } from "@shared/lib/stablecoins/registry";
import { PUBLIC_DOC_BY_SLUG } from "@shared/lib/public-docs";
import { getGeneratedMarkdownAssetPath } from "@shared/lib/markdown-route-policy";
import { METHODOLOGY_CHANGELOG_SITEMAP_PATHS } from "@shared/lib/methodology-versions/registry";
import { MECHANISM_ARCHETYPE_VALUES } from "@shared/types/core";
import type { MechanismArchetype, StablecoinMeta } from "@shared/types";
import { getResolvedBlacklistStatus } from "@/lib/blacklist-status";
import { DIGEST_DATES } from "@/lib/digest-registry";
import { buildStablecoinUrl } from "@shared/lib/urls";

interface BuildPageMetadataInput {
  title: string;
  description: string;
  canonical: string;
  ogImage?: string;
  ogWidth?: number;
  ogHeight?: number;
  robots?: Metadata["robots"];
  /**
   * Emit `title` as `{ absolute }`, bypassing the root `"%s | Pharos"`
   * template. Only for pages whose title already carries the brand.
   */
  titleAbsolute?: boolean;
  /** Open Graph object type. Defaults to `"website"`. */
  ogType?: "website" | "article";
  /** `og:article:published_time`; requires `ogType: "article"`. */
  publishedTime?: string;
}

/**
 * The `.md` twins are written by
 * `scripts/maintenance/generate-markdown-exports.ts`. The route *families* come
 * from `shared/lib/markdown-route-policy.ts` (shared with
 * `functions/_middleware.ts`); the per-family guards below mirror exactly what
 * the generator writes, so an unknown slug or date never advertises an
 * alternate that would 404.
 */
const METHODOLOGY_MARKDOWN_PATHS: ReadonlySet<string> = new Set<string>([
  "/methodology/",
  ...METHODOLOGY_CHANGELOG_SITEMAP_PATHS,
]);

export function normalizeWhitespace(text: string): string {
  return text.replace(/\s+/g, " ").trim();
}

function trimTrailingPunctuation(text: string): string {
  return text.replace(/[.!?]+$/, "");
}

function canonicalPathname(canonical: string): string | null {
  try {
    const url = new URL(canonical, SITE_ORIGIN);
    return url.origin === SITE_ORIGIN ? url.pathname : null;
  } catch {
    return null;
  }
}

function hasGeneratedMarkdownAsset(pathname: string): boolean {
  if (pathname === "/changelog/" || pathname === "/docs/") return true;
  if (METHODOLOGY_MARKDOWN_PATHS.has(pathname)) return true;

  const stablecoinMatch = pathname.match(/^\/stablecoin\/([^/]+)\/$/);
  if (stablecoinMatch) {
    return TRACKED_META_BY_ID.has(decodeURIComponent(stablecoinMatch[1]));
  }

  const digestMatch = pathname.match(/^\/digest\/([^/]+)\/$/);
  if (digestMatch) {
    return DIGEST_DATES.has(decodeURIComponent(digestMatch[1]));
  }

  const docMatch = pathname.match(/^\/docs\/([^/]+)\/$/);
  if (docMatch) {
    return PUBLIC_DOC_BY_SLUG.has(decodeURIComponent(docMatch[1]));
  }

  return false;
}

export function getMarkdownAlternateForCanonical(canonical: string): string | null {
  const pathname = canonicalPathname(canonical);
  if (!pathname) return null;

  const assetPath = getGeneratedMarkdownAssetPath(pathname);
  if (!assetPath) return null;

  return hasGeneratedMarkdownAsset(pathname) ? assetPath : null;
}

export function trimTextAtWordBoundary(text: string, maxLength: number, ellipsis = "…"): string {
  const normalized = normalizeWhitespace(text);
  if (normalized.length <= maxLength) return normalized;

  const targetLength = Math.max(1, maxLength - ellipsis.length);
  const truncated = normalized.slice(0, targetLength);
  const lastSpace = truncated.lastIndexOf(" ");
  const safeCutoff = lastSpace > Math.floor(targetLength * 0.6) ? lastSpace : targetLength;

  return `${trimTrailingPunctuation(truncated.slice(0, safeCutoff))}${ellipsis}`;
}

export function summarizeText(text: string, maxLength: number): string {
  const normalized = normalizeWhitespace(text);
  if (!normalized) return normalized;

  const sentenceMatch = normalized.match(/^(.+?[.!?])(?:\s|$)/);
  if (sentenceMatch && sentenceMatch[1].length <= maxLength) {
    return sentenceMatch[1];
  }

  return trimTextAtWordBoundary(normalized, maxLength);
}

function getReserveDifferentiator(coin: StablecoinMeta): string | null {
  const reserveName = coin.reserves?.[0]?.name;
  if (!reserveName) return null;
  const cleanedReserveName = reserveName.replace(/\s*\([^)]*\)/g, "").trim();
  if (!cleanedReserveName) return null;
  return `Reserve base: ${cleanedReserveName}.`;
}

function getMetadataDifferentiator(coin: StablecoinMeta): string | null {
  const blacklistStatus = getResolvedBlacklistStatus(coin.id);
  const variantParent = coin.variantOf ? TRACKED_META_BY_ID.get(coin.variantOf) : null;

  if (coin.variantKind && variantParent) {
    return `${coin.symbol} is tracked as a ${coin.variantKind.replace(/-/g, " ")} of ${variantParent.symbol}.`;
  }

  if (coin.flags.yieldBearing) {
    const source = coin.yieldConfig?.yieldSource;
    return source ? `Yield-bearing via ${source}.` : "Yield-bearing design.";
  }

  if (coin.proofOfReserves?.type === "real-time") {
    return "Real-time reserve reporting.";
  }

  if (coin.proofOfReserves?.provider) {
    return `${coin.proofOfReserves.provider} reserve attestations.`;
  }

  if (blacklistStatus === true) {
    return "Issuer can freeze addresses.";
  }

  if (blacklistStatus === "inherited") {
    return "Freeze risk inherited from upstream collateral.";
  }

  if (blacklistStatus === "possible") {
    return "Blacklist or freeze exposure is possible.";
  }

  if (coin.flags.rwa) {
    return "Real-world asset reserve structure.";
  }

  return getReserveDifferentiator(coin) ?? null;
}

function buildStablecoinTitle(options: readonly string[]): string {
  const maxCoreLength = 61; // Leaves room for the root " | Pharos" template in search snippets.
  return options.find((option) => option.length <= maxCoreLength) ?? options[options.length - 1] ?? "";
}

/**
 * Coins like pmUSD carry the same string as both name and symbol; the
 * `${symbol} (${name})` template would render a redundant "pmUSD (pmUSD)".
 */
function hasRedundantName(coin: StablecoinMeta): boolean {
  return coin.name.trim().toLowerCase() === coin.symbol.trim().toLowerCase();
}

/** Distinct deployment chains, for "on N chains" description enrichment. */
function deploymentChainCount(coin: StablecoinMeta): number {
  return new Set((coin.contracts ?? []).map((contract) => contract.chain)).size;
}

// September 2026 search-intent cohorts; keep other coins as controls.
const STABLECOIN_METADATA_PILOT: Partial<Record<string, { title: string; description: string }>> = {
  "paxg-paxos": {
    title: "PAX Gold (PAXG): Gold Backing, Custody & Risk",
    description:
      "Inspect PAX Gold's gold backing, custody evidence, redemption access and issuer controls. Compare PAXG with XAUT using Pharos risk data.",
  },
  "usdg-paxos": {
    title: "USDG (Global Dollar): Reserves, Redemption & Risk",
    description:
      "Inspect Global Dollar (USDG) reserve evidence, redemption access, freeze controls and liquidity, with Pharos Safety Scores and comparisons.",
  },
  "usde-ethena": {
    title: "Ethena USDe: Backing, Peg Stability & Risk",
    description:
      "Inspect Ethena USDe's backing, custody, peg history and exit liquidity. Compare its risk profile with sUSDe and other dollar stablecoins.",
  },
  "bold-liquity": {
    title: "Liquity BOLD: Collateral, Redemption & Risk",
    description:
      "Review Liquity BOLD's collateral, redemption mechanics, peg history and liquidity. Compare its Safety Score and risk profile with LUSD.",
  },
  // Second cohort: query-level baselines reviewed on September 6; metadata only.
  "fpi-frax": {
    title: "Frax Price Index (FPI): CPI Peg, Backing & Risk",
    description:
      "Understand Frax FPI's CPI-linked target, backing and redemption mechanics. Review reserve evidence and risks, beyond a fixed $1 peg.",
  },
  "sgho-aave": {
    title: "Aave Savings GHO (sGHO): Yield, Withdrawals & Risk",
    description:
      "Understand Aave's sGHO savings vault, its GHO-denominated yield and withdrawal mechanics. Review backing, current yield data and risks.",
  },
};

function buildStablecoinStatusTitle(coin: StablecoinMeta): string {
  if (coin.status === "frozen") {
    return buildStablecoinTitle([
      ...(hasRedundantName(coin) ? [] : [`${coin.symbol} (${coin.name}) Failed Stablecoin Archive`]),
      `${coin.symbol} Failed Stablecoin Archive & Timeline`,
      `${coin.symbol} Failed Stablecoin Archive`,
    ]);
  }

  if (coin.status === "pre-launch") {
    return buildStablecoinTitle([
      ...(hasRedundantName(coin) ? [] : [`${coin.symbol} (${coin.name}) Stablecoin Launch Tracker`]),
      `${coin.symbol} Stablecoin Launch Tracker & Profile`,
      `${coin.symbol} Launch Tracker & Profile`,
      `${coin.symbol} Launch Tracker`,
    ]);
  }

  if (coin.status === "quarantined" || coin.status === "delisted") {
    return buildStablecoinTitle([
      ...(hasRedundantName(coin) ? [] : [`${coin.symbol} (${coin.name}) Inactive Listing Record`]),
      `${coin.symbol} Inactive Listing Record`,
      `${coin.symbol} Catalog Record`,
    ]);
  }

  const pilotCopy = STABLECOIN_METADATA_PILOT[coin.id];
  if (pilotCopy) return pilotCopy.title;

  if (hasRedundantName(coin)) {
    return buildStablecoinTitle([
      `${coin.symbol} Stablecoin Safety Score & Risk Profile`,
      `${coin.symbol} Stablecoin Risk Profile: Peg, Liquidity & Safety`,
      `${coin.symbol} Risk Profile: Peg, Liquidity & Safety`,
      `${coin.symbol} Stablecoin Risk: Peg & Liquidity`,
      `${coin.symbol} Risk Profile`,
    ]);
  }

  return buildStablecoinTitle([
    `${coin.symbol} (${coin.name}) Stablecoin Safety Score & Risk Profile`,
    `${coin.symbol} (${coin.name}) Stablecoin Risk Profile`,
    `${coin.symbol} (${coin.name}) Risk Profile`,
    `${coin.symbol} Stablecoin Risk Profile: Peg, Liquidity & Safety`,
    `${coin.symbol} Risk Profile: Peg, Liquidity & Safety`,
    `${coin.symbol} Stablecoin Risk: Peg & Liquidity`,
    `${coin.symbol} Risk Profile`,
  ]);
}

export function buildStablecoinDetailDescription(coin: StablecoinMeta): string {
  const governancePhrase = GOVERNANCE_PROSE_LABELS[coin.flags.governance];
  const pegLabel = PEG_LABELS_SHORT[coin.flags.pegCurrency] ?? coin.flags.pegCurrency;
  const profilePegLabel = getProfilePegLabel(
    coin.flags,
    coin.pegReferenceId ? TRACKED_META_BY_ID.get(coin.pegReferenceId)?.symbol : undefined,
  );
  const backingPhrase = BACKING_PROSE_LABELS[coin.flags.backing];

  if (coin.status === "pre-launch") {
    const structure =
      coin.flags.backing === "algorithmic"
        ? `planned ${pegLabel} peg, ${governancePhrase} ${backingPhrase}`
        : `planned ${pegLabel} peg, ${backingPhrase}`;
    const description = [
      `Pre-launch profile for ${coin.symbol}: ${structure}.`,
      `Track launch milestones before live data begins for ${coin.name}.`,
    ]
      .filter(Boolean)
      .join(" ");

    return trimTextAtWordBoundary(description, 160);
  }

  if (coin.status === "quarantined" || coin.status === "delisted") {
    return trimTextAtWordBoundary(
      `${coin.name} (${coin.symbol}) is outside Pharos's active universe. ${coin.listingStatusReview?.reason ?? "The static catalog record remains available for historical reference."}`,
      160,
    );
  }

  const pilotCopy = coin.status !== "frozen" ? STABLECOIN_METADATA_PILOT[coin.id] : undefined;
  if (pilotCopy) return pilotCopy.description;

  const structure = coin.flags.navToken
    ? `${governancePhrase} ${backingPhrase} yield-bearing token with ${profilePegLabel}`
    : coin.flags.backing === "algorithmic"
      ? `${governancePhrase} ${backingPhrase} pegged to ${pegLabel}`
      : `${governancePhrase} stablecoin ${backingPhrase} and pegged to ${pegLabel}`;
  const chainCount = deploymentChainCount(coin);
  const chainPhrase = chainCount >= 2 ? ` on ${chainCount} chains` : "";
  const opener = hasRedundantName(coin)
    ? `${coin.symbol} risk profile: ${structure}${chainPhrase}.`
    : `${coin.symbol} risk profile for ${coin.name}: ${structure}${chainPhrase}.`;
  const differentiator = getMetadataDifferentiator(coin);
  const description = [
    opener,
    differentiator,
    "Live peg score, liquidity, reserves & Safety Score.",
  ]
    .filter(Boolean)
    .join(" ");

  return trimTextAtWordBoundary(description, 160);
}

export function buildStablecoinDetailMetadata(coin: StablecoinMeta): Metadata {
  if (coin.status === "frozen") {
    const epitaph = coin.obituary?.epitaph ?? "";
    const description = trimTextAtWordBoundary(
      `Historical data and obituary for ${coin.name} (${coin.symbol}), a now-defunct stablecoin tracked by Pharos through ${coin.frozenAt ?? "freeze date"}. ${epitaph}`.trim(),
      160,
    );
    return buildPageMetadata({
      title: buildStablecoinStatusTitle(coin),
      description,
      canonical: buildStablecoinUrl(coin.id),
      // Preserve OG image so social previews render the same card as live coins.
      ogImage: buildApiOgImageUrl(API_PATHS.ogStablecoin(coin.id)),
    });
  }

  if (coin.status === "pre-launch") {
    return buildPageMetadata({
      title: buildStablecoinStatusTitle(coin),
      description: buildStablecoinDetailDescription(coin),
      canonical: buildStablecoinUrl(coin.id),
      // Pre-launch ids never enter the worker's READABLE_IDS set, so use a
      // static launch-tracker card until launch promotes the coin.
      ogImage: "/og-upcoming.png",
    });
  }

  if (coin.status === "quarantined" || coin.status === "delisted") {
    return buildPageMetadata({
      title: buildStablecoinStatusTitle(coin),
      description: buildStablecoinDetailDescription(coin),
      canonical: buildStablecoinUrl(coin.id),
      // Policy-withheld IDs are absent from the live stablecoins cache used by
      // the Worker OG renderer, so use a static catalog card.
      ogImage: "/og-stablecoins.png",
    });
  }

  return buildPageMetadata({
    title: buildStablecoinStatusTitle(coin),
    description: buildStablecoinDetailDescription(coin),
    canonical: buildStablecoinUrl(coin.id),
    ogImage: buildApiOgImageUrl(API_PATHS.ogStablecoin(coin.id)),
  });
}

export function buildApiOgImageUrl(path: string): string {
  return new URL(path, API_ORIGIN).toString();
}

const INDEXABLE_ROBOTS: Metadata["robots"] = {
  index: true,
  follow: true,
  googleBot: {
    index: true,
    follow: true,
    "max-snippet": -1,
    "max-image-preview": "large",
    "max-video-preview": -1,
  },
}

export function buildPageMetadata({
  title,
  description,
  canonical,
  ogImage,
  ogWidth = 1200,
  ogHeight = 628,
  robots,
  titleAbsolute = false,
  ogType = "website",
  publishedTime,
}: BuildPageMetadataInput): Metadata {
  const resolvedImage = {
    url: ogImage ?? "/og-card.png",
    width: ogWidth,
    height: ogHeight,
  };
  const markdownAlternate = getMarkdownAlternateForCanonical(canonical);
  const alternates: Metadata["alternates"] = { canonical };

  if (markdownAlternate) {
    alternates.types = {
      "text/markdown": [{ title: `${title} (Markdown)`, url: markdownAlternate }],
    };
  }

  const openGraph: Metadata["openGraph"] =
    ogType === "article"
      ? {
          title,
          description,
          url: canonical,
          type: "article",
          ...(publishedTime ? { publishedTime } : {}),
          images: [resolvedImage],
        }
      : {
          title,
          description,
          url: canonical,
          type: "website",
          images: [resolvedImage],
        };

  return {
    title: titleAbsolute ? { absolute: title } : title,
    description,
    alternates,
    openGraph,
    twitter: {
      card: "summary_large_image",
      title,
      description,
      images: [resolvedImage],
    },
    robots: robots ?? INDEXABLE_ROBOTS,
  };
}
// ---------------------------------------------------------------------------
// JSON-LD helpers for the mechanism explainer hub and per-archetype pages.
// ---------------------------------------------------------------------------

/**
 * Build a `DefinedTermSet` document describing the tracked mechanism
 * archetypes. Emitted on the `/learn/mechanisms/` hub so search engines see
 * the page as a glossary of mechanism designs.
 */
export function buildDefinedTermSetJsonLd(): Record<string, unknown> {
  const hubUrl = `${SITE_ORIGIN}/learn/mechanisms/`;
  return {
    "@context": "https://schema.org",
    "@type": "DefinedTermSet",
    "@id": hubUrl,
    name: "Stablecoin Mechanism Archetypes",
    description: `${MECHANISM_ARCHETYPE_VALUES.length} mechanism archetypes covering every stablecoin design Pharos tracks.`,
    url: hubUrl,
    hasDefinedTerm: MECHANISM_ARCHETYPE_VALUES.map((archetype: MechanismArchetype) => ({
      "@type": "DefinedTerm",
      "@id": `${SITE_ORIGIN}${getMechanismExplainerPath(archetype)}`,
      name: getMechanismArchetypeLabel(archetype),
      termCode: archetype,
      description: getMechanismArchetypeOneLiner(archetype),
      inDefinedTermSet: hubUrl,
      url: `${SITE_ORIGIN}${getMechanismExplainerPath(archetype)}`,
    })),
  };
}

// First-publish date for the mechanism explainer cluster (git: 9de91c809,
// the commit that added src/app/learn/mechanisms). `dateModified` comes from
// the git-derived sitemap date for the cluster, so it only moves when the
// explainer content actually changes — not on every build.
const MECHANISM_EXPLAINER_DATE_PUBLISHED = "2026-05-16T00:00:00Z";
const MECHANISM_EXPLAINER_DATE_MODIFIED =
  (sitemapDates as Record<string, string>)["/learn/mechanisms/"] ?? MECHANISM_EXPLAINER_DATE_PUBLISHED;

/**
 * Build an `Article` JSON-LD document for a per-archetype explainer page.
 */
export function buildArchetypeArticleJsonLd(archetype: MechanismArchetype): Record<string, unknown> {
  const url = `${SITE_ORIGIN}${getMechanismExplainerPath(archetype)}`;
  return {
    "@context": "https://schema.org",
    "@type": "Article",
    "@id": url,
    headline: `${getMechanismArchetypeLabel(archetype)} stablecoins, explained`,
    description: getMechanismArchetypeOneLiner(archetype),
    url,
    mainEntityOfPage: url,
    author: { "@type": "Organization", name: "Pharos" },
    publisher: {
      "@type": "Organization",
      name: "Pharos",
      url: SITE_ORIGIN,
    },
    inLanguage: "en",
    isPartOf: `${SITE_ORIGIN}/learn/mechanisms/`,
    about: {
      "@type": "DefinedTerm",
      name: getMechanismArchetypeLabel(archetype),
      termCode: archetype,
    },
    datePublished: MECHANISM_EXPLAINER_DATE_PUBLISHED,
    dateModified: MECHANISM_EXPLAINER_DATE_MODIFIED,
  };
}
