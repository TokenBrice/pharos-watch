import { BACKING_LABELS_SHORT, GOVERNANCE_LABELS, PEG_LABELS_SHORT } from "@shared/lib/classification";
import { FROZEN_IDS, TRACKED_META_BY_ID } from "@shared/lib/stablecoins/registry";
import type { StablecoinMeta } from "@shared/types";
import { getResolvedBlacklistStatus } from "@/lib/blacklist-status";
import { trimTextAtWordBoundary } from "@/lib/page-metadata";
import { buildStablecoinUrl } from "@/lib/urls";

export const STATIC_COMPARE_PAIRS = [
  ["usdt-tether", "usdc-circle"],
  ["usdt-tether", "usde-ethena"],
  ["usdt-tether", "dai-makerdao"],
  ["usdt-tether", "usds-sky"],
  ["usdc-circle", "usde-ethena"],
  ["usdc-circle", "dai-makerdao"],
  ["usdc-circle", "usds-sky"],
  ["usde-ethena", "dai-makerdao"],
  ["usde-ethena", "usds-sky"],
  ["usds-sky", "dai-makerdao"],
  ["rlusd-ripple", "usdc-circle"],
  ["usdt-tether", "pyusd-paypal"],
  ["usdt-tether", "rlusd-ripple"],
  ["usdc-circle", "pyusd-paypal"],
  ["usdt-tether", "fdusd-first-digital"],
  ["usdc-circle", "fdusd-first-digital"],
  ["usdt-tether", "frax-frax"],
  ["usdc-circle", "frax-frax"],
  ["dai-makerdao", "gho-aave"],
  ["dai-makerdao", "crvusd-curve"],
  ["gho-aave", "crvusd-curve"],
  ["usdt-tether", "usd0-usual"],
  ["usdc-circle", "usd0-usual"],
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
  summary: string;
  left: StablecoinMeta;
  right: StablecoinMeta;
}

export interface ComparisonFaqItem {
  question: string;
  answer: string;
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

function assertStaticComparePairs() {
  const slugs = new Set<string>();
  const unorderedKeys = new Set<string>();

  for (const [leftId, rightId] of STATIC_COMPARE_PAIRS) {
    if (leftId === rightId) {
      throw new Error(`Static comparison pair cannot compare a coin with itself: ${leftId}`);
    }
    if (FROZEN_IDS.has(leftId) || FROZEN_IDS.has(rightId)) {
      throw new Error(`Static comparison pair includes frozen stablecoin: ${leftId} vs ${rightId}`);
    }

    const slug = `${leftId}-vs-${rightId}`;
    if (slugs.has(slug)) {
      throw new Error(`Duplicate static comparison slug: ${slug}`);
    }
    slugs.add(slug);

    const unorderedKey = [leftId, rightId].sort().join("::");
    if (unorderedKeys.has(unorderedKey)) {
      throw new Error(`Duplicate static comparison pair: ${leftId} vs ${rightId}`);
    }
    unorderedKeys.add(unorderedKey);
  }
}

function describeBlacklistability(coin: StablecoinMeta): string {
  const status = getResolvedBlacklistStatus(coin.id);
  if (status === true) return "Issuer blacklist controls";
  if (status === "dilutable") return "Admin can dilute holders via unbounded mint";
  if (status === "inherited") return "Upstream freeze exposure";
  if (status === "possible") return "Blacklist or freeze exposure possible";
  return "No clear blacklist signal";
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

  const yieldSentence =
    left.flags.yieldBearing === right.flags.yieldBearing
      ? left.flags.yieldBearing
        ? "Both are yield-bearing or yield-forward designs, so raw APY needs to be weighed against issuer, collateral, and liquidity risk."
        : "Neither token is primarily a yield-bearing wrapper, so the comparison centers on collateral, issuer controls, liquidity, and peg behavior."
      : `${left.symbol} is ${left.flags.yieldBearing ? "yield-bearing" : "not yield-bearing"}, while ${right.symbol} is ${right.flags.yieldBearing ? "yield-bearing" : "not yield-bearing"}.`;

  return `${left.name} and ${right.name} are two widely followed stablecoins. ${pegSentence} ${governanceSentence} ${backingSentence} ${yieldSentence} This static comparison highlights structural differences before you open the live Pharos compare tool.`;
}

function buildComparisonSummary(left: StablecoinMeta, right: StablecoinMeta): string {
  const leftChains = left.contracts?.length ?? 0;
  const rightChains = right.contracts?.length ?? 0;
  const chainSentence =
    leftChains === rightChains
      ? `Both have ${leftChains} tracked deployments in Pharos.`
      : `${left.symbol} has ${leftChains} tracked deployments, while ${right.symbol} has ${rightChains}.`;
  const reserveSentence =
    left.flags.backing === right.flags.backing
      ? `Both sit in the ${BACKING_LABELS_SHORT[left.flags.backing].toLowerCase()} cohort.`
      : `${left.symbol} is ${BACKING_LABELS_SHORT[left.flags.backing].toLowerCase()}, while ${right.symbol} is ${BACKING_LABELS_SHORT[right.flags.backing].toLowerCase()}.`;

  return `${chainSentence} ${reserveSentence} Use the rows below to separate headline market share from the mechanics that matter during stress: redemption path, reserve signal, blacklistability, and venue depth.`;
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

assertStaticComparePairs();

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
    summary: buildComparisonSummary(left, right),
    left,
    right,
  };
});

