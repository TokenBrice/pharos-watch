"use client";

import { useMemo, useRef, useState } from "react";
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
import { cn } from "@/lib/utils";

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

  const containerRef = useRef<HTMLDivElement>(null);
  const ctaRef = useRef<HTMLAnchorElement>(null);

  const handleDismiss = () => {
    setState("dismissed");
    persistCalloutState("dismissed");
  };

  const handleRestore = () => {
    setState("default");
    persistCalloutState("default");
  };

  const handlePointerMove = (event: React.PointerEvent<HTMLDivElement>) => {
    const el = containerRef.current;
    if (!el) return;
    const rect = el.getBoundingClientRect();
    const x = ((event.clientX - rect.left) / rect.width) * 100;
    const y = ((event.clientY - rect.top) / rect.height) * 100;
    el.style.setProperty("--px", `${x}%`);
    el.style.setProperty("--py", `${y}%`);

    const cta = ctaRef.current;
    if (cta) {
      const ctaRect = cta.getBoundingClientRect();
      const cx = ctaRect.left + ctaRect.width / 2;
      const cy = ctaRect.top + ctaRect.height / 2;
      const dx = event.clientX - cx;
      const dy = event.clientY - cy;
      const dist = Math.hypot(dx, dy) || 1;
      const reach = 160;
      const pull = Math.max(0, 1 - dist / reach);
      const tx = (dx / dist) * pull * 5;
      const ty = (dy / dist) * pull * 5;
      cta.style.setProperty("--cta-tx", `${tx.toFixed(2)}px`);
      cta.style.setProperty("--cta-ty", `${ty.toFixed(2)}px`);
    }
  };

  const handlePointerLeave = () => {
    const cta = ctaRef.current;
    if (cta) {
      cta.style.setProperty("--cta-tx", "0px");
      cta.style.setProperty("--cta-ty", "0px");
    }
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
    <div
      ref={containerRef}
      role="note"
      onPointerMove={handlePointerMove}
      onPointerLeave={handlePointerLeave}
      className={cn(
        "pharos-picker-callout group relative isolate overflow-hidden rounded-xl border border-border/65 bg-card/60",
      )}
    >
      <div className="pharos-picker-callout__grid pointer-events-none absolute inset-0" aria-hidden="true" />
      <div className="pharos-picker-callout__scan pointer-events-none absolute inset-0" aria-hidden="true" />
      <div className="pharos-picker-callout__glow pointer-events-none absolute inset-0" aria-hidden="true" />

      <div className="relative flex flex-col gap-3 p-4 sm:flex-row sm:items-center sm:justify-between sm:gap-4 sm:p-5">
        <div className="flex min-w-0 items-start gap-3 sm:gap-4">
          <span
            className="pharos-picker-emblem pharos-picker-emblem__rose relative inline-flex h-9 w-9 shrink-0 items-center justify-center"
            aria-hidden="true"
          >
            <SelectorEmblem />
          </span>
          <div className="pharos-picker-stack min-w-0 space-y-1">
            <p className="text-sm font-semibold tracking-tight text-foreground">
              Pharos Stablecoin Picker
            </p>
            <p className="text-sm leading-relaxed text-muted-foreground">
              The Screener gives you the full universe to filter. The Picker flips that: describe your operation and needs and Pharos returns a profile-fit shortlist.
            </p>
          </div>
        </div>
        <div className="relative flex items-center gap-2 sm:shrink-0">
          <Link
            ref={ctaRef}
            href={selectorHref}
            className="pharos-picker-cta pharos-focus-ring relative inline-flex min-h-11 items-center gap-1.5 overflow-hidden rounded-full px-4 text-sm font-medium sm:min-h-9"
          >
            <span className="pharos-picker-cta__shimmer pointer-events-none absolute inset-0" aria-hidden="true" />
            <span className="relative z-10">Try the Picker</span>
            <ArrowRight className="pharos-picker-cta__arrow relative z-10 h-3.5 w-3.5 opacity-80" aria-hidden="true" />
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
