"use client";

import { useEffect, useRef } from "react";
import { IntentLink } from "@/components/intent-link";
import { Info } from "lucide-react";
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from "@/components/ui/tooltip";
import type { HeroPassportItemViewModel } from "@/lib/stablecoin-detail-passport";
import { alignAnchorAfterHydration, revealAnchorId } from "@/lib/anchor-reveal";
import { FigureLeadText } from "./figure-lead-text";

const ORDERED_KEYS: HeroPassportItemViewModel["key"][] = [
  "mechanism", "redeemability", "minting", "freeze", "record", "chains",
  "jurisdiction", "mica", "genius", "attestor",
];

const PENDING_CATEGORY_LABELS: Record<HeroPassportItemViewModel["key"], HeroPassportItemViewModel["category"]> = {
  mechanism: "Mechanism",
  redeemability: "Redeemability",
  minting: "Minting",
  freeze: "Freeze",
  record: "Record",
  chains: "Chains",
  jurisdiction: "Jurisdiction",
  mica: "MiCA",
  genius: "GENIUS",
  attestor: "Attestor",
};

/**
 * Desktop cell width by cell count. Every fact shares one row while the strip
 * gives each 8.5rem; past that the cells wrap into two rows as even as
 * possible (4 + 3, 4 + 4, 5 + 4), never an orphan stretched across the card.
 * Six cells always fit one row at lg and up.
 */
const DESKTOP_CELL_BASIS: Record<number, string> = {
  7: "basis-1/4 @[59.5rem]:basis-0",
  8: "basis-1/4 @[68rem]:basis-0",
  9: "basis-1/5 @[76.5rem]:basis-0",
};

function alignSection(sectionId: string) {
  // scrollIntoView honors the targets' CSS scroll-margin-top (sticky-chrome
  // clearance) and the page's scroll-behavior, including its reduced-motion
  // override. `revealAnchorId` lands on the visible rail twin when the in-flow
  // owner of the id is display-hidden at xl.
  revealAnchorId(sectionId)?.scrollIntoView({ block: "start" });
}

function PassportItemValue({ item, valueClassName }: { item: HeroPassportItemViewModel; valueClassName: string }) {
  const toneClass = item.valueClass ?? "text-foreground";
  const valueNode = (
    <span className={`${valueClassName} underline-offset-2 group-hover:underline ${toneClass}`}><FigureLeadText text={item.value} /></span>
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
  pendingKeys = [],
  compactDesktop = false,
}: {
  items: HeroPassportItemViewModel[];
  /** Facts whose read is in flight: each keeps its slot, so nothing reflows when it lands. */
  pendingKeys?: readonly HeroPassportItemViewModel["key"][];
  compactDesktop?: boolean;
}) {
  const stopScrollSyncRef = useRef<(() => void) | null>(null);

  useEffect(
    () => () => stopScrollSyncRef.current?.(),
    [],
  );

  if (items.length < 3) return null;

  // Keep the click's CSS-controlled smooth jump, then use the shared bounded
  // correction lifecycle so reader input always takes over navigation.
  function jumpToSection(sectionId: string) {
    stopScrollSyncRef.current?.();
    window.history.pushState(null, "", `#${sectionId}`);
    alignSection(sectionId);
    stopScrollSyncRef.current = alignAnchorAfterHydration(sectionId, false);
  }

  // A fact still being read owns its slot before the read settles. An empty
  // slot makes no evidence claim and never links to an unavailable section; a
  // fact that never resolves (no depeg record for a NAV token) has no slot.
  const resolvedByKey = new Map(items.map((item) => [item.key, item]));
  const slots = ORDERED_KEYS
    .filter((key) => resolvedByKey.has(key) || pendingKeys.includes(key))
    .map((key) => ({ key, item: resolvedByKey.get(key) }));
  const desktopSlots = slots.filter(({ key }) => key !== "mechanism");
  const desktopCellBasis = DESKTOP_CELL_BASIS[desktopSlots.length] ?? "basis-0";

  return (
    <TooltipProvider>
      {/* Docked last in the card, the strip clips to the card's bottom corners. */}
      <div
        className={
          compactDesktop
            ? "relative overflow-hidden border-t border-border/40 px-4 py-2.5 last:rounded-b-xl sm:px-5 lg:px-0 lg:py-0"
            : "relative overflow-hidden border-t border-border/30 px-4 py-2.5 last:rounded-b-xl sm:px-5"
        }
        role="group"
        aria-label="Verification passport"
      >
        {/* Scroll affordance for the mobile row; from lg the facts wrap. */}
        <div
          aria-hidden="true"
          className="pointer-events-none absolute inset-y-0 right-0 z-10 w-8 bg-gradient-to-l from-card to-transparent lg:hidden"
        />
        <div
          className={`scrollbar-none flex snap-x items-start gap-x-6 gap-y-1.5 overflow-x-auto ${
            compactDesktop ? "lg:hidden" : "lg:flex-wrap lg:gap-x-4 lg:overflow-visible"
          }`}
        >
          {slots.map(({ item }) => {
            if (!item) return null;
            const isHashJump = item.href.startsWith("#");
            return withPassportTooltip(
              item,
              <IntentLink
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
                className={`pharos-focus-ring group flex shrink-0 snap-start flex-col justify-center rounded-sm ${compactDesktop ? "min-h-11" : "min-h-11 lg:min-h-0"}`}
              >
                <span className="pharos-label leading-tight">
                  {item.category}
                </span>
                <PassportItemValue
                  item={item}
                  valueClassName="whitespace-nowrap text-xs font-semibold leading-snug"
                />
              </IntentLink>,
            );
          })}
        </div>
        {compactDesktop ? (
          // Wraps instead of scrolling: every fact stays visible at every
          // desktop width. Cells draw right/bottom hairlines and the wrapper
          // clips the outer ones, so a short last row never shows a stray rule.
          <div className="@container hidden overflow-hidden lg:block">
          <div className="-mb-px -mr-px flex flex-wrap">
            {desktopSlots.map(({ key, item }) => {
              if (!item) {
                const pendingLabel = PENDING_CATEGORY_LABELS[key];
                return (
                  <span
                    key={key}
                    aria-hidden="true"
                    data-passport-reserve={key}
                    className={`flex min-h-[4.5rem] grow flex-col justify-center border-b border-r border-border/40 px-4 py-3 ${desktopCellBasis}`}
                  >
                    <span className="pharos-label leading-tight">{pendingLabel}</span>
                    <span className="mt-1.5 block h-3.5 w-20 animate-pulse rounded-sm bg-muted motion-reduce:animate-none" />
                  </span>
                );
              }
              const isHashJump = item.href.startsWith("#");
              return withPassportTooltip(
                item,
                <IntentLink
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
                  className={`pharos-focus-ring group flex min-h-[4.5rem] grow flex-col justify-center border-b border-r border-border/40 px-4 py-3 transition-colors hover:bg-muted/30 ${desktopCellBasis}`}
                >
                  <span className="pharos-label leading-tight">
                    {item.category}
                  </span>
                  <span className="mt-0.5 flex">
                    <PassportItemValue
                      item={item}
                      valueClassName="break-words text-xs font-semibold leading-snug"
                    />
                  </span>
                </IntentLink>,
              );
            })}
          </div>
          </div>
        ) : null}
      </div>
    </TooltipProvider>
  );
}
