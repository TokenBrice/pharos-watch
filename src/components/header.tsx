"use client";

import { useState } from "react";
import Link from "next/link";
import { usePathname } from "next/navigation";
import { PharosLogo } from "@/components/pharos-logo";
import { ThemeControls } from "@/components/theme-controls";
import { Sheet, SheetTrigger, SheetContent, SheetDescription, SheetTitle } from "@/components/ui/sheet";
import { Button } from "@/components/ui/button";
import {
  BOTTOM_NAV_ITEMS,
  COMPANION_NAV_ITEMS,
  NAV_GROUPS,
  stickyChromeTopOffsetClass,
} from "@/lib/nav-config";
import type { NavItem } from "@/lib/nav-config";
import { ExternalLink, Menu, Search, X, ChevronRight } from "lucide-react";
import { openCommandPalette } from "@/lib/command-palette";
import { isRouteActive } from "@/lib/navigation";
import { useNavCollapse } from "@/hooks/use-nav-collapse";
import { useStartHereNavVisibility } from "@/hooks/use-start-here-nav-visibility";

function MobileNavLink({ item, active, onNavigate }: { item: NavItem; active: boolean; onNavigate: () => void }) {
  const Icon = item.icon;
  const className = `pharos-focus-ring flex items-center gap-3 rounded-lg border px-3 py-3 transition-[background-color,border-color,color,box-shadow] duration-[160ms] ease-[var(--motion-ease-standard)] ${
    active
      ? "border-border/70 bg-muted/60 font-medium text-foreground"
      : "border-transparent text-muted-foreground hover:border-border/55 hover:bg-muted/45 hover:text-foreground"
  }`;

  const body = (
    <>
      <Icon className="h-4 w-4 shrink-0" />
      <div className="min-w-0 flex-1 text-sm flex items-center gap-1.5">
        {item.label}
        {item.external && <ExternalLink className="h-3 w-3 text-muted-foreground/70" aria-hidden="true" />}
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
  const visibleBottomNavItems = BOTTOM_NAV_ITEMS.filter(
    (item) => item.href !== "/start/" || (startHereReady && shouldShowStartHereNav),
  );
  const priorityBottomNavItems = visibleBottomNavItems.filter((item) => item.href === "/start/");
  const remainingBottomNavItems = visibleBottomNavItems.filter((item) => item.href !== "/start/");
  const groups = NAV_GROUPS;
  const mobileLeadItemCount = priorityBottomNavItems.length;
  const topOffsetClass = stickyChromeTopOffsetClass(pathname);

  // The header renders above the core rail in flow, so it pins directly under
  // the PSI strip on every route; z-[56] keeps the tape and rail sliding
  // beneath it while scrolling.
  return (
    <header
      className={`sticky z-[56] border-b border-border/80 bg-background/85 backdrop-blur-md lg:hidden ${topOffsetClass}`}
    >
      <div className="container mx-auto flex h-14 items-center justify-between px-4">
        <Link
          prefetch={false}
          href="/"
          className="pharos-focus-ring flex min-h-11 min-w-0 items-center gap-2.5 rounded-md py-1 font-semibold"
        >
          <PharosLogo size={32} priority />
          <span className="pharos-display truncate text-[1.45rem] font-semibold leading-none tracking-tight text-foreground">
            Pharos
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
              // z-[70] lifts the drawer above the sticky chrome (header z-[56],
              // rail z-[55], PSI strip z-[60]); the Sheet default z-50 would
              // leave the drawer's own header row painted beneath them.
              // Motion overrides retime the shadcn slide (500/300ms ease-in-out)
              // to the canon 220ms decelerating curve and drop it entirely for
              // prefers-reduced-motion — kept local so ui/sheet stays stock.
              className="z-[70] w-full sm:max-w-full flex flex-col border-r border-border/70 bg-card/95 p-0 ease-[var(--motion-ease-standard)] data-[state=open]:duration-[220ms] data-[state=closed]:duration-[220ms] motion-reduce:data-[state=open]:animate-none motion-reduce:data-[state=closed]:animate-none"
            >
              {/* Header */}
              <div className="flex items-center justify-between px-4 h-14 border-b border-border/70 shrink-0">
                <Link
                  prefetch={false}
                  href="/"
                  onClick={() => setOpen(false)}
                  className="pharos-focus-ring flex items-center gap-3 rounded-md"
                >
                  <PharosLogo size={28} />
                  <SheetTitle className="pharos-display text-[1.45rem] leading-none tracking-tight">Pharos</SheetTitle>
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
                {priorityBottomNavItems.length > 0 ? (
                  <div
                    className={`animate-in fade-in slide-in-from-left-2 ease-[var(--motion-ease-standard)] [animation-fill-mode:backwards] motion-reduce:animate-none ${
                      priorityBottomNavItems.some((item) => isRouteActive(pathname, item.href))
                        ? "border-l-2 border-l-frost-blue pl-3"
                        : "pl-[14px]"
                    }`}
                    style={{ animationDelay: "50ms", animationDuration: "220ms" }}
                  >
                    {priorityBottomNavItems.map((item) => (
                      <MobileNavLink
                        key={item.href}
                        item={item}
                        active={isRouteActive(pathname, item.href)}
                        onNavigate={() => setOpen(false)}
                      />
                    ))}
                  </div>
                ) : null}

                {/* Grouped sections */}
                {groups.map((group, groupIndex) => {
                  const groupIsActive = group.items.some((item) => isRouteActive(pathname, item.href));
                  const groupExpanded = isGroupExpanded(group.key);
                  return (
                    <div
                      key={group.key}
                      className={`mt-4 animate-in fade-in slide-in-from-left-2 ease-[var(--motion-ease-standard)] [animation-fill-mode:backwards] motion-reduce:animate-none ${
                        groupIsActive ? "border-l-2 border-l-frost-blue pl-3" : "pl-[14px]"
                      }`}
                      style={{
                        animationDelay: `${(mobileLeadItemCount + groupIndex) * 50}ms`,
                        animationDuration: "220ms",
                      }}
                    >
                      <button
                        type="button"
                        onClick={() => toggle(group.key)}
                        className="pharos-kicker flex w-full items-center justify-between mb-1.5 text-muted-foreground/70 hover:text-muted-foreground transition-colors"
                        aria-expanded={groupExpanded}
                        aria-controls={`mobile-nav-group-${group.key}`}
                      >
                        <span className="flex items-center gap-2">
                          {group.label}
                          <span className="rounded-full bg-muted px-1.5 font-mono text-[10px] font-semibold tabular-nums tracking-normal text-muted-foreground/70">
                            {group.items.length}
                          </span>
                        </span>
                        <ChevronRight
                          className={`h-3 w-3 transition-transform duration-[220ms] ease-[var(--motion-ease-standard)] motion-reduce:transition-none ${groupExpanded ? "rotate-90" : ""}`}
                        />
                      </button>
                      <div
                        className={`grid transition-[grid-template-rows] duration-[220ms] ease-[var(--motion-ease-standard)] motion-reduce:transition-none ${groupExpanded ? "grid-rows-[1fr]" : "grid-rows-[0fr]"}`}
                        aria-hidden={!groupExpanded}
                        inert={!groupExpanded}
                      >
                        <div className="overflow-hidden">
                          <div id={`mobile-nav-group-${group.key}`}>
                            {group.items.map((item) => (
                              <MobileNavLink
                                key={item.href}
                                item={item}
                                active={isRouteActive(pathname, item.href)}
                                onNavigate={() => setOpen(false)}
                              />
                            ))}
                          </div>
                        </div>
                      </div>
                    </div>
                  );
                })}

                {remainingBottomNavItems.length > 0 ? (
                  <div
                    className={`mt-4 animate-in fade-in slide-in-from-left-2 ease-[var(--motion-ease-standard)] [animation-fill-mode:backwards] motion-reduce:animate-none ${
                      remainingBottomNavItems.some((item) => isRouteActive(pathname, item.href))
                        ? "border-l-2 border-l-frost-blue pl-3"
                        : "pl-[14px]"
                    }`}
                    style={{
                      animationDelay: `${(mobileLeadItemCount + groups.length) * 50}ms`,
                      animationDuration: "220ms",
                    }}
                  >
                    {remainingBottomNavItems.map((item) => (
                      <MobileNavLink
                        key={item.href}
                        item={item}
                        active={isRouteActive(pathname, item.href)}
                        onNavigate={() => setOpen(false)}
                      />
                    ))}
                  </div>
                ) : null}

                {COMPANION_NAV_ITEMS.length > 0 ? (
                  <div
                    className="mt-4 pl-[14px] animate-in fade-in slide-in-from-left-2 ease-[var(--motion-ease-standard)] [animation-fill-mode:backwards] motion-reduce:animate-none"
                    style={{
                      animationDelay: `${(mobileLeadItemCount + groups.length + 1) * 50}ms`,
                      animationDuration: "220ms",
                    }}
                  >
                    <p className="pharos-kicker mb-1.5 text-muted-foreground/70">Companion</p>
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
                <ThemeControls density="mobile" />
              </div>
            </SheetContent>
          </Sheet>
        </div>
      </div>
    </header>
  );
}
