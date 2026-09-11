import {
  BookOpen,
  Coins,
  Heart,
  KeyRound,
  Landmark,
  LockKeyhole,
  Scale,
  ScrollText,
  ShieldCheck,
  TableProperties,
} from "lucide-react";
import { NAV_ITEMS } from "@/lib/nav-config";
import type { NavItem } from "@/lib/nav-config";
import { COMMAND_PALETTE_STABLECOINS } from "@/lib/command-palette-search-data";
import { CASE_STUDY_CLIENT_LIST } from "@/lib/case-study-client-index";
import { GLOSSARY_ENTRIES } from "@/lib/glossary-content";
import { BLOG_POSTS } from "@/data/blog";
import { buildStablecoinUrl } from "@shared/lib/urls";
import { CHAIN_META, getActiveChainIds } from "@shared/lib/chains";
import { CLIENT_TRACKED_META_BY_ID, CLIENT_TRACKED_STABLECOINS } from "@shared/lib/stablecoins/client-registry";
import { hasStaticYieldWorkbench } from "@shared/lib/yield-auto-lending";
import { PEG_TAXONOMY_PAGES } from "@/lib/peg-taxonomy";
import { buildStaticComparisonSlug, STATIC_COMPARE_PAIRS } from "@/lib/compare-links";
import { PUBLIC_DOCS } from "@shared/lib/public-docs";
import { MECHANISM_ARCHETYPE_VALUES } from "@shared/types/stablecoin-taxonomy";
import { MECHANISM_ARCHETYPE_LABELS, MECHANISM_ARCHETYPE_ONE_LINERS } from "@shared/lib/classification";
import depegEventSearchData from "@/generated/depeg-event-search-data.json";
import {
  fuzzyMatch,
  isBoundedTypoMatch,
  isExactStablecoinSymbolMatch,
  PAGE_LEAD_MIN_SCORE,
  pageLeadMatchScore,
  rankCommandPaletteResults,
  scoreKeywordTokenMatch,
  scorePageSearchMatch,
  scoreStablecoinSearchMatch,
  stablecoinProminenceBonus,
  TYPO_COIN_MATCH_SCORE,
  TYPO_PAGE_MATCH_SCORE,
} from "./command-palette-scoring";
import type {
  CommandPaletteActionDefinition,
  CommandPaletteGroup,
  CommandPaletteHistoryItem,
  CommandPaletteResultDescriptor,
  CommandPaletteSection,
  CommandPaletteSectionedItem,
  CommandPaletteStablecoinLiveMetadata,
} from "./command-palette-types";

// Re-export the split-out types and scoring helpers retained on this module's
// public surface. [audit Q-130]
export type { CommandPaletteSection, CommandPaletteActionId, CommandPaletteActionIcon, CommandPaletteActionDefinition, CommandPaletteGroup, CommandPaletteSectionedItem, CommandPaletteHistoryItem, CommandPalettePegStatus, CommandPaletteStablecoinHealth, CommandPaletteStablecoinLiveMetadata, CommandPaletteResultDescriptor, CommandPaletteResultKind } from "./command-palette-types";
export {
  fuzzyMatch,
  rankCommandPaletteResults,
} from "./command-palette-scoring";

