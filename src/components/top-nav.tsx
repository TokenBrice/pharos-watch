"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { useEffect, useState, type SVGProps } from "react";
import { useTheme } from "next-themes";
import { Activity, Monitor, Moon, Search, Send, Sparkles, Sun } from "lucide-react";
import { PharosLogo } from "@/components/pharos-logo";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { openCommandPalette } from "@/lib/command-palette";
import { NAV_GROUPS, normalizeNavPath, PRIMARY_NAV_ITEMS, type NavItem } from "@/lib/nav-config";
import { cn } from "@/lib/utils";

// The Figma top nav collapses the existing IA into six menus. Terminal carries
// the core product set; the other five are the existing NAV_GROUPS, relabelled.
type TopMenu = { key: string; label: string; items: NavItem[] };

function groupItems(key: string): NavItem[] {
  return NAV_GROUPS.find((group) => group.key === key)?.items ?? [];
}

const TOP_MENUS: TopMenu[] = [
  { key: "terminal", label: "Terminal", items: PRIMARY_NAV_ITEMS },
  { key: "track", label: "Track", items: groupItems("data") },
  { key: "monitor", label: "Monitor", items: groupItems("monitor") },
  { key: "analyze", label: "Analyze", items: groupItems("tools") },
  { key: "docs", label: "Docs", items: groupItems("learn") },
  { key: "resources", label: "Resources", items: groupItems("info") },
];

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
    <DropdownMenuItem asChild className="items-start gap-2.5 rounded-lg px-2.5 py-2 focus:bg-muted/60">
      <Link href={item.href} prefetch={false} {...(item.external ? { target: "_blank", rel: "noreferrer" } : {})}>
        <Icon className="mt-0.5 size-4 shrink-0 text-muted-foreground" aria-hidden />
        <span className="flex min-w-0 flex-col gap-0.5">
          <span className="text-sm font-medium text-foreground">{item.label}</span>
          {item.description ? (
            <span className="text-xs leading-snug text-muted-foreground">{item.description}</span>
          ) : null}
        </span>
      </Link>
    </DropdownMenuItem>
  );
}

// dark / light / system controls, folded into the overflow menu per the Figma.
function ThemeControls() {
  const { theme, setTheme } = useTheme();
  const [mounted, setMounted] = useState(false);
  useEffect(() => {
    // next-themes: only read the resolved theme after mount so the active
    // highlight doesn't cause a hydration mismatch. One-shot, empty deps.
    // eslint-disable-next-line react-hooks/set-state-in-effect
    setMounted(true);
  }, []);
  const options = [
    { value: "dark", label: "Dark", icon: Moon },
    { value: "light", label: "Light", icon: Sun },
    { value: "system", label: "System", icon: Monitor },
  ] as const;
  return (
    <div className="flex items-center gap-1 px-1.5 py-1">
      {options.map((opt) => {
        const Icon = opt.icon;
        const active = mounted && theme === opt.value;
        return (
          <button
            key={opt.value}
            type="button"
            onClick={() => setTheme(opt.value)}
            aria-label={`${opt.label} theme`}
            aria-pressed={active}
            className={cn(
              "inline-flex size-8 items-center justify-center rounded-md transition-colors",
              active ? "bg-muted text-foreground" : "text-muted-foreground hover:bg-muted/40 hover:text-foreground",
            )}
          >
            <Icon className="size-4" aria-hidden />
          </button>
        );
      })}
    </div>
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
  const topOffsetClass = pathname === "/" ? "top-0" : "top-[3px]";

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
        <PharosLogo size={28} className="rounded-lg shadow-sm" priority />
        <span className="pharos-display text-[15px] font-bold tracking-tight text-foreground">Pharos</span>
      </Link>

      <nav aria-label="Sections" className="flex min-w-0 items-center gap-0.5">
        {TOP_MENUS.map((menu) => {
          const isActive = menu.items.some((item) => normalizeNavPath(item.href) === normalizedPath);
          return (
            <DropdownMenu key={menu.key}>
              <DropdownMenuTrigger asChild>
                <button
                  type="button"
                  aria-current={isActive ? "true" : undefined}
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
              <DropdownMenuContent align="start" sideOffset={8} className="w-72 p-1.5">
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

        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <button
              type="button"
              aria-label="More"
              className="pharos-focus-ring inline-flex size-9 items-center justify-center rounded-lg text-muted-foreground transition-colors hover:bg-muted/40 hover:text-foreground"
            >
              <LighthouseIcon className="size-4" aria-hidden />
            </button>
          </DropdownMenuTrigger>
          <DropdownMenuContent align="end" sideOffset={8} className="w-56 p-1.5">
            <DropdownMenuItem asChild className="gap-2.5 rounded-lg px-2.5 py-2">
              <Link href="/pharoswatchbot/" prefetch={false}>
                <Send className="size-4 text-muted-foreground" aria-hidden />
                <span className="text-sm font-medium">Telegram Bot</span>
              </Link>
            </DropdownMenuItem>
            <DropdownMenuItem asChild className="gap-2.5 rounded-lg px-2.5 py-2">
              <Link href="/changelog/" prefetch={false}>
                <Sparkles className="size-4 text-muted-foreground" aria-hidden />
                <span className="text-sm font-medium">What&apos;s New</span>
              </Link>
            </DropdownMenuItem>
            <DropdownMenuSeparator />
            <DropdownMenuItem asChild className="gap-2.5 rounded-lg px-2.5 py-2">
              <Link href="/status/" prefetch={false}>
                <Activity className="size-4 text-muted-foreground" aria-hidden />
                <span className="text-sm font-medium">Pharos is Healthy</span>
                <span className="ml-auto size-2 rounded-full bg-emerald-500" aria-hidden />
              </Link>
            </DropdownMenuItem>
            <DropdownMenuSeparator />
            <ThemeControls />
          </DropdownMenuContent>
        </DropdownMenu>
      </div>
    </header>
  );
}
