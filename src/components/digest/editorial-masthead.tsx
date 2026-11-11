import { cn } from "@/lib/utils";

export interface EditorialMastheadProps {
  /** Publication name. Defaults to "Pharos". */
  publication?: string;
  /** Issue / edition / incident number. Numbers are rendered with a "#" prefix; strings render verbatim. */
  issueNumber?: number | string;
  /** Formatted publication date (e.g. "May 21, 2026"). */
  date?: string;
  /** Editor of record. Defaults to "TokenBrice". */
  editor?: string;
  /** Methodology version label (e.g. "v7.5"). */
  methodologyVersion?: string;
  className?: string;
}

/**
 * Editorial masthead — a single hairline-divided line of running publication
 * chrome. Renders on Digest, Depeg briefings, Changelog, Methodology. Mono,
 * low contrast, no card. The page's signature, not a feature.
 */
export function EditorialMasthead({
  publication = "Pharos",
  issueNumber,
  date,
  editor = "TokenBrice",
  methodologyVersion,
  className,
}: EditorialMastheadProps) {
  const segments: string[] = [];

  if (publication) segments.push(publication);
  if (issueNumber !== undefined && issueNumber !== null && issueNumber !== "") {
    segments.push(
      typeof issueNumber === "number" ? `Issue #${issueNumber}` : String(issueNumber),
    );
  }
  if (date) segments.push(date);
  if (editor) segments.push(`Editor: ${editor}`);
  if (methodologyVersion) segments.push(`Methodology ${methodologyVersion}`);

  if (segments.length === 0) return null;

  return (
    <p
      className={cn(
        "border-b border-border/50 pb-2 font-mono text-[10px] uppercase tracking-[0.14em] text-muted-foreground/80",
        className,
      )}
    >
      {segments.map((segment, i) => (
        <span key={i}>
          {i > 0 && <span aria-hidden className="mx-2 text-muted-foreground/40">·</span>}
          {segment}
        </span>
      ))}
    </p>
  );
}
