"use client";

import { useEffect } from "react";
import Link from "next/link";
import { usePathname } from "next/navigation";
import { PharosLogo } from "@/components/pharos-logo";
import {
  AlertOctagon,
  AlertTriangle,
  CheckCircle2,
  ChevronsLeft,
  ChevronsRight,
  ChevronRight,
  ExternalLink,
  Info,
  Moon,
  Search,
  Sun,
} from "lucide-react";
import { PharosIcon } from "@/components/pharos-icon";
import { BOTTOM_NAV_ITEMS, COMPANION_NAV_ITEMS, getSidebarNavForPath } from "@/lib/nav-config";
import type { NavItem } from "@/lib/nav-config";
import { useNavCollapse } from "@/hooks/use-nav-collapse";
import { useSidebarNavSignals } from "@/hooks/use-sidebar-nav-signals";
import { useStartHereNavVisibility } from "@/hooks/use-start-here-nav-visibility";
import { openCommandPalette } from "@/lib/command-palette";
import { isRouteActive } from "@/lib/navigation";
import type { SidebarNavSignal } from "@/lib/sidebar-signals";
import { useThemeToggle } from "@/hooks/use-theme-toggle";
import { useNavPrefetch } from "@/hooks/use-nav-prefetch";
import { useSidebar } from "@/components/sidebar-context";
import { isSidebarShortcutDisabled } from "@/lib/keyboard-shortcut-settings";
import { cn } from "@/lib/utils";

const SIDEBAR_SIGNAL_TONE_CLASS: Record<SidebarNavSignal["tone"], string> = {
  neutral: "border-border/60 bg-muted/35 text-muted-foreground",
  info: "border-frost-blue/30 bg-frost-blue/10 text-sky-800 dark:text-sky-200",
  healthy: "border-green-500/30 bg-green-500/10 text-green-700 dark:text-green-300",
  warning: "border-amber-500/30 bg-amber-500/10 text-amber-700 dark:text-amber-300",
  danger: "border-red-500/30 bg-red-500/10 text-red-700 dark:text-red-300",
};

/* WCAG 1.4.1 Use of Color — pair the tone with a Lucide glyph so the signal
 * survives monochrome viewing and colour-blindness. `null` for neutral keeps
 * the chrome calm when nothing is happening. */
const SIDEBAR_SIGNAL_TONE_ICON: Record<SidebarNavSignal["tone"], typeof AlertTriangle | null> = {
  neutral: null,
  info: Info,
  healthy: CheckCircle2,
  warning: AlertTriangle,
  danger: AlertOctagon,
};

function SidebarNavSignalIndicator({ signal }: { signal: SidebarNavSignal }) {
  if (signal.kind === "accent") return null;

  const ToneIcon = SIDEBAR_SIGNAL_TONE_ICON[signal.tone];

  if (signal.kind === "dot") {
    return (
      <span className="ml-auto inline-flex items-center gap-1" title={signal.title} aria-hidden="true">
        <span className={cn("h-2.5 w-2.5 rounded-full border", SIDEBAR_SIGNAL_TONE_CLASS[signal.tone])} />
      </span>
    );
  }

  return (
    <span
      className={cn(
        "ml-auto inline-flex items-center gap-1 rounded-md border px-1.5 py-0.5 text-[10px] font-mono font-semibold tabular-nums",
        SIDEBAR_SIGNAL_TONE_CLASS[signal.tone],
      )}
      title={signal.title}
      aria-hidden="true"
    >
      {ToneIcon && signal.showIcon !== false ? <ToneIcon className="h-2.5 w-2.5" /> : null}
      {signal.text}
    </span>
  );
}

