import { afterEach, describe, expect, it, vi } from "vitest";
import { createRssRoute, escapeXml, renderRss20, rssResponse, toRfc822 } from "./rss";

describe("rss helpers", () => {
  afterEach(() => vi.useRealTimers());

  it("escapes XML special characters", () => {
    expect(escapeXml(`<a href="x">&'</a>`)).toBe(
      "&lt;a href=&quot;x&quot;&gt;&amp;&apos;&lt;/a&gt;",
    );
  });

  it("renders RFC 822 dates in UTC", () => {
    expect(toRfc822(0)).toBe(new Date(0).toUTCString());
    expect(toRfc822("not-a-date")).toBe(new Date(0).toUTCString());
  });

  it("renders an empty channel when there are no items", () => {
    const xml = renderRss20({
      title: "Empty",
      link: "https://example.com/",
      feedUrl: "https://example.com/feed/",
      description: "desc",
      language: "en-US",
      lastBuildDate: toRfc822(0),
      items: [],
    });
    expect(xml).toContain('<?xml version="1.0" encoding="UTF-8"?>');
    expect(xml).toContain("<channel>");
    expect(xml).toContain("<title>Empty</title>");
    expect(xml).toContain("</channel>");
    expect(xml).not.toContain("<item>");
  });

  it("CDATA-wraps description and escapes title", () => {
    const xml = renderRss20({
      title: "Feed <pharos>",
      link: "https://example.com/",
      feedUrl: "https://example.com/feed/",
      description: "feed desc",
      language: "en-US",
      lastBuildDate: toRfc822(0),
      items: [
        {
          title: "Item & Co",
          link: "https://example.com/x",
          description: "<p>body with ]]> sequence</p>",
          guid: "pharos:test:1",
          pubDate: toRfc822(0),
        },
      ],
    });
    expect(xml).toContain("<title>Feed &lt;pharos&gt;</title>");
    expect(xml).toContain("<title>Item &amp; Co</title>");
    expect(xml).toContain('<guid isPermaLink="false">pharos:test:1</guid>');
    // CDATA must keep `]]>` from breaking the section.
    expect(xml).toContain("<![CDATA[<p>body with ]]]]><![CDATA[>");
    expect(xml).toContain("]]>");
  });

  it("serves RSS headers and uses the first item's date", async () => {
    const items = [{
      title: "One & Only",
      link: "https://example.com/one/",
      description: "<p>Body</p>",
      guid: "example:one",
      pubDate: "Thu, 01 Jan 1970 00:00:00 GMT",
    }, {
      title: "Second item",
      link: "https://example.com/two/",
      description: "Second body",
      guid: "example:two",
      pubDate: "Fri, 02 Jan 1970 00:00:00 GMT",
    }];
    const feed = {
      title: "Example Feed",
      link: "https://example.com/",
      feedUrl: "https://example.com/feed.xml",
      description: "Example description",
      language: "en-US",
      items,
    };

    const actual = await createRssRoute({ ...feed, items: () => items })();

    expect(actual.headers.get("Content-Type")).toBe("application/rss+xml; charset=utf-8");
    expect(actual.headers.get("Cache-Control")).toBe("public, max-age=3600");
    const xml = await actual.text();
    expect(xml).toContain("<lastBuildDate>Thu, 01 Jan 1970 00:00:00 GMT</lastBuildDate>");
    expect(xml).toContain("<title>One &amp; Only</title>");
    expect(xml).toContain('<guid isPermaLink="false">example:one</guid>');
  });

  it("prefers an explicit build date over the first item", async () => {
    const response = rssResponse({
      title: "Feed", link: "https://example.com", feedUrl: "https://example.com/feed",
      description: "Feed", language: "en-US",
      lastBuildDate: "Fri, 02 Jan 1970 00:00:00 GMT",
      items: [{ title: "Item", link: "https://example.com/item", description: "Body",
        guid: "item", pubDate: "Thu, 01 Jan 1970 00:00:00 GMT" }],
    });
    expect(await response.text()).toContain("<lastBuildDate>Fri, 02 Jan 1970 00:00:00 GMT</lastBuildDate>");
  });

  it("uses the current clock for an empty route feed", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-05-16T12:00:00Z"));
    const response = await createRssRoute({
      title: "Feed", link: "https://example.com", feedUrl: "https://example.com/feed",
      description: "Feed", items: () => [],
    })();
    expect(await response.text()).toContain("<lastBuildDate>Sat, 16 May 2026 12:00:00 GMT</lastBuildDate>");
  });

  it("propagates asynchronous item loading failures", async () => {
    const failure = new Error("item source unavailable");
    const route = createRssRoute({
      title: "Feed", link: "https://example.com", feedUrl: "https://example.com/feed",
      description: "Feed", items: async () => { throw failure; },
    });
    await expect(route()).rejects.toBe(failure);
  });
});
