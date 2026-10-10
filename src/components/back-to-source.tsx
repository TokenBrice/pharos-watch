"use client";

import { createContext, useContext, useEffect, useState, useSyncExternalStore, type ReactNode } from "react";
import Link from "next/link";
import { cn } from "@/lib/utils";
import { usePathname } from "next/navigation";
import { useUrlFilters } from "@/hooks/use-url-filters";

/** Only a preceding in-document tracker route exposes a contextual return link. */
const TRACKER_LABELS: Record<string, string> = {
  "/screener": "Screener results",
  "/compare": "Compare",
  "/timeline": "Tape",
  "/portfolio": "Portfolio",
  "/depeg": "Depeg tracker",
  "/yield": "Yield leaderboard",
  "/liquidity": "Liquidity",
  "/safety-scores": "Safety Scores",
  "/freezewatch": "FreezeWatch",
  "/flows": "Mint/Burn Flows",
};

interface SourceStore {
  visit: (url: string) => void;
  subscribe: (listener: () => void) => () => void;
  getSnapshot: () => string | null;
}

function createSourceStore(): SourceStore {
  let currentUrl: string | null = null;
  let previousUrl: string | null = null;
  const listeners = new Set<() => void>();
  return {
    visit(url) {
      if (currentUrl && currentUrl.split("?")[0] !== url.split("?")[0]) {
        previousUrl = currentUrl;
        currentUrl = url;
        for (const listener of listeners) listener();
      } else currentUrl = url;
    },
    subscribe(listener) {
      listeners.add(listener);
      return () => { listeners.delete(listener); };
    },
    getSnapshot: () => previousUrl,
  };
}

const PreviousSourceContext = createContext<SourceStore | null>(null);
const getServerSnapshot = () => null;
const subscribeNothing = () => () => {};

/** Mounted once in the shell; filter-only writes update the URL before departure. */
export function SourceNavigationProvider({ children }: { children: ReactNode }) {
  const pathname = usePathname();
  const { searchParams, isReady } = useUrlFilters();
  const search = searchParams.toString();
  const [store] = useState(createSourceStore);

  useEffect(() => {
    if (!isReady || !pathname) return;
    store.visit(`${window.location.pathname}${window.location.search}`);
  }, [pathname, search, isReady, store]);

  return <PreviousSourceContext.Provider value={store}>{children}</PreviousSourceContext.Provider>;
}

/** Direct document entries have no invented client-route provenance. */
export function BackToSource({ className }: { className?: string }) {
  const store = useContext(PreviousSourceContext);
  const sourceUrl = useSyncExternalStore(store?.subscribe ?? subscribeNothing, store?.getSnapshot ?? getServerSnapshot, getServerSnapshot);
  const segment = sourceUrl ? "/" + sourceUrl.split("?")[0].split("/").filter(Boolean)[0] : null;
  const label = segment ? TRACKER_LABELS[segment] : null;
  const backLink = sourceUrl && label ? { href: sourceUrl, label } : null;

  if (!backLink) return null;
  return (
    <Link
      href={backLink.href}
      className={cn(
        "pharos-focus-ring inline-flex items-center gap-1.5 rounded-sm text-xs text-muted-foreground transition-colors hover:text-foreground",
        className,
      )}
    >
      <span aria-hidden="true">←</span> Back to {backLink.label}
    </Link>
  );
}
