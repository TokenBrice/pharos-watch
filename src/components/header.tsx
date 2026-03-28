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
import { NAV_GROUPS, BOTTOM_NAV_ITEMS, DASHBOARD_NAV_ITEM } from "@/lib/nav-config";
import type { NavItem } from "@/lib/nav-config";
import { Menu, Search, X } from "lucide-react";

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

  function isActive(href: string) {
    if (href === "/") return pathname === "/";
    return pathname === href || pathname.startsWith(href + "/");
  }

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
                <MobileNavLink item={DASHBOARD_NAV_ITEM} active={isActive(DASHBOARD_NAV_ITEM.href)} onNavigate={() => setOpen(false)} />
              </div>

              {/* Grouped sections */}
              {NAV_GROUPS.map((group, groupIndex) => {
                const groupIsActive = group.items.some((item) => isActive(item.href));
                return (
                  <div
                    key={group.label}
                    className={`mt-4 animate-in fade-in slide-in-from-left-2 [animation-fill-mode:backwards] ${
                      groupIsActive ? "border-l-2 border-l-frost-blue pl-3" : "pl-[14px]"
                    }`}
                    style={{ animationDelay: `${(groupIndex + 1) * 50}ms`, animationDuration: "200ms" }}
                  >
                    <div className="text-xs font-semibold uppercase tracking-[0.11em] text-muted-foreground/65 mb-1.5">
                      {group.label}
                    </div>
                    {group.items.map((item) => (
                      <MobileNavLink key={item.href} item={item} active={isActive(item.href)} onNavigate={() => setOpen(false)} />
                    ))}
                  </div>
                );
              })}

              {BOTTOM_NAV_ITEMS.length > 0 ? (
                <div
                  className={`mt-4 animate-in fade-in slide-in-from-left-2 [animation-fill-mode:backwards] ${
                    BOTTOM_NAV_ITEMS.some((item) => isActive(item.href)) ? "border-l-2 border-l-frost-blue pl-3" : "pl-[14px]"
                  }`}
                  style={{ animationDelay: `${(NAV_GROUPS.length + 1) * 50}ms`, animationDuration: "200ms" }}
                >
                  <div className="mb-1.5 text-xs font-semibold uppercase tracking-[0.11em] text-muted-foreground/65">
                    Quick Start
                  </div>
                  {BOTTOM_NAV_ITEMS.map((item) => (
                    <MobileNavLink key={item.href} item={item} active={isActive(item.href)} onNavigate={() => setOpen(false)} />
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
                  window.dispatchEvent(new CustomEvent("open-command-palette"));
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