function SidebarNavItem({
  item,
  expanded,
  isActive,
  signal,
  onPrefetch,
}: {
  item: NavItem;
  expanded: boolean;
  isActive: boolean;
  signal?: SidebarNavSignal | null;
  onPrefetch?: (href: string) => void;
}) {
  const Icon = item.icon;
  const accentBg = signal?.accentClass;
  const externalSuffix = item.external ? " (opens in new tab)" : "";
  const title = expanded ? undefined : signal ? `${item.label} — ${signal.title}${externalSuffix}` : `${item.label}${externalSuffix}`;
  const ariaLabel = signal ? `${item.label} — ${signal.title}${externalSuffix}` : `${item.label}${externalSuffix}`;
  const stateClass = accentBg
    ? isActive
      ? `${accentBg} pharos-nav-active`
      : `${accentBg} text-foreground/80 hover:text-foreground`
    : isActive
      ? "pharos-nav-active"
      : "text-muted-foreground hover:bg-muted/50 hover:text-foreground";
  const className = `pharos-focus-ring relative isolate flex items-center gap-3 rounded-md ${
    expanded ? "mx-2 px-3 py-2.5" : "mx-auto px-0 py-2 justify-center w-10"
  } ${stateClass}`;

  if (item.external) {
    // PharosVille-flavoured hint: warm parchment/brass tint that sets
    // companion experiences apart from the dashboard's analytical chrome.
    // A brass inset ring (not a left stripe) keeps it in step with the
    // watch-column language while preserving its harbor warmth.
    const externalClassName = `pharos-focus-ring relative flex items-center gap-3 rounded-md bg-[linear-gradient(180deg,oklch(0.95_0.06_88_/_0.16),oklch(0.86_0.13_78_/_0.05))] text-[oklch(0.34_0.07_60)] shadow-[inset_0_0_0_1px_oklch(0.6_0.13_84_/_0.24)] transition-[background-color,box-shadow,color] duration-200 hover:bg-[linear-gradient(180deg,oklch(0.95_0.06_88_/_0.3),oklch(0.86_0.13_78_/_0.1))] hover:shadow-[inset_0_0_0_1px_oklch(0.72_0.15_84_/_0.42)] dark:text-[oklch(0.92_0.05_84)] dark:bg-[linear-gradient(180deg,oklch(0.34_0.06_60_/_0.5),oklch(0.22_0.04_50_/_0.35))] dark:shadow-[inset_0_0_0_1px_oklch(0.62_0.13_84_/_0.34)] dark:hover:bg-[linear-gradient(180deg,oklch(0.38_0.07_60_/_0.66),oklch(0.24_0.05_50_/_0.5))] ${
      expanded ? "mx-2 px-3 py-2.5" : "mx-auto px-0 py-2 justify-center w-10"
    }`;

    return (
      <a
        href={item.href}
        target="_blank"
        rel="noopener noreferrer"
        title={title}
        aria-label={ariaLabel}
        className={externalClassName}
      >
        <PharosIcon icon={Icon} className="shrink-0 text-[oklch(0.55_0.13_84)] dark:text-[oklch(0.82_0.16_84)]" />
        {expanded && <span className="min-w-0 text-sm truncate font-medium">{item.label}</span>}
        {expanded && (
          <PharosIcon
            icon={ExternalLink}
            size="micro"
            className="ml-auto shrink-0 text-[oklch(0.55_0.13_84_/_0.7)] dark:text-[oklch(0.82_0.16_84_/_0.7)]"
            aria-hidden="true"
          />
        )}
      </a>
    );
  }

  const handlePrefetch = onPrefetch ? () => onPrefetch(item.href) : undefined;

  return (
    <Link
      prefetch={false}
      href={item.href}
      title={title}
      aria-label={ariaLabel}
      aria-current={isActive ? "page" : undefined}
      className={className}
      onMouseEnter={handlePrefetch}
      onFocus={handlePrefetch}
    >
      {isActive ? <span aria-hidden className="pharos-nav-beam" /> : null}
      <PharosIcon icon={Icon} className={cn("shrink-0", isActive && "text-frost-blue")} />
      {expanded && <span className="min-w-0 text-sm truncate">{item.label}</span>}
      {expanded && signal ? <SidebarNavSignalIndicator signal={signal} /> : null}
    </Link>
  );
}

function ThemeSidebarItem({ expanded }: { expanded: boolean }) {
  const { isDark, label, toggleTheme } = useThemeToggle();

  return (
    <button type="button"
      onClick={toggleTheme}
      title={expanded ? undefined : label}
      aria-label={label}
      className={`pharos-focus-ring flex items-center gap-3 rounded-md text-muted-foreground transition-[background-color,color] duration-200 hover:bg-muted/50 hover:text-foreground ${
        expanded ? "w-full mx-2 px-3 py-2.5" : "mx-auto px-0 py-2 justify-center w-10"
      }`}
    >
      <div className="relative h-4 w-4 shrink-0">
        <PharosIcon
          icon={Sun}
          className={`absolute transition-all duration-200 ${
            isDark ? 'opacity-0 rotate-90 scale-50' : 'opacity-100 rotate-0 scale-100'
          }`}
          aria-hidden="true"
        />
        <PharosIcon
          icon={Moon}
          className={`absolute transition-all duration-200 ${
            isDark ? 'opacity-100 rotate-0 scale-100' : 'opacity-0 -rotate-90 scale-50'
          }`}
          aria-hidden="true"
        />
      </div>
      {expanded && <span className="text-sm">{label}</span>}
    </button>
  );
}

