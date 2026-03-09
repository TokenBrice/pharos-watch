import { BACKING_LABELS_SHORT, GOVERNANCE_LABELS, PEG_LABELS_SHORT } from "@shared/lib/classification";
import { TRACKED_META_BY_ID } from "@shared/lib/stablecoins";
import type { StablecoinMeta } from "@shared/types";
import { trimTextAtWordBoundary } from "@/lib/page-metadata";
import { buildStablecoinUrl } from "@/lib/urls";

const STATIC_COMPARE_PAIRS = [
  ["usdt-tether", "usdc-circle"],
  ["usdt-tether", "usde-ethena"],
  ["usdt-tether", "dai-makerdao"],
  ["usdc-circle", "usde-ethena"],
  ["usdc-circle", "dai-makerdao"],
  ["usde-ethena", "dai-makerdao"],
  ["usds-sky", "dai-makerdao"],
  ["pyusd-paypal", "usdc-circle"],
  ["rlusd-ripple", "usdc-circle"],
  ["usdt-tether", "pyusd-paypal"],
  ["usdt-tether", "rlusd-ripple"],
  ["usdc-circle", "pyusd-paypal"],
] as const;

const BACKING_COPY = {
  "rwa-backed": "real-world-asset-backed",
  "crypto-backed": "crypto-backed",
  algorithmic: "algorithmic",
} as const;

interface StaticComparisonPage {
  slug: string;
  href: string;
  title: string;
  shortTitle: string;
  description: string;
  intro: string;
  left: StablecoinMeta;
  right: StablecoinMeta;
}

function getStablecoinOrThrow(id: string): StablecoinMeta {
  const coin = TRACKED_META_BY_ID.get(id);
  if (!coin) {
    throw new Error(`Missing stablecoin metadata for static comparison page: ${id}`);
  }
  return coin;
}

function buildComparisonSlug(left: StablecoinMeta, right: StablecoinMeta): string {
  return `${left.id}-vs-${right.id}`;
}

function describeBlacklistability(coin: StablecoinMeta): string {
  if (coin.canBeBlacklisted === true) return "Issuer blacklist controls";
  if (coin.canBeBlacklisted === "possible") return "Blacklist controls possible";
  return "No explicit blacklist flag";
}

function describeReserveSignal(coin: StablecoinMeta): string {
  if (coin.proofOfReserves?.type === "real-time") return "Real-time reserve reporting";
  if (coin.proofOfReserves?.provider) return `${coin.proofOfReserves.provider} attestations`;
  if (coin.reserves?.[0]?.name) return coin.reserves[0].name.replace(/\s*\([^)]*\)/g, "").trim();
  if (coin.collateral) return coin.collateral.split(/[.;]/)[0]?.trim() ?? "Collateral profile disclosed";
  return "Collateral profile disclosed";
}

function buildComparisonIntro(left: StablecoinMeta, right: StablecoinMeta): string {
  const pegSentence =
    left.flags.pegCurrency === right.flags.pegCurrency
      ? `Both target the ${PEG_LABELS_SHORT[left.flags.pegCurrency]}.`
      : `${left.symbol} targets ${PEG_LABELS_SHORT[left.flags.pegCurrency]}, while ${right.symbol} targets ${PEG_LABELS_SHORT[right.flags.pegCurrency]}.`;
  const governanceSentence =
    left.flags.governance === right.flags.governance
      ? `They share a ${GOVERNANCE_LABELS[left.flags.governance].toLowerCase()} governance model.`
      : `${left.symbol} is ${GOVERNANCE_LABELS[left.flags.governance].toLowerCase()}, while ${right.symbol} is ${GOVERNANCE_LABELS[right.flags.governance].toLowerCase()}.`;
  const backingSentence =
    left.flags.backing === right.flags.backing
      ? `Both use ${BACKING_COPY[left.flags.backing]} designs.`
      : `${left.symbol} uses a ${BACKING_COPY[left.flags.backing]} design, while ${right.symbol} uses a ${BACKING_COPY[right.flags.backing]} design.`;

  return `${left.name} and ${right.name} are two widely followed stablecoins. ${pegSentence} ${governanceSentence} ${backingSentence} This static comparison highlights structural differences before you open the live Pharos compare tool.`;
}

