import { describe, expect, it } from "vitest";
import { rejectIfNotSiteDataUiOrigin } from "../site-data-origin";

const env = { SITE_ORIGIN: "https://pharos.watch", OPS_UI_ORIGIN: "https://ops.pharos.watch" };
const notFound = () => new Response(null, { status: 404 });

function req(url: string, headers: Record<string, string> = {}): Request {
  return new Request(url, { headers });
}

describe("rejectIfNotSiteDataUiOrigin", () => {
  it.each<{ name: string; host?: string; headers: Record<string, string>; allowed: boolean }>([
    { name: "site Origin", headers: { Origin: "https://pharos.watch" }, allowed: true },
    { name: "ops Origin", host: "ops.pharos.watch", headers: { Origin: "https://ops.pharos.watch" }, allowed: true },
    { name: "foreign Origin", headers: { Origin: "https://evil.example.com" }, allowed: false },
    { name: "foreign Origin overrides allowed Referer", headers: { Origin: "https://evil.example.com", Referer: "https://pharos.watch/" }, allowed: false },
    { name: "absent Origin uses allowed Referer", headers: { Referer: "https://pharos.watch/some-page" }, allowed: true },
    { name: "absent Origin with foreign Referer", headers: { Referer: "https://evil.example.com/path" }, allowed: false },
    { name: "missing caller headers", headers: {}, allowed: false },
    { name: "direct preview without caller headers", host: "stablecoin-dashboard.pages.dev", headers: {}, allowed: false },
    { name: "preview Referer on preview host", host: "abc123.stablecoin-dashboard.pages.dev", headers: { Referer: "https://abc123.stablecoin-dashboard.pages.dev/stablecoins" }, allowed: true },
    { name: "preview Origin on site host", headers: { Origin: "https://stablecoin-dashboard.pages.dev" }, allowed: true },
    { name: "malformed Origin without Referer", headers: { Origin: "not-a-url" }, allowed: false },
    { name: "literal-null Origin without Referer", headers: { Origin: "null" }, allowed: false },
    { name: "malformed Origin falls through to allowed Referer", headers: { Origin: "not-a-url", Referer: "https://pharos.watch/" }, allowed: true },
    { name: "malformed Origin with foreign Referer", headers: { Origin: "not-a-url", Referer: "https://evil.example.com/" }, allowed: false },
    { name: "literal-null Origin falls through to allowed Referer", headers: { Origin: "null", Referer: "https://pharos.watch/" }, allowed: true },
    { name: "literal-null Origin with foreign Referer", headers: { Origin: "null", Referer: "https://evil.example.com/" }, allowed: false },
  ])("$name", ({ host = "pharos.watch", headers, allowed }) => {
    const result = rejectIfNotSiteDataUiOrigin(req(`https://${host}/_site-data/peg-summary`, headers), env, notFound);
    if (allowed) expect(result).toBeNull();
    else expect(result?.status).toBe(404);
  });
});
