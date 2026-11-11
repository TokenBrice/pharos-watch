import { cn } from "@/lib/utils";

export interface EditorialColophonCitation {
  title: string;
  canonicalUrl: string;
  /** Optional access date for the citation snippet (e.g. "2026-05-21"). */
  accessedDate?: string;
}

export interface EditorialColophonProps {
  /** One-line production note describing how the page was assembled. */
  productionNote: string;
  /** Methodology version label (e.g. "v7.5"). */
  methodologyVersion?: string;
  /** Citation block. Renders the formatted citation plus a `<code>` URL. */
  citation?: EditorialColophonCitation;
  className?: string;
}

/**
 * Editorial colophon — closes a publication-shaped page with production
 * provenance and a citation snippet. Hairline border-top, muted body tone,
 * no card chrome. Mirrors the masthead's restraint.
 */
export function EditorialColophon({
  productionNote,
  methodologyVersion,
  citation,
  className,
}: EditorialColophonProps) {
  const citationLine = citation
    ? `Pharos, "${citation.title}," ${citation.canonicalUrl}${
        citation.accessedDate ? `, accessed ${citation.accessedDate}` : ""
      }`
    : null;

  return (
    <footer
      className={cn(
        "mt-8 space-y-3 border-t border-border/50 pt-5 text-[13px] leading-relaxed text-muted-foreground",
        className,
      )}
    >
      <p className="max-w-[68ch]">{productionNote}</p>

      {methodologyVersion && (
        <p className="font-mono text-[11px] uppercase tracking-[0.12em] text-muted-foreground/80">
          Methodology {methodologyVersion}
        </p>
      )}

      {citation && citationLine && (
        <div className="space-y-1.5">
          <p className="font-mono text-[11px] uppercase tracking-[0.12em] text-muted-foreground/80">
            How to cite this page
          </p>
          <p className="max-w-[68ch] text-[13px]">{citationLine}</p>
          <code className="block max-w-[68ch] overflow-x-auto rounded-md border border-border/50 bg-card/40 px-2.5 py-1.5 font-mono text-[12px] text-foreground/80">
            {citation.canonicalUrl}
          </code>
        </div>
      )}
    </footer>
  );
}
