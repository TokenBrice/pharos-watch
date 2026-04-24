import { NAV_ITEMS, BOTTOM_NAV_ITEMS } from "@/lib/nav-config";

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

export const COMMAND_PALETTE_PAGES = [...NAV_ITEMS, ...BOTTOM_NAV_ITEMS] as const;
export const COMMAND_PALETTE_SECTION_ORDER: readonly CommandPaletteSection[] = [
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
