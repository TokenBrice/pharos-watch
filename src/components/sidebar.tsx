"use client";

import { createContext, useCallback, useContext, useEffect, useRef, useState } from "react";
import Image from "next/image";
import Link from "next/link";
import { usePathname } from "next/navigation";
import { useTheme } from "next-themes";
import { ChevronsLeft, ChevronsRight, Moon, Search, Sun } from "lucide-react";
import { NAV_GROUPS, BOTTOM_NAV_ITEMS, DASHBOARD_NAV_ITEM } from "@/lib/nav-config";
import type { NavItem } from "@/lib/nav-config";
import { trackEvent } from "@/lib/analytics";

const STORAGE_KEY = "pharos-sidebar-expanded";
const HOVER_DELAY = 200;

/* ------------------------------------------------------------------ */
/*  Context — shares pinned state between Sidebar and SidebarSpacer   */
/* ------------------------------------------------------------------ */

interface SidebarState {
  expanded: boolean;
  pinned: boolean;
  togglePin: () => void;
  onMouseEnter: () => void;
  onMouseLeave: () => void;
}

const SidebarContext = createContext<SidebarState | null>(null);

function useSidebar() {
  const ctx = useContext(SidebarContext);
  if (!ctx) throw new Error("useSidebar must be used within <SidebarProvider>");
  return ctx;
}

function useExpanded(): SidebarState {
  const [pinned, setPinned] = useState(() => {
    if (typeof window === "undefined") return true;
    return localStorage.getItem(STORAGE_KEY) !== "false";
  });
  const [hovered, setHovered] = useState(false);
  const hoverTimeout = useRef<ReturnType<typeof setTimeout> | null>(null);

  const togglePin = useCallback(() => {
    setPinned((prev) => {
      const next = !prev;
      localStorage.setItem(STORAGE_KEY, String(next));
      return next;
    });
  }, []);

  const onMouseEnter = useCallback(() => {
    hoverTimeout.current = setTimeout(() => setHovered(true), HOVER_DELAY);
  }, []);

  const onMouseLeave = useCallback(() => {
    if (hoverTimeout.current) clearTimeout(hoverTimeout.current);
    hoverTimeout.current = null;
    setHovered(false);
  }, []);

  // Expanded if pinned OR hovered
  const expanded = pinned || hovered;

  return { expanded, pinned, togglePin, onMouseEnter, onMouseLeave };
}

export function SidebarProvider({ children }: { children: React.ReactNode }) {
  const value = useExpanded();
  return <SidebarContext.Provider value={value}>{children}</SidebarContext.Provider>;
}

export function SidebarSpacer() {
  const { pinned } = useSidebar();
  return (
    <div
      className={`hidden md:block shrink-0 transition-all duration-200 ${pinned ? "w-[var(--sidebar-width-expanded)]" : "w-[var(--sidebar-width-collapsed)]"}`}
    />
  );
}

function SidebarNavItem({ item, expanded, isActive }: { item: NavItem; expanded: boolean; isActive: boolean }) {
  const Icon = item.icon;

  return (
    <Link
      href={item.href}
      title={expanded ? undefined : item.label}
      aria-label={item.label}
      aria-current={isActive ? "page" : undefined}
      className={`pharos-focus-ring flex items-center gap-3 rounded-md border-l-[3px] transition-[background-color,border-color,color,box-shadow] duration-200 ${
        expanded ? "mx-2 px-3 py-2.5" : "mx-auto px-0 py-2 justify-center w-10"
      } ${
        isActive
          ? "border-l-frost-blue bg-muted/60 text-foreground shadow-sm"
          : "border-l-transparent text-muted-foreground hover:border-l-border/80 hover:bg-muted/45 hover:text-foreground"
      }`}
    >
      <Icon className="h-4 w-4 shrink-0" />
      {expanded && <span className="text-sm truncate">{item.label}</span>}
    </Link>
  );
}

function ThemeSidebarItem({ expanded }: { expanded: boolean }) {
  const { theme, setTheme } = useTheme();
  const [mounted, setMounted] = useState(false);
  // eslint-disable-next-line react-hooks/set-state-in-effect
  useEffect(() => setMounted(true), []);

  const isDark = mounted ? theme === "dark" : false;
  const Icon = isDark ? Sun : Moon;
  const label = isDark ? "Light mode" : "Dark mode";

  return (
    <button
      onClick={() => {
        const next = isDark ? "light" : "dark";
        trackEvent("theme_toggled", { theme: next });
        setTheme(next);
      }}
      title={expanded ? undefined : label}
      aria-label={label}
      className={`pharos-focus-ring flex items-center gap-3 rounded-md border-l-[3px] border-l-transparent text-muted-foreground transition-[background-color,border-color,color,box-shadow] duration-200 hover:border-l-border/80 hover:bg-muted/45 hover:text-foreground ${
        expanded ? "w-full mx-2 px-3 py-2.5" : "mx-auto px-0 py-2 justify-center w-10"
      }`}
    >
      <Icon className="h-4 w-4 shrink-0" />
      {expanded && <span className="text-sm">{label}</span>}
    </button>
  );
}

