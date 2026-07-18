import { mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { afterEach, describe, expect, it, vi } from "vitest";
import { checkSitemap, checkSitemapUrls, isMainEntrypoint } from "../ci/check-seo-live-smoke.mjs";

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
  it("rejects duplicate locations in the live sitemap", async () => {
    const sitemap = responseWithBody(200, "application/xml");
    sitemap.text.mockResolvedValue(
      "<urlset><url><loc>https://pharos.watch/</loc></url><url><loc>https://pharos.watch/</loc></url></urlset>",
    );
    vi.stubGlobal("fetch", vi.fn(async () => sitemap));
    const errors: string[] = [];

    await checkSitemap(new URL("https://pharos.watch/"), errors);

    expect(errors).toEqual([
      "sitemap.xml contains duplicate <loc> entries: https://pharos.watch/",
    ]);
  });

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

describe("check-seo-live-smoke entrypoint guard", () => {
  it("matches symlinked invocation paths against the real module URL", () => {
    const tempDir = mkdtempSync(join(tmpdir(), "pharos-seo-smoke-"));
    const realScript = join(tempDir, "check-seo-live-smoke.mjs");
    const symlinkedScript = join(tempDir, "check-seo-live-smoke-link.mjs");
    writeFileSync(realScript, "export {};\n");
    symlinkSync(realScript, symlinkedScript);

    try {
      expect(isMainEntrypoint(pathToFileURL(realScript).href, symlinkedScript)).toBe(true);
    } finally {
      rmSync(tempDir, { recursive: true, force: true });
    }
  });
});
