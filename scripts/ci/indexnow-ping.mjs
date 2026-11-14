#!/usr/bin/env node
// Pings IndexNow with only the sitemap URLs that changed in this release.
// Usage: node scripts/ci/indexnow-ping.mjs --previous <sitemap.xml> [--current out/sitemap.xml] [--max 500] [--dry-run]
import { readdirSync, readFileSync } from "node:fs";
import { parseStrictCliArgs, runDirectCli } from "../lib/cli-args.mjs";

const HOST = "pharos.watch";
const ENDPOINT = "https://api.indexnow.org/indexnow";

/** The IndexNow key is public by design: it is the name of the key file served at /<key>.txt. */
function indexNowKey() {
  const file = readdirSync("public").find((name) => /^[0-9a-f]{32}\.txt$/.test(name));
  if (!file) throw new Error("No IndexNow key file found (public/<32 hex characters>.txt)");
  return file.slice(0, -".txt".length);
}

function sitemapDates(xml) {
  const dates = new Map();
  for (const [, body] of xml.matchAll(/<url>([\s\S]*?)<\/url>/g)) {
    const loc = /<loc>([^<]+)<\/loc>/.exec(body)?.[1];
    if (loc) dates.set(loc, /<lastmod>([^<]+)<\/lastmod>/.exec(body)?.[1] ?? "");
  }
  return dates;
}

/** New, removed, or lastmod-changed URLs between two sitemap documents. */
export function diffSitemaps(previousXml, currentXml) {
  const previous = sitemapDates(previousXml);
  const current = sitemapDates(currentXml);
  const urls = [];
  for (const [loc, lastmod] of current) if (previous.get(loc) !== lastmod) urls.push(loc);
  for (const loc of previous.keys()) if (!current.has(loc)) urls.push(loc);
  return urls;
}

/** Returns { urls } to send, or { skip } naming why nothing is sent. */
export function planPing(previousXml, currentXml, max = 500) {
  if (!previousXml || sitemapDates(previousXml).size === 0) return { skip: "no previous sitemap available" };
  const urls = diffSitemaps(previousXml, currentXml);
  if (urls.length === 0) return { skip: "no sitemap changes" };
  if (urls.length > max) return { skip: `${urls.length} changed URLs exceed the cap of ${max}` };
  return { urls };
}

runDirectCli(import.meta.url, async () => {
  const { values } = parseStrictCliArgs(process.argv.slice(2), {
    options: {
      previous: { type: "string" },
      current: { type: "string", default: "out/sitemap.xml" },
      max: { type: "string", default: "500" },
      "dry-run": { type: "boolean" },
    },
  });
  if (values.help) {
    console.log("Usage: node scripts/ci/indexnow-ping.mjs --previous <sitemap.xml> [--current out/sitemap.xml] [--max 500] [--dry-run]");
    console.log("Sends only new, removed or lastmod-changed sitemap URLs to IndexNow; never the whole sitemap.");
    return;
  }
  let previousXml = "";
  try {
    previousXml = values.previous ? readFileSync(values.previous, "utf8") : "";
  } catch {
    // a missing or unreadable previous sitemap means nothing is sent
  }
  const max = Number(values.max);
  if (!Number.isInteger(max) || max < 1) throw new Error("--max must be a positive integer");
  const plan = planPing(previousXml, readFileSync(values.current, "utf8"), max);
  if (plan.skip) return console.log(`[indexnow] nothing sent: ${plan.skip}`);
  const key = indexNowKey();
  const payload = { host: HOST, key, keyLocation: `https://${HOST}/${key}.txt`, urlList: plan.urls };
  if (values["dry-run"]) return console.log(`[indexnow] dry run, would send ${plan.urls.length} URLs:\n${plan.urls.join("\n")}`);
  const response = await fetch(ENDPOINT, {
    method: "POST",
    headers: { "Content-Type": "application/json; charset=utf-8" },
    body: JSON.stringify(payload),
    signal: AbortSignal.timeout(30_000),
  });
  if (!response.ok) throw new Error(`IndexNow answered HTTP ${response.status}: ${(await response.text()).slice(0, 200)}`);
  console.log(`[indexnow] sent ${plan.urls.length} URLs, HTTP ${response.status}`);
});
