import { describe, expect, it } from "vitest";
import { addNonceToInlineScripts, buildContentSecurityPolicy, isTelegramMiniAppPath } from "../site-csp";

describe("isTelegramMiniAppPath", () => {
  it("matches the exact app path", () => {
    expect(isTelegramMiniAppPath("/pharoswatchbot/app")).toBe(true);
  });

  it("matches sub-paths under the app root", () => {
    expect(isTelegramMiniAppPath("/pharoswatchbot/app/")).toBe(true);
    expect(isTelegramMiniAppPath("/pharoswatchbot/app/settings")).toBe(true);
  });

  it("does not match unrelated paths", () => {
    expect(isTelegramMiniAppPath("/")).toBe(false);
    expect(isTelegramMiniAppPath("/pharoswatchbot")).toBe(false);
    expect(isTelegramMiniAppPath("/pharoswatchbot/other")).toBe(false);
  });
});

describe("buildStaticContentSecurityPolicy", () => {
  it.each([
    { telegramMiniApp: false, origin: "https://www.googletagmanager.com" },
    { telegramMiniApp: true, origin: "https://telegram.org" },
  ])("authorizes only the intended scripts with the matching nonce ($telegramMiniApp)", ({ telegramMiniApp, origin }) => {
    const nonce = "dGVzdC1ub25jZQ==";
    const directives = new Map(buildContentSecurityPolicy(nonce, { telegramMiniApp })
      .split("; ").map((directive) => {
        const [name, ...sources] = directive.split(" ");
        return [name, sources] as const;
      }));
    expect(directives.get("script-src")).toEqual(["'self'", `'nonce-${nonce}'`, origin]);
    expect(directives.get("img-src")).toEqual(
      telegramMiniApp
        ? ["'self'", "https://coin-images.coingecko.com", "https://pbs.twimg.com", "https://abs.twimg.com", "data:"]
        : [
          "'self'",
          "https://coin-images.coingecko.com",
          "https://www.google-analytics.com",
          "https://*.google-analytics.com",
          "https://analytics.google.com",
          "https://*.analytics.google.com",
          "https://www.googletagmanager.com",
          "https://*.googletagmanager.com",
          "https://pbs.twimg.com",
          "https://abs.twimg.com",
          "data:",
        ],
    );
    expect(directives.get("connect-src")).toEqual(
      telegramMiniApp
        ? ["'self'", "https://api.pharos.watch"]
        : [
          "'self'",
          "https://api.pharos.watch",
          "https://www.google-analytics.com",
          "https://*.google-analytics.com",
          "https://analytics.google.com",
          "https://*.analytics.google.com",
          "https://www.googletagmanager.com",
          "https://*.googletagmanager.com",
        ],
    );
    expect(addNonceToInlineScripts("<script>run()</script>", nonce)).toContain(`nonce="${nonce}"`);
    expect(directives.get("frame-ancestors")).toEqual(
      telegramMiniApp ? ["https://telegram.org", "https://*.telegram.org"] : ["'none'"],
    );
  });

});
