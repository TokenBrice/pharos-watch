import { digestDisplay } from "@/lib/fonts/digest";
import { cn } from "@/lib/utils";

export interface DigestNameplateProps {
  /** Latest daily edition number, rendered as the issue line. */
  issueNumber?: number;
  /** Latest daily digest date string ("YYYY-MM-DD"). */
  date?: string;
  /** Author/model credit from the digest record; falls back to a generic AI credit. */
  author?: string;
  className?: string;
}

// NOT a clone of @shared/lib/format `formatYearMonth`: this renders a FULL date
// (weekday + month + day + year) from a YYYY-MM-DD string, not a "Month YYYY"
// label. Do not fold into formatYearMonth — it would drop the weekday and day.
function formatNameplateDate(dateStr?: string): string | null {
  if (!dateStr) return null;
  const parts = dateStr.replace(/-weekly$/, "").split("-").map(Number);
  if (parts.length !== 3 || parts.some(Number.isNaN)) return null;
  const [year, month, day] = parts;
  const date = new Date(year, month - 1, day);
  if (Number.isNaN(date.getTime())) return null;
  return date.toLocaleDateString("en-US", {
    weekday: "long",
    month: "long",
    day: "numeric",
    year: "numeric",
  });
}

/**
 * Front-page nameplate for the Daily Digest Archive — the section's masthead.
 * Hairline-flanked eyebrow, oversized editorial-serif wordmark, and a ruled
 * dateline strip (thick rule above, hairline below) in the broadsheet idiom.
 * The visible wordmark carries the page <h1>; the descriptive continuation is
 * screen-reader-only so the accessible name stays specific.
 */
export function DigestNameplate({ issueNumber, date, author, className }: DigestNameplateProps) {
  const dateLabel = formatNameplateDate(date);
  const dateline = [
    issueNumber ? `Issue #${issueNumber}` : null,
    dateLabel,
    `Written by ${author ?? "AI"}`,
  ].filter(Boolean) as string[];

  return (
    <header className={cn("text-center", className)}>
      <div className="flex items-center justify-center gap-4">
        <span aria-hidden className="hidden h-px w-12 bg-border sm:block" />
        <p className="font-mono text-[10px] uppercase tracking-[0.3em] text-muted-foreground sm:text-[11px]">
          Daily &amp; Weekly &middot; Stablecoin Intelligence
        </p>
        <span aria-hidden className="hidden h-px w-12 bg-border sm:block" />
      </div>

      <h1
        className={cn(
          digestDisplay.className,
          "mt-4 text-[clamp(2.4rem,9vw,5.25rem)] font-semibold leading-[0.9] tracking-[-0.03em] text-foreground [text-wrap:balance]",
        )}
      >
        Pharos Digest
        <span className="sr-only"> &mdash; daily and weekly stablecoin recap archive</span>
      </h1>

      {dateline.length > 0 && (
        <div className="mt-5 border-t-2 border-foreground/70">
          <p className="flex flex-wrap items-center justify-center gap-x-2.5 gap-y-1 border-b border-border py-2 font-mono text-[10px] uppercase tracking-[0.2em] text-muted-foreground sm:text-[11px]">
            {dateline.map((segment, i) => (
              <span key={segment} className="inline-flex items-center gap-2.5">
                {i > 0 && (
                  <span aria-hidden className="text-muted-foreground/40">
                    &middot;
                  </span>
                )}
                {segment}
              </span>
            ))}
          </p>
        </div>
      )}
    </header>
  );
}
