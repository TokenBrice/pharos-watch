import Link from "next/link";
import { LaunchPhaseBadge } from "@/components/pre-launch-badge";
import type { LaunchedUntrackedRow, LaunchNewsItem, UpcomingCurrencyGroup } from "@/lib/upcoming-static-content";

const LINK_CLASS = "pharos-focus-ring rounded-sm font-medium text-foreground underline-offset-2 hover:underline";

/**
 * "Launched – not yet tracked": live coins with no admitted price or supply
 * lane. Server-rendered and clock-free; a separate count, never "upcoming".
 */
export function UpcomingLaunchedSection({ rows }: { rows: readonly LaunchedUntrackedRow[] }) {
  if (rows.length === 0) return null;
  return (
    <section aria-labelledby="launched-not-tracked" className="space-y-3">
      <div className="space-y-1.5">
        <h2 id="launched-not-tracked" className="pharos-label">
          Launched – not yet tracked (<span className="pharos-numeric">{rows.length}</span>)
        </h2>
        <p className="text-sm text-muted-foreground">
          Publicly issued on-chain, but Pharos has not yet admitted a price and supply source. Their figures are
          unavailable, not zero, until it does.
        </p>
      </div>
      <ul className="pharos-card-shell gap-0 divide-y divide-border/50 py-0">
        {rows.map((row) => (
          <li key={row.id} className="space-y-1 px-4 py-3 text-sm sm:px-5">
            <div className="flex flex-wrap items-center gap-x-2 gap-y-1">
              <Link href={row.href} className={LINK_CLASS}>
                {row.name} ({row.symbol})
              </Link>
              <LaunchPhaseBadge phase="launched" />
              {row.launchDate && row.launchLabel ? (
                <span className="text-xs text-muted-foreground">
                  Live since{" "}
                  <time dateTime={row.launchDate} className="pharos-numeric">
                    {row.launchLabel}
                  </time>
                </span>
              ) : null}
            </div>
            {row.reason ? <p className="break-words text-xs leading-relaxed text-muted-foreground">{row.reason}</p> : null}
            {row.reviewByLabel ? (
              <p className="text-2xs text-muted-foreground">
                Tracking review due <span className="pharos-numeric">{row.reviewByLabel}</span>
              </p>
            ) : null}
          </li>
        ))}
      </ul>
    </section>
  );
}

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
            <h2 className="pharos-label">{group.heading}</h2>
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
