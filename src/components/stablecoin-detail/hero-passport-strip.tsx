"use client";

import { useEffect, useRef } from "react";
import Link from "next/link";
import type { HeroPassportItemViewModel } from "@/lib/stablecoin-detail-view-model";

function alignSection(sectionId: string) {
  // scrollIntoView honors the targets' CSS scroll-margin-top (sticky-chrome
  // clearance) and the page's scroll-behavior, including its reduced-motion
  // override.
  document.getElementById(sectionId)?.scrollIntoView({ block: "start" });
}

/**
 * Dossier "passport": the verification facts (mechanism, attestor,
 * jurisdiction, redeemability, minting, freeze powers, chain count) rendered
 * as identity-document fields docked at the bottom of the hero card — the
 * field name in small letters above, the entry in mono all-caps below. Each
 * field links to the section that proves it (no jump affordance icon: on
 * desktop most targets are already on the visible page).
 * Values come from a bounded authored vocabulary — never CSS-truncated.
 */
export function HeroPassportStrip({ items }: { items: HeroPassportItemViewModel[] }) {
  const pendingScrollSyncRef = useRef<number[]>([]);

  useEffect(
    () => () => {
      for (const timer of pendingScrollSyncRef.current) window.clearTimeout(timer);
    },
    [],
  );

  if (items.length < 3) return null;

  // Deep targets sit below lazy-mounted sections whose final height settles
  // after the jump starts, so a single scroll under-shoots. Re-align while the
  // hash still matches — the same retry cadence as LongformScrollspyNav.
  function jumpToSection(sectionId: string) {
    for (const timer of pendingScrollSyncRef.current) window.clearTimeout(timer);
    pendingScrollSyncRef.current = [];
    window.history.pushState(null, "", `#${sectionId}`);
    alignSection(sectionId);
    for (const delay of [160, 480, 960, 1800]) {
      pendingScrollSyncRef.current.push(
        window.setTimeout(() => {
          if (decodeURIComponent(window.location.hash.replace(/^#/, "")) === sectionId) {
            alignSection(sectionId);
          }
        }, delay),
      );
    }
  }

  return (
    <div
      className="relative border-t border-border/30 px-4 py-2.5 sm:px-5"
      role="group"
      aria-label="Verification passport"
    >
      <div
        aria-hidden="true"
        className="pointer-events-none absolute inset-y-0 right-0 z-10 w-8 bg-gradient-to-l from-card to-transparent lg:hidden"
      />
      <div className="scrollbar-none flex snap-x items-start gap-x-6 gap-y-1.5 overflow-x-auto lg:flex-wrap lg:overflow-visible">
        {items.map((item) => {
          const isHashJump = item.href.startsWith("#");
          return (
            <Link
              key={item.key}
              href={item.href}
              aria-label={item.ariaLabel}
              onClick={
                isHashJump
                  ? (event) => {
                      event.preventDefault();
                      jumpToSection(item.href.slice(1));
                    }
                  : undefined
              }
              className="pharos-focus-ring group flex min-h-11 shrink-0 snap-start flex-col justify-center rounded-sm lg:min-h-0"
            >
              <span className="text-[10px] font-medium uppercase tracking-wider leading-tight text-muted-foreground">
                {item.category}
              </span>
              <span
                className={`whitespace-nowrap font-mono text-xs font-semibold uppercase leading-snug tracking-wide underline-offset-2 group-hover:underline ${
                  item.valueClass ?? "text-foreground"
                }`}
              >
                {item.value}
              </span>
            </Link>
          );
        })}
      </div>
    </div>
  );
}
