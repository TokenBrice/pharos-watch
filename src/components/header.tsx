"use client";

import { useState } from "react";
import Link from "next/link";
import { usePathname } from "next/navigation";
import { PharosLogo } from "@/components/pharos-logo";
import {
  Sheet,
  SheetTrigger,
  SheetContent,
  SheetDescription,
  SheetTitle,
} from "@/components/ui/sheet";
import { Button } from "@/components/ui/button";
import { ThemeToggle } from "./theme-toggle";
import { BOTTOM_NAV_ITEMS, COMPANION_NAV_ITEMS, getSidebarNavForPath, isCoreNavPath } from "@/lib/nav-config";
import type { NavItem } from "@/lib/nav-config";
import { ExternalLink, Menu, Search, X, ChevronRight } from "lucide-react";
import { openCommandPalette } from "@/lib/command-palette";
import { isRouteActive } from "@/lib/navigation";
import { useNavCollapse } from "@/hooks/use-nav-collapse";
import { useStartHereNavVisibility } from "@/hooks/use-start-here-nav-visibility";

function MobileNavLink({ item, active, onNavigate }: { item: NavItem; active: boolean; onNavigate: () => void }) {
  const Icon = item.icon;
  const className = `pharos-focus-ring flex items-start gap-3 rounded-lg border px-3 py-3 transition-[background-color,border-color,color,box-shadow] duration-200 ${
    active
      ? "border-border/70 bg-muted/60 font-medium text-foreground shadow-sm"
      : "border-transparent text-muted-foreground hover:border-border/55 hover:bg-muted/45 hover:text-foreground"
  }`;

  const body = (
    <>
      <Icon className="h-4 w-4 shrink-0 mt-0.5" />
      <div className="min-w-0 flex-1">
        <div className="text-sm flex items-center gap-1.5">
          {item.label}
          {item.external && <ExternalLink className="h-3 w-3 text-muted-foreground/70" aria-hidden="true" />}
        </div>
        {item.description && (
          <div className="text-xs text-muted-foreground/70 mt-0.5">{item.description}</div>
        )}
      </div>
    </>
  );

  if (item.external) {
    return (
      <a
        href={item.href}
        target="_blank"
        rel="noopener noreferrer"
        onClick={onNavigate}
        aria-label={`${item.label} (opens in new tab)`}
        className={className}
      >
        {body}
      </a>
    );
  }

  return (
    <Link
      prefetch={false}
      href={item.href}
      onClick={onNavigate}
      aria-current={active ? "page" : undefined}
      className={className}
    >
      {body}
    </Link>
  );
}

