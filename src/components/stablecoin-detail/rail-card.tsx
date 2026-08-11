import type { ReactNode } from "react";
import type { LucideIcon } from "lucide-react";
import { cn } from "@/lib/utils";
import { DETAIL_MODULE_TITLE_CLASS } from "@/components/stablecoin-detail/section-title-class";

/**
 * The rail-module shell: the card surface plus the one header row every detail
 * module already draws — title on the left, an optional stamp, badge or muted
 * glyph on the right. Extracted from eleven byte-identical copies so the header
 * grammar cannot drift module by module.
 *
 * The body is passed through verbatim: modules keep owning their own padding
 * because several split into `border-t border-border/50 px-4 py-4` bands rather
 * than one padded block.
 */
export function RailCard({
  title,
  titleAdornment,
  ariaLabel,
  icon: Icon,
  trailing,
  frameless = false,
  children,
}: {
  title: string;
  /**
   * Rendered immediately after the title — the home for counts (`RailCount`).
   * Counts are a property of the thing named, not a status, so they sit with
   * the name rather than competing for the `trailing` slot.
   */
  titleAdornment?: ReactNode;
  /** Accessible name for the section landmark, e.g. "Backing mechanics". */
  ariaLabel: string;
  /** Optional muted glyph rendered before the title. */
  icon?: LucideIcon;
  /**
   * Right-aligned header slot: **status only** (owner ruling 2026-08-11).
   *
   * Not freshness, not counts, not a toggle. A reviewed date or a live stamp
   * belongs in the module footer (`EvidenceFooter`'s own `trailing`); a count
   * belongs in `titleAdornment`. Before this rule the corner carried nine
   * different things and changed meaning between coins on the same card, so a
   * reader could never learn what it meant.
   */
  trailing?: ReactNode;
  /**
   * Body-only render for mounting inside a `RailCopyFold` band, which already
   * owns the card shell, the title, and the status chip — a second header
   * inside the fold would duplicate all three.
   */
  frameless?: boolean;
  children: ReactNode;
}) {
  if (frameless) return <>{children}</>;
  return (
    <section className="pharos-card-shell overflow-hidden" aria-label={ariaLabel}>
      <div className="flex items-center justify-between gap-3 px-4 py-3.5">
        <div className="flex min-w-0 items-center gap-2">
          {Icon ? <Icon className="h-3.5 w-3.5 shrink-0 text-muted-foreground" aria-hidden="true" /> : null}
          <h2 className={DETAIL_MODULE_TITLE_CLASS}>{title}</h2>
          {titleAdornment}
        </div>
        {trailing}
      </div>
      {children}
    </section>
  );
}

const RAIL_STAMP_CLASS =
  "inline-flex h-6 items-center rounded-full bg-muted/70 px-2 font-mono text-xs font-medium text-muted-foreground";

/**
 * The header stamp chip — the muted mono pill that carries a review date, a
 * count, or a live-freshness label. Prefer `ReviewedStamp` for dated reviews;
 * use this directly for counts and icon-prefixed labels (`gap-1.5`).
 */
export function RailStamp({ className, children }: { className?: string; children: ReactNode }) {
  return <span className={cn(RAIL_STAMP_CLASS, className)}>{children}</span>;
}

/** `Reviewed 2026-07-15` in the header stamp chip — one spelling for every module. */
export function ReviewedStamp({ date }: { date: string }) {
  return <RailStamp>{`Reviewed ${date}`}</RailStamp>;
}

/**
 * A row count rendered beside its module title (`titleAdornment`). Muted and
 * unboxed so it reads as part of the name rather than as a status chip — the
 * `trailing` slot is reserved for status.
 */
export function RailCount({ children }: { children: ReactNode }) {
  return <span className="pharos-numeric shrink-0 text-xs text-muted-foreground">{children}</span>;
}
