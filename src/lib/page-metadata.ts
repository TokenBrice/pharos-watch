import type { Metadata } from "next";
import { BACKING_BADGE_STYLES, PEG_LABELS_SHORT } from "@shared/lib/classification";
import { API_ORIGIN } from "@shared/lib/runtime-origins";
import { TRACKED_META_BY_ID } from "@shared/lib/stablecoins";
import type { BackingType, StablecoinMeta } from "@shared/types";
import { getResolvedBlacklistStatus } from "@/lib/blacklist-status";
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

const GOVERNANCE_METADATA_PHRASES = {
  centralized: "centralized",
  "centralized-dependent": "CeFi-dependent",
  decentralized: "decentralized",
} as const;

const BACKING_METADATA_PHRASES: Record<BackingType, string> = {
  "rwa-backed": "backed by real-world assets",
  "crypto-backed": "collateralized by crypto assets",
  algorithmic: "algorithmic stablecoin",
};

function normalizeWhitespace(text: string): string {
  return text.replace(/\s+/g, " ").trim();
}

function trimTrailingPunctuation(text: string): string {
  return text.replace(/[.!?]+$/, "");
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

export function buildStablecoinDetailDescription(coin: StablecoinMeta): string {
  const governancePhrase = GOVERNANCE_METADATA_PHRASES[coin.flags.governance];
  const pegLabel = PEG_LABELS_SHORT[coin.flags.pegCurrency] ?? coin.flags.pegCurrency;
  const backingPhrase = BACKING_METADATA_PHRASES[coin.flags.backing];
  const structure =
    coin.flags.backing === "algorithmic"
      ? `${governancePhrase} ${backingPhrase} pegged to ${pegLabel}`
      : `${governancePhrase} stablecoin ${backingPhrase} and pegged to ${pegLabel}`;
  const differentiator = getMetadataDifferentiator(coin);
  const description = [
    `${coin.name} (${coin.symbol}) analytics for this ${structure}.`,
    differentiator,
    "Peg score, liquidity, supply trends, and risk profile.",
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
      title: `${coin.name} (${coin.symbol}) — Frozen Stablecoin Archive`,
      description,
      canonical: buildStablecoinUrl(coin.id),
      // Preserve OG image so social previews render the same card as live coins.
      ogImage: buildApiOgImageUrl(`/api/og/stablecoin/${coin.id}`),
    });
  }
  const backingLabel = BACKING_BADGE_STYLES[coin.flags.backing]?.label ?? "";
  const title = backingLabel
    ? `${coin.name} (${coin.symbol}) — ${backingLabel} Stablecoin Analytics`
    : `${coin.name} (${coin.symbol}) Stablecoin Analytics`;
  return buildPageMetadata({
    title,
    description: buildStablecoinDetailDescription(coin),
    canonical: buildStablecoinUrl(coin.id),
    ogImage: buildApiOgImageUrl(`/api/og/stablecoin/${coin.id}`),
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

  return {
    title,
    description,
    alternates: { canonical },
    openGraph: {
      title,
      description,
      url: canonical,
      type: "website",
      images: [resolvedImage],
    },
    twitter: {
      images: [resolvedImage],
    },
    robots,
  };
}
