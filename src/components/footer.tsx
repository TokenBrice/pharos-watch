import Link from "next/link";
import { Rss, SquareArrowOutUpRight } from "lucide-react";

const SOCIAL_LINK_CLASS =
  "pharos-focus-ring grid h-6 w-6 place-items-center rounded-[5px] border border-border/60 bg-muted/35 text-muted-foreground transition-colors hover:border-border hover:bg-muted/55 hover:text-foreground";

// Compact footer chips matching the small square Figma controls.
const PILL_CLASS =
  "pharos-focus-ring inline-flex h-8 items-center gap-1 rounded-[5px] border border-border/65 bg-muted/55 px-2 text-[11px] leading-none text-muted-foreground transition-colors hover:border-border hover:bg-muted/75 hover:text-foreground";

// Lean footer per the Figma redesign: a disclaimer line, three reference links,
// a compact about/legal row, and the monochrome social cluster. The previous
// 15-link nav, RSS feed list, and category browse were retired with the redesign
// (owner: "match Figma exactly", 2026-06-27) — restore from git if reinstating.
const FOOTER_NAV: ReadonlyArray<{ href: string; label: string }> = [
  { href: "/blog/", label: "Blog" },
  { href: "/changelog/", label: "Changelog" },
  { href: "/methodology/", label: "Methodology" },
  { href: "/api/", label: "API" },
  { href: "/sitemap-tree/", label: "Sitemap" },
];

const FOOTER_META: ReadonlyArray<{ href: string; label: string; external?: boolean }> = [
  { href: "/about/", label: "Independent" },
  { href: "/funding/", label: "Funding" },
  { href: "https://github.com/TokenBrice/pharos-watch", label: "MIT", external: true },
  { href: "/privacy/", label: "Privacy Policy" },
];

export function Footer() {
  return (
    <footer className="border-t border-border/70 py-1 sm:py-2">
      <div className="mx-auto w-full max-w-[120rem] space-y-1 px-4 pb-[var(--mobile-utility-safe-offset,0px)] sm:pb-0 lg:px-5 xl:px-9">
        <div className="flex flex-col gap-2 sm:flex-row sm:items-start sm:justify-between sm:gap-4">
          <p className="min-w-0 flex-1 text-[11px] leading-snug text-muted-foreground sm:text-xs lg:whitespace-nowrap">
            Pharos tracks stablecoin cap, peg stability, liquidity, and dependency risk. Not financial advice.
          </p>
          <nav
            aria-label="Reference"
            className="flex flex-wrap items-center gap-1 text-muted-foreground sm:shrink-0 sm:justify-end sm:gap-1.5 lg:flex-nowrap"
          >
            {FOOTER_NAV.map((link) => (
              <Link key={link.href} href={link.href} className={PILL_CLASS}>
                {link.label}
              </Link>
            ))}
          </nav>
        </div>

        <div className="flex flex-col gap-1 sm:flex-row sm:items-center sm:justify-between">
          <nav
            aria-label="About"
            className="flex flex-wrap items-center gap-1 text-muted-foreground sm:gap-1.5 lg:flex-nowrap"
          >
            {FOOTER_META.map((link) =>
              link.external ? (
                <a key={link.href} href={link.href} target="_blank" rel="noopener noreferrer" className={PILL_CLASS}>
                  {link.label}
                  <SquareArrowOutUpRight aria-hidden="true" className="h-3 w-3" strokeWidth={2} />
                </a>
              ) : (
                <Link key={link.href} href={link.href} className={PILL_CLASS}>
                  {link.label}
                </Link>
              ),
            )}
          </nav>

          <div className="flex items-center gap-1 text-muted-foreground" aria-label="Social links">
            <a href="/feed/digest.xml" className={SOCIAL_LINK_CLASS} aria-label="Pharos digest RSS feed">
              <Rss aria-hidden="true" className="h-3 w-3" strokeWidth={2} />
            </a>
            <a
              href="https://x.com/PharosWatch"
              target="_blank"
              rel="noopener noreferrer"
              className={SOCIAL_LINK_CLASS}
              aria-label="Pharos on X/Twitter"
            >
              <svg className="h-3 w-3" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true">
                <path d="M18.244 2.25h3.308l-7.227 8.26 8.502 11.24H16.17l-5.214-6.817L4.99 21.75H1.68l7.73-8.835L1.254 2.25H8.08l4.713 6.231zm-1.161 17.52h1.833L7.084 4.126H5.117z" />
              </svg>
            </a>
            <a
              href="https://t.me/pharoswatch"
              target="_blank"
              rel="noopener noreferrer"
              className={SOCIAL_LINK_CLASS}
              aria-label="Pharos on Telegram"
            >
              <svg className="h-3 w-3" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true">
                <path d="M11.944 0A12 12 0 0 0 0 12a12 12 0 0 0 12 12 12 12 0 0 0 12-12A12 12 0 0 0 12 0a12 12 0 0 0-.056 0zm4.962 7.224c.1-.002.321.023.465.14a.506.506 0 0 1 .171.325c.016.093.036.306.02.472-.18 1.898-.962 6.502-1.36 8.627-.168.9-.499 1.201-.820 1.23-.696.065-1.225-.46-1.9-.902-1.056-.693-1.653-1.124-2.678-1.8-1.185-.78-.417-1.21.258-1.91.177-.184 3.247-2.977 3.307-3.23.007-.032.014-.15-.056-.212s-.174-.041-.249-.024c-.106.024-1.793 1.14-5.061 3.345-.48.33-.913.49-1.302.48-.428-.008-1.252-.241-1.865-.44-.752-.245-1.349-.374-1.297-.789.027-.216.325-.437.893-.663 3.498-1.524 5.83-2.529 6.998-3.014 3.332-1.386 4.025-1.627 4.476-1.635z" />
              </svg>
            </a>
            <a
              href="https://github.com/TokenBrice/pharos-watch"
              target="_blank"
              rel="noopener noreferrer"
              className={SOCIAL_LINK_CLASS}
              aria-label="Pharos on GitHub"
            >
              <svg className="h-3 w-3" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true">
                <path d="M12 .297c-6.63 0-12 5.373-12 12 0 5.303 3.438 9.8 8.205 11.385.6.113.82-.258.82-.577 0-.285-.01-1.04-.015-2.04-3.338.724-4.042-1.61-4.042-1.61C4.422 18.07 3.633 17.7 3.633 17.7c-1.087-.744.084-.729.084-.729 1.205.084 1.838 1.236 1.838 1.236 1.07 1.835 2.809 1.305 3.495.998.108-.776.417-1.305.76-1.605-2.665-.3-5.466-1.332-5.466-5.93 0-1.31.465-2.38 1.235-3.22-.135-.303-.54-1.523.105-3.176 0 0 1.005-.322 3.3 1.23.96-.267 1.98-.399 3-.405 1.02.006 2.04.138 3 .405 2.28-1.552 3.285-1.23 3.285-1.23.645 1.653.24 2.873.12 3.176.765.84 1.23 1.91 1.23 3.22 0 4.61-2.805 5.625-5.475 5.92.42.36.81 1.096.81 2.22 0 1.606-.015 2.896-.015 3.286 0 .315.21.69.825.57C20.565 22.092 24 17.592 24 12.297c0-6.627-5.373-12-12-12" />
              </svg>
            </a>
          </div>
        </div>
      </div>
    </footer>
  );
}
