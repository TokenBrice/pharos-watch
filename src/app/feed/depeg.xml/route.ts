import { createRssRoute, toRfc822, type RssItem } from "@/lib/rss";
import {
  getPeakDeviationMagnitudeBps,
  selectStaticDepegEventPages,
} from "@/lib/depeg-event-config";
import { SITE_ORIGIN as SITE_URL } from "@shared/lib/runtime-origins";
import { buildStablecoinUrl } from "@shared/lib/urls";
import type { DepegEventEntry } from "@shared/types/market";
import { readDepegEventSnapshot } from "@/lib/depeg-event-snapshot";

export const dynamic = "force-static";
export const revalidate = false;

const FEED_PATH = "/feed/depeg.xml";
const MAX_ITEMS = 100;

function depegItems(events: readonly DepegEventEntry[]): RssItem[] {
  const staticPageSlugs = new Set(selectStaticDepegEventPages(events).map((event) => event.slug));
  return events
    .slice()
    .sort((a, b) => b.startedAt - a.startedAt)
    .slice(0, MAX_ITEMS)
    .map((event) => {
      const startedISO = new Date(event.startedAt * 1000).toISOString().slice(0, 10);
      const sign = event.direction === "below" ? "-" : "+";
      const peakBps = getPeakDeviationMagnitudeBps(event);
      const title = `${event.symbol} depeg ${sign}${peakBps} bps`;
      const status = event.endedAt ? "Resolved" : "Active";
      const eventLink =
        staticPageSlugs.has(event.slug)
          ? `${SITE_URL}/depeg/${event.slug}/`
          : `${SITE_URL}${buildStablecoinUrl(event.stablecoinId, "#depeg-history")}`;
      return {
        title,
        link: eventLink,
        description: `${status} ${event.direction} peg by ${peakBps} bps starting ${startedISO}.`,
        guid: `pharos:depeg-event:${event.slug}`,
        pubDate: toRfc822(event.startedAt * 1000),
      };
    });
}

export const GET = createRssRoute({
  title: "Pharos Depeg Events",
  link: `${SITE_URL}/depeg/`,
  feedUrl: `${SITE_URL}${FEED_PATH}`,
  description:
    "Confirmed depeg events tracked by pharos.watch — symbol, direction, peak deviation, and resolution status.",
  items: () => depegItems(readDepegEventSnapshot({ missing: "empty" })),
});
