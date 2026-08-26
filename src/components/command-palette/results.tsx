import type { ReactNode } from "react";
import type { useRouter } from "next/navigation";
import {
  Moon,
  Sun,
  FileText,
  Copy,
  BookOpen,
  Newspaper,
  KeyRound,
  GitCompare,
  Terminal,
  Network,
  Globe2,
  Layers,
  Activity,
  PlayCircle,
} from "lucide-react";
import {
  buildCommandPaletteResultDescriptors,
  buildPopularStablecoinDescriptors,
  type CommandPaletteActionIcon,
  type CommandPaletteActionId,
  type CommandPaletteResultDescriptor,
  type CommandPaletteSection,
  type CommandPaletteStablecoinHealth,
  type CommandPaletteStablecoinLiveMetadata,
  type CommandPaletteHistoryItem,
} from "@/components/command-palette-model";
import { buildCompareHrefFromCoinIds } from "@/lib/command-palette-verbs";
import { copyText } from "@/lib/clipboard";
import type { CommandPaletteVerbPreview } from "@/components/command-palette-actions";

export interface CommandPaletteSearchResult {
  id: string;
  label: string;
  sublabel?: string;
  section: CommandPaletteSection;
  logoUrl?: string;
  imagePath?: string;
  imageSquare?: boolean;
  imageDarkInvert?: boolean;
  icon?: ReactNode;
  frozen?: boolean;
  /** Live USD market cap, shown right-aligned on stablecoin rows. */
  marketCap?: number;
  /** Live peg/NAV health state, shown on stablecoin rows. */
  stablecoinHealth?: CommandPaletteStablecoinHealth;
  /** Render the sublabel in the mono face (tickers, dates - data, not prose). */
  mono?: boolean;
  onSelect: () => void;
  keywords?: string[];
}

interface BuildCommandPaletteSearchResultsOptions {
  query: string;
  history: readonly CommandPaletteHistoryItem[];
  isDark: boolean;
  watchlistCount: number;
  watchlistIds: readonly string[];
  logos: Record<string, string> | undefined;
  router: ReturnType<typeof useRouter>;
  closePalette: () => void;
  addToHistory: (
    id: string,
    type: "stablecoin" | "page",
    label: string,
    sublabel: string | undefined,
    href: string,
  ) => void;
  toggleTheme: () => void;
  setQuery: (next: string) => void;
  stablecoinLiveMetadata: ReadonlyMap<string, CommandPaletteStablecoinLiveMetadata>;
  popularIds: readonly string[];
  verbPreview: CommandPaletteVerbPreview | null;
  runVerb: () => boolean;
}

function getActionIcon(icon: CommandPaletteActionIcon): ReactNode {
  switch (icon) {
    case "theme-light":
      return <Sun className="h-4 w-4" />;
    case "theme-dark":
      return <Moon className="h-4 w-4" />;
    case "copy":
      return <Copy className="h-4 w-4" />;
    case "digest":
      return <Newspaper className="h-4 w-4" />;
    case "methodology":
      return <BookOpen className="h-4 w-4" />;
    case "api-docs":
      return <KeyRound className="h-4 w-4" />;
    case "compare-watchlist":
      return <GitCompare className="h-4 w-4" />;
    case "verb-hint":
      return <Terminal className="h-4 w-4" />;
    case "run-command":
      return <PlayCircle className="h-4 w-4" />;
  }
}

function getKindIcon(kind: CommandPaletteResultDescriptor["kind"]): ReactNode {
  switch (kind) {
    case "chain":
      return <Network className="h-4 w-4" />;
    case "peg":
      return <Globe2 className="h-4 w-4" />;
    case "mechanism":
      return <Layers className="h-4 w-4" />;
    case "depeg-event":
      return <Activity className="h-4 w-4" />;
    case "verb-hint":
      return <Terminal className="h-4 w-4" />;
    case "verb-run":
      return <PlayCircle className="h-4 w-4" />;
    default:
      return null;
  }
}

