"use client";

import { useEffect, useRef, type CSSProperties, type ReactNode } from "react";
import Link from "next/link";
import { usePathname, useRouter } from "next/navigation";
import { Activity, LogOut, Moon, Sun } from "lucide-react";
import { PharosLogo } from "@/components/pharos-logo";
import { useOpsUiHost } from "@/hooks/use-ops-ui-host";
import { useThemeToggle } from "@/hooks/use-theme-toggle";
import {
  ADMIN_WORKSPACES,
  getActiveAdminWorkspace,
  getAdminWorkspacePathForLegacyHash,
  isAdminWorkspaceActive,
} from "@/lib/admin-workspaces";
import { cn } from "@/lib/utils";

function OpsPublicHostGate() {
  return (
    <main id="ops-main-content" className="mx-auto flex min-h-[60vh] w-full max-w-3xl items-center px-4 py-12 sm:px-6">
      <div className="w-full border border-border bg-background p-6 sm:p-8">
        <p className="pharos-kicker">Private surface</p>
        <h1 className="mt-2 text-2xl font-semibold text-foreground">Operator tooling is unavailable on this host</h1>
        <p className="mt-3 max-w-2xl text-sm leading-relaxed text-muted-foreground">
          Admin workspaces only run on the Access-protected ops domain. Public system health remains available on the
          read-only status page.
        </p>
        <div className="mt-5 flex flex-wrap gap-3">
          <Link
            href="/status/"
            className="pharos-focus-ring inline-flex min-h-11 items-center gap-2 rounded-md border border-border bg-background px-4 py-2 text-sm font-medium text-foreground hover:bg-muted/50"
          >
            Open public status
            <Activity className="size-4" aria-hidden="true" />
          </Link>
          <Link
            href="/"
            className="pharos-focus-ring inline-flex min-h-11 items-center rounded-md px-4 py-2 text-sm font-medium text-muted-foreground hover:bg-muted/50 hover:text-foreground"
          >
            Return to dashboard
          </Link>
        </div>
      </div>
    </main>
  );
}

