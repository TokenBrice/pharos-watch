import Link from "next/link";
import { ArrowUpRight } from "lucide-react";
import { cn } from "@/lib/utils";

export interface SeeAlsoLink {
  href: string;
  label: string;
  description?: string;
}

interface SeeAlsoFooterProps {
  links: ReadonlyArray<SeeAlsoLink>;
  className?: string;
}

/**
 * Hatnote-style "See also" block rendered at the bottom of long-form pages.
 * Caps at 4 links per the IA council's discoverability rule; extra entries
 * are silently dropped to keep the footer scannable.
 */
export function SeeAlsoFooter({ links, className }: SeeAlsoFooterProps) {
  if (links.length === 0) return null;
  const capped = links.slice(0, 4);

  return (
    <aside
      aria-label="See also"
      className={cn(
        "mt-10 border-t border-border/60 pt-6",
        className,
      )}
    >
      <p className="pharos-kicker text-muted-foreground">See also</p>
      <ul className="mt-3 grid gap-3 sm:grid-cols-2">
        {capped.map((link) => (
          <li key={link.href}>
            <Link
              href={link.href}
              className="pharos-focus-ring group flex items-start gap-2 rounded-lg border border-border/50 bg-card/55 px-3 py-2.5 transition-colors hover:border-border hover:bg-card/80"
            >
              <span className="flex min-w-0 flex-1 flex-col gap-0.5">
                <span className="text-sm font-medium text-foreground">
                  {link.label}
                </span>
                {link.description ? (
                  <span className="text-xs leading-snug text-muted-foreground">
                    {link.description}
                  </span>
                ) : null}
              </span>
              <ArrowUpRight
                className="mt-0.5 h-3.5 w-3.5 shrink-0 text-muted-foreground/70 transition-colors group-hover:text-foreground"
                aria-hidden="true"
              />
            </Link>
          </li>
        ))}
      </ul>
    </aside>
  );
}
