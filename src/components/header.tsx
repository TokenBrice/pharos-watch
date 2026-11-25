"use client";

import { useEffect, useRef, useState } from "react";
import Link from "next/link";
import { usePathname } from "next/navigation";
import { PharosLogo } from "@/components/pharos-logo";
import { RegimeBarToggle } from "@/components/psi-beacon/regime-bar";
import { ThemeControls } from "@/components/theme-controls";
import { Sheet, SheetContent, SheetDescription, SheetTitle } from "@/components/ui/sheet";
import { Button } from "@/components/ui/button";
import {
  MOBILE_DRAWER_QUICK_ITEMS,
  NAV_GROUPS,
  isNavItemActive,
  stickyChromeTopOffsetClass,
} from "@/lib/nav-config";
import type { NavItem, NavSection } from "@/lib/nav-config";
import { ArrowUpRight, ChevronDown, Search, X } from "lucide-react";
import { trackEvent } from "@/lib/analytics";
import { dismissChromeOverlays, subscribeChromeDismiss } from "@/lib/chrome-popover";
import { openCommandPalette } from "@/lib/command-palette";
import { OPEN_NAV_DRAWER_EVENT, setNavDrawerOpen } from "@/lib/nav-drawer";

function getInitialExpandedGroups(pathname: string | null | undefined): Set<string> {
  const activeGroup = NAV_GROUPS.find((group) =>
    group.items.some((item) => isNavItemActive(pathname, item)),
  );
  return new Set([activeGroup ? activeGroup.key : NAV_GROUPS[0].key]);
}

