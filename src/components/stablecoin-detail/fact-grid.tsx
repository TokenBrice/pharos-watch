import Link from "next/link";
import type { ReactNode } from "react";
import { cn } from "@/lib/utils";

/**
 * - `figure`: mono uppercase, for figures and one-word enums (`12.4%`, `2 of 3`, `Omnibus`).
 * - `text`: sentence case in the UI sans, for anything that reads as words.
 */
export type FactValueStyle = "figure" | "text";

export interface FactGridItem {
  key: string;
  label: string;
  value: ReactNode;
  /** Tone override for the value, e.g. a severity text class. */
  valueClassName?: string;
  /** Overrides the value style resolved by `resolveFactValueStyle`. */
  valueStyle?: FactValueStyle;
  /** Optional proof link — same-page anchor, internal route, or external URL. */
  href?: string;
  title?: string;
}

const LABEL_CLASS = "text-[11px] font-medium uppercase leading-tight tracking-[0.12em] text-muted-foreground";
const VALUE_CLASS: Record<FactValueStyle, string> = {
  figure: "font-mono text-[11px] font-semibold uppercase leading-snug tracking-wide",
  text: "text-xs font-medium leading-snug",
};

/** Wide-form track count by item count; one and two items keep the narrow two tracks. */
const WIDE_COLUMNS_CLASS: Record<2 | 3 | 4, string> = {
  2: "",
  3: "@[35rem]/facts:grid-cols-3",
  4: "@[35rem]/facts:grid-cols-4",
};

/** A token with no digit and at most three letters reads as a unit (`bps`, `d`, `of`, `/`). */
const UNIT_TOKEN = /^[^\p{L}\d]*\p{L}{0,3}[^\p{L}\d]*$/u;

/**
 * Mono uppercase is reserved for figures (design rule 8): a number, a one-word
 * enum, or a short digit-bearing string whose other words are units
 * (`$662k of $25m`, `1.0 d`, `Tier 2`). Anything else that reads as words
 * ("Asset-referenced token", "Pathway unresolved", "Sourced review") renders
 * sentence case — mono capitals make prose shout and hide word shapes.
 * Non-text nodes keep the figure style; callers pass `valueStyle` to override.
 */
export function resolveFactValueStyle(value: ReactNode): FactValueStyle {
  if (typeof value !== "string") return "figure";
  const tokens = value.trim().split(/\s+/);
  if (tokens.length <= 1) return "figure";
  if (!/\d/.test(value)) return "text";
  return tokens.length <= 2 || tokens.every((token) => /\d/.test(token) || UNIT_TOKEN.test(token))
    ? "figure"
    : "text";
}

function FactValue({ item }: { item: FactGridItem }) {
  const style = item.valueStyle ?? resolveFactValueStyle(item.value);
  return (
    <>
      <span className={LABEL_CLASS}>{item.label}</span>
      <span className={cn("mt-0.5", VALUE_CLASS[style], item.valueClassName ?? "text-foreground")}>{item.value}</span>
    </>
  );
}

/**
 * The hero passport grammar (field name in small tracked caps above, entry
 * below) extracted for module summary layers. Values come from bounded
 * authored vocabularies or formatted figures — never CSS-truncated prose.
 *
 * Two tracks by default, not the old `sm:grid-cols-3`. A fixed three left
 * every 4-item set as a 3+1 orphan row (Bridging's `THIRD-PARTY`, Reserve
 * quality's `SLICES`/`CONFIDENCE`) and squeezed the 22rem rail hard enough
 * that Custody's `REHYPOTHECATION` label clipped at the card edge. Two
 * columns wrap 4 items as 2×2 and leave every label room to render in full.
 *
 * Wide form: the grid queries its own wrapper (`@container/facts`), so once it
 * has ≥ 35rem (560 px) of width — a full-width module or a strip, never the
 * rail or a ~480 px tile — up to four facts share one row instead of
 * stranding the second column at 50 % of a 992–1472 px module.
 *
 * Deliberately static track classes and not
 * `grid-cols-[repeat(auto-fit,minmax(8rem,1fr))]`: that arbitrary value does
 * not survive this project's Tailwind build (verified absent from the
 * generated CSS while sibling `grid-cols-[...]` classes are present), so the
 * element silently loses `grid-template-columns` and collapses to one column.
 *
 * `className` lands on the outer wrapper (spacing, visibility such as
 * `sm:hidden`). Track tokens (`grid-cols-*`, any variant) are forwarded to the
 * grid itself, so a card that genuinely fits three narrow tracks still passes
 * `grid-cols-3`.
 */
export function FactGrid({
  items,
  className,
  "aria-label": ariaLabel,
}: {
  items: readonly FactGridItem[];
  className?: string;
  "aria-label"?: string;
}) {
  if (items.length === 0) return null;

  const trackClasses: string[] = [];
  const wrapperClasses: string[] = [];
  for (const token of className?.split(/\s+/) ?? []) {
    if (token) (/(?:^|:)grid-cols-/.test(token) ? trackClasses : wrapperClasses).push(token);
  }
  const wideColumns = Math.min(Math.max(items.length, 2), 4) as 2 | 3 | 4;

  return (
    <div className={cn("@container/facts w-full min-w-0", wrapperClasses)}>
      <div
        role="group"
        aria-label={ariaLabel}
        className={cn("grid grid-cols-2 gap-x-4 gap-y-3", WIDE_COLUMNS_CLASS[wideColumns], trackClasses)}
      >
        {items.map((item) => {
          const isExternal = item.href?.startsWith("http");
          const cellClass = "flex min-w-0 flex-col";
          if (!item.href) {
            return (
              <div key={item.key} title={item.title} className={cellClass}>
                <FactValue item={item} />
              </div>
            );
          }
          const linkClass = cn(cellClass, "pharos-focus-ring group rounded-sm [&>span:last-child]:group-hover:underline");
          return isExternal ? (
            <a
              key={item.key}
              href={item.href}
              target="_blank"
              rel="noopener noreferrer"
              title={item.title}
              className={linkClass}
            >
              <FactValue item={item} />
            </a>
          ) : (
            <Link key={item.key} href={item.href} title={item.title} className={linkClass}>
              <FactValue item={item} />
            </Link>
          );
        })}
      </div>
    </div>
  );
}
