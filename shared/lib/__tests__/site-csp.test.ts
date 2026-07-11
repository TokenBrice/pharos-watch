import { describe, expect, it } from "vitest";
import { addNonceToInlineScripts, buildStaticContentSecurityPolicy, isTelegramMiniAppPath } from "../site-csp";

describe("site CSP helpers", () => {
  it("adds a nonce to inline script tags", () => {
    expect(addNonceToInlineScripts("<script>1</script>", "abc123")).toBe(
      '<script nonce="abc123">1</script>',
    );
  });

  it("replaces stale inline script nonces", () => {
    expect(addNonceToInlineScripts('<script nonce="old">1</script>', "abc123")).toBe(
      '<script nonce="abc123">1</script>',
    );
  });

  it("replaces empty inline script nonces", () => {
    expect(addNonceToInlineScripts('<script nonce="">1</script>', "abc123")).toBe(
      '<script nonce="abc123">1</script>',
    );
  });

  it("leaves external script tags unchanged", () => {
    expect(addNonceToInlineScripts('<script src="/app.js"></script>', "abc123")).toBe(
      '<script src="/app.js"></script>',
    );
  });
});

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
  it("standard path sets frame-ancestors to none", () => {
    const csp = buildStaticContentSecurityPolicy();
    expect(csp).toContain("frame-ancestors 'none'");
    expect(csp).not.toContain("telegram.org");
  });

  it("Telegram Mini App path allows telegram.org frame-ancestors", () => {
    const csp = buildStaticContentSecurityPolicy({ telegramMiniApp: true });
    expect(csp).toContain("frame-ancestors https://telegram.org");
    expect(csp).toContain("https://telegram.org");
    expect(csp).not.toContain("google-analytics.com");
    expect(csp).not.toContain("analytics.google.com");
    expect(csp).not.toContain("googletagmanager.com");
  });

  it("keeps Google Analytics origins on standard public pages", () => {
    const csp = buildStaticContentSecurityPolicy();
    expect(csp).toContain("https://www.google-analytics.com");
    expect(csp).toContain("https://www.googletagmanager.com");
  });
});
