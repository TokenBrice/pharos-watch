import Link from "next/link";
import type { LaunchNewsItem, UpcomingCurrencyGroup } from "@/lib/upcoming-static-content";

const LINK_CLASS = "pharos-focus-ring rounded-sm font-medium text-foreground underline-offset-2 hover:underline";

/** Server-rendered `/upcoming/` body sections: crawlable, dated, and identical before and after hydration. */
export function UpcomingStaticSections({
  news,
  groups,
}: {
  news: readonly LaunchNewsItem[];
  groups: readonly UpcomingCurrencyGroup[];
}) {
  return (
    <>
      {news.length > 0 ? (
        <section aria-labelledby="latest-launch-news" className="space-y-3">
          <div className="space-y-1.5">
            <h2 id="latest-launch-news" className="pharos-label">Latest launch news</h2>
            <p className="text-sm text-muted-foreground">
              The {news.length} newest milestones logged across pre-launch profiles, from their cited sources.
            </p>
          </div>
          <ol className="pharos-card-shell gap-0 divide-y divide-border/50 py-0">
            {news.map((item) => (
              <li key={item.key} className="px-4 py-2.5 text-sm sm:px-5">
                <time dateTime={item.date} className="pharos-numeric text-xs text-muted-foreground">
                  {item.dateLabel}
                </time>
                <span aria-hidden="true" className="text-muted-foreground"> · </span>
                <Link href={item.href} className={LINK_CLASS}>
                  {`${item.symbol}: ${item.title}`}
                </Link>
              </li>
            ))}
          </ol>
        </section>
      ) : null}

      <section aria-label="Upcoming stablecoins by currency" className="space-y-4">
        {groups.map((group) => (
          <div key={group.peg} className="space-y-2">
            <h2 className="text-base font-semibold text-foreground">{group.heading}</h2>
            <ul className="flex flex-wrap gap-2">
              {group.coins.map((coin) => (
                <li key={coin.id}>
                  <Link
                    href={coin.href}
                    className="pharos-focus-ring inline-flex items-center rounded-full border border-border/60 bg-background px-2.5 py-1 text-xs font-medium transition-colors hover:bg-accent"
                  >
                    {coin.name} ({coin.symbol})
                  </Link>
                </li>
              ))}
              {group.hubHref ? (
                <li>
                  <Link
                    href={group.hubHref}
                    className="pharos-focus-ring inline-flex items-center rounded-full px-2.5 py-1 text-xs text-muted-foreground transition-colors hover:text-foreground"
                  >
                    {group.hubLabel}
                    <span aria-hidden="true">&nbsp;→</span>
                  </Link>
                </li>
              ) : null}
            </ul>
          </div>
        ))}
      </section>
    </>
  );
}
