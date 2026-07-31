"use client";

import { useEffect, useState } from "react";
import Image from "next/image";
import Link from "next/link";
import { Search } from "lucide-react";
import { useCommandPaletteHistory } from "@/hooks/use-command-palette-history";
import { openCommandPalette } from "@/lib/command-palette";
import { guessRoute, type RouteSuggestion } from "@/lib/route-guess";

const FIXED_ENTRY_POINTS: { href: string; label: string }[] = [
  { href: "/", label: "Dashboard" },
  { href: "/stablecoins/usd/", label: "Browse Stablecoins" },
  { href: "/digest/", label: "Daily Digest" },
  { href: "/compare/", label: "Compare Tools" },
];

export default function NotFound() {
  const [failedPath, setFailedPath] = useState<string>("");
  const [suggestions, setSuggestions] = useState<RouteSuggestion[]>([]);
  const { history } = useCommandPaletteHistory();

  useEffect(() => {
    if (typeof window === "undefined") return;
    const path = window.location.pathname;
    // eslint-disable-next-line react-hooks/set-state-in-effect
    setFailedPath(path);
    setSuggestions(guessRoute(path));
  }, []);

  useEffect(() => {
    if (typeof window === "undefined") return;
    const onKey = (event: KeyboardEvent) => {
      if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === "k") {
        event.preventDefault();
        openCommandPalette();
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);

  const recent = history.slice(0, 3);
  const topSuggestion = suggestions[0];

  return (
    <div className="mx-auto flex min-h-[60vh] max-w-3xl flex-col items-center justify-center gap-6 py-10 text-center">
      <FadedBeamSvg />
      <Image
        src="/pharos-mark.png"
        alt="Pharos"
        width={96}
        height={96}
        className="opacity-20"
      />
      <div className="space-y-2">
        {/* Georgia (`font-serif`), not Newsreader: the not-found boundary is
            bundled into every route, and importing digestDisplay here
            preloaded the digest font CSS app-wide (mythos review #19). */}
        <p className="font-serif text-xs font-semibold uppercase tracking-[0.22em] text-frost-blue/80">
          Trail gone cold
        </p>
        <h1 className="font-serif text-4xl font-semibold tracking-tight sm:text-5xl">
          The lamp swept past this page.
        </h1>
        {failedPath && (
          <p className="font-mono text-xs text-muted-foreground/80">
            Asked for: <span className="text-foreground/80">{failedPath}</span>
          </p>
        )}
      </div>
      <p className="max-w-xl font-mono text-sm italic leading-relaxed text-muted-foreground">
        The page you asked for is missing, moved, or no longer tracked. Use one of the
        recovery paths below — or press <kbd className="rounded border border-border/60 bg-muted/30 px-1.5 py-0.5 not-italic text-[0.65rem] font-mono">Cmd K</kbd> to search the dashboard.
      </p>

      {topSuggestion && (
        <div className="w-full max-w-xl rounded-xl border border-frost-blue/40 bg-frost-blue/5 px-4 py-3 text-left">
          <p className="text-xs font-mono uppercase tracking-wider text-frost-blue/80">
            Did you mean?
          </p>
          <ul className="mt-2 space-y-1">
            {suggestions.map((s) => (
              <li key={s.href}>
                <Link
                  href={s.href}
                  className="pharos-focus-ring inline-flex items-baseline gap-2 rounded-sm text-sm hover:underline"
                >
                  <span className="font-mono text-foreground/90">{s.href}</span>
                  <span className="text-xs text-muted-foreground">{s.label}</span>
                </Link>
              </li>
            ))}
          </ul>
        </div>
      )}

      <button
        type="button"
        onClick={openCommandPalette}
        className="pharos-focus-ring inline-flex w-full max-w-xl items-center gap-2 rounded-xl border border-border/60 bg-card/55 px-4 py-3 text-left text-sm text-muted-foreground transition-colors hover:text-foreground"
      >
        <Search className="h-4 w-4" aria-hidden />
        <span>Search the dashboard…</span>
        <kbd className="ml-auto rounded border border-border/60 bg-background/60 px-1.5 py-0.5 text-[0.65rem] font-mono">
          Cmd K
        </kbd>
      </button>

      {recent.length > 0 && (
        <div className="w-full max-w-xl">
          <p className="text-left text-xs font-mono uppercase tracking-wider text-muted-foreground/70">
            Recent visits
          </p>
          <ul className="mt-2 grid gap-2 sm:grid-cols-3">
            {recent.map((item) => (
              <li key={item.id}>
                <Link
                  href={item.href}
                  className="pharos-focus-ring block truncate rounded-xl border border-border/40 bg-card/40 px-3 py-2 text-left text-xs text-muted-foreground transition-colors hover:text-foreground"
                >
                  {item.label}
                </Link>
              </li>
            ))}
          </ul>
        </div>
      )}

      <div className="grid w-full max-w-xl gap-3 sm:grid-cols-2">
        {FIXED_ENTRY_POINTS.map((entry) => (
          <Link
            key={entry.href}
            href={entry.href}
            className="pharos-focus-ring rounded-xl border border-border/60 bg-card/55 px-4 py-3 text-sm text-muted-foreground transition-colors hover:text-foreground"
          >
            {entry.label}
          </Link>
        ))}
      </div>
    </div>
  );
}

/** Faded "trail gone cold" beam — hairline strokes, low opacity. */
function FadedBeamSvg() {
  return (
    <svg
      width="96"
      height="96"
      viewBox="0 0 96 96"
      fill="none"
      stroke="currentColor"
      strokeWidth="1"
      strokeLinecap="round"
      className="text-frost-blue/25"
      aria-hidden="true"
    >
      <circle cx="48" cy="48" r="3" strokeWidth="1.2" opacity="0.55" />
      <path d="M48 45 L18 24" opacity="0.18" />
      <path d="M48 45 L78 24" opacity="0.12" />
      <path d="M48 51 L20 76" opacity="0.10" />
      <path d="M48 51 L76 76" opacity="0.20" />
      <path d="M48 44 L48 14" opacity="0.30" strokeDasharray="2 4" />
    </svg>
  );
}
