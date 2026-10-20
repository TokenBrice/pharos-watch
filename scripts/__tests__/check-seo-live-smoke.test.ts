import { afterEach, describe, expect, it, vi } from "vitest";

import { checkSitemapUrls } from "../ci/check-seo-live-smoke.mjs";

const loc = "https://pharos.watch/stablecoin/usdt-tether/";
const selfCanonicalHtml = `<html><head><link rel="canonical" href="${loc}"></head><body>Stablecoin</body></html>`;

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("live sitemap document admission", () => {
  it.each([
    ["JSON error", "application/json", '{"error":"unavailable"}'],
    ["missing Content-Type", null, selfCanonicalHtml],
    ["HTML-like media type", "text/html-error", selfCanonicalHtml],
  ])("rejects HTTP-200 %s documents and cancels their bodies", async (_name, contentType, body) => {
    const response = new Response(new TextEncoder().encode(body), {
      headers: contentType ? { "Content-Type": contentType } : {},
    });
    const cancel = vi.spyOn(response.body!, "cancel");
    vi.stubGlobal("fetch", vi.fn(async () => response));
    const errors: string[] = [];

    await checkSitemapUrls([loc], Number.POSITIVE_INFINITY, errors);

    expect(errors).toEqual([`${loc}: sitemap URL has unexpected Content-Type (${contentType ?? "missing"})`]);
    expect(cancel).toHaveBeenCalledOnce();
  });

  it.each(["text/html", "Text/HTML; charset=utf-8"])("accepts indexable self-canonical %s", async (contentType) => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response(selfCanonicalHtml, {
      headers: { "Content-Type": contentType },
    })));
    const errors: string[] = [];

    await checkSitemapUrls([loc], Number.POSITIVE_INFINITY, errors);

    expect(errors).toEqual([]);
  });

  it.each(["meta", "header"])("rejects HTML noindexed by %s", async (source) => {
    const html = source === "meta"
      ? selfCanonicalHtml.replace("</head>", '<meta name="robots" content="noindex"></head>')
      : selfCanonicalHtml;
    vi.stubGlobal("fetch", vi.fn(async () => new Response(html, {
      headers: { "Content-Type": "text/html", ...(source === "header" ? { "X-Robots-Tag": "noindex" } : {}) },
    })));
    const errors: string[] = [];

    await checkSitemapUrls([loc], Number.POSITIVE_INFINITY, errors);

    expect(errors).toHaveLength(1);
    expect(errors[0]).toContain("noindexed");
  });

  it("rejects HTML whose canonical does not match its sitemap URL", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response(selfCanonicalHtml.replace(loc, "https://pharos.watch/"), {
      headers: { "Content-Type": "text/html" },
    })));
    const errors: string[] = [];

    await checkSitemapUrls([loc], Number.POSITIVE_INFINITY, errors);

    expect(errors).toEqual([`${loc}: sitemap URL canonical must match itself (got https://pharos.watch/)`]);
  });

  it("rejects redirects without following them and cancels their bodies", async () => {
    const response = new Response("Moved", { status: 301, headers: { Location: "https://pharos.watch/" } });
    const cancel = vi.spyOn(response.body!, "cancel");
    const fetchMock = vi.fn(async () => response);
    vi.stubGlobal("fetch", fetchMock);
    const errors: string[] = [];

    await checkSitemapUrls([loc], Number.POSITIVE_INFINITY, errors);

    expect(errors).toEqual([`${loc}: sitemap URL redirects with 301`]);
    expect(fetchMock).toHaveBeenCalledWith(loc, expect.objectContaining({ redirect: "manual" }));
    expect(cancel).toHaveBeenCalledOnce();
  });
});
