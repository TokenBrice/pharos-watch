import Link from "next/link";
import type { ReactNode } from "react";
import { cn } from "@/lib/utils";

export interface FactGridItem {
  key: string;
  label: string;
  value: ReactNode;
  /** Tone override for the value, e.g. a severity text class. */
  valueClassName?: string;
  /** Optional proof link — same-page anchor, internal route, or external URL. */
  href?: string;
  title?: string;
}

const LABEL_CLASS = "text-[10px] font-medium uppercase leading-tight tracking-[0.14em] text-muted-foreground";
const VALUE_CLASS = "font-mono text-[11px] font-semibold uppercase leading-snug tracking-wide";

function FactValue({ item }: { item: FactGridItem }) {
  return (
    <>
      <span className={LABEL_CLASS}>{item.label}</span>
      <span className={cn("mt-0.5", VALUE_CLASS, item.valueClassName ?? "text-foreground")}>{item.value}</span>
    </>
  );
}

/**
 * The hero passport grammar (field name in small tracked caps above, entry in
 * mono below) extracted for module summary layers. Values come from bounded
 * authored vocabularies or formatted figures — never CSS-truncated prose.
 *
 * Two tracks, not the old `sm:grid-cols-3`. A fixed three left every 4-item
 * set as a 3+1 orphan row (Bridging's `THIRD-PARTY`, Reserve quality's
 * `SLICES`/`CONFIDENCE`) and squeezed the 22rem rail hard enough that
 * Custody's `REHYPOTHECATION` label clipped at the card edge. Two columns
 * wrap 4 items as 2×2 and leave every label room to render in full.
 *
 * Deliberately a static `grid-cols-2` and not
 * `grid-cols-[repeat(auto-fit,minmax(8rem,1fr))]`: that arbitrary value does
 * not survive this project's Tailwind build (verified absent from the
 * generated CSS while sibling `grid-cols-[...]` classes are present), so the
 * element silently loses `grid-template-columns` and collapses to one column.
 * Cards that genuinely fit three tracks pass `grid-cols-3` explicitly.
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

  return (
    <div
      role="group"
      aria-label={ariaLabel}
      className={cn("grid grid-cols-2 gap-x-4 gap-y-3", className)}
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
  );
}
