"use client";

import { useState } from "react";
import Link from "next/link";
import { usePathname } from "next/navigation";
import { PharosLogo } from "@/components/pharos-logo";
import {
  Sheet,
  SheetTrigger,
  SheetContent,
  SheetTitle,
} from "@/components/ui/sheet";
import { Button } from "@/components/ui/button";
import { ThemeToggle } from "./theme-toggle";
import { NAV_GROUPS, ABOUT_NAV_GROUP, BOTTOM_NAV_ITEMS, DASHBOARD_NAV_ITEM } from "@/lib/nav-config";
import type { NavItem } from "@/lib/nav-config";
import { Menu, Search, X, ChevronRight } from "lucide-react";
import { openCommandPalette } from "@/lib/command-palette";
import { isRouteActive } from "@/lib/navigation";
import { useNavCollapse } from "@/hooks/use-nav-collapse";

function MobileNavLink({ item, active, onNavigate }: { item: NavItem; active: boolean; onNavigate: () => void }) {
  const Icon = item.icon;
  return (
    <Link
      href={item.href}
      onClick={onNavigate}
      aria-current={active ? "page" : undefined}
      className={`pharos-focus-ring flex items-start gap-3 rounded-lg border px-3 py-3 transition-[background-color,border-color,color,box-shadow] duration-200 ${
        active
          ? "border-border/70 bg-muted/60 font-medium text-foreground shadow-sm"
          : "border-transparent text-muted-foreground hover:border-border/55 hover:bg-muted/45 hover:text-foreground"
      }`}
    >
      <Icon className="h-4 w-4 shrink-0 mt-0.5" />
      <div className="min-w-0">
        <div className="text-sm">{item.label}</div>
        {item.description && (
          <div className="text-xs text-muted-foreground/60 mt-0.5">{item.description}</div>
        )}
      </div>
    </Link>
  );
}