function buildSearchResult(
  descriptor: CommandPaletteResultDescriptor,
  {
    logos,
    router,
    closePalette,
    addToHistory,
    toggleTheme,
    watchlistIds,
    setQuery,
  }: Pick<
    BuildCommandPaletteSearchResultsOptions,
    "logos" | "router" | "closePalette" | "addToHistory" | "toggleTheme" | "watchlistIds" | "setQuery"
  >,
): CommandPaletteSearchResult {
  const selectAction = (actionId: CommandPaletteActionId) => {
    switch (actionId) {
      case "theme":
        toggleTheme();
        closePalette();
        return;
      case "copy-url":
        if (typeof window !== "undefined") void copyText(window.location.href);
        closePalette();
        return;
      case "open-digest":
        router.push("/digest/");
        closePalette();
        return;
      case "open-methodology":
        router.push("/methodology/");
        closePalette();
        return;
      case "open-api-docs":
        router.push("/about/api/");
        closePalette();
        return;
      case "compare-watchlist": {
        if (watchlistIds.length < 2) return;
        router.push(buildCompareHrefFromCoinIds(watchlistIds));
        closePalette();
        return;
      }
    }
  };

  const PageIcon = descriptor.pageIcon;
  const onSelect = () => {
    if (descriptor.kind === "verb-hint" && descriptor.prefill) {
      setQuery(descriptor.prefill);
      return;
    }
    if (descriptor.actionId) {
      selectAction(descriptor.actionId);
      return;
    }
    if (!descriptor.href) return;
    if (descriptor.external) {
      window.open(descriptor.href, "_blank", "noopener,noreferrer");
      closePalette();
      return;
    }
    if (descriptor.history) {
      addToHistory(
        descriptor.history.id,
        descriptor.history.type,
        descriptor.history.label,
        descriptor.history.sublabel,
        descriptor.history.href,
      );
    }
    router.push(descriptor.href);
    closePalette();
  };

  const kindIcon = getKindIcon(descriptor.kind);

  return {
    id: descriptor.id,
    label: descriptor.label,
    sublabel: descriptor.sublabel,
    section: descriptor.section,
    logoUrl: descriptor.logoId ? logos?.[descriptor.logoId] : undefined,
    imagePath: descriptor.imagePath,
    imageSquare: descriptor.imageSquare,
    imageDarkInvert: descriptor.imageDarkInvert,
    icon: descriptor.actionIcon
      ? getActionIcon(descriptor.actionIcon)
      : PageIcon
        ? <PageIcon className="h-4 w-4" />
        : kindIcon
          ? kindIcon
          : descriptor.kind === "recent" && !descriptor.logoId
            ? <FileText className="h-4 w-4" />
            : undefined,
    frozen: descriptor.frozen,
    marketCap: descriptor.kind === "stablecoin" ? descriptor.marketCapUsd : undefined,
    stablecoinHealth: descriptor.kind === "stablecoin" ? descriptor.stablecoinHealth : undefined,
    mono: descriptor.kind === "stablecoin" || descriptor.kind === "depeg-event",
    onSelect,
  };
}

export function buildCommandPaletteSearchResults({
  query,
  history,
  isDark,
  watchlistCount,
  watchlistIds,
  logos,
  router,
  closePalette,
  addToHistory,
  toggleTheme,
  setQuery,
  stablecoinLiveMetadata,
  popularIds,
  verbPreview,
  runVerb,
}: BuildCommandPaletteSearchResultsOptions): CommandPaletteSearchResult[] {
  const ctx = {
    logos,
    router,
    closePalette,
    addToHistory,
    toggleTheme,
    watchlistIds,
    setQuery,
  };

  const built = buildCommandPaletteResultDescriptors({
    query,
    history,
    isDark,
    watchlistCount,
    stablecoinLiveMetadata,
  }).map((descriptor) => buildSearchResult(descriptor, ctx));

  const popular = query.trim()
    ? []
    : buildPopularStablecoinDescriptors(popularIds, stablecoinLiveMetadata).map((descriptor) =>
        buildSearchResult(descriptor, ctx),
      );

  if (verbPreview) {
    const verbRow: CommandPaletteSearchResult = {
      id: "verb-run",
      label: verbPreview.label,
      sublabel: verbPreview.sublabel,
      section: "Run command",
      icon: <PlayCircle className="h-4 w-4" />,
      onSelect: () => {
        if (verbPreview.runnable) runVerb();
      },
    };
    return [verbRow, ...popular, ...built];
  }

  return [...popular, ...built];
}
