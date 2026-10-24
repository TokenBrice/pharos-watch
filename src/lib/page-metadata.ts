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
import { TRACKED_META_BY_ID, TRACKED_STABLECOINS } from "@shared/lib/stablecoins/registry";
import { PUBLIC_DOC_BY_SLUG } from "@shared/lib/public-docs";
import { getGeneratedMarkdownAssetPath } from "@shared/lib/markdown-route-policy";
import { METHODOLOGY_CHANGELOG_SITEMAP_PATHS } from "@shared/lib/methodology-versions/registry";
import { METHODOLOGY_ARCHIVE_PATHS } from "@shared/lib/methodology-versions/archives";
import { CHANGELOG_MONTH_ARCHIVES } from "@/lib/changelog-history";
import { MECHANISM_ARCHETYPE_VALUES } from "@shared/types/core";
import type { MechanismArchetype, StablecoinMeta } from "@shared/types";
import { getResolvedBlacklistStatus } from "@shared/lib/blacklist-status";
import { DIGEST_DATES } from "@/lib/digest-registry";
import { buildStablecoinUrl } from "@shared/lib/urls";
import type { OgPageSlug } from "@shared/lib/og-route-cards";
import { formatUtcDayLabel } from "@shared/lib/format";
import { PUBLIC_DATASET_CURRENT_DATE } from "@/lib/datasets/public-dataset-current";
import { formatFuzzyDate } from "@/lib/pre-launch";
import { getSnapshotSafetyAssessment } from "@/lib/safety-grade-snapshot";
import { SITE_OPEN_GRAPH_IDENTITY, SITE_TWITTER_IDENTITY } from "@/lib/site-identity";
import { isStablecoinTitleTreatment } from "@/lib/stablecoin-title-cohort";
import { stripTermMarkup } from "@/lib/term-markup";

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
  ...METHODOLOGY_ARCHIVE_PATHS,
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
  if (CHANGELOG_MONTH_ARCHIVES.some((archive) => archive.path === pathname)) return true;
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