export function Sidebar() {
  const { expanded, pinned, togglePin, onMouseEnter, onMouseLeave } = useSidebar();
  const pathname = usePathname();

  useEffect(() => {
    function handleKeyDown(e: KeyboardEvent) {
      // Ignore when typing in inputs
      if (e.target instanceof HTMLInputElement || e.target instanceof HTMLTextAreaElement) return;
      if (e.key === "[" || e.key === "]") {
        e.preventDefault();
        togglePin();
      }
    }
    window.addEventListener("keydown", handleKeyDown);
    return () => window.removeEventListener("keydown", handleKeyDown);
  }, [togglePin]);

  function isActive(href: string) {
    if (href === "/") return pathname === "/";
    return pathname === href || pathname.startsWith(href + "/");
  }

  return (
    <aside
      className="hidden md:flex flex-col fixed top-0 left-0 h-screen border-r border-border/70 bg-card/92 shadow-[0_0_0_1px_oklch(1_0_0_/0.03),0_20px_35px_oklch(0_0_0_/0.2)] backdrop-blur-xl z-40 transition-all duration-200"
      style={{ width: expanded ? "var(--sidebar-width-expanded)" : "var(--sidebar-width-collapsed)" }}
      aria-label="Main navigation"
      onMouseEnter={onMouseEnter}
      onMouseLeave={onMouseLeave}
    >
      {/* Logo */}
      <div className={`flex items-center h-14 shrink-0 border-b border-border/65 ${expanded ? "px-4 gap-3" : "justify-center"}`}>
        <Link href="/" className="pharos-focus-ring flex items-center gap-3 rounded-md" aria-label="Pharos home">
          <Image
            src="/pharos-icon.png"
            alt=""
            width={28}
            height={28}
            className="rounded-lg ring-1 ring-border/60 shrink-0 bg-slate-900/90 dark:bg-transparent"
          />
          {expanded && <span className="text-sm font-mono uppercase tracking-[0.18em] font-semibold">PHAROS</span>}
        </Link>
      </div>

      {/* Search */}
      <button
        onClick={() => window.dispatchEvent(new CustomEvent("open-command-palette"))}
        title={expanded ? undefined : "Search (Ctrl+K)"}
        aria-label="Search (Ctrl+K)"
        className={`pharos-focus-ring flex items-center gap-3 rounded-md border-l-[3px] border-l-transparent text-muted-foreground transition-[background-color,border-color,color,box-shadow] duration-200 hover:border-l-border/80 hover:bg-muted/45 hover:text-foreground ${
          expanded ? "mx-2 mt-1 px-3 py-2.5" : "mx-auto mt-1 px-0 py-2 justify-center w-10"
        }`}
      >
        <Search className="h-4 w-4 shrink-0" />
        {expanded && <span className="text-sm">Search</span>}
        {expanded && (
          <kbd className="ml-auto text-[10px] font-mono text-muted-foreground/70 border border-border/75 rounded-md px-1.5 py-0.5">
            Ctrl+K
          </kbd>
        )}
      </button>

      {/* Nav groups */}
      <nav className="flex-1 overflow-y-auto py-2 space-y-4" aria-label="Main navigation">
        {/* Dashboard standalone */}
        <div className="space-y-0.5">
          <SidebarNavItem item={DASHBOARD_NAV_ITEM} expanded={expanded} isActive={isActive(DASHBOARD_NAV_ITEM.href)} />
        </div>
        {NAV_GROUPS.map((group) => (
          <div key={group.label}>
            {expanded && (
              <div className="px-5 pb-1.5 text-xs font-semibold uppercase tracking-[0.11em] text-muted-foreground/65">
                {group.label}
              </div>
            )}
            <div className="space-y-0.5">
              {group.items.map((item) => (
                <SidebarNavItem
                  key={item.href}
                  item={item}
                  expanded={expanded}
                  isActive={isActive(item.href)}
                />
              ))}
            </div>
          </div>
        ))}
      </nav>

      {/* Bottom section */}
      <div className="shrink-0 border-t border-border/65 bg-muted/15 py-2 space-y-0.5">
        {BOTTOM_NAV_ITEMS.map((item) => (
          <SidebarNavItem
            key={item.href}
            item={item}
            expanded={expanded}
            isActive={isActive(item.href)}
          />
        ))}
        <ThemeSidebarItem expanded={expanded} />
        <button
          onClick={togglePin}
          title={pinned ? "Unpin sidebar" : "Pin sidebar open"}
          aria-label={pinned ? "Unpin sidebar" : "Pin sidebar open"}
          className={`pharos-focus-ring flex items-center gap-3 rounded-md border-l-[3px] border-l-transparent text-muted-foreground transition-[background-color,border-color,color,box-shadow] duration-200 hover:border-l-border/80 hover:bg-muted/45 hover:text-foreground ${
            expanded ? "mx-2 px-3 py-2.5" : "mx-auto px-0 py-2 justify-center w-10"
          }`}
        >
          {expanded ? (
            <>
              <ChevronsLeft className="h-4 w-4 shrink-0" />
              <span className="text-sm">{pinned ? "Unpin" : "Pin open"}</span>
            </>
          ) : (
            <ChevronsRight className="h-4 w-4 shrink-0" />
          )}
        </button>
      </div>
    </aside>
  );
}
