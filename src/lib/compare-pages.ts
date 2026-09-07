import { BACKING_LABELS_SHORT, GOVERNANCE_LABELS, PEG_LABELS_SHORT } from "@shared/lib/classification";
import { SITE_ORIGIN as SITE_URL } from "@shared/lib/runtime-origins";
import { FROZEN_IDS, TRACKED_META_BY_ID } from "@shared/lib/stablecoins/registry";
import type { StablecoinMeta } from "@shared/types";
import { getResolvedBlacklistStatus } from "@/lib/blacklist-status";
import { STATIC_COMPARE_PAIRS, buildLiveCompareUrl, buildStaticComparisonSlug } from "@/lib/compare-links";
import { trimTextAtWordBoundary } from "@/lib/page-metadata";
import { buildPharosUrnJsonLdIdentifier } from "@/lib/pharos-urn-json-ld";
import { buildStablecoinUrl } from "@shared/lib/urls";

export { STATIC_COMPARE_PAIRS };

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
  editorial?: ComparisonEditorial;
}

interface ComparisonEditorial {
  updatedAt: string;
  sourcesCheckedAt: string;
  intro: string;
  answer: string;
  sections: {
    question: string;
    answer: string;
    sources: { label: string; href: string }[];
  }[];
}

const COMPARISON_EDITORIAL: Record<string, ComparisonEditorial> = {
  "usdc-circle-vs-usdg-paxos": {
    updatedAt: "2026-09-06",
    sourcesCheckedAt: "2026-09-06",
    intro: "USDC and Global Dollar (USDG) both target one US dollar. Circle and Paxos operate separate issuance and redemption arrangements, so the practical comparison starts with reserve disclosures and the cash-out route available to you.",
    answer: "USDC is Circle's dollar token; USDG is Paxos's Global Dollar. Both use dollar-denominated reserves, but holding either token does not by itself establish access to its issuer's direct redemption service. Compare the applicable account terms and the liquidity on the chain and venue you use.",
    sections: [
      {
        question: "How do USDC and USDG reserves compare?",
        answer: "Circle says most USDC reserves are invested in the Circle Reserve Fund, a government money market fund. Paxos describes USDG reserves as US dollar deposits, US Treasuries and cash equivalents. These asset categories alone do not establish a safety ranking: report dates, custodians and access to the reserves during stress also matter.",
        sources: [
          { label: "Circle: USDC reserves", href: "https://www.circle.com/usdc" },
          { label: "Paxos: mint and redeem", href: "https://www.paxos.com/mint-and-redeem" },
        ],
      },
      {
        question: "Can every holder redeem USDC or USDG directly for dollars?",
        answer: "Direct redemption and selling on an exchange are different exit routes. Circle's terms distinguish customer categories and make redemption subject to applicable eligibility and compliance requirements. Paxos also sets issuer-specific terms for its dollar stablecoins. Check the terms that apply to your jurisdiction and account; an exchange balance is not proof of a direct issuer account or an immediate bank payout.",
        sources: [
          { label: "Circle: USDC terms", href: "https://www.circle.com/legal/usdc-terms" },
          { label: "Paxos: dollar stablecoin terms", href: "https://www.paxos.com/terms-and-conditions/stablecoin-terms-conditions" },
        ],
      },
    ],
  },
  "usde-ethena-vs-susde-ethena": {
    updatedAt: "2026-09-06",
    sourcesCheckedAt: "2026-09-06",
    intro: "USDe is Ethena's synthetic dollar. sUSDe represents USDe deposited in Ethena's staking vault, where distributed rewards accrue to the vault share. The distinction is the staking layer and its exit mechanics, not two independent reserve systems.",
    answer: "sUSDe adds a reward-accruing vault position on top of USDe. It retains exposure to the underlying USDe system and adds staking-contract and unstaking constraints. Its value in USDe can rise as rewards accrue, so a price above one dollar is not automatically a peg premium.",
    sections: [
      {
        question: "Why can one sUSDe be worth more than one USDe?",
        answer: "Ethena's staking vault receives USDe rewards. Those rewards increase the USDe represented by each sUSDe share instead of requiring the token balance to grow. Compare sUSDe's market price with its current redeemable USDe value, then account for USDe's own dollar price. A fixed one-dollar comparison misses the accrued rewards.",
        sources: [
          { label: "Ethena: staking USDe", href: "https://docs.ethena.fi/solution-design/staking-usde" },
        ],
      },
      {
        question: "How do the exit routes and risks differ?",
        answer: "Ethena documents an unstaking cooldown before the resulting USDe can be withdrawn; the duration is configurable, so check the current setting before unstaking. Selling sUSDe on a secondary market instead depends on available liquidity and price. Both tokens remain exposed to Ethena's underlying funding, custody and exchange risks. Staking rewards do not remove those exposures or guarantee a return.",
        sources: [
          { label: "Ethena: staking controls", href: "https://docs.ethena.fi/solution-design/staking-usde/staking-key-functions" },
          { label: "Ethena: underlying system risks", href: "https://docs.ethena.fi/solution-overview/risks" },
        ],
      },
    ],
  },
  "paxg-paxos-vs-xaut-tether": {
    updatedAt: "2026-09-06",
    sourcesCheckedAt: "2026-09-06",
    intro: "PAX Gold (PAXG) and Tether Gold (XAUT) represent exposure to physical gold rather than a fixed US dollar. Each issuer describes one token as representing one fine troy ounce. Custody, allocation records and redemption conditions distinguish the two products.",
    answer: "PAXG and XAUT share a gold reference, but their issuers and delivery arrangements differ. Paxos describes allocated gold held in London vaults; Tether Gold provides physical delivery in Switzerland under its redemption terms. Neither token is a dollar-stable substitute: its dollar value moves with gold as well as any token-market discount or premium.",
    sections: [
      {
        question: "What gold claim does each token represent?",
        answer: "Paxos describes PAXG as ownership of one fine troy ounce of allocated gold held in London vaults, with a wallet-based allocation lookup. Tether Gold's terms describe an undivided fine troy ounce within a specific bar. Allocation records help identify the backing, but holders still depend on the issuer and physical custody arrangements; a token transfer does not deliver a gold bar.",
        sources: [
          { label: "Paxos: PAX Gold and allocation lookup", href: "https://www.paxos.com/pax-gold" },
          { label: "Tether Gold: ownership and redemption terms", href: "https://gold.tether.to/legal/" },
        ],
      },
      {
        question: "Can a small holder redeem either token for physical gold?",
        answer: "Fractional token ownership should not be confused with fractional-bar delivery. Paxos describes redemption for Good Delivery bullion bars and a USD route at market prices. Tether Gold makes physical redemption subject to verification, minimum size and fees, with delivery in Switzerland or a broker-assisted potential sale. Check current minimums, fees and destination restrictions before treating physical redemption as an available exit.",
        sources: [
          { label: "Paxos: PAXG redemption options", href: "https://www.paxos.com/pax-gold" },
          { label: "Tether Gold: redemption conditions", href: "https://gold.tether.to/legal/" },
        ],
      },
    ],
  },
};

