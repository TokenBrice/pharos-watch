import { describe, expect, it } from "vitest";
import { createRssRoute, escapeXml, renderRss20, rssResponse, toRfc822 } from "./rss";

describe("rss helpers", () => {
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

  it("assembles route output byte-identically to a direct RSS response", async () => {
    const items = [{
      title: "One & Only",
      link: "https://example.com/one/",
      description: "<p>Body</p>",
      guid: "example:one",
      pubDate: "Thu, 01 Jan 1970 00:00:00 GMT",
    }];
    const feed = {
      title: "Example Feed",
      link: "https://example.com/",
      feedUrl: "https://example.com/feed.xml",
      description: "Example description",
      language: "en-US",
      items,
    };

    const expected = rssResponse(feed);
    const actual = await createRssRoute({ ...feed, items: () => items })();

    expect(await actual.text()).toBe(await expected.text());
    expect(Array.from(actual.headers.entries())).toEqual(Array.from(expected.headers.entries()));
  });
});