export const COMMAND_PALETTE_EXTRA_PAGES: readonly NavItem[] = [
  {
    href: "/stablecoins/",
    label: "Stablecoins",
    icon: Coins,
    description: "Full tracked stablecoin directory with peg, backing, and risk filters",
  },
  {
    href: "/stablecoins/governance/",
    label: "Governance Taxonomy",
    icon: Scale,
    description: "Browse stablecoins by issuer and governance model",
  },
  {
    href: "/stablecoins/backing/",
    label: "Backing Taxonomy",
    icon: ShieldCheck,
    description: "Browse stablecoins by reserve and collateral design",
  },
  {
    href: "/stablecoins/infrastructure/",
    label: "Infrastructure Taxonomy",
    icon: Landmark,
    description: "Browse shared stablecoin infrastructure and deployment families",
  },
  {
    href: "/docs/",
    label: "Docs",
    icon: BookOpen,
    description: "Public documentation archive for Pharos methods and data contracts",
  },
  {
    href: "/privacy/",
    label: "Privacy",
    icon: LockKeyhole,
    description: "Privacy policy for Pharos web, API, and alert surfaces",
  },
  {
    href: "/about/api/",
    label: "API Reference",
    icon: KeyRound,
    description: "Endpoint reference, authentication model, and public API access",
  },
  {
    href: "/methodology/pricing-pipeline-changelog/",
    label: "Pricing Pipeline Changelog",
    icon: ScrollText,
    description: "Version history for Pharos price source and consensus rules",
  },
  {
    href: "/methodology/scoring-changelog/",
    label: "Report Card Changelog",
    icon: TableProperties,
    description: "Version history for Safety Score and report-card scoring",
  },
  // Footer-only routes: demoted out of NAV_GROUPS by the 2026-09-04 nav
  // revamp, so the palette must carry them explicitly or search loses them.
  {
    href: "/coverage/",
    label: "Coverage",
    icon: TableProperties,
    description: "Truth surface for what each route can show per coin",
  },
  {
    href: "/funding/",
    label: "Funding",
    icon: Heart,
    description: "Running costs, supporter ledger, and public sustainability path",
  },
] as const;

function normalizePaletteHref(href: string): string {
  if (href === "/") return href;
  return href.replace(/\/+$/, "");
}

