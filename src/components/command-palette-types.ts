/**
 * Command-palette type declarations.
 *
 * Split out of `command-palette-model.ts` so the section/action/result shapes
 * can be imported without pulling in the static data tables, lucide icons, or
 * scoring math. `command-palette-model.ts` re-exports these for existing
 * importers.
 */
import type { NavItem } from "@/lib/nav-config";

export type CommandPaletteSection =
  | "Run command"
  | "Recent"
  | "Popular"
  | "Stablecoins"
  | "Pages"
  | "Chains"
  | "Peg currencies"
  | "Mechanism archetypes"
  | "Recent depegs"
  | "Actions"
  | "Try a command";
export type CommandPaletteActionId =
  | "theme"
  | "copy-url"
  | "open-digest"
  | "open-methodology"
  | "open-api-docs"
  | "compare-watchlist";
export type CommandPaletteActionIcon =
  | "theme-light"
  | "theme-dark"
  | "copy"
  | "digest"
  | "methodology"
  | "api-docs"
  | "compare-watchlist"
  | "verb-hint"
  | "run-command";

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

export interface CommandPaletteHistoryItem {
  id: string;
  type: "stablecoin" | "page";
  label: string;
  sublabel?: string;
  href: string;
}

export type CommandPaletteResultKind =
  | "recent"
  | "stablecoin"
  | "page"
  | "action"
  | "chain"
  | "peg"
  | "mechanism"
  | "depeg-event"
  | "verb-hint"
  | "verb-run";

export type CommandPalettePegStatus = "calm" | "watch" | "alert";

export type CommandPaletteStablecoinHealth =
  | { kind: "peg"; status: CommandPalettePegStatus }
  | { kind: "nav" };

export interface CommandPaletteStablecoinLiveMetadata {
  marketCapUsd?: number;
  health?: CommandPaletteStablecoinHealth;
}

export interface CommandPaletteResultDescriptor {
  id: string;
  label: string;
  sublabel?: string;
  section: CommandPaletteSection;
  kind: CommandPaletteResultKind;
  logoId?: string;
  /** Static image path (e.g. chain logo) when not driven by the logos hook. */
  imagePath?: string;
  /** Render the static image as a square thumbnail instead of a circle. */
  imageSquare?: boolean;
  /** Apply CSS invert in dark mode (used for chain logos with darkInvert). */
  imageDarkInvert?: boolean;
  marketCapUsd?: number;
  stablecoinHealth?: CommandPaletteStablecoinHealth;
  frozen?: boolean;
  href?: string;
  external?: boolean;
  pageIcon?: NavItem["icon"];
  actionIcon?: CommandPaletteActionIcon;
  actionId?: CommandPaletteActionId;
  /** For verb-hint rows: the literal text the palette input should be set to. */
  prefill?: string;
  history?: {
    id: string;
    type: "stablecoin" | "page";
    label: string;
    sublabel?: string;
    href: string;
  };
}
