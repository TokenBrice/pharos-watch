import digests from "../../../../data/digests.json";
import { renderRss20, toRfc822, type RssItem } from "@/lib/rss";
import { SITE_ORIGIN as SITE_URL } from "@shared/lib/runtime-origins";

export const dynamic = "force-static";
export const revalidate = false;

const FEED_PATH = "/feed/digest.xml";
const MAX_ITEMS = 100;

interface DigestEntry {
  date: string;
  title: string;
  text: string;
  extended?: string;
  generatedAt: number;
  digestType?: string;
}

function digestItems(entries: readonly DigestEntry[]): RssItem[] {
  return entries
    .slice()
    .sort((a, b) => (b.generatedAt ?? 0) - (a.generatedAt ?? 0))
    .slice(0, MAX_ITEMS)
    .map((entry) => ({
      title: entry.title,
      link: `${SITE_URL}/digest/${entry.date}/`,
      description: entry.extended ?? entry.text,
      guid: `pharos:digest:${entry.date}`,
      pubDate: toRfc822(entry.generatedAt * 1000),
    }));
}

export async function GET(): Promise<Response> {
  const items = digestItems(digests as DigestEntry[]);
  const lastBuildDate = items[0]?.pubDate ?? toRfc822(new Date());
  const xml = renderRss20({
    title: "Pharos Digest",
    link: `${SITE_URL}/digest/`,
    feedUrl: `${SITE_URL}${FEED_PATH}`,
    description:
      "Daily and weekly digests from pharos.watch — stablecoin market signals, PSI moves, depeg flags, and yield anomalies.",
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
