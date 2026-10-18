import type { HomepageHistory } from "@shared/types/homepage";
import { formatCurrency, formatLongDate } from "@shared/lib/format";
import { HOMEPAGE_HERO_MAX_FALLBACK_AGE_MS } from "@/lib/homepage-hero-snapshot";
import { HomeAltHeroChartFallback } from "@/components/home-alt-hero-chart-fallback";

/** A bounded dated preview, never a live query seed or a replacement census. */
export function HomeAltHeroStaticChart({ history, nowMs }: { history?: HomepageHistory; nowMs: number }): React.JSX.Element {
  const updatedAt = history?.sources.total.updatedAt;
  if (!history || updatedAt == null || updatedAt * 1000 > nowMs || nowMs - updatedAt * 1000 > HOMEPAGE_HERO_MAX_FALLBACK_AGE_MS) {
    return <HomeAltHeroChartFallback />;
  }
  const rows = history.rows;
  const observed = rows.filter((row) => row.total !== null);
  if (rows.length < 2 || observed.length < 2) return <HomeAltHeroChartFallback />;
  const path = buildStaticHistoryPath(rows, Math.max(1, ...observed.map((row) => row.total!)));
  return (
    <figure className="flex h-[305px] flex-col justify-center gap-3 p-5 sm:p-6">
      <svg viewBox="0 0 600 190" role="img" aria-label="Dated fallback: recent total stablecoin market cap history" className="w-full">
        <path d={path} fill="none" stroke="var(--color-muted-foreground)" strokeWidth="2" />
      </svg>
      <figcaption className="pharos-meta">
        Fallback history · as of {formatLongDate(new Date(updatedAt * 1000), { utc: true })}
        <span className="block">Latest observed total {formatCurrency(observed[observed.length - 1]!.total!, 1)} · live full history loading</span>
      </figcaption>
    </figure>
  );
}

function buildStaticHistoryPath(rows: HomepageHistory["rows"], max: number): string {
  const start = rows[0]!.ts;
  const span = Math.max(1, rows[rows.length - 1]!.ts - start);
  return rows.map((row, index) => {
    if (row.total === null) return "";
    const inSegment = index > 0 && rows[index - 1]!.total !== null;
    return `${inSegment ? "L" : "M"}${(12 + (row.ts - start) / span * 576).toFixed(1)},${(174 - row.total / max * 150).toFixed(1)}`;
  }).join(" ");
}