export function OpsShell({ children }: { children: ReactNode }) {
  const opsUiHost = useOpsUiHost();
  const pathname = usePathname();
  const router = useRouter();
  const navScrollerRef = useRef<HTMLElement>(null);
  const activeTabRef = useRef<HTMLAnchorElement>(null);
  const activeWorkspace = getActiveAdminWorkspace(pathname);
  const { isDark, label: themeLabel, toggleTheme } = useThemeToggle();

  useEffect(() => {
    const root = document.documentElement;
    root.classList.add("overflow-x-clip");
    return () => root.classList.remove("overflow-x-clip");
  }, []);

  useEffect(() => {
    if (!opsUiHost) return;

    const redirectLegacyHash = () => {
      const target = getAdminWorkspacePathForLegacyHash(window.location.hash);
      if (target) router.replace(target, { scroll: false });
    };

    redirectLegacyHash();
    window.addEventListener("hashchange", redirectLegacyHash);
    return () => window.removeEventListener("hashchange", redirectLegacyHash);
  }, [opsUiHost, router]);

  useEffect(() => {
    if (!opsUiHost) return;

    const scroller = navScrollerRef.current;
    const activeTab = activeTabRef.current;
    if (!scroller || !activeTab) return;

    const targetLeft = activeTab.offsetLeft - (scroller.clientWidth - activeTab.offsetWidth) / 2;
    const maxLeft = Math.max(0, scroller.scrollWidth - scroller.clientWidth);
    const left = Math.max(0, Math.min(targetLeft, maxLeft));
    if (typeof scroller.scrollTo === "function") {
      scroller.scrollTo({ left, behavior: "auto" });
    } else {
      scroller.scrollLeft = left;
    }
  }, [opsUiHost, pathname]);

  if (opsUiHost == null) {
    return (
      <main id="ops-main-content" className="py-20 text-center text-sm text-muted-foreground">
        <p role="status" aria-live="polite">
          Loading operator access...
        </p>
      </main>
    );
  }

  if (!opsUiHost) return <OpsPublicHostGate />;

  const handleSignOut = () => {
    window.location.assign("/cdn-cgi/access/logout");
  };

  return (
    <div
      className="min-h-screen overflow-x-clip bg-background"
      style={{ "--ops-sticky-offset": "7rem" } as CSSProperties}
    >
      <a
        href="#ops-main-content"
        className="pharos-focus-ring fixed left-3 top-3 z-50 -translate-y-24 rounded-md bg-foreground px-4 py-2 text-sm font-medium text-background transition-transform focus:translate-y-0 motion-reduce:transition-none"
      >
        Skip to operator workspace
      </a>
      <header className="sticky top-0 z-40 border-b border-border bg-background/95 backdrop-blur-sm">
        <div className="mx-auto flex w-full max-w-[96rem] flex-wrap items-center justify-between gap-3 px-3 py-2 sm:px-5">
          <div className="flex min-w-0 items-center gap-3">
            <Link href="/admin/" className="pharos-focus-ring flex shrink-0 items-center gap-2 rounded-md">
              <PharosLogo size={26} priority />
              <span className="text-sm font-semibold text-foreground">
                <span className="sm:hidden">Pharos Ops</span>
                <span className="hidden sm:inline">Pharos Operator Admin</span>
              </span>
            </Link>
            <span className="hidden h-5 border-l border-border md:block" aria-hidden="true" />
            <span className="hidden truncate text-xs font-medium text-muted-foreground md:inline">
              {activeWorkspace?.label ?? "Operator workspace"}
            </span>
          </div>

          <div className="flex items-center gap-1">
            <span className="mr-1 inline-flex items-center gap-1.5 rounded-md border border-emerald-500/30 bg-emerald-500/10 px-2 py-1 text-[11px] font-medium text-emerald-800 dark:text-emerald-200">
              <span className="size-1.5 rounded-full bg-emerald-500" aria-hidden="true" />
              <span className="sm:hidden">Prod</span>
              <span className="hidden sm:inline">Production</span>
            </span>
            <Link
              href="/status/"
              className="pharos-focus-ring inline-flex size-11 items-center justify-center rounded-md text-muted-foreground hover:bg-muted/50 hover:text-foreground sm:w-auto sm:gap-2 sm:px-3"
              title="Open public status"
            >
              <Activity className="size-4" aria-hidden="true" />
              <span className="hidden text-xs sm:inline">Public status</span>
            </Link>
            <button
              type="button"
              onClick={toggleTheme}
              className="pharos-focus-ring inline-flex size-11 items-center justify-center rounded-md text-muted-foreground hover:bg-muted/50 hover:text-foreground"
              aria-label={themeLabel}
              title={themeLabel}
            >
              {isDark ? <Sun className="size-4" aria-hidden="true" /> : <Moon className="size-4" aria-hidden="true" />}
            </button>
            <button
              type="button"
              onClick={handleSignOut}
              className="pharos-focus-ring inline-flex min-h-11 items-center gap-2 rounded-md px-2.5 text-xs font-medium text-muted-foreground hover:bg-muted/50 hover:text-foreground"
              title="Sign out"
            >
              <LogOut className="size-4" aria-hidden="true" />
              <span className="hidden sm:inline">Sign out</span>
            </button>
          </div>
        </div>

        <nav
          ref={navScrollerRef}
          aria-label="Operator workspaces"
          className="mx-auto w-full max-w-[96rem] overflow-x-auto px-3 scrollbar-none sm:px-5"
          style={{ contain: "paint" }}
        >
          <div className="flex min-w-max gap-1 pb-2">
            {ADMIN_WORKSPACES.map((workspace) => {
              const active = isAdminWorkspaceActive(pathname, workspace.id);
              return (
                <Link
                  key={workspace.id}
                  ref={active ? activeTabRef : undefined}
                  href={workspace.path}
                  aria-current={active ? "page" : undefined}
                  className={cn(
                    "pharos-focus-ring inline-flex min-h-11 items-center rounded-md border border-transparent px-3 text-xs font-medium transition-colors motion-reduce:transition-none",
                    active
                      ? "bg-foreground text-background forced-colors:border forced-colors:border-[Highlight] forced-colors:text-[Highlight]"
                      : "text-muted-foreground hover:bg-muted/50 hover:text-foreground",
                  )}
                >
                  {workspace.label}
                </Link>
              );
            })}
          </div>
        </nav>
      </header>

      <main id="ops-main-content" className="mx-auto w-full max-w-[96rem] px-3 py-4 sm:px-5 sm:py-5 lg:px-6">
        {children}
      </main>
    </div>
  );
}