export function Header() {
  const pathname = usePathname();
  const [open, setOpen] = useState(false);
  const { isExpanded: isGroupExpanded, toggle } = useNavCollapse();

  return (
    <header className="md:hidden sticky top-[3px] z-50 border-b border-border/80 bg-background" style={{ boxShadow: "var(--elevation-rest)" }}>
      <div className="container mx-auto flex h-14 items-center justify-between px-4">
        <Link href="/" className="pharos-focus-ring flex items-center gap-3 rounded-md font-semibold">
          <PharosLogo size={32} priority />
          <span className="text-[1.05rem] font-mono uppercase tracking-[0.18em]">PHAROS</span>
        </Link>

        <Sheet open={open} onOpenChange={setOpen}>
          <SheetTrigger asChild>
            <Button variant="ghost" size="icon" className="h-11 w-11">
              <Menu className="h-4 w-4" />
              <span className="sr-only">Menu</span>
            </Button>
          </SheetTrigger>
          <SheetContent
            side="left"
            showCloseButton={false}
            className="w-full sm:max-w-full flex flex-col border-r border-border/70 bg-card/95 p-0"
          >
            {/* Header */}
            <div className="flex items-center justify-between px-4 h-14 border-b border-border/70 shrink-0">
              <Link href="/" onClick={() => setOpen(false)} className="pharos-focus-ring flex items-center gap-3 rounded-md">
                <PharosLogo size={28} />
                <SheetTitle className="text-lg font-mono uppercase tracking-[0.18em]">PHAROS</SheetTitle>
              </Link>
              <Button variant="ghost" size="icon" className="h-11 w-11" onClick={() => setOpen(false)}>
                <X className="h-4 w-4" />
                <span className="sr-only">Close menu</span>
              </Button>
            </div>

            {/* Navigation */}
            <nav className="flex-1 overflow-y-auto px-4 py-4" aria-label="Main navigation">
              {/* Dashboard standalone */}
              <div
                className="animate-in fade-in slide-in-from-left-2 [animation-fill-mode:backwards]"
                style={{ animationDelay: "0ms", animationDuration: "200ms" }}
              >
                <MobileNavLink item={DASHBOARD_NAV_ITEM} active={isRouteActive(pathname, DASHBOARD_NAV_ITEM.href)} onNavigate={() => setOpen(false)} />
              </div>

              {/* Grouped sections */}
              {NAV_GROUPS.map((group, groupIndex) => {
                const groupIsActive = group.items.some((item) => isRouteActive(pathname, item.href));
                const groupExpanded = isGroupExpanded(group.key);
                return (
                  <div
                    key={group.key}
                    className={`mt-4 animate-in fade-in slide-in-from-left-2 [animation-fill-mode:backwards] ${
                      groupIsActive ? "border-l-2 border-l-frost-blue pl-3" : "pl-[14px]"
                    }`}
                    style={{ animationDelay: `${(groupIndex + 1) * 50}ms`, animationDuration: "200ms" }}
                  >
                    <button
                      onClick={() => toggle(group.key)}
                      className="flex w-full items-center justify-between mb-1.5 text-xs font-semibold uppercase tracking-[0.11em] text-muted-foreground/65 hover:text-muted-foreground transition-colors"
                      aria-expanded={groupExpanded}
                    >
                      {group.label}
                      <ChevronRight className={`h-3 w-3 transition-transform duration-200 ${groupExpanded ? "rotate-90" : ""}`} />
                    </button>
                    <div className={`grid transition-[grid-template-rows] duration-200 ease-[var(--motion-ease-standard)] ${groupExpanded ? "grid-rows-[1fr]" : "grid-rows-[0fr]"}`}>
                      <div className="overflow-hidden">
                        {group.items.map((item) => (
                          <MobileNavLink key={item.href} item={item} active={isRouteActive(pathname, item.href)} onNavigate={() => setOpen(false)} />
                        ))}
                      </div>
                    </div>
                    {!groupExpanded && (
                      <div className="px-3 py-2 text-xs italic text-muted-foreground/40">{group.items.length} pages</div>
                    )}
                  </div>
                );
              })}

              {/* About group — link + expansion row */}
              <div
                className={`mt-4 animate-in fade-in slide-in-from-left-2 [animation-fill-mode:backwards] ${
                  isRouteActive(pathname, ABOUT_NAV_GROUP.href) || ABOUT_NAV_GROUP.children.some((c) => isRouteActive(pathname, c.href))
                    ? "border-l-2 border-l-frost-blue pl-3" : "pl-[14px]"
                }`}
                style={{ animationDelay: `${(NAV_GROUPS.length + 1) * 50}ms`, animationDuration: "200ms" }}
              >
                <MobileNavLink
                  item={{ href: ABOUT_NAV_GROUP.href, label: ABOUT_NAV_GROUP.label, icon: ABOUT_NAV_GROUP.icon, description: ABOUT_NAV_GROUP.description }}
                  active={isRouteActive(pathname, ABOUT_NAV_GROUP.href)}
                  onNavigate={() => setOpen(false)}
                />
                <button
                  onClick={() => toggle("about")}
                  className="flex w-full items-center justify-between rounded-lg px-3 py-3 text-xs text-muted-foreground/60 hover:text-muted-foreground transition-colors"
                  aria-expanded={isGroupExpanded("about")}
                >
                  <span>Methodology, API, Changelog…</span>
                  <ChevronRight className={`h-3 w-3 transition-transform duration-200 ${isGroupExpanded("about") ? "rotate-90" : ""}`} />
                </button>
                <div className={`grid transition-[grid-template-rows] duration-200 ease-[var(--motion-ease-standard)] ${isGroupExpanded("about") ? "grid-rows-[1fr]" : "grid-rows-[0fr]"}`}>
                  <div className="overflow-hidden ml-2">
                    {ABOUT_NAV_GROUP.children.map((item) => (
                      <MobileNavLink key={item.href} item={item} active={isRouteActive(pathname, item.href)} onNavigate={() => setOpen(false)} />
                    ))}
                  </div>
                </div>
              </div>

              {BOTTOM_NAV_ITEMS.length > 0 ? (
                <div
                  className={`mt-4 animate-in fade-in slide-in-from-left-2 [animation-fill-mode:backwards] ${
                    BOTTOM_NAV_ITEMS.some((item) => isRouteActive(pathname, item.href)) ? "border-l-2 border-l-frost-blue pl-3" : "pl-[14px]"
                  }`}
                  style={{ animationDelay: `${(NAV_GROUPS.length + 2) * 50}ms`, animationDuration: "200ms" }}
                >
                  {BOTTOM_NAV_ITEMS.map((item) => (
                    <MobileNavLink key={item.href} item={item} active={isRouteActive(pathname, item.href)} onNavigate={() => setOpen(false)} />
                  ))}
                </div>
              ) : null}
            </nav>

            {/* Footer */}
            <div className="border-t border-border/70 bg-muted/20 px-4 py-3 flex items-center justify-between shrink-0">
              <Button
                variant="ghost"
                size="sm"
                className="gap-2 min-h-11"
                onClick={() => {
                  setOpen(false);
                  openCommandPalette();
                }}
              >
                <Search className="h-4 w-4" />
                Search
              </Button>
              <ThemeToggle />
            </div>
          </SheetContent>
        </Sheet>
      </div>
    </header>
  );
}
