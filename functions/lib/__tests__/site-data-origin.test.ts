import { describe, expect, it } from "vitest";
import { rejectIfNotSiteDataUiOrigin } from "../site-data-origin";

const env = { SITE_ORIGIN: "https://pharos.watch", OPS_UI_ORIGIN: "https://ops.pharos.watch" };
const notFound = () => new Response(null, { status: 404 });

function req(url: string, headers: Record<string, string> = {}): Request {
  return new Request(url, { headers });
}

describe("rejectIfNotSiteDataUiOrigin", () => {
  it("passes when Origin matches an allowed hostname", () => {
    const r = req("https://pharos.watch/_site-data/peg-summary", { Origin: "https://pharos.watch" });
    expect(rejectIfNotSiteDataUiOrigin(r, env, notFound)).toBeNull();
  });

  it("passes when Origin matches ops UI", () => {
    const r = req("https://ops.pharos.watch/_site-data/peg-summary", { Origin: "https://ops.pharos.watch" });
    expect(rejectIfNotSiteDataUiOrigin(r, env, notFound)).toBeNull();
  });

  it("rejects a foreign Origin", () => {
    const r = req("https://pharos.watch/_site-data/peg-summary", { Origin: "https://evil.example.com" });
    expect(rejectIfNotSiteDataUiOrigin(r, env, notFound)?.status).toBe(404);
  });

  it("rejects a foreign Origin even if Referer is allowed", () => {
    const r = req("https://pharos.watch/_site-data/peg-summary", {
      Origin: "https://evil.example.com",
      Referer: "https://pharos.watch/",
    });
    expect(rejectIfNotSiteDataUiOrigin(r, env, notFound)?.status).toBe(404);
  });

  it("passes when Origin is absent but Referer hostname is allowed", () => {
    const r = req("https://pharos.watch/_site-data/peg-summary", { Referer: "https://pharos.watch/some-page" });
    expect(rejectIfNotSiteDataUiOrigin(r, env, notFound)).toBeNull();
  });

  it("rejects when Origin is absent and Referer is foreign", () => {
    const r = req("https://pharos.watch/_site-data/peg-summary", { Referer: "https://evil.example.com/path" });
    expect(rejectIfNotSiteDataUiOrigin(r, env, notFound)?.status).toBe(404);
  });

  it("rejects when neither Origin nor Referer is present", () => {
    const r = req("https://pharos.watch/_site-data/peg-summary");
    expect(rejectIfNotSiteDataUiOrigin(r, env, notFound)?.status).toBe(404);
  });

  it("shortcuts the header check on Pages preview hostnames", () => {
    const r = req("https://stablecoin-dashboard.pages.dev/_site-data/peg-summary");
    expect(rejectIfNotSiteDataUiOrigin(r, env, notFound)).toBeNull();
  });

  it("shortcuts the header check on Pages preview subdomains", () => {
    const r = req("https://abc123.stablecoin-dashboard.pages.dev/_site-data/peg-summary");
    expect(rejectIfNotSiteDataUiOrigin(r, env, notFound)).toBeNull();
  });

  it("passes when Origin is a *.pages.dev preview hostname and request is on pharos.watch", () => {
    const r = req("https://pharos.watch/_site-data/peg-summary", {
      Origin: "https://stablecoin-dashboard.pages.dev",
    });
    expect(rejectIfNotSiteDataUiOrigin(r, env, notFound)).toBeNull();
  });

  it("rejects a malformed Origin header", () => {
    const r = req("https://pharos.watch/_site-data/peg-summary", { Origin: "not-a-url" });
    expect(rejectIfNotSiteDataUiOrigin(r, env, notFound)?.status).toBe(404);
  });

  it("rejects 'Origin: null' (file://, sandboxed iframes, some browsers)", () => {
    const r = req("https://pharos.watch/_site-data/peg-summary", { Origin: "null" });
    expect(rejectIfNotSiteDataUiOrigin(r, env, notFound)?.status).toBe(404);
  });
});
