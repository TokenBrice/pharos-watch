import {
  BACKING_LABELS_SHORT,
  GOVERNANCE_LABELS,
  LIABILITY_RECONCILIATION_LABELS,
  PROOF_ASSURANCE_METHOD_LABELS,
  PROOF_ASSURANCE_SCOPE_LABELS,
  REDEMPTION_HOLDER_ELIGIBILITY_LABELS,
  getProfilePegLabel,
  getProofOfReservesStyle,
} from "@shared/lib/classification";
import { SITE_ORIGIN as SITE_URL } from "@shared/lib/runtime-origins";
import { FROZEN_IDS, TRACKED_META_BY_ID } from "@shared/lib/stablecoins/registry";
import { resolveDefaultHolderEligibility } from "@shared/lib/redemption-backstop-configs/shared";
import type { RedemptionBackstopConfig } from "@shared/lib/redemption-backstop-configs/shared";
import type { RedemptionDocSourceSupport, StablecoinMeta } from "@shared/types";
import { isValidIsoDateOnly } from "@shared/types/date-primitives";
import { getResolvedBlacklistStatus } from "@shared/lib/blacklist-status";
import { STATIC_COMPARE_PAIRS, buildComparePrefillUrl, buildStaticComparisonSlug } from "@/lib/compare-links";
import { PUBLIC_DATASET_CURRENT_DATE } from "@/lib/datasets/public-dataset-current";
import { trimTextAtWordBoundary } from "@/lib/page-metadata";
import { getCurrentRedemptionConfig } from "@/lib/redemption-review-currency";
import { getSnapshotSafetyAssessment, type SnapshotSafetyAssessment } from "@/lib/safety-grade-snapshot";
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


/** Lowercase a backing label for prose, but keep acronyms such as "RWA" intact. */
function formatCohortLabel(label: string): string {
  return label.split(" ").map((word) => (word === word.toUpperCase() ? word : word.toLowerCase())).join(" ");
}

export function assertStaticComparePairs() {
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
  // The storage type cannot distinguish an examination from an audit, so the
  // blanket "{provider} attestations" label is replaced by the shared resolver.
  const proofStyle = getProofOfReservesStyle(coin.proofOfReserves);
  if (proofStyle) return proofStyle.label;
  if (coin.collateral) return coin.collateral.split(/[.;]/)[0]?.trim() ?? "Collateral profile disclosed";
  return "Collateral profile disclosed";
}

function describeStaticSafetyLens(coin: StablecoinMeta): string {
  return `${coin.symbol}: ${GOVERNANCE_LABELS[coin.flags.governance]} governance, ${BACKING_LABELS_SHORT[coin.flags.backing]} backing, ${describeBlacklistability(coin)}, ${describeReserveSignal(coin)}.`;
}

// Dated grades come from the same scores-latest release mirror the profile
// static HTML cites, so a compare page and its two profiles always agree.
interface ComparisonGrades {
  asOf: string;
  left: SnapshotSafetyAssessment;
  right: SnapshotSafetyAssessment;
}

function getComparisonGrades(left: StablecoinMeta, right: StablecoinMeta): ComparisonGrades | null {
  const leftAssessment = getSnapshotSafetyAssessment(left.id);
  const rightAssessment = getSnapshotSafetyAssessment(right.id);
  if (!leftAssessment || !rightAssessment) return null;
  return { asOf: PUBLIC_DATASET_CURRENT_DATE, left: leftAssessment, right: rightAssessment };
}

function formatGradeScore(assessment: SnapshotSafetyAssessment): string {
  return assessment.score !== null ? `${assessment.grade} ${assessment.score}/100` : assessment.grade;
}

function formatGradeClause(assessment: SnapshotSafetyAssessment): string {
  const article = assessment.grade.startsWith("A") || assessment.grade === "F" ? "an" : "a";
  return assessment.score !== null
    ? `${article} ${assessment.grade} Safety Score grade (${assessment.score}/100)`
    : `${article} ${assessment.grade} Safety Score grade`;
}

function describeCoinWithGrade(coin: StablecoinMeta, assessment: SnapshotSafetyAssessment): string {
  const sameNameAndSymbol = coin.name.trim().toLowerCase() === coin.symbol.trim().toLowerCase();
  return sameNameAndSymbol
    ? `${coin.symbol} (${formatGradeScore(assessment)})`
    : `${coin.name} (${coin.symbol}, ${formatGradeScore(assessment)})`;
}

