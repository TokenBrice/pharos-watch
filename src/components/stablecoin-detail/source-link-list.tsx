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
 *
 * `numbered` renders an `<ol>` whose rows show their 1-based position in place
 * of the glyph, for a module whose body cites its sources by number. The
 * number is a CSS counter: the `<ol>` already conveys order to assistive
 * technology, so the visible digit is not announced twice.
 */
export function SourceLinkList({
  sources,
  numbered = false,
  className,
  "aria-label": ariaLabel,
}: {
  sources: readonly SourceLink[];
  numbered?: boolean;
  className?: string;
  "aria-label"?: string;
}) {
  const List = numbered ? "ol" : "ul";
  return (
    <List aria-label={ariaLabel} className={cn("pharos-source-list", numbered && "pharos-source-list-numbered", className)}>
      {sources.map((source) => (
        <li key={`${source.label}:${source.url}`}>
          <a href={source.url} target="_blank" rel="noopener noreferrer">
            {source.label}
          </a>
          {source.note ? <span>{source.note}</span> : null}
        </li>
      ))}
    </List>
  );
}
