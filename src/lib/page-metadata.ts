import type { Metadata } from "next";
import sitemapDates from "@/generated/sitemap-dates.json";
import {
  BACKING_PROSE_LABELS,
  GOVERNANCE_PROSE_LABELS,
  PEG_LABELS_SHORT,
  getMechanismArchetypeLabel,
  getMechanismArchetypeOneLiner,
  getMechanismExplainerPath,
} from "@shared/lib/classification";
import { API_ORIGIN, SITE_ORIGIN } from "@shared/lib/runtime-origins";
import { API_PATHS } from "@shared/lib/api-endpoints";
import { TRACKED_META_BY_ID } from "@shared/lib/stablecoins/registry";
import { PUBLIC_DOC_BY_SLUG } from "@shared/lib/public-docs";
import { MECHANISM_ARCHETYPE_VALUES } from "@shared/types/core";
import type { MechanismArchetype, StablecoinMeta } from "@shared/types";
import { getResolvedBlacklistStatus } from "@/lib/blacklist-status";
import { INDEXABLE_ROBOTS } from "@/lib/seo-robots";
import { buildStablecoinUrl } from "@/lib/urls";

interface BuildPageMetadataInput {
  title: string;
  description: string;
  canonical: string;
  ogImage?: string;
  ogWidth?: number;
  ogHeight?: number;
  robots?: Metadata["robots"];
}

const METHODOLOGY_MARKDOWN_PATHS = new Set([
  "/methodology/",
  "/methodology/blacklist-tracker-changelog/",
  "/methodology/chain-health-changelog/",
  "/methodology/depeg-changelog/",
  "/methodology/depeg-resolver-changelog/",
  "/methodology/liquidity-score-changelog/",
  "/methodology/mint-burn-flow-changelog/",
  "/methodology/pricing-pipeline-changelog/",
  "/methodology/scoring-changelog/",
  "/methodology/stability-index-changelog/",
  "/methodology/yield-changelog/",
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

export function getMarkdownAlternateForCanonical(canonical: string): string | null {
  const pathname = canonicalPathname(canonical);
  if (!pathname) return null;

  if (pathname === "/changelog/" || METHODOLOGY_MARKDOWN_PATHS.has(pathname)) {
    return `${pathname}index.md`;
  }

  const stablecoinMatch = pathname.match(/^\/stablecoin\/([^/]+)\/$/);
  if (stablecoinMatch) {
    const id = decodeURIComponent(stablecoinMatch[1]);
    return TRACKED_META_BY_ID.has(id) ? `${pathname}index.md` : null;
  }

  if (pathname === "/docs/") {
    return "/docs/index.md";
  }

  const docMatch = pathname.match(/^\/docs\/([^/]+)\/$/);
  if (docMatch) {
    const slug = decodeURIComponent(docMatch[1]);
    return PUBLIC_DOC_BY_SLUG.has(slug) ? `${pathname}index.md` : null;
  }

  return null;
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

  const structure =
    coin.flags.backing === "algorithmic"
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

export function buildPageMetadata({
  title,
  description,
  canonical,
  ogImage,
  ogWidth = 1200,
  ogHeight = 628,
  robots,
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

  return {
    title,
    description,
    alternates,
    openGraph: {
      title,
      description,
      url: canonical,
      type: "website",
      images: [resolvedImage],
    },
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
 * Build a `DefinedTermSet` document describing the six tracked mechanism
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
    description: "Six mechanism archetypes covering every stablecoin design Pharos tracks.",
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
