import { readFileSync } from "node:fs";
import path from "node:path";
import { renderRss20, toRfc822, type RssItem } from "@/lib/rss";
import {
  getPeakDeviationMagnitudeBps,
  selectStaticDepegEventPages,
} from "@/app/depeg/[event]/config";
import { SITE_ORIGIN as SITE_URL } from "@shared/lib/runtime-origins";

export const dynamic = "force-static";
export const revalidate = false;

const FEED_PATH = "/feed/depeg.xml";
const MAX_ITEMS = 100;
/** W3-D will populate this file during prebuild. Until then, treat absence as zero events. */
const DEPEG_EVENTS_PATH = path.join(process.cwd(), "data/depeg-events.json");

interface DepegFeedEvent {
  id: number | string;
  stablecoinId: string;
  symbol: string;
  direction: "above" | "below";
  peakDeviationBps: number;
  startedAt: number;
  endedAt: number | null;
  slug: string;
}

function loadEvents(): DepegFeedEvent[] {
  try {
    const raw = readFileSync(DEPEG_EVENTS_PATH, "utf-8");
    const parsed = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];
    return parsed as DepegFeedEvent[];
  } catch {
    return [];
  }
}

function depegItems(events: readonly DepegFeedEvent[]): RssItem[] {
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
          : `${SITE_URL}/stablecoin/${event.stablecoinId}/#depeg-history`;
      return {
        title,
        link: eventLink,
        description: `${status} ${event.direction} peg by ${peakBps} bps starting ${startedISO}.`,
        guid: `pharos:depeg-event:${event.slug}`,
        pubDate: toRfc822(event.startedAt * 1000),
      };
    });
}

export async function GET(): Promise<Response> {
  const items = depegItems(loadEvents());
  const lastBuildDate = items[0]?.pubDate ?? toRfc822(new Date());
  const xml = renderRss20({
    title: "Pharos Depeg Events",
    link: `${SITE_URL}/depeg/`,
    feedUrl: `${SITE_URL}${FEED_PATH}`,
    description:
      "Confirmed depeg events tracked by pharos.watch — symbol, direction, peak deviation, and resolution status.",
    language: "en-US",
    lastBuildDate,
    items,
  });
  return new Response(xml, {
    headers: {
      "Content-Type": "application/rss+xml; charset=utf-8",
      "Cache-Control": "public, max-age=3600",
    },
  });
}