function SidebarGroup({
  groupKey, label, items, expanded: sidebarExpanded, isGroupExpanded, onToggle, pathname, navSignals, onPrefetch,
}: {
  groupKey: string; label: string; items: NavItem[]; expanded: boolean;
  isGroupExpanded: boolean; onToggle: () => void; pathname: string; navSignals: Record<string, SidebarNavSignal | null>;
  onPrefetch?: (href: string) => void;
}) {
  return (
    <div>
      {sidebarExpanded && (
        <button type="button"
          onClick={onToggle}
          className="flex min-h-7 w-full items-center justify-between px-5 py-1.5 text-[10px] font-semibold uppercase tracking-[0.15em] text-muted-foreground/75 transition-colors hover:text-foreground"
          aria-expanded={isGroupExpanded}
          aria-controls={`nav-group-${groupKey}`}
        >
          {label}
          <ChevronRight
            className={`h-3 w-3 ${isGroupExpanded ? "rotate-90" : ""}`}
            style={{ transition: "transform 160ms var(--motion-ease-standard)" }}
          />
        </button>
      )}
      {sidebarExpanded ? (
        <>
          <div
            className={`grid transition-[grid-template-rows] duration-200 ease-[var(--motion-ease-standard)] ${isGroupExpanded ? "grid-rows-[1fr]" : "grid-rows-[0fr]"}`}
            aria-hidden={!isGroupExpanded}
            inert={!isGroupExpanded}
          >
            <div className="overflow-hidden">
              <div id={`nav-group-${groupKey}`} className="space-y-0.5">
                {items.map((item) => (
                  <SidebarNavItem
                    key={item.href}
                    item={item}
                    expanded={sidebarExpanded}
                    isActive={isRouteActive(pathname, item.href)}
                    signal={navSignals[item.href]}
                    onPrefetch={onPrefetch}
                  />
                ))}
              </div>
            </div>
          </div>
          {!isGroupExpanded && (
            <div className="px-5 text-[11px] italic text-muted-foreground">{items.length} pages</div>
          )}
        </>
      ) : (
        <div className="space-y-0.5">
          {items.map((item) => (
            <SidebarNavItem
              key={item.href}
              item={item}
              expanded={false}
              isActive={isRouteActive(pathname, item.href)}
              signal={navSignals[item.href]}
              onPrefetch={onPrefetch}
            />
          ))}
        </div>
      )}
    </div>
  );
}