function dedupeCommandPalettePages(pages: readonly NavItem[]): NavItem[] {
  const seen = new Set<string>();
  return pages.filter((page) => {
    const key = normalizePaletteHref(page.href);
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

export const COMMAND_PALETTE_PAGES = dedupeCommandPalettePages([
  ...NAV_ITEMS,
  ...COMMAND_PALETTE_EXTRA_PAGES,
]);
const COMMAND_PALETTE_SECTION_ORDER: readonly CommandPaletteSection[] = [
  "Run command",
  "Recent",
  "Popular",
  "Stablecoins",
  "Pages",
  "Chains",
  "Peg currencies",
  "Comparisons",
  "Case studies",
  "Glossary",
  "Mechanism archetypes",
  "Recent depegs",
  "Docs",
  "Blog",
  "Actions",
  "Try a command",
] as const;

const NEW_SECTION_RESULT_CAP = 5;

// ── Static palette content sources ──────────────────────────────────────────

interface PaletteChain {
  id: string;
  name: string;
  logoPath: string;
  darkInvert: boolean;
}

interface PaletteMechanism {
  id: string;
  label: string;
  oneLiner: string;
}

const PALETTE_CHAINS: readonly PaletteChain[] = getActiveChainIds().map((id) => {
  const meta = CHAIN_META[id];
  return {
    id,
    name: meta?.name ?? id,
    logoPath: meta?.logoPath ?? "",
    darkInvert: meta?.darkInvert ?? false,
  };
});

const PALETTE_MECHANISMS: readonly PaletteMechanism[] = MECHANISM_ARCHETYPE_VALUES.map((id) => ({
  id,
  label: MECHANISM_ARCHETYPE_LABELS[id],
  oneLiner: MECHANISM_ARCHETYPE_ONE_LINERS[id],
}));

interface PaletteComparison {
  id: string;
  label: string;
  /** Lowercased symbols for substring containment checks. */
  leftSymbolLower: string;
  rightSymbolLower: string;
  href: string;
}

const PALETTE_COMPARISONS: readonly PaletteComparison[] = STATIC_COMPARE_PAIRS.map(([leftId, rightId]) => {
  const leftSymbol = CLIENT_TRACKED_META_BY_ID.get(leftId)?.symbol ?? leftId;
  const rightSymbol = CLIENT_TRACKED_META_BY_ID.get(rightId)?.symbol ?? rightId;
  return {
    id: `${leftId}-vs-${rightId}`,
    label: `${leftSymbol} vs ${rightSymbol}`,
    leftSymbolLower: leftSymbol.toLowerCase(),
    rightSymbolLower: rightSymbol.toLowerCase(),
    href: `/compare/${buildStaticComparisonSlug(leftId, rightId)}/`,
  };
});

/**
 * Coins whose `/stablecoin/<id>/yield/` route actually exists in the static
 * export (mirrors the yield page's `generateStaticParams` gate). Yield rows
 * are only emitted for these ids so the palette never links a 404.
 */
const YIELD_WORKBENCH_IDS: ReadonlySet<string> = new Set(
  CLIENT_TRACKED_STABLECOINS.filter(hasStaticYieldWorkbench).map((coin) => coin.id),
);

const VERB_HINTS: ReadonlyArray<{ id: string; label: string; prefill: string }> = [
  { id: "verb-hint-compare", label: "compare USDT USDC USDe", prefill: "compare USDT USDC USDe" },
  { id: "verb-hint-screen", label: "screen safety>=80 dews<20", prefill: "screen safety>=80 dews<20" },
  { id: "verb-hint-pin", label: "pin USDS", prefill: "pin USDS" },
];

const STABLECOIN_BY_ID = new Map<string, (typeof COMMAND_PALETTE_STABLECOINS)[number]>(
  COMMAND_PALETTE_STABLECOINS.map((coin) => [coin[0], coin]),
);

function stablecoinLifecycleLabel(status: string | undefined, frozenAt?: string): string | null {
  if (status === "pre-launch") return "Pre-launch";
  if (status === "quarantined") return "Quarantined";
  if (status === "delisted") return "Delisted";
  if (status === "frozen") return `Frozen${frozenAt ? ` ${frozenAt}` : ""}`;
  return null;
}

function projectStablecoinLiveMetadata(
  stablecoinId: string,
  liveMetadata?: ReadonlyMap<string, CommandPaletteStablecoinLiveMetadata>,
): Pick<CommandPaletteResultDescriptor, "marketCapUsd" | "stablecoinHealth"> {
  const live = liveMetadata?.get(stablecoinId);
  return {
    marketCapUsd: live?.marketCapUsd,
    stablecoinHealth: live?.health,
  };
}

/**
 * Build descriptors for the empty-state "Popular" jump list from a caller-
 * supplied, ordered list of coin ids (the palette ranks these live by market
 * cap). Unknown ids are skipped. Kept pure: the id ordering is the component's
 * concern, the static name/symbol projection is this module's.
 */
export function buildPopularStablecoinDescriptors(
  ids: readonly string[],
  liveMetadata?: ReadonlyMap<string, CommandPaletteStablecoinLiveMetadata>,
): CommandPaletteResultDescriptor[] {
  const out: CommandPaletteResultDescriptor[] = [];
  for (const id of ids) {
    const coin = STABLECOIN_BY_ID.get(id);
    if (!coin) continue;
    const [coinId, name, symbol, status, frozenAt] = coin;
    const href = buildStablecoinUrl(coinId);
    const lifecycleLabel = stablecoinLifecycleLabel(status, frozenAt);
    out.push({
      id: `popular-${coinId}`,
      label: name,
      sublabel: lifecycleLabel ? `${symbol} · ${lifecycleLabel}` : symbol,
      section: "Popular",
      kind: "stablecoin",
      logoId: coinId,
      ...projectStablecoinLiveMetadata(coinId, liveMetadata),
      frozen: status === "frozen",
      href,
      history: { id: coinId, type: "stablecoin", label: name, sublabel: symbol, href },
    });
  }
  return out;
}

export function buildCommandPaletteActionDefinitions(
  isDark: boolean,
  options?: { watchlistCount?: number },
): CommandPaletteActionDefinition[] {
  const watchlistCount = options?.watchlistCount ?? 0;
  const actions: CommandPaletteActionDefinition[] = [
    {
      id: "action-theme",
      actionId: "theme",
      label: isDark ? "Switch to light mode" : "Switch to dark mode",
      sublabel: "Toggle dark/light theme",
      keywords: "toggle dark light mode theme",
      icon: isDark ? "theme-light" : "theme-dark",
    },
    {
      id: "action-copy-url",
      actionId: "copy-url",
      label: "Copy current URL",
      sublabel: "Copies the current page URL to your clipboard",
      keywords: "copy url link share clipboard",
      icon: "copy",
    },
  ];

  if (watchlistCount >= 2) {
    actions.push({
      id: "action-compare-watchlist",
      actionId: "compare-watchlist",
      label: `Compare watchlist (${watchlistCount})`,
      sublabel: "Open /compare with your starred stablecoins",
      keywords: "compare watchlist pinned starred top coins",
      icon: "compare-watchlist",
    });
  }

  actions.push(
    {
      id: "action-open-digest",
      actionId: "open-digest",
      label: "Open today's digest",
      sublabel: "Daily editorial recap of the stablecoin market",
      keywords: "digest daily editorial newsletter summary",
      icon: "digest",
    },
    {
      id: "action-open-methodology",
      actionId: "open-methodology",
      label: "Open methodology",
      sublabel: "Reference manual for formulas, thresholds, and changelogs",
      keywords: "methodology reference formulas",
      icon: "methodology",
    },
    {
      id: "action-open-api-docs",
      actionId: "open-api-docs",
      label: "Open API docs",
      sublabel: "Auth model, key requirement, and full endpoint reference",
      keywords: "api docs endpoint reference keys",
      icon: "api-docs",
    },
  );

  return actions;
}

/**
 * Sections strong enough to float above the Stablecoins block. Peg currency
 * pages lead above Pages when both qualify: "euro" should open the EUR peg
 * page, not the broader Non-USD hub that also keyword-matches.
 */
const LEAD_PROMOTABLE_SECTIONS: readonly CommandPaletteSection[] = ["Peg currencies", "Pages"];

function resolveSectionRenderOrder(leadSections: ReadonlySet<CommandPaletteSection>): readonly CommandPaletteSection[] {
  const promoted = LEAD_PROMOTABLE_SECTIONS.filter((section) => leadSections.has(section));
  if (promoted.length === 0) return COMMAND_PALETTE_SECTION_ORDER;
  const order: CommandPaletteSection[] = [];
  for (const section of COMMAND_PALETTE_SECTION_ORDER) {
    if (section === "Stablecoins" || promoted.includes(section)) continue;
    order.push(section);
    if (section === "Popular") order.push(...promoted, "Stablecoins");
  }
  return order;
}

export function groupCommandPaletteResults<TItem extends CommandPaletteSectionedItem>(
  results: TItem[],
): CommandPaletteGroup<TItem>[] {
  const leadSections = new Set<CommandPaletteSection>();
  for (const result of results) {
    if (result.lead) leadSections.add(result.section);
  }
  const groups: CommandPaletteGroup<TItem>[] = [];
  for (const section of resolveSectionRenderOrder(leadSections)) {
    const items = results.filter((result) => result.section === section);
    if (items.length > 0) {
      groups.push({ section, items });
    }
  }
  return groups;
}

export function buildCommandPaletteResultDescriptors({
  query,
  history,
  isDark,
  watchlistCount = 0,
  stablecoinLiveMetadata,
}: {
  query: string;
  history: readonly CommandPaletteHistoryItem[];
  isDark: boolean;
  watchlistCount?: number;
  stablecoinLiveMetadata?: ReadonlyMap<string, CommandPaletteStablecoinLiveMetadata>;
}): CommandPaletteResultDescriptor[] {
  const q = query.trim();
  const items: CommandPaletteResultDescriptor[] = [];

  if (!q && history.length > 0) {
    for (const item of history) {
      items.push({
        id: `recent-${item.id}`,
        label: item.label,
        sublabel: item.sublabel,
        section: "Recent",
        kind: "recent",
        logoId: item.type === "stablecoin" ? item.id : undefined,
        href: item.href,
      });
    }
  }

  if (q) {
    // "yield" / "apy" are intent tokens, not content: strip them so "usde
    // yield" still finds the coin and can attach its yield deep-link row.
    const queryTokens = q.toLowerCase().split(/\s+/).filter(Boolean);
    const contentTokens = queryTokens.filter((token) => token !== "yield" && token !== "apy");
    const hasYieldIntent = contentTokens.length < queryTokens.length;
    const searchQuery = hasYieldIntent && contentTokens.length > 0 ? contentTokens.join(" ") : q;

    const matched: Array<{
      coin: (typeof COMMAND_PALETTE_STABLECOINS)[number];
      score: number;
      status: string;
      exactSymbol: boolean;
    }> = [];

    for (const [index, coin] of COMMAND_PALETTE_STABLECOINS.entries()) {
      const status = coin[3];
      const base = scoreStablecoinSearchMatch(searchQuery, coin);
      if (base <= 0) continue;
      matched.push({
        coin,
        score: base + stablecoinProminenceBonus(coin[0], index, stablecoinLiveMetadata),
        status: status ?? "active",
        exactSymbol: isExactStablecoinSymbolMatch(searchQuery, coin),
      });
    }

    const pageMatches: Array<{ page: NavItem; score: number; leadScore: number }> = [];
    for (const page of COMMAND_PALETTE_PAGES) {
      const score = scorePageSearchMatch(searchQuery, page);
      if (score > 0) {
        pageMatches.push({ page, score, leadScore: pageLeadMatchScore(searchQuery, page) });
      }
    }

    // Bounded typo pass: only when strict matching came up thin, look for
    // single-edit coin symbols and page labels/keyword tokens ("usdcc" → USDC).
    // Typo hits score at the ordinary `contains` tier, never above real matches.
    if (matched.length + pageMatches.length < 3) {
      const matchedCoinIds = new Set(matched.map((entry) => entry.coin[0]));
      for (const [index, coin] of COMMAND_PALETTE_STABLECOINS.entries()) {
        if (matchedCoinIds.has(coin[0])) continue;
        if (!isBoundedTypoMatch(searchQuery, coin[2])) continue;
        matched.push({
          coin,
          score: TYPO_COIN_MATCH_SCORE + stablecoinProminenceBonus(coin[0], index, stablecoinLiveMetadata),
          status: coin[3] ?? "active",
          exactSymbol: false,
        });
      }
      const matchedPageHrefs = new Set(pageMatches.map((entry) => entry.page.href));
      for (const page of COMMAND_PALETTE_PAGES) {
        if (matchedPageHrefs.has(page.href)) continue;
        const labelWords = page.label.toLowerCase().split(/\s+/);
        const keywordTokens = page.keywords?.toLowerCase().split(/\s+/) ?? [];
        const typoHit =
          isBoundedTypoMatch(searchQuery, page.label)
          || labelWords.some((word) => isBoundedTypoMatch(searchQuery, word))
          || keywordTokens.some((token) => isBoundedTypoMatch(searchQuery, token));
        if (typoHit) {
          pageMatches.push({ page, score: TYPO_PAGE_MATCH_SCORE, leadScore: 0 });
        }
      }
    }

    // An exact coin-symbol match always outranks any page/peg lead, so ticker
    // lookups ("usdc", "eurc") keep the coin as the first result.
    const hasExactSymbolCoin = matched.some((entry) => entry.exactSymbol);
    const pagesLead = !hasExactSymbolCoin;

    pageMatches.sort((a, b) => b.score - a.score);

    let yieldRowsEmitted = 0;
    for (const { coin } of rankCommandPaletteResults(matched)) {
      const [id, name, symbol, status, frozenAt] = coin;
      const href = buildStablecoinUrl(id);
      const lifecycleLabel = stablecoinLifecycleLabel(status, frozenAt);
      items.push({
        id: `coin-${id}`,
        label: name,
        sublabel: lifecycleLabel ? `${symbol} · ${lifecycleLabel}` : symbol,
        section: "Stablecoins",
        kind: "stablecoin",
        logoId: id,
        ...projectStablecoinLiveMetadata(id, stablecoinLiveMetadata),
        frozen: status === "frozen",
        href,
        history: { id, type: "stablecoin", label: name, sublabel: symbol, href },
      });
      if (hasYieldIntent && yieldRowsEmitted < 3 && YIELD_WORKBENCH_IDS.has(id)) {
        yieldRowsEmitted += 1;
        const yieldHref = buildStablecoinUrl(id, "yield/");
        items.push({
          id: `coin-yield-${id}`,
          label: `${name} · Yield`,
          sublabel: `${symbol} · per-source APY history and warnings`,
          section: "Stablecoins",
          kind: "stablecoin-yield",
          logoId: id,
          ...projectStablecoinLiveMetadata(id, stablecoinLiveMetadata),
          href: yieldHref,
          history: { id: `coin-yield-${id}`, type: "page", label: name, sublabel: "Yield", href: yieldHref },
        });
      }
    }

    for (const { page, leadScore } of pageMatches) {
      items.push({
        id: `page-${page.href}`,
        label: page.label,
        sublabel: page.description,
        section: "Pages",
        kind: "page",
        lead: pagesLead && leadScore >= PAGE_LEAD_MIN_SCORE,
        href: page.href,
        external: page.external,
        pageIcon: page.icon,
        history: {
          id: page.href,
          type: "page",
          label: page.label,
          sublabel: page.description,
          href: page.href,
        },
      });
    }

    // Chains
    const chainMatches: PaletteChain[] = [];
    for (const chain of PALETTE_CHAINS) {
      if (chainMatches.length >= NEW_SECTION_RESULT_CAP) break;
      if (fuzzyMatch(searchQuery, chain.name) || fuzzyMatch(searchQuery, chain.id)) {
        chainMatches.push(chain);
      }
    }
    for (const chain of chainMatches) {
      const href = `/chains/${chain.id}/`;
      items.push({
        id: `chain-${chain.id}`,
        label: chain.name,
        sublabel: "Chain profile",
        section: "Chains",
        kind: "chain",
        imagePath: chain.logoPath || undefined,
        imageSquare: true,
        imageDarkInvert: chain.darkInvert,
        href,
        history: {
          id: `chain-${chain.id}`,
          type: "page",
          label: chain.name,
          sublabel: "Chain profile",
          href,
        },
      });
    }

    // Peg currencies. "euro" should open the EUR peg page above any coin whose
    // name merely contains the word, so an exact/word-prefix peg-name hit
    // leads (unless a coin matched its exact symbol).
    const pegMatches: (typeof PEG_TAXONOMY_PAGES)[number][] = [];
    for (const peg of PEG_TAXONOMY_PAGES) {
      if (pegMatches.length >= NEW_SECTION_RESULT_CAP) break;
      if (
        fuzzyMatch(searchQuery, peg.shortLabel) ||
        fuzzyMatch(searchQuery, peg.value) ||
        fuzzyMatch(searchQuery, peg.slug)
      ) {
        pegMatches.push(peg);
      }
    }
    for (const peg of pegMatches) {
      const lead = !hasExactSymbolCoin && [peg.shortLabel, peg.value, peg.slug].some((field) => {
        const target = field.toLowerCase();
        const queryLower = searchQuery.toLowerCase();
        return target === queryLower || target.split(/\s+/).some((word) => word.startsWith(queryLower));
      });
      items.push({
        id: `peg-${peg.slug}`,
        label: peg.title,
        sublabel: `${peg.coins.length} tracked stablecoin${peg.coins.length === 1 ? "" : "s"}`,
        section: "Peg currencies",
        kind: "peg",
        lead,
        href: peg.href,
        history: {
          id: `peg-${peg.slug}`,
          type: "page",
          label: peg.title,
          sublabel: peg.shortLabel,
          href: peg.href,
        },
      });
    }

    // Static comparison pages: match when the query names both symbols in any
    // order, or an explicit "vs"/"versus" plus one side.
    const queryLower = searchQuery.toLowerCase();
    const hasVsToken = queryTokens.includes("vs") || queryTokens.includes("versus") || queryTokens.includes("vs.");
    const comparisonMatches: PaletteComparison[] = [];
    for (const pair of PALETTE_COMPARISONS) {
      if (comparisonMatches.length >= NEW_SECTION_RESULT_CAP) break;
      const leftHit = queryLower.includes(pair.leftSymbolLower);
      const rightHit = queryLower.includes(pair.rightSymbolLower);
      if ((leftHit && rightHit) || (hasVsToken && (leftHit || rightHit))) {
        comparisonMatches.push(pair);
      }
    }
    for (const pair of comparisonMatches) {
      items.push({
        id: `comparison-${pair.id}`,
        label: pair.label,
        sublabel: "Static comparison page",
        section: "Comparisons",
        kind: "comparison",
        href: pair.href,
        history: {
          id: `comparison-${pair.id}`,
          type: "page",
          label: pair.label,
          sublabel: "Comparison",
          href: pair.href,
        },
      });
    }

    // Case studies (generated client index: title, slug words, symbols, keywords)
    const caseStudyMatches: (typeof CASE_STUDY_CLIENT_LIST)[number][] = [];
    for (const study of CASE_STUDY_CLIENT_LIST) {
      if (caseStudyMatches.length >= NEW_SECTION_RESULT_CAP) break;
      const titleScore = scorePageSearchMatch(searchQuery, { label: study.title, keywords: study.keywords });
      const symbolScore = study.coinSymbols.reduce(
        (best, symbol) => Math.max(best, scoreKeywordTokenMatch(searchQuery, symbol)),
        0,
      );
      if (titleScore + symbolScore > 0) {
        caseStudyMatches.push(study);
      }
    }
    for (const study of caseStudyMatches) {
      const href = `/learn/case-studies/${study.slug}/`;
      items.push({
        id: `case-study-${study.slug}`,
        label: study.title,
        sublabel: `Case study${study.year ? ` · ${study.year}` : ""}`,
        section: "Case studies",
        kind: "case-study",
        href,
        history: {
          id: `case-study-${study.slug}`,
          type: "page",
          label: study.title,
          sublabel: "Case study",
          href,
        },
      });
    }

    // Glossary terms, deep-linked to the entry anchor on /learn/glossary/
    const glossaryMatches: (typeof GLOSSARY_ENTRIES)[number][] = [];
    for (const entry of GLOSSARY_ENTRIES) {
      if (glossaryMatches.length >= NEW_SECTION_RESULT_CAP) break;
      // Term exact/prefix/word-prefix via the label tiers; definition hits via
      // the weak description tiers.
      if (scorePageSearchMatch(searchQuery, { label: entry.term, description: entry.definition }) > 0) {
        glossaryMatches.push(entry);
      }
    }
    for (const entry of glossaryMatches) {
      const href = `/learn/glossary/#${entry.id}`;
      items.push({
        id: `glossary-${entry.id}`,
        label: entry.term,
        sublabel: "Glossary term",
        section: "Glossary",
        kind: "glossary-term",
        href,
        history: {
          id: `glossary-${entry.id}`,
          type: "page",
          label: entry.term,
          sublabel: "Glossary term",
          href,
        },
      });
    }

    // Mechanism archetypes
    const mechMatches: PaletteMechanism[] = [];
    for (const mech of PALETTE_MECHANISMS) {
      if (mechMatches.length >= NEW_SECTION_RESULT_CAP) break;
      if (
        fuzzyMatch(searchQuery, mech.label) ||
        fuzzyMatch(searchQuery, mech.id) ||
        fuzzyMatch(searchQuery, mech.oneLiner)
      ) {
        mechMatches.push(mech);
      }
    }
    for (const mech of mechMatches) {
      const href = `/learn/mechanisms/${mech.id}/`;
      items.push({
        id: `mechanism-${mech.id}`,
        label: mech.label,
        sublabel: "Mechanism archetype explainer",
        section: "Mechanism archetypes",
        kind: "mechanism",
        href,
        history: {
          id: `mechanism-${mech.id}`,
          type: "page",
          label: mech.label,
          sublabel: "Mechanism archetype",
          href,
        },
      });
    }

    // Recent depeg events (generated top 10 by startedAt)
    if (depegEventSearchData.length > 0) {
      const depegMatches: Array<(typeof depegEventSearchData)[number]> = [];
      for (const event of depegEventSearchData) {
        if (depegMatches.length >= NEW_SECTION_RESULT_CAP) break;
        if (
          fuzzyMatch(searchQuery, event.symbol) ||
          fuzzyMatch(searchQuery, event.stablecoinId) ||
          fuzzyMatch(searchQuery, event.slug)
        ) {
          depegMatches.push(event);
        }
      }
      for (const event of depegMatches) {
        const href = `/depeg/${event.slug}/`;
        const dateLabel = event.startedAt
          ? new Date(event.startedAt * 1000).toISOString().slice(0, 10)
          : "";
        const directionLabel = event.direction === "below" ? "below" : "above";
        items.push({
          id: `depeg-${event.slug}`,
          label: `${event.symbol} ${directionLabel} ${event.pegType}`,
          sublabel: dateLabel
            ? `${dateLabel} · peak ${event.peakDeviationBps}bps`
            : `peak ${event.peakDeviationBps}bps`,
          section: "Recent depegs",
          kind: "depeg-event",
          logoId: event.stablecoinId,
          href,
          history: {
            id: `depeg-${event.slug}`,
            type: "page",
            label: `${event.symbol} ${dateLabel}`.trim(),
            sublabel: "Depeg event",
            href,
          },
        });
      }
    }

    // Public docs (title + summary; the markdown bodies stay out of the bundle)
    const docMatches: (typeof PUBLIC_DOCS)[number][] = [];
    for (const doc of PUBLIC_DOCS) {
      if (docMatches.length >= NEW_SECTION_RESULT_CAP) break;
      if (scorePageSearchMatch(searchQuery, { label: doc.title, description: doc.summary }) > 0) {
        docMatches.push(doc);
      }
    }
    for (const doc of docMatches) {
      const href = `/docs/${doc.slug}/`;
      items.push({
        id: `doc-${doc.slug}`,
        label: doc.title,
        sublabel: doc.summary,
        section: "Docs",
        kind: "doc",
        href,
        history: {
          id: `doc-${doc.slug}`,
          type: "page",
          label: doc.title,
          sublabel: "Docs",
          href,
        },
      });
    }

    // Blog posts (metadata-only registry: title, description, slug)
    const blogMatches: (typeof BLOG_POSTS)[number][] = [];
    for (const post of BLOG_POSTS) {
      if (blogMatches.length >= NEW_SECTION_RESULT_CAP) break;
      if (scorePageSearchMatch(searchQuery, { label: post.title, description: post.description }) > 0) {
        blogMatches.push(post);
      }
    }
    for (const post of blogMatches) {
      const href = `/blog/${post.slug}/`;
      items.push({
        id: `blog-${post.slug}`,
        label: post.title,
        sublabel: post.description,
        section: "Blog",
        kind: "blog-post",
        href,
        history: {
          id: `blog-${post.slug}`,
          type: "page",
          label: post.title,
          sublabel: "Blog",
          href,
        },
      });
    }
  }

  for (const action of buildCommandPaletteActionDefinitions(isDark, { watchlistCount })) {
    if (!q || fuzzyMatch(q, action.label) || fuzzyMatch(q, action.keywords)) {
      items.push({
        id: action.id,
        label: action.label,
        sublabel: action.sublabel,
        section: "Actions",
        kind: "action",
        actionIcon: action.icon,
        actionId: action.actionId,
      });
    }
  }

  // Empty-state verb hints. Surfaced as a quiet "Try a command" block beneath
  // the recents so the verb grammar is discoverable.
  if (!q) {
    for (const hint of VERB_HINTS) {
      items.push({
        id: hint.id,
        label: hint.label,
        sublabel: "Press Enter to prefill",
        section: "Try a command",
        kind: "verb-hint",
        actionIcon: "verb-hint",
        prefill: hint.prefill,
      });
    }
  }

  return items;
}
