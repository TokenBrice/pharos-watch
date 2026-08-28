/**
 * Minimal RSS 2.0 renderer for the pharos.watch `/feed/*.xml` routes.
 *
 * Hand-rolled to avoid a new dependency. Inputs are typed; rich bodies are
 * CDATA-wrapped; titles/descriptions are XML-escaped for safety.
 */

export interface RssItem {
  /** Plain-text title; entities will be escaped. */
  title: string;
  /** Absolute URL the reader navigates to. */
  link: string;
  /** Item body. May contain HTML; will be wrapped in CDATA. */
  description: string;
  /** Stable identifier, e.g. "pharos:digest:2026-05-16". `isPermaLink="false"`. */
  guid: string;
  /** RFC 822-formatted date string. */
  pubDate: string;
}

export interface RssFeed {
  title: string;
  /** Absolute URL for the feed's parent HTML page. */
  link: string;
  /** Absolute self-reference URL for the feed (used in atom:link). */
  feedUrl: string;
  description: string;
  language: string;
  /** RFC 822-formatted date. Typically the latest item's pubDate or the build date. */
  lastBuildDate: string;
  items: RssItem[];
}

type RssResponseFeed = Omit<RssFeed, "lastBuildDate"> & {
  lastBuildDate?: string;
};

/** Escape characters that have special meaning in XML element text/attributes. */
export function escapeXml(value: string): string {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&apos;");
}

/** Wrap rich text in CDATA, escaping any nested `]]>` sequences. */
function cdata(value: string): string {
  return `<![CDATA[${value.replaceAll("]]>", "]]]]><![CDATA[>")}]]>`;
}

/** Convert ISO 8601 (or any Date-parseable string) to RFC 822 UTC. */
export function toRfc822(input: string | number | Date): string {
  const date = input instanceof Date ? input : new Date(input);
  if (Number.isNaN(date.getTime())) {
    return new Date(0).toUTCString();
  }
  return date.toUTCString();
}

function renderItem(item: RssItem): string {
  return [
    "    <item>",
    `      <title>${escapeXml(item.title)}</title>`,
    `      <link>${escapeXml(item.link)}</link>`,
    `      <guid isPermaLink="false">${escapeXml(item.guid)}</guid>`,
    `      <pubDate>${escapeXml(item.pubDate)}</pubDate>`,
    `      <description>${cdata(item.description)}</description>`,
    "    </item>",
  ].join("\n");
}

/** Render an RSS 2.0 XML document. Always emits a `<channel>` even with zero items. */
export function renderRss20(feed: RssFeed): string {
  const header = [
    '<?xml version="1.0" encoding="UTF-8"?>',
    '<rss version="2.0" xmlns:atom="http://www.w3.org/2005/Atom">',
    "  <channel>",
    `    <title>${escapeXml(feed.title)}</title>`,
    `    <link>${escapeXml(feed.link)}</link>`,
    `    <atom:link href="${escapeXml(feed.feedUrl)}" rel="self" type="application/rss+xml" />`,
    `    <description>${escapeXml(feed.description)}</description>`,
    `    <language>${escapeXml(feed.language)}</language>`,
    `    <lastBuildDate>${escapeXml(feed.lastBuildDate)}</lastBuildDate>`,
  ];
  const footer = ["  </channel>", "</rss>", ""];
  const items = feed.items.map(renderItem);
  return [...header, ...items, ...footer].join("\n");
}

export function rssResponse(feed: RssResponseFeed): Response {
  const xml = renderRss20({
    ...feed,
    lastBuildDate: feed.lastBuildDate ?? feed.items[0]?.pubDate ?? toRfc822(new Date()),
  });
  return new Response(xml, {
    headers: {
      "Content-Type": "application/rss+xml; charset=utf-8",
      "Cache-Control": "public, max-age=3600",
    },
  });
}

interface RssRouteConfig {
  title: string;
  link: string;
  feedUrl: string;
  description: string;
  language?: string;
  items: () => RssItem[] | Promise<RssItem[]>;
}

/** Build a static RSS route while leaving domain-specific item construction local. */
export function createRssRoute({
  title,
  link,
  feedUrl,
  description,
  language = "en-US",
  items,
}: RssRouteConfig): () => Promise<Response> {
  return async () => rssResponse({
    title,
    link,
    feedUrl,
    description,
    language,
    items: await items(),
  });
}
