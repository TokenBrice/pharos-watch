"use client";

import { useState } from "react";
import Image from "next/image";
import Link from "next/link";
import { usePathname } from "next/navigation";
import {
  Sheet,
  SheetTrigger,
  SheetContent,
  SheetTitle,
} from "@/components/ui/sheet";
import { Button } from "@/components/ui/button";
import { ThemeToggle } from "./theme-toggle";
import { NAV_GROUPS, DASHBOARD_NAV_ITEM } from "@/lib/nav-config";
import type { NavItem } from "@/lib/nav-config";
import { Menu, Search, X } from "lucide-react";

function MobileNavLink({ item, active, onNavigate }: { item: NavItem; active: boolean; onNavigate: () => void }) {
  const Icon = item.icon;
  return (
    <Link
      href={item.href}
      onClick={onNavigate}
      aria-current={active ? "page" : undefined}
      className={`flex items-start gap-3 rounded-md px-3 py-3 transition-colors ${
        active
          ? "bg-muted/50 font-medium text-foreground"
          : "text-muted-foreground hover:bg-muted/50 hover:text-foreground"
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
    <header className="md:hidden sticky top-0 z-50 border-b bg-background/95 backdrop-blur supports-[backdrop-filter]:bg-background/60">
      <div className="container mx-auto flex h-14 items-center justify-between px-4">
        <Link href="/" className="flex items-center gap-3 font-semibold">
          <Image src="/pharos-icon.png" alt="Pharos" width={32} height={32} className="rounded-lg" priority />
          <span className="text-lg font-mono uppercase tracking-[0.2em]">PHAROS</span>
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
            className="w-full sm:max-w-full flex flex-col p-0"
          >
            {/* Header */}
            <div className="flex items-center justify-between px-4 h-14 border-b shrink-0">
              <Link href="/" onClick={() => setOpen(false)} className="flex items-center gap-3">
                <Image src="/pharos-icon.png" alt="" width={28} height={28} className="rounded-lg" />
                <SheetTitle className="text-lg font-mono uppercase tracking-[0.2em]">PHAROS</SheetTitle>
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
                    <div className="text-xs font-semibold uppercase tracking-wider text-muted-foreground/60 mb-1">
                      {group.label}
                    </div>
                    {group.items.map((item) => (
                      <MobileNavLink key={item.href} item={item} active={isActive(item.href)} onNavigate={() => setOpen(false)} />
                    ))}
                  </div>
                );
              })}
            </nav>

            {/* Footer */}
            <div className="border-t px-4 py-3 flex items-center justify-between shrink-0">
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