function buildComparisonGradeSentence(left: StablecoinMeta, right: StablecoinMeta, grades: ComparisonGrades): string {
  return `In the Pharos Safety Score release of ${grades.asOf}, ${left.symbol} held ${formatGradeClause(grades.left)} and ${right.symbol} held ${formatGradeClause(grades.right)}.`;
}

function comparisonPegLabel(coin: StablecoinMeta): string {
  return getProfilePegLabel(
    coin.flags,
    coin.pegReferenceId ? TRACKED_META_BY_ID.get(coin.pegReferenceId)?.symbol : undefined,
  );
}

function buildComparisonIntro(left: StablecoinMeta, right: StablecoinMeta): string {
  const leftPegLabel = comparisonPegLabel(left);
  const rightPegLabel = comparisonPegLabel(right);
  const pegSentence =
    leftPegLabel === rightPegLabel
      ? `Both target the ${leftPegLabel}.`
      : `${left.symbol} targets ${leftPegLabel}, while ${right.symbol} targets ${rightPegLabel}.`;
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
      ? `Both sit in the ${formatCohortLabel(BACKING_LABELS_SHORT[left.flags.backing])} cohort.`
      : `${left.symbol} is ${BACKING_LABELS_SHORT[left.flags.backing].toLowerCase()}, while ${right.symbol} is ${BACKING_LABELS_SHORT[right.flags.backing].toLowerCase()}.`;

  return `${chainSentence} ${reserveSentence} Use the rows below to separate headline market share from the mechanics that matter during stress: redemption path, reserve signal, blacklistability, and venue depth.`;
}

function buildComparisonDescription(left: StablecoinMeta, right: StablecoinMeta): string {
  const grades = getComparisonGrades(left, right);
  if (grades) {
    return trimTextAtWordBoundary(
      `${describeCoinWithGrade(left, grades.left)} vs ${describeCoinWithGrade(right, grades.right)}, Safety Scores as of ${grades.asOf}: reserves, redemption, freeze controls and chain reach.`,
      160,
    );
  }
  return trimTextAtWordBoundary(
    `${left.symbol} vs ${right.symbol} comparison: peg stability, liquidity, reserves, blacklist controls, chain reach, and live Pharos risk signals for ${left.name} and ${right.name}.`,
    160,
  );
}

// Fits about 60 characters once the root " | Pharos" suffix is added.
const COMPARISON_TITLE_MAX_LENGTH = 51;