export function Header() {
  const pathname = usePathname();
  const [open, setOpen] = useState(false);
  const { isExpanded: isGroupExpanded, toggle } = useNavCollapse();
  const { isReady: startHereReady, shouldShow: shouldShowStartHereNav } = useStartHereNavVisibility();
  const visibleBottomNavItems = BOTTOM_NAV_ITEMS.filter((item) => item.href !== "/start/" || (startHereReady && shouldShowStartHereNav));
  const priorityBottomNavItems = visibleBottomNavItems.filter((item) => item.href === "/start/");
  const remainingBottomNavItems = visibleBottomNavItems.filter((item) => item.href !== "/start/");
  const { primaryItems, groups } = getSidebarNavForPath(pathname);
  const [dashboardNavItem, ...remainingPrimaryNavItems] = primaryItems;
  const mobileLeadItemCount = primaryItems.length + priorityBottomNavItems.length;
  const isCorePath = isCoreNavPath(pathname);

  return (
    <header
      className={`lg:hidden sticky z-50 border-b border-border/80 bg-background ${
        isCorePath ? "top-[calc(3px+3.75rem)] sm:top-[calc(3px+2.75rem)]" : "top-[3px]"
      }`}
      style={{ boxShadow: "var(--elevation-rest)" }}
    >
      <div className="container mx-auto flex h-14 items-center justify-between px-4">
        <Link prefetch={false} href="/" className="pharos-focus-ring flex min-h-11 min-w-0 items-center gap-2.5 rounded-md py-1 font-semibold">
          <PharosLogo size={32} priority />
          <span className="flex min-w-0 flex-col leading-tight">
            <span className="text-[1.05rem] font-mono tabular-nums uppercase tracking-[0.18em]">PHAROS</span>
            <span className="truncate text-[10px] font-mono tabular-nums lowercase tracking-[0.08em] text-muted-foreground/80">
              live stablecoin signals
            </span>
          </span>
        </Link>

        <div className="flex items-center gap-1">
          <Button
            variant="ghost"
            size="icon"
            className="h-11 w-11"
            onClick={openCommandPalette}
            aria-label="Search stablecoins and pages"
          >
            <Search className="h-4 w-4" />
          </Button>

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
              <Link prefetch={false} href="/" onClick={() => setOpen(false)} className="pharos-focus-ring flex items-center gap-3 rounded-md">
                <PharosLogo size={28} />
                <SheetTitle className="text-lg font-mono tabular-nums uppercase tracking-[0.18em]">PHAROS</SheetTitle>
              </Link>
              <SheetDescription className="sr-only">
                Main navigation for Pharos dashboard routes, monitoring tools, references, and companion experiences.
              </SheetDescription>
              <Button variant="ghost" size="icon" className="h-11 w-11" onClick={() => setOpen(false)}>
                <X className="h-4 w-4" />
                <span className="sr-only">Close menu</span>
              </Button>
            </div>

            {/* Navigation */}
            <nav className="flex-1 overflow-y-auto px-4 py-4" aria-label="Main navigation">
              {/* Primary pages */}
              {dashboardNavItem ? (
                <div
                  className="animate-in fade-in slide-in-from-left-2 [animation-fill-mode:backwards]"
                  style={{ animationDelay: "0ms", animationDuration: "200ms" }}
                >
                  <MobileNavLink item={dashboardNavItem} active={isRouteActive(pathname, dashboardNavItem.href)} onNavigate={() => setOpen(false)} />
                </div>
              ) : null}

              {priorityBottomNavItems.length > 0 ? (
                <div
                  className={`mt-2 animate-in fade-in slide-in-from-left-2 [animation-fill-mode:backwards] ${
                    priorityBottomNavItems.some((item) => isRouteActive(pathname, item.href)) ? "border-l-2 border-l-frost-blue pl-3" : "pl-[14px]"
                  }`}
                  style={{ animationDelay: "50ms", animationDuration: "200ms" }}
                >
                  {priorityBottomNavItems.map((item) => (
                    <MobileNavLink key={item.href} item={item} active={isRouteActive(pathname, item.href)} onNavigate={() => setOpen(false)} />
                  ))}
                </div>
              ) : null}

              {remainingPrimaryNavItems.map((item, index) => (
                <div
                  key={item.href}
                  className="animate-in fade-in slide-in-from-left-2 [animation-fill-mode:backwards]"
                  style={{ animationDelay: `${(index + 1 + priorityBottomNavItems.length) * 50}ms`, animationDuration: "200ms" }}
                >
                  <MobileNavLink item={item} active={isRouteActive(pathname, item.href)} onNavigate={() => setOpen(false)} />
                </div>
              ))}

              {/* Grouped sections */}
              {groups.map((group, groupIndex) => {
                const groupIsActive = group.items.some((item) => isRouteActive(pathname, item.href));
                const groupExpanded = isGroupExpanded(group.key);
                return (
                  <div
                    key={group.key}
                    className={`mt-4 animate-in fade-in slide-in-from-left-2 [animation-fill-mode:backwards] ${
                      groupIsActive ? "border-l-2 border-l-frost-blue pl-3" : "pl-[14px]"
                    }`}
                    style={{ animationDelay: `${(mobileLeadItemCount + groupIndex) * 50}ms`, animationDuration: "200ms" }}
                  >
                    <button type="button"
                      onClick={() => toggle(group.key)}
                      className="flex w-full items-center justify-between mb-1.5 text-xs font-semibold uppercase tracking-[0.11em] text-muted-foreground/70 hover:text-muted-foreground transition-colors"
                      aria-expanded={groupExpanded}
                      aria-controls={`mobile-nav-group-${group.key}`}
                    >
                      {group.label}
                      <ChevronRight className={`h-3 w-3 transition-transform duration-200 ${groupExpanded ? "rotate-90" : ""}`} />
                    </button>
                    <div
                      className={`grid transition-[grid-template-rows] duration-200 ease-[var(--motion-ease-standard)] ${groupExpanded ? "grid-rows-[1fr]" : "grid-rows-[0fr]"}`}
                      aria-hidden={!groupExpanded}
                      inert={!groupExpanded}
                    >
                      <div className="overflow-hidden">
                        <div id={`mobile-nav-group-${group.key}`}>
                          {group.items.map((item) => (
                            <MobileNavLink key={item.href} item={item} active={isRouteActive(pathname, item.href)} onNavigate={() => setOpen(false)} />
                          ))}
                        </div>
                      </div>
                    </div>
                    {!groupExpanded && (
                      <div className="px-3 py-2 text-xs italic text-muted-foreground/70">{group.items.length} pages</div>
                    )}
                  </div>
                );
              })}

              {remainingBottomNavItems.length > 0 ? (
                <div
                  className={`mt-4 animate-in fade-in slide-in-from-left-2 [animation-fill-mode:backwards] ${
                    remainingBottomNavItems.some((item) => isRouteActive(pathname, item.href)) ? "border-l-2 border-l-frost-blue pl-3" : "pl-[14px]"
                  }`}
                  style={{ animationDelay: `${(primaryItems.length + groups.length) * 50}ms`, animationDuration: "200ms" }}
                >
                  {remainingBottomNavItems.map((item) => (
                    <MobileNavLink key={item.href} item={item} active={isRouteActive(pathname, item.href)} onNavigate={() => setOpen(false)} />
                  ))}
                </div>
              ) : null}

              {COMPANION_NAV_ITEMS.length > 0 ? (
                <div
                  className="mt-4 pl-[14px] animate-in fade-in slide-in-from-left-2 [animation-fill-mode:backwards]"
                  style={{ animationDelay: `${(primaryItems.length + groups.length + 1) * 50}ms`, animationDuration: "200ms" }}
                >
                  <p className="mb-1.5 text-xs font-semibold uppercase tracking-[0.11em] text-muted-foreground/70">Companion</p>
                  {COMPANION_NAV_ITEMS.map((item) => (
                    <MobileNavLink key={item.href} item={item} active={false} onNavigate={() => setOpen(false)} />
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
      </div>
    </header>
  );
}