function MobileNavLink({
  item,
  active,
  group,
  variant = "row",
  onNavigate,
}: {
  item: NavItem;
  active: boolean;
  /** Analytics bucket for the tap: the owning NAV_GROUPS key. */
  group: string;
  variant?: "row" | "companion";
  onNavigate: () => void;
}) {
  const Icon = item.icon;
  const isCompanion = variant === "companion";
  const className = isCompanion
    ? "pharos-focus-ring flex min-h-11 items-center gap-3 rounded-lg border border-border/60 bg-muted/25 px-3 py-2.5 text-foreground transition-[background-color,border-color,color,box-shadow] duration-[160ms] ease-[var(--motion-ease-standard)] hover:border-border hover:bg-muted/45"
    : `pharos-focus-ring flex min-h-11 items-center gap-3 rounded-lg border px-3 py-2.5 transition-[background-color,border-color,color,box-shadow] duration-[160ms] ease-[var(--motion-ease-standard)] ${
        active
          ? "border-brand-accent-text/45 bg-muted/60 font-medium text-foreground"
          : "border-transparent text-foreground hover:border-border/55 hover:bg-muted/45"
      }`;

  // External hrefs fall outside the nav_click contract's internal-path
  // namespace, so only in-app rows report.
  function handleClick() {
    if (!item.external) trackEvent("nav_click", { surface: "drawer", group, href: item.href });
    onNavigate();
  }

  const body = (
    <>
      {isCompanion ? (
        <span className="grid size-8 shrink-0 place-items-center rounded-md border border-border/60 bg-background/70 text-brand-accent-text">
          <Icon className="h-4 w-4" aria-hidden="true" />
        </span>
      ) : (
        <Icon
          className={`h-4 w-4 shrink-0 ${active ? "text-brand-accent-text" : "text-muted-foreground"}`}
          aria-hidden="true"
        />
      )}
      {/* Desktop menus carry these lines too; without them invented names
          (FreezeWatch, Compliance, DDR) are illegible in the drawer. */}
      <div className="flex min-w-0 flex-1 flex-col gap-0.5">
        <span
          className={`flex items-center gap-1.5 text-sm leading-snug ${
            active ? "font-semibold text-brand-accent-text" : "font-medium text-foreground"
          }`}
        >
          <span>{item.label}</span>
          {item.external ? (
            <>
              <ArrowUpRight className="h-3.5 w-3.5 shrink-0 text-muted-foreground" aria-hidden="true" />
              <span className="sr-only"> (opens in new tab)</span>
            </>
          ) : null}
        </span>
        {item.description ? (
          <>
            {" "}
            <span className="text-xs font-normal leading-snug text-muted-foreground">{item.description}</span>
          </>
        ) : null}
      </div>
    </>
  );

  if (item.external) {
    return (
      <a
        href={item.href}
        target="_blank"
        rel="noopener noreferrer"
        onClick={handleClick}
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
      onClick={handleClick}
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
  const [prevPathname, setPrevPathname] = useState(pathname);
  const [expandedGroups, setExpandedGroups] = useState<Set<string>>(() => getInitialExpandedGroups(pathname));
  const drawerOpenerRef = useRef<HTMLElement | null>(null);
  const suppressCloseAutoFocusRef = useRef(false);
  const openedPathnameRef = useRef<string | null>(null);
  const pathnameRef = useRef(pathname);
  const openRef = useRef(open);
  const topOffsetClass = stickyChromeTopOffsetClass(pathname);

  // Close the drawer automatically if the route changes while it is open.
  if (prevPathname !== pathname) {
    setPrevPathname(pathname);
    if (open) {
      setOpen(false);
    }
  }

  function handleOpenChange(nextOpen: boolean) {
    if (nextOpen) {
      dismissChromeOverlays("nav-drawer");
      openedPathnameRef.current = pathnameRef.current;
      setExpandedGroups(getInitialExpandedGroups(pathnameRef.current));
    }
    setOpen(nextOpen);
  }

  function handleNavigate() {
    drawerOpenerRef.current = null;
    suppressCloseAutoFocusRef.current = true;
    handleOpenChange(false);
  }

  function toggleGroup(groupKey: string) {
    setExpandedGroups((prev) => {
      const next = new Set(prev);
      if (next.has(groupKey)) next.delete(groupKey);
      else next.add(groupKey);
      return next;
    });
  }

  useEffect(() => {
    pathnameRef.current = pathname;
  }, [pathname]);

  useEffect(() => {
    function handleOpenNavDrawer() {
      // The bottom-nav Menu is the drawer's one entry point (no header twin);
      // focus returns to whatever opened it.
      drawerOpenerRef.current = document.activeElement instanceof HTMLElement ? document.activeElement : null;
      suppressCloseAutoFocusRef.current = false;
      openedPathnameRef.current = pathnameRef.current;
      dismissChromeOverlays("nav-drawer");
      setExpandedGroups(getInitialExpandedGroups(pathnameRef.current));
      setOpen(true);
    }

    window.addEventListener(OPEN_NAV_DRAWER_EVENT, handleOpenNavDrawer);
    return () => window.removeEventListener(OPEN_NAV_DRAWER_EVENT, handleOpenNavDrawer);
  }, []);

  // Coordinate with other chrome overlays so opening search, shortcuts, or the
  // regime strip closes the drawer without pulling focus back to Menu.
  useEffect(() => {
    return subscribeChromeDismiss("nav-drawer", () => {
      if (!openRef.current) return;
      drawerOpenerRef.current = null;
      suppressCloseAutoFocusRef.current = true;
      setOpen(false);
    });
  }, []);

  // Close the portalled Sheet when crossing into desktop (>=1024px) so tablet
  // rotation never leaves the mobile drawer floating over TopNav.
  useEffect(() => {
    if (typeof window === "undefined" || typeof window.matchMedia !== "function") return;
    const mediaQuery = window.matchMedia("(min-width: 1024px)");
    if (typeof mediaQuery.addEventListener !== "function") return;
    const handleChange = (event: MediaQueryListEvent) => {
      if (!event.matches || !openRef.current) return;
      drawerOpenerRef.current = null;
      suppressCloseAutoFocusRef.current = true;
      setOpen(false);
    };
    mediaQuery.addEventListener("change", handleChange);
    return () => mediaQuery.removeEventListener("change", handleChange);
  }, []);

  // Openers read the drawer state for aria-expanded.
  useEffect(() => {
    openRef.current = open;
    setNavDrawerOpen(open);
    return () => {
      openRef.current = false;
      setNavDrawerOpen(false);
    };
  }, [open]);

  // The header renders above the core rail in flow, so it pins directly under
  // the PSI strip on every route; z-chrome-header keeps the tape and rail
  // sliding beneath it while scrolling.
  return (
    <header
      aria-label="Primary"
      className={`sticky z-chrome-header h-14 border-b border-border/70 bg-background/85 backdrop-blur-md lg:hidden ${topOffsetClass}`}
    >
      <div className="flex h-full w-full items-center justify-between px-4">
        <Link
          prefetch={false}
          href="/"
          aria-current={pathname === "/" ? "page" : undefined}
          className="pharos-focus-ring flex min-h-11 min-w-0 items-center gap-2 rounded-md py-1 font-semibold"
        >
          <PharosLogo size={28} priority />
          <span className="pharos-display truncate text-lg font-semibold leading-none tracking-tight text-foreground">
            Pharos
          </span>
        </Link>

        <div className="flex items-center gap-1.5">
          <RegimeBarToggle className="min-h-11" />
          {/* Labeled pill, not a bare icon: search is the fastest path to a
              coin profile, and an unlabeled magnifier hides that at 360px.
              shrink-0 keeps the pill intact while the logo text truncates. */}
          <button
            type="button"
            onClick={openCommandPalette}
            aria-label="Search stablecoins and pages"
            className="pharos-focus-ring flex min-h-11 shrink-0 cursor-pointer items-center gap-1.5 rounded-md border border-border/70 bg-muted/20 px-3 text-sm text-muted-foreground transition-colors hover:bg-muted/40 hover:text-foreground"
          >
            <Search className="h-4 w-4" aria-hidden="true" />
            Search
          </button>

          <Sheet open={open} onOpenChange={handleOpenChange}>
            <SheetContent
              side="left"
              showCloseButton={false}
              onCloseAutoFocus={(event) => {
                if (
                  suppressCloseAutoFocusRef.current ||
                  (openedPathnameRef.current !== null && openedPathnameRef.current !== pathname)
                ) {
                  suppressCloseAutoFocusRef.current = false;
                  drawerOpenerRef.current = null;
                  event.preventDefault();
                  return;
                }
                // Without a recorded opener, Radix restores focus itself.
                if (!drawerOpenerRef.current) return;
                event.preventDefault();
                drawerOpenerRef.current.focus();
              }}
              // Motion overrides retime the shadcn slide (500/300ms ease-in-out)
              // to the canon 220ms decelerating curve and drop it entirely for
              // prefers-reduced-motion — kept local so ui/sheet stays stock.
              className="flex w-full flex-col gap-0 border-r border-border/70 bg-card p-0 ease-[var(--motion-ease-standard)] data-[state=open]:duration-[220ms] data-[state=closed]:duration-[220ms] sm:max-w-md motion-reduce:data-[state=open]:animate-none motion-reduce:data-[state=closed]:animate-none"
            >
              <div className="flex h-14 shrink-0 items-center justify-between border-b border-border/70 px-4">
                <Link
                  prefetch={false}
                  href="/"
                  onClick={handleNavigate}
                  aria-current={pathname === "/" ? "page" : undefined}
                  className="pharos-focus-ring flex min-h-11 items-center gap-2 rounded-md py-1"
                >
                  <PharosLogo size={28} />
                  <SheetTitle className="pharos-display text-lg font-semibold leading-none tracking-tight">
                    Pharos
                  </SheetTitle>
                </Link>
                <SheetDescription className="sr-only">
                  Main navigation for Pharos dashboard routes, monitoring tools, references, and companion experiences.
                </SheetDescription>
                <Button
                  variant="ghost"
                  size="icon"
                  className="h-11 w-11 cursor-pointer"
                  onClick={() => handleOpenChange(false)}
                >
                  <X className="h-4 w-4" aria-hidden="true" />
                  <span className="sr-only">Close menu</span>
                </Button>
              </div>

              <nav className="flex-1 overflow-y-auto px-4 py-4" aria-label="Main navigation">
                {/* Pinned monitors: the two primary monitors not already pinned in the mobile bottom bar. */}
                <div className="grid grid-cols-2 gap-2">
                  {MOBILE_DRAWER_QUICK_ITEMS.map((item) => {
                    const Icon = item.icon;
                    const active = isNavItemActive(pathname, item);
                    return (
                      <Link
                        key={item.href}
                        prefetch={false}
                        href={item.href}
                        onClick={() => {
                          trackEvent("nav_click", { surface: "drawer", group: "rail", href: item.href });
                          handleNavigate();
                        }}
                        aria-current={active ? "page" : undefined}
                        className={`pharos-focus-ring flex min-h-16 flex-col justify-between gap-1.5 rounded-lg border px-3 py-2.5 transition-colors ${
                          active
                            ? "border-brand-accent-text/45 bg-muted/60 text-foreground"
                            : "border-border/55 bg-muted/20 text-foreground hover:border-border hover:bg-muted/40"
                        }`}
                      >
                        <div className="flex items-center gap-2">
                          <Icon
                            className={`h-4 w-4 shrink-0 ${active ? "text-brand-accent-text" : "text-muted-foreground"}`}
                            aria-hidden="true"
                          />
                          <span
                            className={`truncate text-sm font-semibold leading-tight ${
                              active ? "text-brand-accent-text" : "text-foreground"
                            }`}
                          >
                            {item.shortLabel ?? item.label}
                          </span>
                        </div>
                        {item.description ? (
                          <span className="line-clamp-1 text-xs font-normal leading-snug text-muted-foreground">
                            {item.description}
                          </span>
                        ) : null}
                      </Link>
                    );
                  })}
                </div>

                {/* Single-scroll collapsible taxonomy mirroring desktop NAV_GROUPS one-to-one. */}
                <div className="mt-4 space-y-1 border-t border-border/60 pt-3">
                  {NAV_GROUPS.map((group) => {
                    const panelId = `mobile-nav-${group.key}-panel`;
                    const isExpanded = expandedGroups.has(group.key);
                    const categoryIsActive = group.items.some((item) => isNavItemActive(pathname, item));
                    const sections: readonly NavSection[] = group.sections ?? [
                      { key: group.key, label: null, items: group.items },
                    ];

                    return (
                      <div key={group.key}>
                        <button
                          type="button"
                          onClick={() => toggleGroup(group.key)}
                          aria-expanded={isExpanded}
                          aria-controls={panelId}
                          aria-current={categoryIsActive ? "true" : undefined}
                          className={`pharos-focus-ring flex min-h-11 w-full cursor-pointer items-center justify-between rounded-md border px-3 text-sm transition-[background-color,border-color,color,box-shadow] duration-[160ms] ease-[var(--motion-ease-standard)] motion-reduce:transition-none ${
                            categoryIsActive
                              ? "border-brand-accent-text/45 bg-muted/60 font-semibold text-foreground"
                              : "border-transparent font-medium text-foreground hover:border-border/55 hover:bg-muted/45"
                          }`}
                        >
                          <span className="flex items-center gap-2">
                            <span className={categoryIsActive ? "text-brand-accent-text" : undefined}>
                              {group.label}
                            </span>
                            {" "}
                            <span className="rounded-full bg-muted px-1.5 py-0.5 font-mono text-3xs font-semibold leading-none tabular-nums text-muted-foreground">
                              {group.items.length}
                            </span>
                          </span>
                          <ChevronDown
                            className={`h-4 w-4 shrink-0 text-muted-foreground transition-transform duration-[160ms] ease-[var(--motion-ease-standard)] motion-reduce:transition-none ${
                              isExpanded ? "rotate-180" : ""
                            }`}
                            aria-hidden="true"
                          />
                        </button>

                        {isExpanded ? (
                          <div id={panelId} className="mt-1 space-y-1 pb-1">
                            {sections.map((section, sectionIndex) => {
                              const sectionHeadingId = section.label
                                ? `${panelId}-${section.key}-heading`
                                : undefined;
                              return (
                                <div
                                  key={section.key}
                                  className={
                                    sectionIndex > 0 || section.label || section.companion
                                      ? "mt-2 border-t border-border/60 pt-2"
                                      : undefined
                                  }
                                >
                                  {section.label ? (
                                    <p
                                      id={sectionHeadingId}
                                      className="pharos-label mb-1 px-3 text-muted-foreground"
                                    >
                                      {section.label}
                                    </p>
                                  ) : null}
                                  <ul aria-labelledby={sectionHeadingId} className="space-y-0.5">
                                    {section.items.map((item) => (
                                      <li key={item.href}>
                                        <MobileNavLink
                                          item={item}
                                          active={isNavItemActive(pathname, item)}
                                          group={group.key}
                                          variant={section.companion ? "companion" : "row"}
                                          onNavigate={handleNavigate}
                                        />
                                      </li>
                                    ))}
                                  </ul>
                                </div>
                              );
                            })}

                            {group.quickBarLinks?.length ? (
                              <div className="mt-2 border-t border-border/60 px-1 pt-2">
                                <p
                                  id={`${panelId}-quick-bar-heading`}
                                  className="pharos-label mb-1.5 px-2 text-muted-foreground"
                                >
                                  On the quick bar
                                </p>
                                <ul
                                  aria-labelledby={`${panelId}-quick-bar-heading`}
                                  className="flex flex-wrap gap-1.5 px-2"
                                >
                                  {group.quickBarLinks.map((item) => {
                                    const Icon = item.icon;
                                    const active = isNavItemActive(pathname, item);
                                    return (
                                      <li key={item.href}>
                                        <Link
                                          prefetch={false}
                                          href={item.href}
                                          onClick={() => {
                                            if (!item.external) {
                                              trackEvent("nav_click", {
                                                surface: "drawer",
                                                group: group.key,
                                                href: item.href,
                                              });
                                            }
                                            handleNavigate();
                                          }}
                                          aria-current={active ? "page" : undefined}
                                          className={`pharos-focus-ring inline-flex min-h-11 items-center gap-1.5 rounded-full border px-3 py-1.5 text-xs transition-colors ${
                                            active
                                              ? "border-brand-accent-text/45 bg-muted/60 font-semibold text-brand-accent-text"
                                              : "border-border/60 bg-muted/20 font-medium text-muted-foreground hover:border-border hover:bg-muted/45 hover:text-foreground"
                                          }`}
                                        >
                                          <Icon className="h-3.5 w-3.5 shrink-0" aria-hidden="true" />
                                          <span>{item.shortLabel ?? item.label}</span>
                                        </Link>
                                      </li>
                                    );
                                  })}
                                </ul>
                              </div>
                            ) : null}
                          </div>
                        ) : null}
                      </div>
                    );
                  })}
                </div>
              </nav>

              <div className="flex shrink-0 items-center justify-between border-t border-border/70 bg-muted/20 px-4 pt-3 pb-[calc(env(safe-area-inset-bottom)+0.75rem)]">
                <span className="pharos-label text-muted-foreground">Appearance</span>
                <ThemeControls density="mobile" />
              </div>
            </SheetContent>
          </Sheet>
        </div>
      </div>
    </header>
  );
}
