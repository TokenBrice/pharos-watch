import {
  BookOpen,
  Coins,
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
import { buildStablecoinUrl } from "@/lib/urls";
import { CHAIN_META, getActiveChainIds } from "@shared/lib/chains";
import { PEG_TAXONOMY_PAGES } from "@/lib/peg-taxonomy";
import { MECHANISM_ARCHETYPE_VALUES } from "@shared/types/stablecoin-taxonomy";
import { MECHANISM_ARCHETYPE_LABELS, MECHANISM_ARCHETYPE_ONE_LINERS } from "@shared/lib/classification";
import depegEventSearchData from "@/generated/depeg-event-search-data.json";
import {
  fuzzyMatch,
  isExactStablecoinSymbolMatch,
  rankCommandPaletteResults,
  scoreStablecoinSearchMatch,
  stablecoinProminenceBonus,
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

// Re-export the split-out types and pure scoring helpers so existing importers
// of this module keep working unchanged. [audit Q-130]
export type {
  CommandPaletteSection,
  CommandPaletteActionId,
  CommandPaletteActionIcon,
  CommandPaletteActionDefinition,
  CommandPaletteGroup,
  CommandPaletteSectionedItem,
  CommandPaletteHistoryItem,
  CommandPaletteResultKind,
  CommandPalettePegStatus,
  CommandPaletteStablecoinHealth,
  CommandPaletteStablecoinLiveMetadata,
  CommandPaletteResultDescriptor,
} from "./command-palette-types";
export {
  fuzzyMatch,
  scoreStablecoinSearchMatch,
  isExactStablecoinSymbolMatch,
  stablecoinProminenceBonus,
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
  "Mechanism archetypes",
  "Recent depegs",
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

export function groupCommandPaletteResults<TItem extends CommandPaletteSectionedItem>(
  results: TItem[],
): CommandPaletteGroup<TItem>[] {
  const groups: CommandPaletteGroup<TItem>[] = [];
  for (const section of COMMAND_PALETTE_SECTION_ORDER) {
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
    const matched: Array<{
      coin: (typeof COMMAND_PALETTE_STABLECOINS)[number];
      score: number;
      status: string;
      exactSymbol: boolean;
    }> = [];

    for (const [index, coin] of COMMAND_PALETTE_STABLECOINS.entries()) {
      const status = coin[3];
      const base = scoreStablecoinSearchMatch(q, coin);
      if (base <= 0) continue;
      matched.push({
        coin,
        score: base + stablecoinProminenceBonus(coin[0], index, stablecoinLiveMetadata),
        status: status ?? "active",
        exactSymbol: isExactStablecoinSymbolMatch(q, coin),
      });
    }

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
    }

    for (const page of COMMAND_PALETTE_PAGES) {
      if (fuzzyMatch(q, page.label) || (page.description && fuzzyMatch(q, page.description))) {
        items.push({
          id: `page-${page.href}`,
          label: page.label,
          sublabel: page.description,
          section: "Pages",
          kind: "page",
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
    }

    // Chains
    const chainMatches: PaletteChain[] = [];
    for (const chain of PALETTE_CHAINS) {
      if (chainMatches.length >= NEW_SECTION_RESULT_CAP) break;
      if (fuzzyMatch(q, chain.name) || fuzzyMatch(q, chain.id)) {
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

    // Peg currencies
    const pegMatches: (typeof PEG_TAXONOMY_PAGES)[number][] = [];
    for (const peg of PEG_TAXONOMY_PAGES) {
      if (pegMatches.length >= NEW_SECTION_RESULT_CAP) break;
      if (
        fuzzyMatch(q, peg.shortLabel) ||
        fuzzyMatch(q, peg.value) ||
        fuzzyMatch(q, peg.slug)
      ) {
        pegMatches.push(peg);
      }
    }
    for (const peg of pegMatches) {
      items.push({
        id: `peg-${peg.slug}`,
        label: peg.title,
        sublabel: `${peg.coins.length} tracked stablecoin${peg.coins.length === 1 ? "" : "s"}`,
        section: "Peg currencies",
        kind: "peg",
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

    // Mechanism archetypes
    const mechMatches: PaletteMechanism[] = [];
    for (const mech of PALETTE_MECHANISMS) {
      if (mechMatches.length >= NEW_SECTION_RESULT_CAP) break;
      if (
        fuzzyMatch(q, mech.label) ||
        fuzzyMatch(q, mech.id) ||
        fuzzyMatch(q, mech.oneLiner)
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
          fuzzyMatch(q, event.symbol) ||
          fuzzyMatch(q, event.stablecoinId) ||
          fuzzyMatch(q, event.slug)
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