function getMarkdownAlternateForCanonical(canonical: string): string | null {
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

export type DescriptionPart = string | readonly (string | null | undefined)[] | null | undefined;

/**
 * Compose a meta description from whole sentences. Parts are appended in
 * priority order (which is also output order) and skipped when they do not
 * fit; an array part lists alternatives, preferred first, and contributes the
 * first one that fits. The result never ends in "…": only when not even the
 * first part fits is its shortest alternative cut at a word boundary.
 */
export function composeDescription(parts: readonly DescriptionPart[], maxLength = 160): string {
  const alternativesByPart = parts.map((part) =>
    (typeof part === "string" ? [part] : (part ?? []))
      .map((text) => (text ? normalizeWhitespace(text) : ""))
      .filter(Boolean),
  );

  let description = "";
  for (const alternatives of alternativesByPart) {
    for (const text of alternatives) {
      const candidate = description ? `${description} ${text}` : text;
      if (candidate.length <= maxLength) {
        description = candidate;
        break;
      }
    }
  }
  if (description) return description;

  const fallback = alternativesByPart.find((alternatives) => alternatives.length > 0)?.at(-1) ?? "";
  return trimTextAtWordBoundary(fallback, maxLength, "");
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

/** Profile title core budget: core plus the root " | Pharos" suffix fits about 60 characters. */
const PROFILE_TITLE_MAX_CORE_LENGTH = 51;
/** Frozen archive titles keep their original budget; they are outside the 2026-10 title work. */
const FROZEN_TITLE_MAX_CORE_LENGTH = 61;
/** Matches the `check-seo-static` description ceiling. */
const PROFILE_DESCRIPTION_MAX_LENGTH = 180;

function buildStablecoinTitle(
  options: readonly (string | null | undefined | false)[],
  maxCoreLength = PROFILE_TITLE_MAX_CORE_LENGTH,
): string {
  const candidates = options.filter((option): option is string => Boolean(option));
  return candidates.find((option) => option.length <= maxCoreLength) ?? candidates[candidates.length - 1] ?? "";
}

/**
 * Coins like pmUSD carry the same string as both name and symbol; the
 * `${symbol} (${name})` template would render a redundant "pmUSD (pmUSD)".
 */
function hasRedundantName(coin: StablecoinMeta): boolean {
  return coin.name.trim().toLowerCase() === coin.symbol.trim().toLowerCase();
}

/** Title qualifier: the curated issuer `brand`, else the name unless it only repeats the symbol. */
function getTitleBrand(coin: StablecoinMeta): string | null {
  return coin.brand ?? (hasRedundantName(coin) ? null : coin.name);
}

let symbolRecordCounts: Map<string, number> | null = null;

/** Tickers shared by two or more tracked records (any status), compared case-insensitively. */
function hasCollidingSymbol(coin: StablecoinMeta): boolean {
  symbolRecordCounts ??= TRACKED_STABLECOINS.reduce((counts, tracked) => {
    const key = tracked.symbol.trim().toLowerCase();
    counts.set(key, (counts.get(key) ?? 0) + 1);
    return counts;
  }, new Map<string, number>());
  return (symbolRecordCounts.get(coin.symbol.trim().toLowerCase()) ?? 0) >= 2;
}

/** Control arm: the pre-2026-10-25 active chain, with `brand` standing in for a redundant name. */
function buildActiveControlTitle(coin: StablecoinMeta): string {
  const symbol = coin.symbol;
  const qualifier = hasRedundantName(coin) ? coin.brand : coin.name;
  if (!qualifier) {
    return buildStablecoinTitle([
      `${symbol} Stablecoin Safety Score & Risk Profile`,
      `${symbol} Stablecoin Risk Profile: Peg, Liquidity & Safety`,
      `${symbol} Risk Profile: Peg, Liquidity & Safety`,
      `${symbol} Stablecoin Risk: Peg & Liquidity`,
      `${symbol} Risk Profile`,
    ]);
  }

  return buildStablecoinTitle([
    `${symbol} (${qualifier}) Stablecoin Safety Score & Risk Profile`,
    `${symbol} (${qualifier}) Stablecoin Risk Profile`,
    `${symbol} (${qualifier}) Risk Profile`,
    `${symbol} Stablecoin Risk Profile: Peg, Liquidity & Safety`,
    `${symbol} Risk Profile: Peg, Liquidity & Safety`,
    `${symbol} Stablecoin Risk: Peg & Liquidity`,
    `${symbol} Risk Profile`,
  ]);
}

function activeTreatmentTitleOptions(symbol: string, qualifier: string, navToken: boolean): string[] {
  return navToken
    ? [`${symbol} (${qualifier}): Safety Score, Backing & Risk`, `${symbol} (${qualifier}): Backing & Risk`]
    : [`${symbol} Stablecoin (${qualifier}): Safety Score & Risk`, `${symbol} (${qualifier}): Safety Score, Reserves & Risk`];
}

/** Treatment arm (SEO plan W2.1): intent words and the issuer brand, never the grade value (D1). */
function buildActiveTreatmentTitle(coin: StablecoinMeta): string {
  const symbol = coin.symbol;
  const navToken = coin.flags.navToken;

  if (hasCollidingSymbol(coin)) {
    // A shared ticker always keeps its `{SYM} ({name})` disambiguator.
    const qualifiers = [...new Set([hasRedundantName(coin) ? null : coin.name, coin.brand ?? null])]
      .filter((qualifier): qualifier is string => Boolean(qualifier));
    if (qualifiers.length > 0) {
      return buildStablecoinTitle([
        ...qualifiers.flatMap((qualifier) => [
          ...activeTreatmentTitleOptions(symbol, qualifier, navToken),
          `${symbol} (${qualifier}): Safety Score & Risk`,
          `${symbol} (${qualifier}) Safety Score`,
        ]),
        `${symbol} (${qualifiers[qualifiers.length - 1]})`,
      ]);
    }
  }

  const brand = getTitleBrand(coin);
  return buildStablecoinTitle([
    ...(brand ? activeTreatmentTitleOptions(symbol, brand, navToken) : []),
    navToken ? `${symbol}: Safety Score, Backing & Risk` : `${symbol} Stablecoin: Safety Score & Risk`,
    `${symbol} Safety Score`,
  ]);
}

function buildStablecoinStatusTitle(coin: StablecoinMeta): string {
  if (coin.status === "frozen") {
    return buildStablecoinTitle([
      ...(hasRedundantName(coin) ? [] : [`${coin.symbol} (${coin.name}) Failed Stablecoin Archive`]),
      `${coin.symbol} Failed Stablecoin Archive & Timeline`,
      `${coin.symbol} Failed Stablecoin Archive`,
    ], FROZEN_TITLE_MAX_CORE_LENGTH);
  }

  if (coin.status === "pre-launch") {
    const brand = getTitleBrand(coin);
    const intent = coin.launchPhase === "beta" ? "Beta Access & Status" : "Launch Date & Status";
    return buildStablecoinTitle([
      brand ? `${coin.symbol} Stablecoin (${brand}): ${intent}` : null,
      `${coin.symbol} Stablecoin: ${intent}`,
      `${coin.symbol} Launch Status`,
    ]);
  }

  if (coin.status === "quarantined" || coin.status === "delisted") {
    return buildStablecoinTitle([
      hasRedundantName(coin) ? null : `${coin.symbol} (${coin.name}): Profile & Listing Status`,
      coin.brand ? `${coin.symbol} (${coin.brand}): Profile & Listing Status` : null,
      `${coin.symbol}: Profile & Listing Status`,
    ]);
  }

  return isStablecoinTitleTreatment(coin.id) ? buildActiveTreatmentTitle(coin) : buildActiveControlTitle(coin);
}

/**
 * Amounts that drift after a snippet is cached: supply, AUM or TVL figures,
 * magnitudes such as "$1.2B" or "5M USDC", and approximations like
 * "~HK$527k". Deliberately broad; a fixed "$1" peg or "1:1" is not matched.
 */
const VOLATILE_AMOUNT_PATTERNS: readonly RegExp[] = [
  /~\s?[A-Z]{0,3}[$€£¥]?\d/,
  /(?:[A-Z]{0,3}\$|[€£¥])\s?\d[\d,.]*\s?(?:[kKmMbBtT]|bn|mn|thousand|million|billion|trillion)\b/,
  /\b\d[\d,.]*\s?(?:[MB]|bn|mn|million|billion|trillion)\b/,
  /\b(?:AUM|TVL)\b/,
  /\b(?:circulating|in circulation|market cap)\b/i,
];

export function hasVolatileAmount(text: string): boolean {
  return VOLATILE_AMOUNT_PATTERNS.some((pattern) => pattern.test(text));
}

/** The curated `oneLiner`, unless it is missing or carries an amount that would go stale in the snippet cache. */
function getMetadataOneLiner(coin: StablecoinMeta): string | null {
  const oneLiner = coin.oneLiner ? normalizeWhitespace(stripTermMarkup(coin.oneLiner)) : "";
  return oneLiner && !hasVolatileAmount(oneLiner) ? oneLiner : null;
}

/** Fixed-structure identity sentence used when no metadata-safe `oneLiner` exists. */
function buildStructureSentence(coin: StablecoinMeta): string {
  const governancePhrase = GOVERNANCE_PROSE_LABELS[coin.flags.governance];
  const backingPhrase = BACKING_PROSE_LABELS[coin.flags.backing];
  const pegLabel = PEG_LABELS_SHORT[coin.flags.pegCurrency] ?? coin.flags.pegCurrency;
  const profilePegLabel = getProfilePegLabel(
    coin.flags,
    coin.pegReferenceId ? TRACKED_META_BY_ID.get(coin.pegReferenceId)?.symbol : undefined,
  );
  const structure = coin.flags.navToken
    ? `${governancePhrase} yield-bearing token ${backingPhrase}, with ${profilePegLabel}`
    : coin.flags.backing === "algorithmic"
      ? `${governancePhrase} ${backingPhrase} pegged to ${pegLabel}`
      : `${governancePhrase} stablecoin ${backingPhrase}, pegged to ${pegLabel}`;
  const subject = hasRedundantName(coin) ? coin.symbol : `${coin.name} (${coin.symbol})`;
  const determiner = coin.brand ? `${coin.brand}'s` : "a";
  const lifecycle = coin.status === "pre-launch" ? "pre-launch " : "";
  return `${subject} is ${determiner} ${lifecycle}${structure}.`;
}

/** Short identity for inactive records; it avoids calling an out-of-scope instrument a stablecoin. */
function buildInactiveIdentitySentence(coin: StablecoinMeta): string {
  const backingPhrase = coin.flags.backing === "algorithmic"
    ? "with an algorithmic design"
    : BACKING_PROSE_LABELS[coin.flags.backing];
  const determiner = coin.brand ? `${coin.brand}'s` : "a";
  return `${coin.symbol} is ${determiner} ${GOVERNANCE_PROSE_LABELS[coin.flags.governance]} token ${backingPhrase}.`;
}

function formatDayLabel(isoDate: string): string {
  return formatUtcDayLabel(new Date(`${isoDate}T00:00:00Z`));
}

/** Newest day-precision milestone date (`YYYY-MM-DD`); fuzzy dates are never promoted to a day. */
export function getLatestDatedMilestoneDate(coin: Pick<StablecoinMeta, "milestones">): string | null {
  return (coin.milestones ?? []).reduce<string | null>(
    (latest, milestone) =>
      /^\d{4}-\d{2}-\d{2}$/.test(milestone.date) && (!latest || milestone.date > latest) ? milestone.date : latest,
    null,
  );
}

/** Plain-language category for a quarantine or delisting; the raw review reason stays on the page. */
function getListingStatusCategory(coin: StablecoinMeta): string {
  if (coin.status === "quarantined") return "price or supply data under review";
  const reason = coin.listingStatusReview?.reason ?? "";
  if (/\bout of scope\b|\bscope delisting\b/i.test(reason)) return "outside the listing scope";
  if (/wind-down|buyback|redemption ended|shut down|terminat/i.test(reason)) return "issuer wind-down";
  return "removed from the active listing";
}

function buildStablecoinDetailDescription(coin: StablecoinMeta): string {
  const body = getMetadataOneLiner(coin) ?? buildStructureSentence(coin);

  if (coin.status === "pre-launch") {
    const latestMilestone = getLatestDatedMilestoneDate(coin);
    return composeDescription([
      body,
      latestMilestone ? `Latest milestone: ${formatDayLabel(latestMilestone)}.` : null,
      coin.expectedLaunchDate ? `Target: ${formatFuzzyDate(coin.expectedLaunchDate)}.` : null,
    ], PROFILE_DESCRIPTION_MAX_LENGTH);
  }

  if (coin.status === "quarantined" || coin.status === "delisted") {
    const notScored = `Not currently scored by Pharos: ${getListingStatusCategory(coin)}.`;
    return composeDescription([
      [`${body} ${notScored}`, `${buildInactiveIdentitySentence(coin)} ${notScored}`, notScored],
      "See history and documents.",
    ], PROFILE_DESCRIPTION_MAX_LENGTH);
  }

  // Grade first: Google truncates around 155 characters. The date is the
  // scores-latest release the profile body cites; live price, peg and supply
  // stay out because snippets are cached for weeks.
  const assessment = getSnapshotSafetyAssessment(coin.id);
  const lead = assessment
    ? [
        `Safety Score ${assessment.grade} (${formatDayLabel(PUBLIC_DATASET_CURRENT_DATE)}). ${body}`,
        `Safety Score ${assessment.grade}. ${body}`,
        body,
      ]
    : body;
  return composeDescription([lead, getMetadataDifferentiator(coin)], PROFILE_DESCRIPTION_MAX_LENGTH);
}

export function buildStablecoinDetailMetadata(coin: StablecoinMeta): Metadata {
  if (coin.status === "frozen") {
    const description = composeDescription([
      `Historical data and obituary for ${coin.name} (${coin.symbol}), a now-defunct stablecoin tracked by Pharos through ${coin.frozenAt ?? "freeze date"}.`,
      coin.obituary?.epitaph,
    ], PROFILE_DESCRIPTION_MAX_LENGTH);
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

/** Live route share card (`/api/og/page/:slug`); it falls back to the route's timeless card server-side. */
export function buildLiveRouteOgImageUrl(slug: OgPageSlug): string {
  return buildApiOgImageUrl(API_PATHS.ogPage(slug));
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
          ...SITE_OPEN_GRAPH_IDENTITY,
          type: "article",
          ...(publishedTime ? { publishedTime } : {}),
          images: [resolvedImage],
        }
      : {
          title,
          description,
          url: canonical,
          ...SITE_OPEN_GRAPH_IDENTITY,
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
      ...SITE_TWITTER_IDENTITY,
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