export interface ComparisonFaqItem {
  question: string;
  answer: string;
}

export interface ComparisonSnippetAnswer {
  question: string;
  answer: string;
  caveat: string;
}

function getStablecoinOrThrow(id: string): StablecoinMeta {
  const coin = TRACKED_META_BY_ID.get(id);
  if (!coin) {
    throw new Error(`Missing stablecoin metadata for static comparison page: ${id}`);
  }
  return coin;
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

    const slug = buildStaticComparisonSlug(leftId, rightId);
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

function describeStaticSafetyLens(coin: StablecoinMeta): string {
  return `${coin.symbol}: ${GOVERNANCE_LABELS[coin.flags.governance]} governance, ${BACKING_LABELS_SHORT[coin.flags.backing]} backing, ${describeBlacklistability(coin)}, ${describeReserveSignal(coin)}.`;
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
    `${left.symbol} vs ${right.symbol} comparison: peg stability, liquidity, reserves, blacklist controls, chain reach, and live Pharos risk signals for ${left.name} and ${right.name}.`,
    160,
  );
}

function buildStaticComparisonPages(): StaticComparisonPage[] {
  return STATIC_COMPARE_PAIRS.map(([leftId, rightId]) => {
    const left = getStablecoinOrThrow(leftId);
    const right = getStablecoinOrThrow(rightId);
    const shortTitle = `${left.symbol} vs ${right.symbol}`;
    const slug = buildStaticComparisonSlug(left.id, right.id);
    const editorial = COMPARISON_EDITORIAL[slug];
    return {
      slug,
      href: `/compare/${slug}/`,
      title: `${shortTitle}: Risk, Reserves & Liquidity Compared`,
      shortTitle,
      description: buildComparisonDescription(left, right),
      intro: editorial?.intro ?? buildComparisonIntro(left, right),
      summary: buildComparisonSummary(left, right),
      left,
      right,
      ...(editorial ? { editorial } : {}),
    };
  });
}

// Both `assertStaticComparePairs()` and `buildStaticComparisonPages()` run at
// module evaluation (Next.js build time). A bare throw here surfaces as an
// opaque bundler-wrapped stack, so wrap it to prepend an actionable prefix
// pointing back at the STATIC_COMPARE_PAIRS source before re-throwing.
function buildStaticComparisonPagesOrThrow(): StaticComparisonPage[] {
  try {
    assertStaticComparePairs();
    return buildStaticComparisonPages();
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    throw new Error(
      `[compare-pages] Invalid STATIC_COMPARE_PAIRS (see src/lib/compare-links.ts): ${detail}`,
      error instanceof Error ? { cause: error } : undefined,
    );
  }
}

export const STATIC_COMPARISON_PAGES: StaticComparisonPage[] = buildStaticComparisonPagesOrThrow();

export const STATIC_COMPARISON_PAGE_BY_SLUG = new Map(STATIC_COMPARISON_PAGES.map((page) => [page.slug, page]));

