import { escapeXml, rssResponse, toRfc822, type RssItem } from "@/lib/rss";
import { CEMETERY_ENTRIES } from "@shared/lib/cemetery-merged";
import { SITE_ORIGIN as SITE_URL } from "@shared/lib/runtime-origins";

export const dynamic = "force-static";
export const revalidate = false;

const FEED_PATH = "/feed/cemetery.xml";
const MAX_ITEMS = 50;

/**
 * Coarse `deathDate` strings are normalized to a Date. Most rows use `YYYY-MM`;
 * fall back to the first of the month so RFC 822 conversion stays stable.
 */
function deathDateToMs(deathDate: string): number {
  const padded = /^\d{4}$/.test(deathDate)
    ? `${deathDate}-01-01`
    : /^\d{4}-\d{2}$/.test(deathDate)
      ? `${deathDate}-01`
      : deathDate;
  const ms = new Date(padded).getTime();
  return Number.isNaN(ms) ? 0 : ms;
}

function cemeteryItems(): RssItem[] {
  return CEMETERY_ENTRIES.slice()
    .sort((a, b) => deathDateToMs(b.deathDate) - deathDateToMs(a.deathDate))
    .slice(0, MAX_ITEMS)
    .map((coin) => {
      const obituaryHtml = `<p>${escapeXml(coin.obituary)}</p>`;
      const description = coin.epitaph ? `<p><em>${escapeXml(coin.epitaph)}</em></p>${obituaryHtml}` : obituaryHtml;
      return {
        title: `${coin.name} (${coin.symbol}) — ${coin.causeOfDeath}`,
        link: `${SITE_URL}/cemetery/#${coin.id}`,
        description,
        guid: `pharos:cemetery:${coin.id}`,
        pubDate: toRfc822(deathDateToMs(coin.deathDate)),
      };
    });
}

export async function GET(): Promise<Response> {
  const items = cemeteryItems();
  return rssResponse({
    title: "Pharos Cemetery",
    link: `${SITE_URL}/cemetery/`,
    feedUrl: `${SITE_URL}${FEED_PATH}`,
    description:
      "Failed, discontinued, and abandoned stablecoins archived by pharos.watch — each entry carries an epitaph, obituary, and cause-of-death classification.",
    language: "en-US",
    items,
  });
}
