import { createRssRoute, escapeXml, toRfc822, type RssItem } from "@/lib/rss";
import { SITE_ORIGIN as SITE_URL } from "@shared/lib/runtime-origins";
import { METHODOLOGY_CHANGELOG_REGISTRY } from "@shared/lib/methodology-versions/registry";

export const dynamic = "force-static";
export const revalidate = false;

const FEED_PATH = "/feed/methodology.xml";
const MAX_ITEMS = 50;

function methodologyItems(): RssItem[] {
  const all = METHODOLOGY_CHANGELOG_REGISTRY.flatMap((source) => source.entries.map((entry) => ({ source, entry })));
  return all
    // Items are published on their authored date, so the feed order must use
    // the same clock; activation only breaks same-day ties.
    .sort((a, b) => b.entry.date.localeCompare(a.entry.date) || b.entry.effectiveAt - a.entry.effectiveAt)
    .slice(0, MAX_ITEMS)
    .map(({ source, entry }) => {
      const impactHtml = entry.impact.length
        ? `<ul>${entry.impact.map((line) => `<li>${escapeXml(line)}</li>`).join("")}</ul>`
        : "";
      const description = `<p>${escapeXml(entry.summary)}</p>${impactHtml}`;
      return {
        title: `${source.feedLabel} v${entry.version} — ${entry.title}`,
        link: `${SITE_URL}${source.publicPath}`,
        description,
        guid: `pharos:methodology:${source.feedKey}:${entry.version}`,
        // Publish on the authored date shown by the changelog page; activation
        // can be later than authorship.
        pubDate: toRfc822(`${entry.date}T00:00:00Z`),
      };
    });
}

export const GET = createRssRoute({
  title: "Pharos Methodology Changelog",
  link: `${SITE_URL}/methodology/`,
  feedUrl: `${SITE_URL}${FEED_PATH}`,
  description:
    "Versioned methodology updates from pharos.watch — Safety Score, DEWS, DDR, PSI, Liquidity, Chain Health, Blacklist Tracker, Mint/Burn Flow, Pricing Pipeline, and Yield Intelligence.",
  lastBuildDate: () => toRfc822(new Date()),
  items: methodologyItems,
});