export const STATIC_COMPARISON_PAGE_BY_SLUG = new Map(STATIC_COMPARISON_PAGES.map((page) => [page.slug, page]));

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
    {
      href: "/safety-scores/",
      label: "Compare live Safety Scores and contagion exposure",
    },
    {
      href: "/liquidity/",
      label: "Check DEX liquidity depth before sizing an exit",
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
      label: "Governance + backing lens",
      left: `${GOVERNANCE_LABELS[left.flags.governance]} / ${BACKING_LABELS_SHORT[left.flags.backing]}`,
      right: `${GOVERNANCE_LABELS[right.flags.governance]} / ${BACKING_LABELS_SHORT[right.flags.backing]}`,
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

export function buildComparisonFaqItems(page: StaticComparisonPage): ComparisonFaqItem[] {
  const { left, right } = page;
  const leftDescriptor = `${left.name} (${left.symbol})`;
  const rightDescriptor = `${right.name} (${right.symbol})`;

  return [
    {
      question: `What is the main difference between ${left.symbol} and ${right.symbol}?`,
      answer:
        left.flags.backing === right.flags.backing && left.flags.governance === right.flags.governance
          ? `${leftDescriptor} and ${rightDescriptor} share the same broad governance and backing labels in Pharos, so the useful comparison is in the live details: peg history, liquidity depth, reserve signal, issuer controls, chain deployments, and dependency exposure.`
          : `${leftDescriptor} and ${rightDescriptor} differ structurally: ${left.symbol} is ${GOVERNANCE_LABELS[left.flags.governance].toLowerCase()} and ${BACKING_LABELS_SHORT[left.flags.backing].toLowerCase()}, while ${right.symbol} is ${GOVERNANCE_LABELS[right.flags.governance].toLowerCase()} and ${BACKING_LABELS_SHORT[right.flags.backing].toLowerCase()}.`,
    },
    {
      question: `Which is safer: ${left.symbol} or ${right.symbol}?`,
      answer: `Safety is not decided by ticker alone. Use this static page for the structural comparison, then open the live ${page.shortTitle} compare tool and Safety Scores page for current peg behavior, liquidity / exit capacity, dependency risk, resilience, and decentralization scoring.`,
    },
    {
      question: `Why does Pharos keep a static ${left.symbol} vs ${right.symbol} page?`,
      answer: `This page gives crawlers and readers a stable overview of the ${left.symbol} vs ${right.symbol} question while the live dashboard keeps volatile metrics fresh. It intentionally covers a capped set of high-intent comparisons instead of generating every possible stablecoin pair.`,
    },
  ];
}
