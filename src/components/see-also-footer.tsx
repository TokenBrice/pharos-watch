"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { ChevronRight } from "lucide-react";
import { getSeeAlsoLinks } from "@/lib/see-also-graph";
import { cn } from "@/lib/utils";

export interface SeeAlsoLink {
  href: string;
  label: string;
  description?: string;
}

interface SeeAlsoFooterProps {
  links?: ReadonlyArray<SeeAlsoLink>;
  /** Optional route key resolved against `SEE_ALSO_GRAPH` when `links` is omitted. */
  route?: string;
  className?: string;
}

/** Routes that already render `<SeeAlsoFooter>` inside their own `<main>` layout. */
const ROUTE_OWNED_SEE_ALSO_PATHS = new Set(["/coverage/"]);

/**
 * Hatnote-style "See also" block rendered at the bottom of long-form and hub pages.
 * Caps at 4 links per the IA council's discoverability rule; extra entries
 * are silently dropped to keep the footer scannable.
 */
export function SeeAlsoFooter({ links, route, className }: SeeAlsoFooterProps) {
  const resolved = links ?? (route ? getSeeAlsoLinks(route) : []);
  if (resolved.length === 0) return null;
  const capped = resolved.slice(0, 4);

  return (
    <aside
      aria-label="See also"
      className={cn(
        "mt-10 border-t border-border/60 pt-6",
        className,
      )}
    >
      <p className="pharos-label">See also</p>
      <ul className="mt-3 grid gap-3 sm:grid-cols-2">
        {capped.map((link) => (
          <li key={link.href}>
            <Link
              href={link.href}
              prefetch={false}
              className="pharos-focus-ring group flex items-start gap-2 rounded-lg border border-border/50 bg-background/55 px-3 py-2.5 transition-colors hover:border-border hover:bg-muted/40"
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
              <ChevronRight
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

/**
 * Route-aware discovery footer mounted beside the global site footer so every
 * curated risk/analytics hub gets cross-hub links without duplicating pages
 * that render `<SeeAlsoFooter>` inline.
 */
export function RouteSeeAlsoFooter() {
  const pathname = usePathname();
  if (!pathname) return null;
  const normalized = pathname === "/" ? "/" : `${pathname.replace(/\/+$/, "")}/`;
  if (ROUTE_OWNED_SEE_ALSO_PATHS.has(normalized)) return null;
  const links = getSeeAlsoLinks(normalized);
  if (links.length === 0) return null;

  return (
    <div className="mx-auto w-full max-w-[120rem] px-4 pb-8 lg:px-5 xl:px-9">
      <SeeAlsoFooter links={links} className="mt-0" />
    </div>
  );
}
