import { ExternalLink } from "lucide-react";

export interface SourceLink {
  label: string;
  url: string;
}

/**
 * A reviewed-evidence source list: one external link per row behind an
 * ExternalLink glyph, opening in a new tab. Spacing and the accessible list
 * name stay with the caller.
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
    <ul aria-label={ariaLabel} className={className}>
      {sources.map((source) => (
        <li key={`${source.label}:${source.url}`} className="flex min-w-0 gap-2">
          <ExternalLink className="mt-0.5 h-3 w-3 shrink-0" aria-hidden="true" />
          <a
            href={source.url}
            target="_blank"
            rel="noopener noreferrer"
            className="pharos-focus-ring min-w-0 break-words rounded-sm underline underline-offset-2 transition-colors hover:text-foreground motion-reduce:transition-none"
          >
            {source.label}
          </a>
        </li>
      ))}
    </ul>
  );
}
