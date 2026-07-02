"use client";

import { useMemo, useState } from "react";
import Link from "next/link";
import { ArrowRight, Compass, X } from "lucide-react";
import { SelectorEmblem } from "@/components/home-alt-callouts/selector-emblem";
import { useIsMobile } from "@/hooks/use-is-mobile";
import { useHydrated } from "@/hooks/use-hydrated";
import {
  getWindowStorage,
  safeStorageGetItem,
  safeStorageSetItem,
} from "@/lib/browser-storage";

const CALLOUT_KEY = "pharos.selector.callout.v1";
const LEGACY_CALLOUT_KEY = "pharos-selector-callout-v1";

type CalloutState = "default" | "dismissed";

function readCalloutState(): CalloutState {
  const storage = getWindowStorage("local");
  if (!storage) return "default";
  return safeStorageGetItem(storage, CALLOUT_KEY) === "dismissed" ||
    safeStorageGetItem(storage, LEGACY_CALLOUT_KEY) === "dismissed"
    ? "dismissed"
    : "default";
}

function persistCalloutState(next: CalloutState): void {
  const storage = getWindowStorage("local");
  if (!storage) return;
  safeStorageSetItem(storage, CALLOUT_KEY, next);
}

export function SelectorCallout() {
  const hydrated = useHydrated();
  const isMobile = useIsMobile(640);
  const initial = useMemo(
    () => (typeof window === "undefined" ? "default" : readCalloutState()),
    [],
  );
  const [state, setState] = useState<CalloutState>(initial);

  const handleDismiss = () => {
    setState("dismissed");
    persistCalloutState("dismissed");
  };

  const handleRestore = () => {
    setState("default");
    persistCalloutState("default");
  };

  // Server renders the default desktop variant; mobile branch flips after hydration.
  const showMobile = hydrated && isMobile;

  const selectorHref = "/screener/picker/";

  if (state === "dismissed") {
    return (
      <div
        role="note"
        className="flex items-center justify-between gap-3 rounded-md border border-border/40 bg-muted/10 px-3 py-2 text-xs text-muted-foreground"
      >
        <span>Picker hidden.</span>
        <button
          type="button"
          onClick={handleRestore}
          className="pharos-focus-ring rounded-sm font-medium text-foreground underline underline-offset-4 hover:text-foreground"
        >
          Bring back the Picker
          <ArrowRight className="ml-1 inline h-3 w-3" aria-hidden="true" />
        </button>
      </div>
    );
  }

  if (showMobile) {
    return (
      <div
        role="note"
        className="flex items-center justify-between gap-2 rounded-md border border-border/60 bg-card/55 px-3 py-2.5 text-sm"
      >
        <Link
          href={selectorHref}
          className="pharos-focus-ring flex min-w-0 flex-1 items-center gap-2 rounded-sm text-foreground"
        >
          <Compass className="h-4 w-4 shrink-0 text-muted-foreground" aria-hidden="true" />
          <span className="min-w-0 truncate">
            <span className="font-semibold">Try the Picker</span>
            <span className="text-muted-foreground"> — match a profile to a shortlist</span>
          </span>
          <ArrowRight className="h-3.5 w-3.5 shrink-0 text-muted-foreground" aria-hidden="true" />
        </Link>
        <button
          type="button"
          onClick={handleDismiss}
          aria-label="Dismiss Picker callout"
          className="pharos-focus-ring inline-flex h-7 w-7 shrink-0 items-center justify-center rounded-full text-muted-foreground hover:bg-muted/40 hover:text-foreground"
        >
          <X className="h-3.5 w-3.5" aria-hidden="true" />
        </button>
      </div>
    );
  }

  return (
    <div role="note" className="pharos-card-shell">
      <div className="flex flex-col gap-3 p-4 sm:flex-row sm:items-center sm:justify-between sm:gap-4 sm:p-5">
        <div className="flex min-w-0 items-start gap-3 sm:gap-4">
          <span
            className="inline-flex h-9 w-9 shrink-0 items-center justify-center text-muted-foreground [&_svg]:h-full [&_svg]:w-full"
            aria-hidden="true"
          >
            <SelectorEmblem />
          </span>
          <div className="min-w-0 space-y-1">
            <p className="text-sm font-semibold tracking-tight text-foreground">
              Pharos Stablecoin Picker
            </p>
            <p className="text-sm leading-relaxed text-muted-foreground">
              The Screener gives you the full universe to filter. The Picker flips that: describe your operation and needs and Pharos returns a profile-fit shortlist.
            </p>
          </div>
        </div>
        <div className="flex items-center gap-2 sm:shrink-0">
          <Link
            href={selectorHref}
            className="pharos-focus-ring inline-flex min-h-11 items-center gap-1.5 rounded-full border border-foreground/60 bg-foreground px-4 text-sm font-medium text-background hover:bg-foreground/90 sm:min-h-9"
          >
            Try the Picker
            <ArrowRight className="h-3.5 w-3.5" aria-hidden="true" />
          </Link>
          <button
            type="button"
            onClick={handleDismiss}
            aria-label="Dismiss Picker callout"
            className="pharos-focus-ring inline-flex h-9 w-9 shrink-0 items-center justify-center rounded-full text-muted-foreground hover:bg-muted/40 hover:text-foreground"
          >
            <X className="h-4 w-4" aria-hidden="true" />
          </button>
        </div>
      </div>
    </div>
  );
}
