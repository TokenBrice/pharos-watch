"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { useEffect, useRef, useState, type SVGProps } from "react";
import { Activity, KeyRound, Search, Send, Sparkles } from "lucide-react";
import { PharosLogo } from "@/components/pharos-logo";
import { ThemeControls } from "@/components/theme-controls";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { openCommandPalette } from "@/lib/command-palette";
import {
  NAV_GROUPS,
  normalizeNavPath,
  stickyChromeTopOffsetClass,
  type NavGroup,
  type NavItem,
} from "@/lib/nav-config";
import { useHealth } from "@/hooks/api-hooks";
import { cn } from "@/lib/utils";

const TOP_MENUS: readonly NavGroup[] = NAV_GROUPS;
const OVERFLOW_MENU_KEY = "overflow";
const HEALTH_STATUS_MENU = {
  healthy: {
    label: "Pharos is Healthy",
    dotClassName: "bg-[var(--severity-healthy)]",
  },
  degraded: {
    label: "Pharos is Degraded",
    dotClassName: "bg-[var(--severity-mild)]",
  },
  stale: {
    label: "Pharos is Stale",
    dotClassName: "bg-[var(--severity-severe)]",
  },
} as const;

const CHECKING_STATUS_MENU = {
  label: "Checking Status",
  dotClassName: "bg-muted-foreground/50",
} as const;

const UNAVAILABLE_STATUS_MENU = {
  label: "Status Unavailable",
  dotClassName: "bg-muted-foreground/50",
} as const;

function LighthouseIcon(props: SVGProps<SVGSVGElement>) {
  return (
    <svg
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
      {...props}
    >
      <path d="M10 4h4" />
      <path d="M9 8h6" />
      <path d="M10 8 8 21" />
      <path d="M14 8l2 13" />
      <path d="M7 21h10" />
      <path d="M9 14h6" />
      <path d="m4 7 3 1" />
      <path d="m20 7-3 1" />
      <path d="M12 4v4" />
    </svg>
  );
}

function NavMenuItem({ item }: { item: NavItem }) {
  const Icon = item.icon;
  return (
    <DropdownMenuItem asChild className="items-center gap-2.5 rounded-lg px-2.5 py-2 focus:bg-muted/60">
      <Link href={item.href} prefetch={false} {...(item.external ? { target: "_blank", rel: "noreferrer" } : {})}>
        <Icon className="size-4 shrink-0 text-muted-foreground" aria-hidden />
        <span className="text-sm font-medium text-foreground">{item.label}</span>
      </Link>
    </DropdownMenuItem>
  );
}

/**
 * Desktop masthead nav (≥lg). Replaces the left "watch column" sidebar with a
 * full-width horizontal bar: brand, six dropdown menus mapped from nav-config,
 * global search, and an overflow menu (links + dark/light/system controls).
 * Mobile keeps <Header />.
 */
