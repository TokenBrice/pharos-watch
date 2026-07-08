"use client";

import { useEffect, useRef } from "react";
import type { CSSProperties } from "react";
import Link from "next/link";
import { Info } from "lucide-react";
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from "@/components/ui/tooltip";
import type { HeroPassportItemViewModel } from "@/lib/stablecoin-detail-passport";

function alignSection(sectionId: string) {
  // scrollIntoView honors the targets' CSS scroll-margin-top (sticky-chrome
  // clearance) and the page's scroll-behavior, including its reduced-motion
  // override. At xl some sections relocate into the right rail and the
  // in-flow twin that owns the id is display-hidden — jump to the visible
  // rail twin (`data-anchor-twin`) instead.
  const target = document.getElementById(sectionId);
  const element =
    target && target.offsetParent === null
      ? (document.querySelector<HTMLElement>(`[data-anchor-twin="${CSS.escape(sectionId)}"]`) ?? target)
      : target;
  element?.scrollIntoView({ block: "start" });
}

function PassportItemValue({ item, valueClassName }: { item: HeroPassportItemViewModel; valueClassName: string }) {
  const toneClass = item.valueClass ?? "text-foreground";
  const valueNode = item.chip ? (
    <span
      className={`inline-flex w-fit items-center rounded-full border border-border/60 bg-muted/40 px-2 py-px ${valueClassName} ${toneClass}`}
    >
      {item.value}
    </span>
  ) : (
    <span className={`${valueClassName} underline-offset-2 group-hover:underline ${toneClass}`}>{item.value}</span>
  );
  if (!item.tooltipLines) return valueNode;
  return (
    <span className="inline-flex items-center gap-1">
      {valueNode}
      <Info className="h-3 w-3 shrink-0 text-muted-foreground" aria-hidden="true" />
    </span>
  );
}

/** Hover detail for items carrying an authority stack (jurisdiction). */
function withPassportTooltip(item: HeroPassportItemViewModel, trigger: React.ReactElement) {
  if (!item.tooltipLines) return trigger;
  return (
    <Tooltip key={item.key}>
      <TooltipTrigger asChild>{trigger}</TooltipTrigger>
      <TooltipContent side="bottom" className="text-left">
        {item.tooltipLines.map((line) => (
          <span key={line} className="block">
            {line}
          </span>
        ))}
      </TooltipContent>
    </Tooltip>
  );
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
export function HeroPassportStrip({
  items,
  compactDesktop = false,
}: {
  items: HeroPassportItemViewModel[];
  compactDesktop?: boolean;
}) {
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

  // Dense strips distribute like a real document data page — fields spread
  // edge-to-edge across the available width. Sparse strips (<6 facts) keep the
  // start-aligned gap so three fields don't float disconnected across the card.
  const distributionClass = items.length >= 6 ? "lg:justify-between" : "";
  const desktopItems = compactDesktop ? items.filter((item) => item.category !== "Mechanism") : items;
  const desktopGridStyle = {
    gridTemplateColumns: `repeat(${Math.max(desktopItems.length, 1)}, minmax(0, 1fr))`,
  } as CSSProperties;

  return (
    <TooltipProvider>
      <div
        className={
          compactDesktop
            ? "relative border-t border-border/40 px-4 py-2.5 sm:px-5 lg:px-0 lg:py-0"
            : "relative border-t border-border/30 px-4 py-2.5 sm:px-5"
        }
        role="group"
        aria-label="Verification passport"
      >
        <div
          aria-hidden="true"
          className="pointer-events-none absolute inset-y-0 right-0 z-10 w-8 bg-gradient-to-l from-card to-transparent lg:hidden"
        />
        <div
          className={`scrollbar-none flex snap-x items-start gap-x-6 gap-y-1.5 overflow-x-auto ${
            compactDesktop ? "lg:hidden" : "lg:flex-wrap lg:gap-x-4 lg:overflow-visible"
          } ${compactDesktop ? "" : distributionClass}`}
        >
          {items.map((item) => {
            const isHashJump = item.href.startsWith("#");
            return withPassportTooltip(
              item,
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
                <PassportItemValue
                  item={item}
                  valueClassName="whitespace-nowrap font-mono text-xs font-semibold uppercase leading-snug tracking-wide"
                />
              </Link>,
            );
          })}
        </div>
        {compactDesktop ? (
          <div className="hidden lg:grid" style={desktopGridStyle}>
            {desktopItems.map((item) => {
              const isHashJump = item.href.startsWith("#");
              return withPassportTooltip(
                item,
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
                  className="pharos-focus-ring group flex min-h-14 min-w-0 flex-col justify-center border-r border-border/40 px-4 py-3 last:border-r-0"
                >
                  <span className="text-[10px] font-medium uppercase leading-tight tracking-[0.14em] text-muted-foreground">
                    {item.category}
                  </span>
                  <span className="mt-0.5 flex">
                    <PassportItemValue
                      item={item}
                      valueClassName="whitespace-nowrap font-mono text-[11px] font-semibold uppercase leading-snug tracking-wide"
                    />
                  </span>
                </Link>,
              );
            })}
          </div>
        ) : null}
      </div>
    </TooltipProvider>
  );
}