export function Sidebar() {
  const { expanded, pinned, togglePin, onMouseEnter, onMouseLeave } = useSidebar();
  const pathname = usePathname();
  const { isExpanded: isGroupExpanded, toggle } = useNavCollapse();
  const navSignals = useSidebarNavSignals();
  const { isReady: startHereReady, shouldShow: shouldShowStartHereNav } = useStartHereNavVisibility();
  const { prefetch } = useNavPrefetch();
  const { primaryItems, groups } = getSidebarNavForPath(pathname);
  const visibleBottomNavItems = BOTTOM_NAV_ITEMS.filter((item) => item.href !== "/start/" || (startHereReady && shouldShowStartHereNav));

  // Keyboard shortcut: [ and ] toggle sidebar pin state.
  // Editable targets are excluded. No modifier key is used intentionally
  // to match VS Code-style sidebar toggle conventions; per WCAG 2.1.4 the
  // shortcut can be turned off from the keyboard-shortcuts dialog (?).
  useEffect(() => {
    function isEditableTarget(target: EventTarget | null): boolean {
      if (!(target instanceof HTMLElement)) return false;
      if (target instanceof HTMLInputElement) return true;
      if (target instanceof HTMLTextAreaElement) return true;
      if (target instanceof HTMLSelectElement) return true;
      return target.isContentEditable;
    }
    function handleKeyDown(e: KeyboardEvent) {
      if (e.key !== "[" && e.key !== "]") return;
      // Leave browser/OS combos like Cmd+[ (history back) alone.
      if (e.ctrlKey || e.metaKey || e.altKey) return;
      if (isEditableTarget(e.target)) return;
      if (isSidebarShortcutDisabled()) return;
      e.preventDefault();
      togglePin();
    }
    window.addEventListener("keydown", handleKeyDown);
    return () => window.removeEventListener("keydown", handleKeyDown);
  }, [togglePin]);

  return (
    <aside
      className="hidden lg:flex flex-col fixed top-[3px] left-0 h-[calc(100vh-3px)] border-r border-border/70 bg-card shadow-[0_0_0_1px_oklch(1_0_0_/0.03),0_20px_35px_oklch(0_0_0_/0.2)] z-[55] transition-all duration-200"
      style={{ width: expanded ? "var(--sidebar-width-expanded)" : "var(--sidebar-width-collapsed)" }}
      aria-label="Main navigation"
      onMouseEnter={onMouseEnter}
      onMouseLeave={onMouseLeave}
    >
      {/* Brand lockup — the tower. A thin shaft of frost light rides the
          header divider and fades to the right like a real beam. */}
      <div className={`relative flex items-center h-14 shrink-0 border-b border-border/55 ${expanded ? "px-4 gap-3" : "justify-center"}`}>
        <Link prefetch={false} href="/" className="pharos-focus-ring flex items-center gap-3 rounded-md" aria-label="PHAROS home">
          <PharosLogo size={28} />
          {expanded && <span className="text-sm font-mono uppercase tracking-[0.2em] font-semibold text-foreground">PHAROS</span>}
        </Link>
        <span aria-hidden className="pharos-brand-beam pointer-events-none absolute inset-x-0 -bottom-px h-px" />
      </div>

      {/* Search — a command field, not a nav row: bordered + inset, with a
          frost edge on hover so it reads as the entry point to everything. */}
      <button type="button"
        onClick={openCommandPalette}
        title={expanded ? undefined : "Search (Ctrl+K)"}
        aria-label="Search Ctrl+K"
        className={`pharos-focus-ring group/search flex items-center rounded-md border border-border/70 bg-background/40 text-muted-foreground transition-[color,background-color,border-color] duration-200 hover:border-frost-blue/45 hover:bg-background/70 hover:text-foreground ${
          expanded ? "mx-2 mt-2 gap-2.5 px-3 py-2" : "mx-auto mt-2 w-10 justify-center py-2"
        }`}
      >
        <PharosIcon icon={Search} className="shrink-0" />
        {expanded && <span className="text-sm">Search</span>}
        {expanded && (
          <kbd className="ml-auto rounded border border-border/70 bg-muted/40 px-1.5 py-0.5 font-mono text-[10px] text-muted-foreground transition-colors group-hover/search:text-foreground">
            Ctrl+K
          </kbd>
        )}
      </button>

      {/* Nav groups */}
      <nav className="flex-1 overflow-y-auto py-2 space-y-4" aria-label="Main navigation">
        {/* Primary pages */}
        <div className="space-y-0.5">
          {primaryItems.map((item) => (
            <SidebarNavItem
              key={item.href}
              item={item}
              expanded={expanded}
              isActive={isRouteActive(pathname, item.href)}
              signal={navSignals[item.href]}
              onPrefetch={prefetch}
            />
          ))}
        </div>
        {groups.map((group) => (
          <SidebarGroup
            key={group.key}
            groupKey={group.key}
            label={group.label}
            items={group.items}
            expanded={expanded}
            isGroupExpanded={isGroupExpanded(group.key)}
            onToggle={() => toggle(group.key)}
            pathname={pathname}
            navSignals={navSignals}
            onPrefetch={prefetch}
          />
        ))}

        {/* Companion experiences — sit just above the utility separator,
            with a subtle parchment/brass tint to nod at PharosVille's
            isometric chrome without breaking the dashboard's aesthetic. */}
        <div className="space-y-0.5 pt-1">
          {COMPANION_NAV_ITEMS.map((item) => (
            <SidebarNavItem
              key={item.href}
              item={item}
              expanded={expanded}
              isActive={false}
            />
          ))}
        </div>
      </nav>

      {/* Bottom section */}
      <div className="shrink-0 border-t border-border/65 bg-muted/15 py-2 space-y-0.5">
        {visibleBottomNavItems.map((item) => (
          <SidebarNavItem
            key={item.href}
            item={item}
            expanded={expanded}
            isActive={isRouteActive(pathname, item.href)}
            onPrefetch={prefetch}
          />
        ))}
        <ThemeSidebarItem expanded={expanded} />
        <button type="button"
          onClick={togglePin}
          title={pinned ? "Unpin sidebar" : "Pin sidebar open"}
          aria-label={pinned ? "Unpin sidebar" : "Pin sidebar open"}
          className={`pharos-focus-ring flex items-center gap-3 rounded-md text-muted-foreground transition-[background-color,color] duration-200 hover:bg-muted/50 hover:text-foreground ${
            expanded ? "mx-2 px-3 py-2.5" : "mx-auto px-0 py-2 justify-center w-10"
          }`}
        >
          {expanded ? (
            <>
              <PharosIcon icon={ChevronsLeft} className="shrink-0" />
              <span className="text-sm">{pinned ? "Unpin" : "Pin open"}</span>
            </>
          ) : (
            <PharosIcon icon={ChevronsRight} className="shrink-0" />
          )}
        </button>
      </div>
    </aside>
  );
}
