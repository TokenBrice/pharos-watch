/**
 * Route share cards: one authority for the slugs, copy and layout of the
 * `/api/og/page/:slug` Worker cards and their timeless static twins in
 * `public/`. The Worker template (`worker/src/lib/og-templates/route-card.tsx`)
 * and the static generator (`scripts/maintenance/build-og-route-timeless.ts`)
 * both read this module, so a fail-closed Worker render and the committed
 * fallback PNG carry the same words.
 *
 * Timeless copy never carries a figure, a date or a state claim: it must stay
 * true for as long as a platform caches the image.
 */

export interface OgRouteCardCopy {
  /** Route name in sentence case, shown beside the route glyph. */
  kicker: string;
  /** Two-line route promise for the timeless variant. No digits. */
  promise: readonly [string, string];
  /** Site path the "live figures at" line names. */
  path: string;
  /** Committed timeless PNG in `public/`; legacy filenames are kept for inbound links. */
  file: string;
}

export const OG_ROUTE_CARDS = {
  home: {
    kicker: "Stablecoin analytics",
    promise: ["Every stablecoin,", "watched at the peg."],
    path: "/",
    file: "og-card.png",
  },
  chains: {
    kicker: "Chains",
    promise: ["Where stablecoin supply", "is docked, chain by chain."],
    path: "/chains/",
    file: "og-chains.png",
  },
  "dependency-map": {
    kicker: "Dependency map",
    promise: ["Which stablecoins are", "built on which."],
    path: "/dependency-map/",
    file: "og-dependency-map.png",
  },
  timeline: {
    kicker: "Timeline",
    promise: ["Depegs, freezes and", "supply shocks, in order."],
    path: "/timeline/",
    file: "og-timeline.png",
  },
  flows: {
    kicker: "Mint & burn flows",
    promise: ["What issuers are printing", "and what they are shredding."],
    path: "/flows/",
    file: "og-flows.png",
  },
  freezewatch: {
    kicker: "FreezeWatch",
    promise: ["How much stablecoin supply", "an issuer can freeze."],
    path: "/freezewatch/",
    file: "og-blacklist.png",
  },
  liquidity: {
    kicker: "DEX liquidity",
    promise: ["How deep the exit is", "for every stablecoin."],
    path: "/liquidity/",
    file: "og-liquidity.png",
  },
  yield: {
    kicker: "Yield",
    promise: ["Stablecoin yields,", "ranked against their risk."],
    path: "/yield/",
    file: "og-yield.png",
  },
  "alt-pegs": {
    kicker: "Alt pegs",
    promise: ["Stablecoins pegged to", "more than the dollar."],
    path: "/alt-pegs/",
    file: "og-alt-pegs.png",
  },
  coverage: {
    kicker: "Coverage",
    promise: ["What Pharos tracks,", "and how deeply."],
    path: "/coverage/",
    file: "og-coverage.png",
  },
  stablecoins: {
    kicker: "Stablecoins",
    promise: ["Every tracked stablecoin,", "sorted and compared."],
    path: "/stablecoins/",
    file: "og-stablecoins.png",
  },
  upcoming: {
    kicker: "Upcoming",
    promise: ["Stablecoins on the way,", "tracked before launch."],
    path: "/upcoming/",
    file: "og-upcoming.png",
  },
  compare: {
    kicker: "Compare",
    promise: ["Two stablecoins,", "side by side."],
    path: "/compare/",
    file: "og-compare.png",
  },
  screener: {
    kicker: "Screener",
    promise: ["Filter stablecoins by", "what matters to you."],
    path: "/screener/",
    file: "og-default.png",
  },
  funding: {
    kicker: "Funding",
    promise: ["Keep Pharos independent", "and free to read."],
    path: "/funding/",
    file: "og-funding.png",
  },
  pharoswatchbot: {
    kicker: "PharosWatchBot",
    promise: ["Stablecoin alerts,", "straight to Telegram."],
    path: "/pharoswatchbot/",
    file: "og-pharoswatchbot.png",
  },
  changelog: {
    kicker: "Changelog",
    promise: ["What changed on Pharos,", "week by week."],
    path: "/changelog/",
    file: "og-changelog.png",
  },
  portfolio: {
    kicker: "Portfolio",
    promise: ["Check the risk in", "your stablecoin holdings."],
    path: "/portfolio/",
    file: "og-portfolio.png",
  },
} as const satisfies Record<string, OgRouteCardCopy>;

