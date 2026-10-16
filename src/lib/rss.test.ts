import { describe, expect, it } from "vitest";
import { createRssRoute, escapeXml, renderRss20, toRfc822 } from "./rss";

describe("rss helpers", () => {
  it("escapes XML special characters", () => {
    expect(escapeXml(`<a href="x">&'</a>`)).toBe(
      "&lt;a href=&quot;x&quot;&gt;&amp;&apos;&lt;/a&gt;",
    );
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

  it("propagates asynchronous item loading failures", async () => {
    const failure = new Error("item source unavailable");
    const route = createRssRoute({
      title: "Feed", link: "https://example.com", feedUrl: "https://example.com/feed",
      description: "Feed", items: async () => { throw failure; },
    });
    await expect(route()).rejects.toBe(failure);
  });
});