function buildComparisonDescription(left: StablecoinMeta, right: StablecoinMeta): string {
  return trimTextAtWordBoundary(
    `Compare ${left.name} (${left.symbol}) vs ${right.name} (${right.symbol}): governance, backing, blacklist controls, reserve structure, chain reach, and links to live Pharos analytics.`,
    160,
  );
}

export function buildLiveCompareUrl(coinIds: readonly string[]): string {
  return `/compare/?coins=${coinIds.map((coinId) => encodeURIComponent(coinId)).join(",")}`;
}

export const STATIC_COMPARISON_PAGES: StaticComparisonPage[] = STATIC_COMPARE_PAIRS.map(([leftId, rightId]) => {
  const left = getStablecoinOrThrow(leftId);
  const right = getStablecoinOrThrow(rightId);
  const shortTitle = `${left.symbol} vs ${right.symbol}`;
  return {
    slug: buildComparisonSlug(left, right),
    href: `/compare/${buildComparisonSlug(left, right)}/`,
    title: `${shortTitle}: ${left.name} vs ${right.name}`,
    shortTitle,
    description: buildComparisonDescription(left, right),
    intro: buildComparisonIntro(left, right),
    left,
    right,
  };
});

export const STATIC_COMPARISON_PAGE_BY_SLUG = new Map(
  STATIC_COMPARISON_PAGES.map((page) => [page.slug, page]),
);

export function getStaticComparisonPagesForCoin(coinId: string): StaticComparisonPage[] {
  return STATIC_COMPARISON_PAGES.filter((page) => page.left.id === coinId || page.right.id === coinId);
}

export function getPrimaryStaticComparisonPageForCoin(coinId: string): StaticComparisonPage | null {
  return getStaticComparisonPagesForCoin(coinId)[0] ?? null;
}

export function buildComparisonResearchLinks(page: StaticComparisonPage) {
  return [
    {
      href: buildStablecoinUrl(page.left.id),
      label: `${page.left.name} (${page.left.symbol}) detail page`,
    },
    {
      href: buildStablecoinUrl(page.right.id),
      label: `${page.right.name} (${page.right.symbol}) detail page`,
    },
    {
      href: buildLiveCompareUrl([page.left.id, page.right.id]),
      label: `Open the live ${page.shortTitle} compare tool`,
    },
  ];
}

export function buildComparisonAtAGlanceRows(page: StaticComparisonPage) {
  const { left, right } = page;
  return [
    {
      label: "Governance",
      left: GOVERNANCE_LABELS[left.flags.governance],
      right: GOVERNANCE_LABELS[right.flags.governance],
    },
    {
      label: "Backing",
      left: BACKING_LABELS_SHORT[left.flags.backing],
      right: BACKING_LABELS_SHORT[right.flags.backing],
    },
    {
      label: "Peg target",
      left: PEG_LABELS_SHORT[left.flags.pegCurrency],
      right: PEG_LABELS_SHORT[right.flags.pegCurrency],
    },
    {
      label: "Yield-bearing",
      left: left.flags.yieldBearing ? "Yes" : "No",
      right: right.flags.yieldBearing ? "Yes" : "No",
    },
    {
      label: "Blacklist controls",
      left: describeBlacklistability(left),
      right: describeBlacklistability(right),
    },
    {
      label: "Reserve signal",
      left: describeReserveSignal(left),
      right: describeReserveSignal(right),
    },
    {
      label: "Tracked chains",
      left: `${left.contracts?.length ?? 0} deployments`,
      right: `${right.contracts?.length ?? 0} deployments`,
    },
  ];
}
