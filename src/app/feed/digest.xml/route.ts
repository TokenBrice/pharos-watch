import digests from "../../../../data/digests.json";
import { rssResponse, toRfc822, type RssItem } from "@/lib/rss";
import { SITE_ORIGIN as SITE_URL } from "@shared/lib/runtime-origins";
import type { DigestContentEntry } from "@shared/types";

export const dynamic = "force-static";
export const revalidate = false;

const FEED_PATH = "/feed/digest.xml";
const MAX_ITEMS = 100;

function digestItems(entries: readonly DigestContentEntry[]): RssItem[] {
  return entries
    .slice()
    .sort((a, b) => b.generatedAt - a.generatedAt)
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
  const items = digestItems(digests as DigestContentEntry[]);
  return rssResponse({
    title: "Pharos Digest",
    link: `${SITE_URL}/digest/`,
    feedUrl: `${SITE_URL}${FEED_PATH}`,
    description:
      "Daily and weekly digests from pharos.watch — stablecoin market signals, PSI moves, depeg flags, and yield anomalies.",
    language: "en-US",
    items,
  });
}
