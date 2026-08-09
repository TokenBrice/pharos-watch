import type React from "react";
import Link from "next/link";

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
 * hrefs resolve through Next's `Link`; everything else opens in a new tab with
 * `noopener noreferrer`. Both forms carry `.pharos-prose-link`.
 */
export function markdownLinkComponent({ resolveHref, httpOnly = false }: MarkdownLinkOptions = {}) {
  return function MarkdownLink({ href, children }: React.ComponentProps<"a">) {
    const resolved = resolveHref ? resolveHref(href) : href;
    if (!resolved) return <span>{children}</span>;
    if (resolved.startsWith("/")) {
      return (
        <Link href={resolved} className="pharos-prose-link">
          {children}
        </Link>
      );
    }
    if (httpOnly && !resolved.startsWith("http://") && !resolved.startsWith("https://")) {
      return <span>{children}</span>;
    }
    return (
      <a href={resolved} target="_blank" rel="noopener noreferrer" className="pharos-prose-link">
        {children}
      </a>
    );
  };
}
