import type React from "react";
import Link from "next/link";
import { cn } from "@/lib/utils";

interface MarkdownLinkOptions {
  /**
   * Rewrites the authored href before rendering (e.g. `resolvePublicDocHref`
   * mapping repo-relative doc paths onto public routes). Returning a falsy
   * value renders the link text without an anchor.
   */
  resolveHref?: (href: string | undefined) => string | null | undefined;
  /**
   * Render hrefs that are neither site-relative nor `http(s):` as inert text.
   * Used where the Markdown source is machine-assembled rather than authored.
   */
  httpOnly?: boolean;
}

/**
 * `react-markdown` `a` renderer shared by the Markdown surfaces. Site-relative
 * hrefs resolve through Next's `Link`; same-page `#fragment` links stay in the
 * current tab; everything else opens in a new tab with `noopener noreferrer`.
 * All forms carry `.pharos-prose-link`.
 */
export function markdownLinkComponent({ resolveHref, httpOnly = false }: MarkdownLinkOptions = {}) {
  return function MarkdownLink({ href, className, children }: React.ComponentProps<"a">) {
    const resolved = resolveHref ? resolveHref(href) : href;
    if (!resolved) return <span>{children}</span>;
    if (resolved.startsWith("/")) {
      return (
        <Link href={resolved} className={cn("pharos-prose-link", className)}>
          {children}
        </Link>
      );
    }
    if (resolved.startsWith("#")) {
      return (
        <a href={resolved} className={cn("pharos-prose-link", className)}>
          {children}
        </a>
      );
    }
    if (httpOnly && !resolved.startsWith("http://") && !resolved.startsWith("https://")) {
      return <span>{children}</span>;
    }
    return (
      <a href={resolved} target="_blank" rel="noopener noreferrer" className={cn("pharos-prose-link", className)}>
        {children}
      </a>
    );
  };
}