export function TopNav() {
  const pathname = usePathname();
  const normalizedPath = normalizeNavPath(pathname ?? "/");
  const topOffsetClass = stickyChromeTopOffsetClass(pathname);

  // Desktop-only hover-to-open for the six section menus. Radix DropdownMenu is
  // click/keyboard-driven; we control `open` per menu and layer hover on top,
  // gated to hover-capable + fine pointers so touch laptops keep tap-to-open.
  // `modal={false}` keeps the page interactive (no scroll/pointer lock) while
  // sweeping across triggers; the focus-guard refs stop hover from stealing
  // focus while leaving keyboard activation untouched.
  const [openMenu, setOpenMenu] = useState<string | null>(null);
  const [hoverCapable, setHoverCapable] = useState(false);
  const closeTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const hoverOpenRef = useRef(false);
  const statusMenuOpen = openMenu === OVERFLOW_MENU_KEY;
  const { data: healthData, isError: healthError } = useHealth({ enabled: statusMenuOpen });
  const healthMenu = healthData
    ? HEALTH_STATUS_MENU[healthData.status]
    : healthError
      ? UNAVAILABLE_STATUS_MENU
      : CHECKING_STATUS_MENU;

  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect
    setHoverCapable(window.matchMedia("(hover: hover) and (pointer: fine)").matches);
    return () => {
      if (closeTimer.current) clearTimeout(closeTimer.current);
    };
  }, []);

  const cancelClose = () => {
    if (closeTimer.current) {
      clearTimeout(closeTimer.current);
      closeTimer.current = null;
    }
  };
  const openOnHover = (key: string) => {
    cancelClose();
    hoverOpenRef.current = true;
    setOpenMenu(key);
  };
  const closeOnHover = () => {
    cancelClose();
    closeTimer.current = setTimeout(() => setOpenMenu(null), 150);
  };

  return (
    <header
      aria-label="Primary"
      className={cn(
        "sticky z-50 hidden h-14 w-full items-center gap-2 border-b border-border/70 bg-background/85 px-4 backdrop-blur-md lg:flex xl:px-6",
        topOffsetClass,
      )}
    >
      <Link
        href="/"
        prefetch={false}
        className="pharos-focus-ring flex shrink-0 items-center gap-2.5 rounded-lg pr-2"
        aria-label="Pharos home"
      >
        <PharosLogo size={28} className="rounded-full shadow-sm" priority />
        <span className="pharos-display text-[15px] font-bold tracking-tight text-foreground">Pharos</span>
      </Link>

      <nav aria-label="Sections" className="flex min-w-0 items-center gap-0.5">
        {TOP_MENUS.map((menu) => {
          const isActive = menu.items.some((item) => normalizeNavPath(item.href) === normalizedPath);
          return (
            <DropdownMenu
              key={menu.key}
              modal={false}
              open={openMenu === menu.key}
              onOpenChange={(next) => {
                cancelClose();
                setOpenMenu(next ? menu.key : null);
              }}
            >
              <DropdownMenuTrigger asChild>
                <button
                  type="button"
                  aria-current={isActive ? "true" : undefined}
                  onPointerDown={() => {
                    hoverOpenRef.current = false;
                  }}
                  onKeyDown={() => {
                    hoverOpenRef.current = false;
                  }}
                  onMouseEnter={hoverCapable ? () => openOnHover(menu.key) : undefined}
                  onMouseLeave={hoverCapable ? closeOnHover : undefined}
                  className={cn(
                    "pharos-focus-ring inline-flex h-9 items-center rounded-md px-3 text-sm font-medium whitespace-nowrap transition-colors",
                    isActive
                      ? "bg-muted/60 text-foreground"
                      : "text-muted-foreground hover:bg-muted/40 hover:text-foreground",
                  )}
                >
                  {menu.label}
                </button>
              </DropdownMenuTrigger>
              <DropdownMenuContent
                align="start"
                sideOffset={8}
                className="w-60 p-1.5"
                onMouseEnter={hoverCapable ? cancelClose : undefined}
                onMouseLeave={hoverCapable ? closeOnHover : undefined}
                onCloseAutoFocus={(event) => {
                  if (hoverOpenRef.current) event.preventDefault();
                }}
              >
                {menu.items.map((item) => (
                  <NavMenuItem key={item.href} item={item} />
                ))}
              </DropdownMenuContent>
            </DropdownMenu>
          );
        })}
      </nav>

      <div className="ml-auto flex shrink-0 items-center gap-1.5">
        <button
          type="button"
          onClick={openCommandPalette}
          aria-label="Search"
          className="pharos-focus-ring inline-flex h-9 w-44 items-center gap-2 rounded-lg border border-border/70 bg-muted/20 px-3 text-sm text-muted-foreground transition-colors hover:bg-muted/40 hover:text-foreground lg:w-56 xl:w-72"
        >
          <Search className="size-4 shrink-0" aria-hidden />
          <span>Search</span>
          <kbd className="ml-auto hidden rounded border border-border/70 bg-background px-1.5 font-mono text-[10px] text-muted-foreground sm:inline">
            ⌘K
          </kbd>
        </button>

        <DropdownMenu
          modal={false}
          open={statusMenuOpen}
          onOpenChange={(next) => {
            cancelClose();
            setOpenMenu(next ? OVERFLOW_MENU_KEY : null);
          }}
        >
          <DropdownMenuTrigger asChild>
            <button
              type="button"
              aria-label="More"
              onPointerDown={() => {
                hoverOpenRef.current = false;
              }}
              onKeyDown={() => {
                hoverOpenRef.current = false;
              }}
              onMouseEnter={hoverCapable ? () => openOnHover(OVERFLOW_MENU_KEY) : undefined}
              onMouseLeave={hoverCapable ? closeOnHover : undefined}
              className="pharos-focus-ring inline-flex size-9 items-center justify-center rounded-lg text-muted-foreground transition-colors hover:bg-muted/40 hover:text-foreground"
            >
              <LighthouseIcon className="size-4" aria-hidden />
            </button>
          </DropdownMenuTrigger>
          <DropdownMenuContent
            align="end"
            sideOffset={8}
            className="w-56 p-1.5"
            onMouseEnter={hoverCapable ? cancelClose : undefined}
            onMouseLeave={hoverCapable ? closeOnHover : undefined}
            onCloseAutoFocus={(event) => {
              if (hoverOpenRef.current) event.preventDefault();
            }}
          >
            <DropdownMenuItem asChild className="gap-2.5 rounded-lg px-2.5 py-2">
              <Link href="/pharoswatchbot/" prefetch={false}>
                <Send className="size-4 text-muted-foreground" aria-hidden />
                <span className="text-sm font-medium">Alert Bot</span>
              </Link>
            </DropdownMenuItem>
            <DropdownMenuItem asChild className="gap-2.5 rounded-lg px-2.5 py-2">
              <Link href="/changelog/" prefetch={false}>
                <Sparkles className="size-4 text-muted-foreground" aria-hidden />
                <span className="text-sm font-medium">What&apos;s New</span>
              </Link>
            </DropdownMenuItem>
            <DropdownMenuItem asChild className="gap-2.5 rounded-lg px-2.5 py-2">
              <Link href="/api/" prefetch={false}>
                <KeyRound className="size-4 text-muted-foreground" aria-hidden />
                <span className="text-sm font-medium">API Access</span>
              </Link>
            </DropdownMenuItem>
            <DropdownMenuSeparator />
            <DropdownMenuItem asChild className="gap-2.5 rounded-lg px-2.5 py-2">
              <Link href="/status/" prefetch={false}>
                <Activity className="size-4 text-muted-foreground" aria-hidden />
                <span className="text-sm font-medium">{healthMenu.label}</span>
                <span className={cn("ml-auto size-2 rounded-full", healthMenu.dotClassName)} aria-hidden />
              </Link>
            </DropdownMenuItem>
            <DropdownMenuSeparator />
            <ThemeControls density="desktop" />
          </DropdownMenuContent>
        </DropdownMenu>
      </div>
    </header>
  );
}
