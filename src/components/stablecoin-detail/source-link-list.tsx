import { cn } from "@/lib/utils";

export interface SourceLink {
  label: string;
  url: string;
  /** Trailing annotation after the link, e.g. "Supports capacity". */
  note?: string;
}

/**
 * A reviewed-evidence source list: one external link per row behind an
 * external-link glyph, opening in a new tab. Spacing and the accessible list
 * name stay with the caller.
 *
 * Detail pages render 50+ of these rows, so the glyph, link and note styling
 * live in the `.pharos-source-list` descendant rules in `globals.css`; each
 * row stays a bare `<li><a>`.
 */
export function SourceLinkList({
  sources,
  className,
  "aria-label": ariaLabel,
}: {
  sources: readonly SourceLink[];
  className?: string;
  "aria-label"?: string;
}) {
  return (
    <ul aria-label={ariaLabel} className={cn("pharos-source-list", className)}>
      {sources.map((source) => (
        <li key={`${source.label}:${source.url}`}>
          <a href={source.url} target="_blank" rel="noopener noreferrer">
            {source.label}
          </a>
          {source.note ? <span>{source.note}</span> : null}
        </li>
      ))}
    </ul>
  );
}