export function buildComparisonTitle(shortTitle: string): string {
  const title = `${shortTitle}: Safety Scores, Reserves & Risk`;
  return title.length <= COMPARISON_TITLE_MAX_LENGTH ? title : `${shortTitle}: Safety Scores & Risk`;
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
      title: buildComparisonTitle(shortTitle),
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

/**
 * The bounded W2/C8 evidence pilot. Reviewed report and redemption facts are
 * projected only for these registered pairs; every other pair keeps its
 * existing structural rows.
 */
export const COMPARISON_EVIDENCE_PILOT_SLUGS: ReadonlySet<string> = new Set([
  "usdc-circle-vs-usdg-paxos",
  "usdt-tether-vs-usdg-paxos",
  "rlusd-ripple-vs-usdc-circle",
  "paxg-paxos-vs-xaut-tether",
  "usdt-tether-vs-usdc-circle",
  "usde-ethena-vs-usds-sky",
]);

for (const slug of COMPARISON_EVIDENCE_PILOT_SLUGS) {
  if (!STATIC_COMPARISON_PAGE_BY_SLUG.has(slug)) {
    throw new Error(`[compare-pages] Evidence-row pilot slug is not a registered static comparison page: ${slug}`);
  }
}

export function getStaticComparisonPagesForCoin(coinId: string): StaticComparisonPage[] {
  return STATIC_COMPARISON_PAGES
    .filter((page) => page.left.id === coinId || page.right.id === coinId)
    .sort((left, right) => Number(Boolean(right.editorial)) - Number(Boolean(left.editorial)));
}

export function buildComparisonResearchLinks(page: StaticComparisonPage) {
  return [
    {
      href: buildStablecoinUrl(page.left.id),
      label: `${page.left.name} (${page.left.symbol}) profile`,
    },
    {
      href: buildStablecoinUrl(page.right.id),
      label: `${page.right.name} (${page.right.symbol}) profile`,
    },
    {
      href: buildComparePrefillUrl([page.left.id, page.right.id]),
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
      href: "/dependency-map/",
      label: "Trace collateral and wrapper dependencies",
    },
    {
      href: "/liquidity/",
      label: "Check DEX liquidity depth before sizing an exit",
    },
  ];
}

export function buildComparisonSnippetAnswer(page: StaticComparisonPage): ComparisonSnippetAnswer {
  const { left, right } = page;
  const grades = getComparisonGrades(left, right);
  const gradeSentence = grades ? buildComparisonGradeSentence(left, right, grades) : null;
  if (page.editorial) {
    return {
      question: `What is the main difference between ${left.symbol} and ${right.symbol}?`,
      answer: gradeSentence ? `${page.editorial.answer} ${gradeSentence}` : page.editorial.answer,
      caveat: `Sources checked ${page.editorial.sourcesCheckedAt}; see the linked issuer documentation below. Open the live ${page.shortTitle} compare tool for current market data. This brief does not rank either token as categorically safer.`,
    };
  }
  const sameBroadLabels =
    left.flags.governance === right.flags.governance && left.flags.backing === right.flags.backing;

  const structuralAnswer = sameBroadLabels
    ? `There is no honest static answer that makes ${left.symbol} or ${right.symbol} categorically safer. They share the same broad Pharos governance and backing labels, so the useful read is in live peg behavior, liquidity depth, reserve freshness, issuer controls, and dependency exposure.`
    : `The safer choice is context-dependent, not a ticker-level fact. Static metadata frames the tradeoff this way: ${describeStaticSafetyLens(left)} ${describeStaticSafetyLens(right)}`;

  return {
    question: `Which is safer, ${left.symbol} or ${right.symbol}?`,
    answer: gradeSentence ? `${gradeSentence} ${structuralAnswer}` : structuralAnswer,
    caveat: `Open the live ${page.shortTitle} compare tool before acting; peg, liquidity, reserve, flow, and Safety Score data can change after this static brief is generated.`,
  };
}

export interface ComparisonRowSource {
  label: string;
  href: string;
}

export interface ComparisonRow {
  label: string;
  left: string;
  right: string;
  leftSources?: ComparisonRowSource[];
  rightSources?: ComparisonRowSource[];
}

export interface ComparisonEvidenceRow {
  label: string;
  left: string | null;
  right: string | null;
  leftSources?: ComparisonRowSource[];
  rightSources?: ComparisonRowSource[];
}

/**
 * The reviewed evidence rows, in the order they follow `Reserve signal`. The
 * route's table note switches to the evidence-scoped wording only when one of
 * these rows is actually present, so structural-only pairs keep their original
 * provenance note.
 */
const COMPARISON_EVIDENCE_ROW_LABELS = {
  reportPeriod: "Latest reviewed report period",
  assuranceScope: "Assurance scope",
  eligibility: "Direct redemption eligibility",
  minimum: "Redemption minimum",
  feeBasis: "Redemption fee basis",
} as const;

const COMPARISON_EVIDENCE_ROW_LABEL_SET: ReadonlySet<string> = new Set(
  Object.values(COMPARISON_EVIDENCE_ROW_LABELS),
);

/** Whether this page's row projection admitted at least one reviewed evidence row. */
export function hasComparisonEvidenceRows(rows: readonly ComparisonRow[]): boolean {
  return rows.some((row) => COMPARISON_EVIDENCE_ROW_LABEL_SET.has(row.label));
}

const NOT_RECORDED = "Not recorded";
const SUSPENDED_ROUTE_ELIGIBILITY = "Route suspended";

interface ComparisonFact {
  value: string;
  sources: ComparisonRowSource[];
}

interface ComparisonReportEvidence {
  period: string | null;
  scope: string;
  sources: ComparisonRowSource[];
}

/**
 * Audited display overrides for the pilot pairs. Each one only restates the
 * reviewed terms already carried by the redemption config: no new research
 * value or source authority enters here. `termsClock` names which reviewed
 * date the displayed terms actually belong to.
 */
interface ComparisonFeeBasisOverride {
  feeBasis: string;
  termsClock: "config" | "route-review-terms" | "physical";
}

const COMPARISON_FEE_BASIS_OVERRIDES: Readonly<Record<string, ComparisonFeeBasisOverride>> = {
  // Keep the percentage distinct from its fee minimum, and that minimum
  // distinct from the $100,000 redemption minimum.
  "usdt-tether": {
    feeBasis: "0.10%, with a minimum fee of $1,000",
    termsClock: "config",
  },
  // Compact standard tariff with the controlling private-pricing and
  // third-party-cost qualifications retained; never an all-in ceiling.
  "paxg-paxos": {
    feeBasis:
      "Standard tariff effective 2026-09-01: 12.5-50 bps on rolling-30-day net redemptions, plus 5 bps for in-kind gold conversion. Customer-specific pricing may override it; delivery, dealer, tax and bank costs are separate.",
    termsClock: "route-review-terms",
  },
  // The physical issuer fee, never the delivery model's default zeros.
  "xaut-tether": {
    feeBasis: "25 bps issuer redemption fee, plus delivery and applicable fees",
    termsClock: "physical",
  },
  // Compact semantic projection of the reviewed USDe fee description.
  "usde-ethena": {
    feeBasis: "10 bps for USDT/USDC redemption under the reviewed USDe terms",
    termsClock: "config",
  },
};

function isHttpSourceUrl(url: string): boolean {
  return url.startsWith("http://") || url.startsWith("https://");
}

/**
 * Citations point readers at a human-readable page. Machine JSON endpoints
 * (an `/api/` path segment, an `api.` host or a `.json` file) are never
 * rendered as a public source: a fact whose only citation is one of those is
 * withheld rather than published with an unreadable link.
 */
function isCitationPageUrl(url: string): boolean {
  if (!isHttpSourceUrl(url)) return false;
  try {
    const parsed = new URL(url);
    if (/\.json$/i.test(parsed.pathname)) return false;
    if (parsed.hostname.toLowerCase().startsWith("api.")) return false;
    return !parsed.pathname.toLowerCase().split("/").includes("api");
  } catch {
    return false;
  }
}

function toCitationSources(
  sources: readonly { label: string; url: string }[],
): ComparisonRowSource[] {
  return sources
    .filter((source) => isCitationPageUrl(source.url))
    .map((source) => ({ label: source.label, href: source.url }));
}

function getComparisonReportEvidence(coin: StablecoinMeta): ComparisonReportEvidence | null {
  const report = coin.proofOfReserves?.latestReport;
  // The reviewed structured report is the authority: never infer a period or
  // scope from the storage type, provider note or build date.
  if (!report || report.confidence !== "verified") return null;
  const sources = toCitationSources(report.sources);
  if (sources.length === 0) return null;
  return {
    period: report.periodEnd !== undefined && isValidIsoDateOnly(report.periodEnd) ? report.periodEnd : null,
    scope: `${PROOF_ASSURANCE_METHOD_LABELS[report.assuranceMethod]}; ${PROOF_ASSURANCE_SCOPE_LABELS[report.scope]}; ${LIABILITY_RECONCILIATION_LABELS[report.liabilityReconciliation]}`,
    sources,
  };
}

type RedemptionDoc = NonNullable<RedemptionBackstopConfig["docs"]>[number];

function docsSupporting(
  docs: readonly RedemptionDoc[] | undefined,
  support: RedemptionDocSourceSupport,
): ComparisonRowSource[] {
  return (docs ?? [])
    .filter((doc) => doc.supports?.includes(support))
    .filter((doc) => isCitationPageUrl(doc.url))
    .map((doc) => ({ label: doc.label, href: doc.url }));
}

function mergeRowSources(...groups: readonly ComparisonRowSource[][]): ComparisonRowSource[] {
  const seen = new Set<string>();
  const merged: ComparisonRowSource[] = [];
  for (const group of groups) {
    for (const source of group) {
      if (seen.has(source.href)) continue;
      seen.add(source.href);
      merged.push(source);
    }
  }
  return merged;
}

function formatUsdAmount(value: number): string {
  return `$${value.toLocaleString("en-US", { maximumFractionDigits: 2 })}`;
}

function formatTokenAmount(value: number): string {
  return value.toLocaleString("en-US", { maximumSignificantDigits: 4 });
}

function withReviewedDate(value: string, reviewedAt: string): string {
  // The review date is a parenthetical on the fact, so a value that already
  // ends a sentence keeps its full stop last: "… are separate (reviewed DATE)."
  const suffix = ` (reviewed ${reviewedAt})`;
  return value.endsWith(".") ? `${value.slice(0, -1)}${suffix}.` : `${value}${suffix}`;
}

function todayFromSeconds(nowSec: number): string {
  return new Date(nowSec * 1_000).toISOString().slice(0, 10);
}

function sourceLabelFromUrl(url: string): string {
  try {
    return new URL(url).hostname.replace(/^www\./u, "");
  } catch {
    return "Route suspension source";
  }
}

function resolvePhysicalMinimumTokens(
  config: RedemptionBackstopConfig,
  today: string,
): { tokens: number; reviewedAt: string } | null {
  const route = config.physicalToUsd;
  if (route) {
    // On the expiry day the review is still current; the following day is not.
    if (route.reviewExpiresAt < today) return null;
    const tokens = route.lot.minimumTokens ?? config.physicalCommodityDelivery?.minimumDeliveryTokens;
    return tokens == null ? null : { tokens, reviewedAt: route.reviewedAt };
  }
  const tokens = config.physicalCommodityDelivery?.minimumDeliveryTokens;
  if (tokens == null || !config.reviewedAt) return null;
  return { tokens, reviewedAt: config.reviewedAt };
}

function resolveRedemptionEligibility(config: RedemptionBackstopConfig, today: string): ComparisonFact | null {
  if (config.routeStatus === "suspended") {
    const suspension = config.routeSuspension;
    if (!suspension) return null;
    return {
      value: withReviewedDate(SUSPENDED_ROUTE_ELIGIBILITY, suspension.reviewedAt),
      sources: suspension.sources
        .filter((source) => isCitationPageUrl(source.url))
        .map((source) => ({ label: sourceLabelFromUrl(source.url), href: source.url })),
    };
  }
  const accessSources = docsSupporting(config.docs, "access");
  if (accessSources.length === 0) return null;
  const physicalRoute = config.physicalToUsd;
  if (physicalRoute) {
    if (physicalRoute.reviewExpiresAt < today) return null;
    // The config's access-scoped docs are the issuer terms; the physical
    // evidence array also carries LBMA and dealer-model sources that cannot
    // support an issuer eligibility claim.
    return {
      value: withReviewedDate(
        REDEMPTION_HOLDER_ELIGIBILITY_LABELS[physicalRoute.eligibility],
        physicalRoute.reviewedAt,
      ),
      sources: accessSources,
    };
  }
  const eligibility = config.holderEligibility ?? resolveDefaultHolderEligibility(config);
  if (eligibility === "unknown" || !config.reviewedAt) return null;
  return {
    value: withReviewedDate(REDEMPTION_HOLDER_ELIGIBILITY_LABELS[eligibility], config.reviewedAt),
    sources: accessSources,
  };
}

function resolveRedemptionMinimum(
  config: RedemptionBackstopConfig,
  coin: StablecoinMeta,
  today: string,
): ComparisonFact | null {
  const sources = mergeRowSources(
    docsSupporting(config.docs, "access"),
    docsSupporting(config.v9RouteReviewTerms?.docs, "access"),
  );
  if (sources.length === 0) return null;
  const reviewedMinimum = config.v9RouteReviewTerms?.minRedeemUsd;
  if (reviewedMinimum !== undefined) {
    if (!Number.isFinite(reviewedMinimum)) return null;
    const reviewedAt = config.v9RouteReviewTerms?.reviewedAt ?? config.reviewedAt;
    return reviewedAt ? { value: withReviewedDate(formatUsdAmount(reviewedMinimum), reviewedAt), sources } : null;
  }
  const physical = resolvePhysicalMinimumTokens(config, today);
  if (!physical) return null;
  return {
    value: withReviewedDate(
      `${formatTokenAmount(physical.tokens)} ${coin.symbol} deposit for a full bar; excess tokens returned`,
      physical.reviewedAt,
    ),
    sources,
  };
}

function resolveFeeBasisReviewedAt(
  override: ComparisonFeeBasisOverride,
  config: RedemptionBackstopConfig,
  today: string,
): string | null {
  switch (override.termsClock) {
    case "config":
      return config.reviewedAt ?? null;
    case "route-review-terms":
      return config.v9RouteReviewTerms?.reviewedAt ?? null;
    case "physical": {
      const route = config.physicalToUsd;
      if (!route || route.reviewExpiresAt < today) return null;
      return route.reviewedAt;
    }
  }
}

function resolveRedemptionFeeBasis(
  config: RedemptionBackstopConfig,
  coinId: string,
  today: string,
): ComparisonFact | null {
  const feeDescription = config.costModel.feeDescription?.trim();
  if (!feeDescription) return null;
  const sources = mergeRowSources(
    docsSupporting(config.docs, "fees"),
    docsSupporting(config.v9RouteReviewTerms?.docs, "fees"),
  );
  if (sources.length === 0) return null;
  const override = COMPARISON_FEE_BASIS_OVERRIDES[coinId];
  if (override) {
    const reviewedAt = resolveFeeBasisReviewedAt(override, config, today);
    return reviewedAt ? { value: withReviewedDate(override.feeBasis, reviewedAt), sources } : null;
  }
  if (!config.reviewedAt) return null;
  return { value: withReviewedDate(feeDescription, config.reviewedAt), sources };
}

interface ComparisonSideEvidence {
  report: ComparisonReportEvidence | null;
  eligibility: ComparisonFact | null;
  minimum: ComparisonFact | null;
  feeBasis: ComparisonFact | null;
}

function buildComparisonSideEvidence(coin: StablecoinMeta, nowSec: number, today: string): ComparisonSideEvidence {
  const config = getCurrentRedemptionConfig(coin.id, nowSec);
  return {
    report: getComparisonReportEvidence(coin),
    eligibility: config ? resolveRedemptionEligibility(config, today) : null,
    minimum: config ? resolveRedemptionMinimum(config, coin, today) : null,
    feeBasis: config ? resolveRedemptionFeeBasis(config, coin.id, today) : null,
  };
}

function appendComparisonEvidenceRow(
  rows: ComparisonEvidenceRow[],
  label: string,
  left: string | null,
  right: string | null,
  leftSources?: ComparisonRowSource[],
  rightSources?: ComparisonRowSource[],
): void {
  // A row with no evidenced side is omitted entirely, never rendered empty.
  if (left === null && right === null) return;
  rows.push({
    label,
    left,
    right,
    ...(left !== null && leftSources?.length ? { leftSources } : {}),
    ...(right !== null && rightSources?.length ? { rightSources } : {}),
  });
}

/**
 * Bounded source-linked evidence rows for the W2/C8 pilot pairs. Cells stay
 * `null` until the final row assembler turns them into "Not recorded", so a
 * one-sided omission is never mistaken for an observed value.
 */
export function buildComparisonEvidenceRows(
  page: StaticComparisonPage,
  nowSec = Math.floor(Date.now() / 1_000),
): ComparisonEvidenceRow[] {
  if (!COMPARISON_EVIDENCE_PILOT_SLUGS.has(page.slug)) return [];
  const today = todayFromSeconds(nowSec);
  const left = buildComparisonSideEvidence(page.left, nowSec, today);
  const right = buildComparisonSideEvidence(page.right, nowSec, today);
  const rows: ComparisonEvidenceRow[] = [];
  appendComparisonEvidenceRow(
    rows,
    COMPARISON_EVIDENCE_ROW_LABELS.reportPeriod,
    left.report?.period ?? null,
    right.report?.period ?? null,
    left.report?.sources,
    right.report?.sources,
  );
  appendComparisonEvidenceRow(
    rows,
    COMPARISON_EVIDENCE_ROW_LABELS.assuranceScope,
    left.report?.scope ?? null,
    right.report?.scope ?? null,
    left.report?.sources,
    right.report?.sources,
  );
  appendComparisonEvidenceRow(
    rows,
    COMPARISON_EVIDENCE_ROW_LABELS.eligibility,
    left.eligibility?.value ?? null,
    right.eligibility?.value ?? null,
    left.eligibility?.sources,
    right.eligibility?.sources,
  );
  appendComparisonEvidenceRow(
    rows,
    COMPARISON_EVIDENCE_ROW_LABELS.minimum,
    left.minimum?.value ?? null,
    right.minimum?.value ?? null,
    left.minimum?.sources,
    right.minimum?.sources,
  );
  appendComparisonEvidenceRow(
    rows,
    COMPARISON_EVIDENCE_ROW_LABELS.feeBasis,
    left.feeBasis?.value ?? null,
    right.feeBasis?.value ?? null,
    left.feeBasis?.sources,
    right.feeBasis?.sources,
  );
  return rows;
}

function finalizeComparisonEvidenceRow(row: ComparisonEvidenceRow): ComparisonRow {
  return {
    label: row.label,
    left: row.left ?? NOT_RECORDED,
    right: row.right ?? NOT_RECORDED,
    ...(row.leftSources ? { leftSources: row.leftSources } : {}),
    ...(row.rightSources ? { rightSources: row.rightSources } : {}),
  };
}

export function buildComparisonAtAGlanceRows(
  page: StaticComparisonPage,
  nowSec = Math.floor(Date.now() / 1_000),
): ComparisonRow[] {
  const { left, right } = page;
  const grades = getComparisonGrades(left, right);
  return [
    ...(grades
      ? [{
          label: `Safety Score (as of ${grades.asOf})`,
          left: formatGradeScore(grades.left),
          right: formatGradeScore(grades.right),
        }]
      : []),
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
      left: comparisonPegLabel(left),
      right: comparisonPegLabel(right),
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
    ...buildComparisonEvidenceRows(page, nowSec).map(finalizeComparisonEvidenceRow),
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

export function buildStaticComparisonJsonLd(
  page: StaticComparisonPage,
  rows: readonly ComparisonRow[] = buildComparisonAtAGlanceRows(page),
) {
  const pageUrl = `${SITE_URL}${page.href}`;
  const itemListId = `${pageUrl}#comparison-rows`;
  const leftThing = buildComparisonCoinThingJsonLd(page.left);
  const rightThing = buildComparisonCoinThingJsonLd(page.right);

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
  const grades = getComparisonGrades(left, right);
  const safetyAnswer = `Safety is not decided by ticker alone. Use this static page for the structural comparison, then open the live ${page.shortTitle} compare tool and Safety Scores page for current V10 Backing, Exit, and Economic Control pillars plus peg behavior, dependency exposure, evidence quality, and structural caps.`;

  return [
    {
      question: `What is the main difference between ${left.symbol} and ${right.symbol}?`,
      // Curated pairs keep the FAQ answer equal to the visible short answer.
      answer: page.editorial ? buildComparisonSnippetAnswer(page).answer : (
        left.flags.backing === right.flags.backing && left.flags.governance === right.flags.governance
          ? `${leftDescriptor} and ${rightDescriptor} share the same broad governance and backing labels in Pharos, so the useful comparison is in the live details: peg history, liquidity depth, reserve signal, issuer controls, chain deployments, and dependency exposure.`
          : `${leftDescriptor} and ${rightDescriptor} differ structurally: ${left.symbol} is ${GOVERNANCE_LABELS[left.flags.governance].toLowerCase()} and ${BACKING_LABELS_SHORT[left.flags.backing].toLowerCase()}, while ${right.symbol} is ${GOVERNANCE_LABELS[right.flags.governance].toLowerCase()} and ${BACKING_LABELS_SHORT[right.flags.backing].toLowerCase()}.`),
    },
    {
      question: `Which is safer: ${left.symbol} or ${right.symbol}?`,
      answer: grades ? `${buildComparisonGradeSentence(left, right, grades)} ${safetyAnswer}` : safetyAnswer,
    },
    {
      question: `Where can I compare current ${left.symbol} and ${right.symbol} data?`,
      answer: `Open the live ${page.shortTitle} comparison from this page to see current peg behavior, liquidity, flows, and Safety Scores. Use this brief to understand the structural differences, then check each coin's latest evidence before making a decision.`,
    },
  ];
}
