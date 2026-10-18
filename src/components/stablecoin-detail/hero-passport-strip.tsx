"use client";

import { useEffect, useRef } from "react";
import { IntentLink } from "@/components/intent-link";
import { Info } from "lucide-react";
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from "@/components/ui/tooltip";
import type { HeroPassportItemViewModel } from "@/lib/stablecoin-detail-passport";
import { alignAnchorAfterHydration, revealAnchorId } from "@/lib/anchor-reveal";
import { FigureLeadText } from "./figure-lead-text";

function alignSection(sectionId: string) {
  // scrollIntoView honors the targets' CSS scroll-margin-top (sticky-chrome
  // clearance) and the page's scroll-behavior, including its reduced-motion
  // override. `revealAnchorId` lands on the visible rail twin when the in-flow
  // owner of the id is display-hidden at xl.
  revealAnchorId(sectionId)?.scrollIntoView({ block: "start" });
}

function PassportItemValue({ item, valueClassName }: { item: HeroPassportItemViewModel; valueClassName: string }) {
  const toneClass = item.valueClass ?? "text-foreground";
  const valueNode = item.chip ? (
    <span
      className={`inline-flex w-fit items-center rounded-full border border-border/60 bg-muted/40 px-2 py-px ${valueClassName} ${toneClass}`}
    >
      <FigureLeadText text={item.value} />
    </span>
  ) : (
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
  compactDesktop = false,
}: {
  items: HeroPassportItemViewModel[];
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

  // Supplemental facts own tracks before their reads settle. Empty tracks make
  // no evidence claim and never become links to unavailable sections.
  const resolvedByKey = new Map(items.map((item) => [item.key, item]));
  const orderedKeys: HeroPassportItemViewModel["key"][] = [
    "mechanism", "redeemability", "minting", "freeze", "record", "chains",
    "jurisdiction", "mica", "genius", "attestor", "issued",
  ];
  const slotKeys = orderedKeys.filter((key) => resolvedByKey.has(key) || key === "redeemability" || key === "minting" || key === "record");
  const slots = compactDesktop ? slotKeys.map((key) => ({ key, item: resolvedByKey.get(key) })) : items.map((item) => ({ key: item.key, item }));
  const desktopSlots = slots.filter(({ item }) => item?.category !== "Mechanism");

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
        {/* Scroll affordance for the two tiers that can run out of room: the
            mobile row, and xl+, where the summary rail narrows the hero enough
            that a dense strip scrolls rather than wrapping off its one row. */}
        <div
          aria-hidden="true"
          className="pointer-events-none absolute inset-y-0 right-0 z-10 w-8 bg-gradient-to-l from-card to-transparent lg:hidden xl:block xl:w-6"
        />
        <div
          className={`scrollbar-none flex snap-x items-start gap-x-6 gap-y-1.5 overflow-x-auto ${
            compactDesktop ? "lg:hidden" : "lg:flex-wrap lg:gap-x-4 lg:overflow-visible"
          }`}
        >
          {slots.map(({ key, item }) => {
            if (!item) return <span key={key} aria-hidden="true" data-passport-reserve={key} className="min-h-16 w-40 shrink-0" />;
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
                className={`pharos-focus-ring group flex shrink-0 snap-start flex-col justify-center rounded-sm ${compactDesktop ? "min-h-16 w-40" : "min-h-11 lg:min-h-0"}`}
              >
                <span className="pharos-label leading-tight">
                  {item.category}
                </span>
                <PassportItemValue
                  item={item}
                  valueClassName={`${compactDesktop ? "break-words" : "whitespace-nowrap"} text-xs font-semibold leading-snug`}
                />
              </IntentLink>,
            );
          })}
        </div>
        {compactDesktop ? (
          <div className="scrollbar-none hidden overflow-x-auto lg:flex">
            {desktopSlots.map(({ key, item }) => {
              if (!item) return <span key={key} aria-hidden="true" data-passport-reserve={key} className="min-h-20 w-40 shrink-0 border-r border-border/40" />;
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
                  className="pharos-focus-ring group flex min-h-20 w-40 shrink-0 flex-col justify-center border-r border-border/40 px-4 py-3 last:border-r-0"
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
        ) : null}
      </div>
    </TooltipProvider>
  );
}