export function getStaticComparisonPagesForCoin(coinId: string): StaticComparisonPage[] {
  return STATIC_COMPARISON_PAGES
    .filter((page) => page.left.id === coinId || page.right.id === coinId)
    .sort((left, right) => Number(Boolean(right.editorial)) - Number(Boolean(left.editorial)));
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
      href: "/depeg/",
      label: "Review peg history and active depegs",
    },
    {
      href: "/flows/",
      label: "Check mint/burn pressure",
    },
    {
      href: "/yield/",
      label: "Review yield context",
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

export function buildComparisonSnippetAnswer(page: StaticComparisonPage): ComparisonSnippetAnswer {
  const { left, right } = page;
  if (page.editorial) {
    return {
      question: `What is the main difference between ${left.symbol} and ${right.symbol}?`,
      answer: page.editorial.answer,
      caveat: `Sources checked ${page.editorial.sourcesCheckedAt}; see the linked issuer documentation below. Open the live ${page.shortTitle} compare tool for current market data. This brief does not rank either token as categorically safer.`,
    };
  }
  const sameBroadLabels =
    left.flags.governance === right.flags.governance && left.flags.backing === right.flags.backing;

  return {
    question: `Which is safer, ${left.symbol} or ${right.symbol}?`,
    answer: sameBroadLabels
      ? `There is no honest static answer that makes ${left.symbol} or ${right.symbol} categorically safer. They share the same broad Pharos governance and backing labels, so the useful read is in live peg behavior, liquidity depth, reserve freshness, issuer controls, and dependency exposure.`
      : `The safer choice is context-dependent, not a ticker-level fact. Static metadata frames the tradeoff this way: ${describeStaticSafetyLens(left)} ${describeStaticSafetyLens(right)}`,
    caveat: `Open the live ${page.shortTitle} compare tool before acting; peg, liquidity, reserve, flow, and Safety Score data can change after this static brief is generated.`,
  };
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

function buildComparisonCoinThingJsonLd(coin: StablecoinMeta) {
  const url = `${SITE_URL}${buildStablecoinUrl(coin.id)}`;

  return {
    "@type": "Thing",
    "@id": `${url}#stablecoin`,
    name: coin.name,
    alternateName: coin.symbol,
    url,
    identifier: [buildPharosUrnJsonLdIdentifier("coin", coin.id)],
  };
}

export function buildStaticComparisonJsonLd(page: StaticComparisonPage) {
  const pageUrl = `${SITE_URL}${page.href}`;
  const itemListId = `${pageUrl}#comparison-rows`;
  const leftThing = buildComparisonCoinThingJsonLd(page.left);
  const rightThing = buildComparisonCoinThingJsonLd(page.right);
  const rows = buildComparisonAtAGlanceRows(page);

  return [
    {
      "@context": "https://schema.org",
      "@type": "WebPage",
      "@id": `${pageUrl}#webpage`,
      name: page.title,
      description: page.description,
      url: pageUrl,
      inLanguage: "en",
      isPartOf: { "@id": `${SITE_URL}#website` },
      about: [leftThing, rightThing],
      mainEntity: { "@id": itemListId },
    },
    {
      "@context": "https://schema.org",
      "@type": "ItemList",
      "@id": itemListId,
      name: `${page.shortTitle} structural comparison rows`,
      numberOfItems: rows.length,
      itemListElement: rows.map((row, index) => ({
        "@type": "ListItem",
        position: index + 1,
        item: {
          "@type": "PropertyValue",
          name: row.label,
          value: `${page.left.symbol}: ${row.left}; ${page.right.symbol}: ${row.right}`,
        },
      })),
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
      answer: page.editorial?.answer ?? (
        left.flags.backing === right.flags.backing && left.flags.governance === right.flags.governance
          ? `${leftDescriptor} and ${rightDescriptor} share the same broad governance and backing labels in Pharos, so the useful comparison is in the live details: peg history, liquidity depth, reserve signal, issuer controls, chain deployments, and dependency exposure.`
          : `${leftDescriptor} and ${rightDescriptor} differ structurally: ${left.symbol} is ${GOVERNANCE_LABELS[left.flags.governance].toLowerCase()} and ${BACKING_LABELS_SHORT[left.flags.backing].toLowerCase()}, while ${right.symbol} is ${GOVERNANCE_LABELS[right.flags.governance].toLowerCase()} and ${BACKING_LABELS_SHORT[right.flags.backing].toLowerCase()}.`),
    },
    {
      question: `Which is safer: ${left.symbol} or ${right.symbol}?`,
      answer: `Safety is not decided by ticker alone. Use this static page for the structural comparison, then open the live ${page.shortTitle} compare tool and Safety Scores page for current V9 Backing, Exit, and Economic Control pillars plus peg behavior, dependency exposure, evidence quality, and structural caps.`,
    },
    {
      question: `Where can I compare current ${left.symbol} and ${right.symbol} data?`,
      answer: `Open the live ${page.shortTitle} comparison from this page to see current peg behavior, liquidity, flows, and Safety Scores. Use this brief to understand the structural differences, then check each coin's latest evidence before making a decision.`,
    },
  ];
}
