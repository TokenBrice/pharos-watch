import {
  BookOpen,
  Coins,
  FileText,
  KeyRound,
  Landmark,
  LockKeyhole,
  Newspaper,
  Scale,
  ScrollText,
  ShieldCheck,
  TableProperties,
} from "lucide-react";
import { NAV_ITEMS } from "@/lib/nav-config";
import type { NavItem } from "@/lib/nav-config";
import { COMMAND_PALETTE_STABLECOINS } from "@/lib/command-palette-search-data";
import { buildStablecoinUrl } from "@/lib/urls";

export type CommandPaletteSection = "Recent" | "Stablecoins" | "Pages" | "Actions";
export type CommandPaletteActionId =
  | "theme"
  | "copy-url"
  | "open-digest"
  | "open-methodology"
  | "open-api-docs";
export type CommandPaletteActionIcon = "theme-light" | "theme-dark" | "copy" | "digest" | "methodology" | "api-docs";

export interface CommandPaletteActionDefinition {
  id: string;
  actionId: CommandPaletteActionId;
  label: string;
  sublabel: string;
  keywords: string;
  icon: CommandPaletteActionIcon;
}

export interface CommandPaletteGroup<TItem> {
  section: string;
  items: TItem[];
}

export interface CommandPaletteSectionedItem {
  section: CommandPaletteSection;
}

const COMMAND_PALETTE_EXTRA_PAGES: readonly NavItem[] = [
  {
    href: "/stablecoins",
    label: "Stablecoins",
    icon: Coins,
    description: "Full tracked stablecoin directory with peg, backing, and risk filters",
  },
  {
    href: "/stablecoins/governance",
    label: "Governance Taxonomy",
    icon: Scale,
    description: "Browse stablecoins by issuer and governance model",
  },
  {
    href: "/stablecoins/backing",
    label: "Backing Taxonomy",
    icon: ShieldCheck,
    description: "Browse stablecoins by reserve and collateral design",
  },
  {
    href: "/stablecoins/infrastructure",
    label: "Infrastructure Taxonomy",
    icon: Landmark,
    description: "Browse shared stablecoin infrastructure and deployment families",
  },
  {
    href: "/docs",
    label: "Docs",
    icon: BookOpen,
    description: "Public documentation archive for Pharos methods and data contracts",
  },
  {
    href: "/privacy",
    label: "Privacy",
    icon: LockKeyhole,
    description: "Privacy policy for Pharos web, API, and alert surfaces",
  },
  {
    href: "/about/api",
    label: "API Reference",
    icon: KeyRound,
    description: "Endpoint reference, authentication model, and public API access",
  },
  {
    href: "/about/editorial",
    label: "Editorial Policy",
    icon: Newspaper,
    description: "How Pharos separates data, automated summaries, and editorial judgment",
  },
  {
    href: "/about/principles",
    label: "Principles",
    icon: FileText,
    description: "Operating principles for stablecoin risk coverage and public methodology",
  },
  {
    href: "/methodology/pricing-pipeline-changelog",
    label: "Pricing Pipeline Changelog",
    icon: ScrollText,
    description: "Version history for Pharos price source and consensus rules",
  },
  {
    href: "/methodology/scoring-changelog",
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
type CommandPalettePage = (typeof COMMAND_PALETTE_PAGES)[number];

export interface CommandPaletteHistoryItem {
  id: string;
  type: "stablecoin" | "page";
  label: string;
  sublabel?: string;
  href: string;
}

export type CommandPaletteResultKind = "recent" | "stablecoin" | "page" | "action";

export interface CommandPaletteResultDescriptor {
  id: string;
  label: string;
  sublabel?: string;
  section: CommandPaletteSection;
  kind: CommandPaletteResultKind;
  logoId?: string;
  frozen?: boolean;
  href?: string;
  external?: boolean;
  pageIcon?: CommandPalettePage["icon"];
  actionIcon?: CommandPaletteActionIcon;
  actionId?: CommandPaletteActionId;
  history?: {
    id: string;
    type: "stablecoin" | "page";
    label: string;
    sublabel?: string;
    href: string;
  };
}

const COMMAND_PALETTE_SECTION_ORDER: readonly CommandPaletteSection[] = [
  "Recent",
  "Stablecoins",
  "Pages",
  "Actions",
] as const;

export function fuzzyMatch(query: string, target: string): boolean {
  const q = query.toLowerCase();
  const t = target.toLowerCase();
  return t.includes(q) || t.split(/\s+/).some((word) => word.startsWith(q));
}

export function rankCommandPaletteResults<T extends { score: number; status?: string }>(
  items: T[],
): T[] {
  return [...items].sort((a, b) => {
    if (b.score !== a.score) return b.score - a.score;
    const aFrozen = a.status === "frozen" ? 1 : 0;
    const bFrozen = b.status === "frozen" ? 1 : 0;
    return aFrozen - bFrozen;
  });
}

export function buildCommandPaletteActionDefinitions(isDark: boolean): CommandPaletteActionDefinition[] {
  return [
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
  ];
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
}: {
  query: string;
  history: readonly CommandPaletteHistoryItem[];
  isDark: boolean;
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
    }> = [];

    for (const coin of COMMAND_PALETTE_STABLECOINS) {
      const [id, name, symbol, status] = coin;
      const symbolMatch = fuzzyMatch(q, symbol);
      const nameMatch = fuzzyMatch(q, name);
      const idMatch = fuzzyMatch(q, id);
      if (!symbolMatch && !nameMatch && !idMatch) continue;
      const score = (symbolMatch ? 3 : 0) + (nameMatch ? 2 : 0) + (idMatch ? 1 : 0);
      matched.push({ coin, score, status: status ?? "active" });
    }

    for (const { coin } of rankCommandPaletteResults(matched)) {
      const [id, name, symbol, status, frozenAt] = coin;
      const href = buildStablecoinUrl(id);
      items.push({
        id: `coin-${id}`,
        label: name,
        sublabel:
          status === "pre-launch"
            ? `${symbol} · Pre-launch`
            : status === "frozen"
              ? `${symbol} · Frozen${frozenAt ? ` ${frozenAt}` : ""}`
              : symbol,
        section: "Stablecoins",
        kind: "stablecoin",
        logoId: id,
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
  }

  for (const action of buildCommandPaletteActionDefinitions(isDark)) {
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

  return items;
}
