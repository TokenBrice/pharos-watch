import { createRssRoute, toRfc822, type RssItem } from "@/lib/rss";
import {
  getPeakDeviationMagnitudeBps,
  selectStaticDepegEventPages,
} from "@/lib/depeg-event-config";
import { SITE_ORIGIN as SITE_URL } from "@shared/lib/runtime-origins";
import { buildStablecoinUrl } from "@shared/lib/urls";
import type { DepegEventEntry } from "@shared/types/market";
import { classifyDepegClosure, type DepegClosureClassification } from "@shared/lib/depeg-closure";
import { readDepegEventSnapshot } from "@/lib/depeg-event-snapshot";

export const dynamic = "force-static";
export const revalidate = false;

const FEED_PATH = "/feed/depeg.xml";
const MAX_ITEMS = 100;

const CLOSURE_STATUS: Record<DepegClosureClassification, string> = {
  open: "Active",
  recovered: "Resolved",
  legacy_recovered: "Resolved",
  coverage_lost: "Closed (coverage lost; recovery not confirmed)",
  superseded: "Closed (superseded by a direction change; recovery not confirmed)",
  orphan: "Closed (removed from tracking; recovery not confirmed)",
  unknown_closed: "Closed (unknown terminal state; recovery not confirmed)",
};

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
      const status = CLOSURE_STATUS[classifyDepegClosure(event)];
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
    "Confirmed depeg events tracked by pharos.watch — symbol, direction, peak deviation, and tracking or recovery status.",
  items: () => depegItems(readDepegEventSnapshot({ missing: "empty" })),
});
