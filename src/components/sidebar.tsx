"use client";

import { useCallback, useEffect, useState } from "react";
import Image from "next/image";
import Link from "next/link";
import { usePathname } from "next/navigation";
import { ChevronsLeft, ChevronsRight } from "lucide-react";
import { NAV_GROUPS, BOTTOM_NAV_ITEMS } from "@/lib/nav-config";
import type { NavItem } from "@/lib/nav-config";
import { ThemeToggle } from "./theme-toggle";

const STORAGE_KEY = "pharos-sidebar-expanded";

function useExpanded() {
  const [expanded, setExpanded] = useState(false);

  useEffect(() => {
    const stored = localStorage.getItem(STORAGE_KEY);
    if (stored === "true") setExpanded(true);
  }, []);

  const toggle = useCallback(() => {
    setExpanded((prev) => {
      const next = !prev;
      localStorage.setItem(STORAGE_KEY, String(next));
      return next;
    });
  }, []);

  return { expanded, toggle };
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
  const { expanded, toggle } = useExpanded();
  const pathname = usePathname();

  useEffect(() => {
    function handleKeyDown(e: KeyboardEvent) {
      // Ignore when typing in inputs
      if (e.target instanceof HTMLInputElement || e.target instanceof HTMLTextAreaElement) return;
      if (e.key === "[" || e.key === "]") {
        e.preventDefault();
        toggle();
      }
    }
    window.addEventListener("keydown", handleKeyDown);
    return () => window.removeEventListener("keydown", handleKeyDown);
  }, [toggle]);

  function isActive(href: string) {
    if (href === "/") return pathname === "/";
    return pathname === href || pathname.startsWith(href + "/");
  }

  return (
    <aside
      className="hidden md:flex flex-col fixed top-0 left-0 h-screen border-r border-border bg-card z-40 transition-all duration-200"
      style={{ width: expanded ? 220 : 56 }}
      aria-label="Main navigation"
    >
      {/* Logo */}
      <div className={`flex items-center h-14 shrink-0 ${expanded ? "px-4 gap-3" : "justify-center"}`}>
        <Link href="/" className="flex items-center gap-3" aria-label="Pharos home">
          <Image src="/pharos-icon.png" alt="" width={28} height={28} className="rounded-lg shrink-0" />
          {expanded && <span className="text-sm font-mono uppercase tracking-[0.2em] font-semibold">PHAROS</span>}
        </Link>
      </div>

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
          onClick={toggle}
          title={expanded ? "Collapse sidebar" : "Expand sidebar"}
          className={`flex items-center gap-3 rounded-md text-muted-foreground hover:bg-muted/50 hover:text-foreground transition-colors ${
            expanded ? "mx-2 px-3 py-2" : "mx-auto px-0 py-2 justify-center w-10"
          }`}
        >
          {expanded ? (
            <>
              <ChevronsLeft className="h-4 w-4 shrink-0" />
              <span className="text-sm">Collapse</span>
            </>
          ) : (
            <ChevronsRight className="h-4 w-4 shrink-0" />
          )}
        </button>
      </div>
    </aside>
  );
}
