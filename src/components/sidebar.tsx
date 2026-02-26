"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import Image from "next/image";
import Link from "next/link";
import { usePathname } from "next/navigation";
import { ChevronsLeft, ChevronsRight, Search } from "lucide-react";
import { NAV_GROUPS, BOTTOM_NAV_ITEMS } from "@/lib/nav-config";
import type { NavItem } from "@/lib/nav-config";
import { ThemeToggle } from "./theme-toggle";

const STORAGE_KEY = "pharos-sidebar-expanded";
const HOVER_DELAY = 200;

function useExpanded() {
  const [pinned, setPinned] = useState(false);
  const [hovered, setHovered] = useState(false);
  const hoverTimeout = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => {
    const stored = localStorage.getItem(STORAGE_KEY);
    if (stored === "true") setPinned(true);
  }, []);

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

function SidebarNavItem({ item, expanded, isActive }: { item: NavItem; expanded: boolean; isActive: boolean }) {
  const Icon = item.icon;

  return (
    <Link
      href={item.href}
      title={expanded ? undefined : item.label}
      aria-current={isActive ? "page" : undefined}
      className={`flex items-center gap-3 rounded-md transition-colors focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-none ${
        expanded ? "mx-2 px-3 py-2" : "mx-auto px-0 py-2 justify-center w-10"
      } ${
        isActive
          ? "border-l-[3px] border-l-frost-blue text-foreground bg-muted/50"
          : "text-muted-foreground hover:bg-muted/50 hover:text-foreground border-l-[3px] border-l-transparent"
      }`}
    >
      <Icon className="h-4 w-4 shrink-0" />
      {expanded && <span className="text-sm truncate">{item.label}</span>}
    </Link>
  );
}

export function Sidebar() {
  const { expanded, pinned, togglePin, onMouseEnter, onMouseLeave } = useExpanded();
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
      className="hidden md:flex flex-col fixed top-0 left-0 h-screen border-r border-border bg-card z-40 transition-all duration-200"
      style={{ width: expanded ? 220 : 56 }}
      aria-label="Main navigation"
      onMouseEnter={onMouseEnter}
      onMouseLeave={onMouseLeave}
    >
      {/* Logo */}
      <div className={`flex items-center h-14 shrink-0 ${expanded ? "px-4 gap-3" : "justify-center"}`}>
        <Link href="/" className="flex items-center gap-3" aria-label="Pharos home">
          <Image src="/pharos-icon.png" alt="" width={28} height={28} className="rounded-lg shrink-0" />
          {expanded && <span className="text-sm font-mono uppercase tracking-[0.2em] font-semibold">PHAROS</span>}
        </Link>
      </div>

      {/* Search */}
      <button
        onClick={() => window.dispatchEvent(new CustomEvent("open-command-palette"))}
        title={expanded ? undefined : "Search (Ctrl+K)"}
        className={`flex items-center gap-3 rounded-md text-muted-foreground hover:bg-muted/50 hover:text-foreground transition-colors ${
          expanded ? "mx-2 px-3 py-2" : "mx-auto px-0 py-2 justify-center w-10"
        }`}
      >
        <Search className="h-4 w-4 shrink-0" />
        {expanded && <span className="text-sm">Search</span>}
        {expanded && (
          <kbd className="ml-auto text-[10px] font-mono text-muted-foreground/60 border border-border rounded px-1 py-0.5">
            Ctrl+K
          </kbd>
        )}
      </button>

      {/* Nav groups */}
      <nav className="flex-1 overflow-y-auto py-2 space-y-4" aria-label="Main navigation">
        {NAV_GROUPS.map((group) => (
          <div key={group.label}>
            {expanded && (
              <div className="px-5 pb-1 text-[11px] font-semibold uppercase tracking-wider text-muted-foreground/60">
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
      <div className="shrink-0 border-t border-border py-2 space-y-0.5">
        {BOTTOM_NAV_ITEMS.map((item) => (
          <SidebarNavItem
            key={item.href}
            item={item}
            expanded={expanded}
            isActive={isActive(item.href)}
          />
        ))}
        <div className={`flex ${expanded ? "mx-2 px-3 py-1" : "justify-center py-1"}`}>
          <ThemeToggle />
        </div>
        <button
          onClick={togglePin}
          title={pinned ? "Unpin sidebar" : "Pin sidebar open"}
          className={`flex items-center gap-3 rounded-md text-muted-foreground hover:bg-muted/50 hover:text-foreground transition-colors ${
            expanded ? "mx-2 px-3 py-2" : "mx-auto px-0 py-2 justify-center w-10"
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