export type OgRouteCardKey = keyof typeof OG_ROUTE_CARDS;

/** Routes whose `og:image` is the live Worker card `/api/og/page/:slug`. */
export const OG_LIVE_PAGE_SLUGS = [
  "home",
  "chains",
  "dependency-map",
  "timeline",
  "flows",
  "freezewatch",
  "liquidity",
  "yield",
] as const satisfies readonly OgRouteCardKey[];

export type OgPageSlug = (typeof OG_LIVE_PAGE_SLUGS)[number];

export function isOgPageSlug(value: string): value is OgPageSlug {
  return (OG_LIVE_PAGE_SLUGS as readonly string[]).includes(value);
}

/** Absolute URL of a route's committed timeless card. */
export function ogRouteTimelessImageUrl(siteUrl: string, key: OgRouteCardKey): string {
  return `${siteUrl}/${OG_ROUTE_CARDS[key].file}`;
}

/** "pharos.watch/chains" — the footer line of a timeless card. */
export function ogRouteCardHost(path: string): string {
  const trimmed = path.replace(/^\/+|\/+$/g, "");
  return trimmed ? `pharos.watch/${trimmed}` : "pharos.watch";
}

/**
 * Shared layout. Both renderers place the same blocks at the same positions on
 * the 1200×628 light canvas; the Worker uses flex boxes, the static generator
 * absolute SVG coordinates derived from these numbers.
 */
export const OG_ROUTE_CARD_LAYOUT = {
  width: 1200,
  height: 628,
  paddingX: 64,
  accentBarHeight: 4,
  headerTop: 40,
  markSize: 40,
  wordmarkSize: 24,
  hostSize: 18,
  kickerTop: 136,
  kickerSize: 26,
  glyphSize: 28,
  promiseTop: 220,
  promiseSize: 68,
  promiseLineHeight: 82,
  heroSize: 116,
  contextSize: 30,
  supportSize: 24,
  footerBottom: 52,
  footerSize: 20,
} as const;

export const OG_ROUTE_CARD_COLORS = {
  background: "#f8f8fa",
  /** Neutral brand ink: a coloured bar would read as a live-state (PSI band) claim. */
  accent: "#171719",
  textPrimary: "#171719",
  textSecondary: "#5f6570",
  rule: "#d9dce1",
  barTrack: "#e4e7eb",
  /** Neutral ink steps for share-bar segments; data hue stays out of the share card. */
  barInk: ["#171719", "#5f6570", "#9aa0a8"],
} as const;

/** A support item; a swatch only for a band the card read this render (never decoration). */
export type OgRouteSupportItem = string | { text: string; swatchHex: string };

/**
 * One restrained visual drawn from data the card already read. Geometry only:
 * every figure it shows is also printed as text, unclamped.
 */
export type OgRouteVisual =
  /** Shares of one whole (0–1), drawn left to right in neutral ink; drawn only when they sum to at most 1. */
  | { kind: "share-bar"; shares: readonly number[] }
  /** Labelled magnitudes on one shared scale (e.g. printed vs shredded). */
  | { kind: "pair-bars"; bars: readonly { label: string; value: number; text: string }[] };

/** Closed vocabulary for `X-Og-Reason` when a live card falls back to its timeless variant. */
export const OG_PAGE_UNAVAILABLE_REASONS = [
  "cache-missing",
  "stale-cache",
  "held-publication",
  "incomplete-coverage",
  "figure-null",
  "owner-error",
  "render-error",
] as const;

export type OgPageUnavailableReason = (typeof OG_PAGE_UNAVAILABLE_REASONS)[number];

const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"] as const;

/** "12 Oct 2026, 14:05 UTC" — the generation time a live card names. */
export function formatOgStampTime(epochSec: number): string {
  const date = new Date(epochSec * 1000);
  const pad = (value: number) => String(value).padStart(2, "0");
  return `${date.getUTCDate()} ${MONTHS[date.getUTCMonth()]} ${date.getUTCFullYear()}, ${pad(date.getUTCHours())}:${pad(date.getUTCMinutes())} UTC`;
}
