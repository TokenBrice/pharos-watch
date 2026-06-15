import { afterEach, describe, expect, it, vi } from "vitest";
import { checkSitemapUrls } from "../ci/check-seo-live-smoke.mjs";

function responseWithBody(status: number, contentType = "text/plain") {
  const cancel = vi.fn(async () => {});
  return {
    status,
    ok: status >= 200 && status < 300,
    headers: new Headers({ "content-type": contentType }),
    body: { cancel },
    text: vi.fn(async () => "<html><head></head><body>ok</body></html>"),
    cancel,
  };
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("check-seo-live-smoke sitemap URL checks", () => {
  it("cancels response bodies on early-return and non-html paths", async () => {
    const redirect = responseWithBody(301);
    const notFound = responseWithBody(404);
    const serverError = responseWithBody(503);
    const nonHtml = responseWithBody(200, "application/json");
    const responses = [redirect, notFound, serverError, nonHtml];
    vi.stubGlobal("fetch", vi.fn(async () => responses.shift()));
    const errors: string[] = [];

    await checkSitemapUrls(
      [
        "https://pharos.watch/redirect/",
        "https://pharos.watch/not-found/",
        "https://pharos.watch/error/",
        "https://pharos.watch/data.json",
      ],
      Number.POSITIVE_INFINITY,
      errors,
    );

    expect(redirect.cancel).toHaveBeenCalledOnce();
    expect(notFound.cancel).toHaveBeenCalledOnce();
    expect(serverError.cancel).toHaveBeenCalledOnce();
    expect(nonHtml.cancel).toHaveBeenCalledOnce();
    expect(errors).toEqual([
      "https://pharos.watch/redirect/: sitemap URL redirects with 301",
      "https://pharos.watch/not-found/: sitemap URL returns 404",
      "https://pharos.watch/error/: sitemap URL returns 503",
    ]);
  });
});
