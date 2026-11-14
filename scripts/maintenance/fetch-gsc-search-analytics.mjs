#!/usr/bin/env node

import { existsSync } from "node:fs";
import { join } from "node:path";
import { serviceAccountAccessToken } from "../lib/google-service-account.mjs";
import { parseStrictCliArgs, runDirectCli, writeFileResolved } from "../lib/cli-args.mjs";

const SCOPE = "https://www.googleapis.com/auth/webmasters.readonly";
const ROW_LIMIT = 25_000;
const HEADER = ["Clicks", "Impressions", "CTR", "Position"];

/** Default window: the 90 complete days ending 3 days ago (UTC). */
export function defaultWindow(now = new Date()) {
  const end = Date.parse(now.toISOString().slice(0, 10)) - 3 * 86_400_000;
  return { start: new Date(end - 89 * 86_400_000).toISOString().slice(0, 10), end: new Date(end).toISOString().slice(0, 10) };
}

/** Canonical URL of a reported page on `origin`, or null for other hosts; query, fragment, scheme and trailing-slash variants fold into the page. */
export function canonicalPage(value, origin) {
  let url;
  try { url = new URL(value); } catch { return null; }
  if (url.hostname !== new URL(origin).hostname) return null;
  return `${origin}${url.pathname.endsWith("/") || url.pathname.includes(".") ? url.pathname : `${url.pathname}/`}`;
}

/** Folds the URL variants of one page into one row (rows of other hosts are dropped); position is impression-weighted. */
export function foldPages(rows, origin) {
  const folded = new Map();
  for (const row of rows) {
    const page = canonicalPage(row.keys[0], origin);
    if (!page) continue;
    const keys = [page, ...row.keys.slice(1)];
    const entry = folded.get(JSON.stringify(keys)) ?? { keys, clicks: 0, impressions: 0, weighted: 0 };
    entry.clicks += row.clicks;
    entry.impressions += row.impressions;
    entry.weighted += row.position * row.impressions;
    folded.set(JSON.stringify(keys), entry);
  }
  return [...folded.values()].map(({ weighted, ...row }) => ({ ...row,
    ctr: row.impressions ? row.clicks / row.impressions : 0, position: row.impressions ? weighted / row.impressions : 0 }));
}

const csvCell = (value) => (/[",\n\r]/.test(String(value)) ? `"${String(value).replaceAll('"', '""')}"` : String(value));

/** CSV with the dimension headers first, then Clicks, Impressions, CTR, Position (CTR as a fraction). */
export function toCsv(dimensionHeaders, rows) {
  const lines = rows.map((r) => [...r.keys, r.clicks, r.impressions, r.ctr.toFixed(6), r.position.toFixed(2)].map(csvCell).join(","));
  return `${[...dimensionHeaders, ...HEADER].join(",")}\n${lines.join("\n")}${lines.length ? "\n" : ""}`;
}

/** POSTs with up to 3 retries on thrown errors and non-2xx answers; never logs the token. */
export async function postWithRetry(fetchFn, url, token, body, { retries = 3, delayMs = 2000 } = {}) {
  let failure;
  for (let attempt = 0; attempt <= retries; attempt += 1) {
    if (attempt) await new Promise((resolve) => setTimeout(resolve, delayMs * attempt));
    try {
      const response = await fetchFn(url, { method: "POST", redirect: "error", signal: AbortSignal.timeout(60_000),
        headers: { authorization: `Bearer ${token}`, "content-type": "application/json" }, body: JSON.stringify(body) });
      if (response.ok) return await response.json();
      failure = new Error(`Search Console API HTTP ${response.status}`);
    } catch (error) {
      failure = new Error(`Search Console request failed: ${error instanceof Error ? error.message : "unknown error"}`);
    }
  }
  throw failure;
}

/** Pages one query with startRow until a short page. `post(body)` returns the parsed response. */
export async function queryAll(post, body) {
  const rows = [];
  for (;;) {
    const page = (await post({ ...body, rowLimit: ROW_LIMIT, startRow: rows.length })).rows ?? [];
    rows.push(...page);
    if (page.length < ROW_LIMIT) return rows;
  }
}

runDirectCli(import.meta.url, async () => {
  const { values } = parseStrictCliArgs(process.argv.slice(2), { options: {
    start: { type: "string" }, end: { type: "string" }, out: { type: "string" },
    "search-type": { type: "string", default: "web" }, site: { type: "string", default: "sc-domain:pharos.watch" },
  } });
  if (values.help) {
    console.log("Usage: npm run fetch:gsc-search-analytics -- --out <dir> [--start YYYY-MM-DD] [--end YYYY-MM-DD] [--search-type web] [--site sc-domain:pharos.watch]\nRead-only Search Console API export (default: the 90 complete days ending 3 days ago). Requires GOOGLE_APPLICATION_CREDENTIALS (service-account JSON file added as a user on the property; loaded from .env.local if present).\nWrites <dir>/pages.csv and <dir>/page-query.csv (read by `npm run analyze:gsc-performance -- <dir>` as one capture) and date series under <dir>/series/ (ignored by the analyzer).");
    return;
  }
  if (!values.out) throw new Error("--out <dir> is required");
  const defaults = defaultWindow();
  const start = values.start ?? defaults.start;
  const end = values.end ?? defaults.end;
  for (const date of [start, end]) if (!/^\d{4}-\d{2}-\d{2}$/.test(date) || Number.isNaN(Date.parse(date))) throw new Error(`Invalid ISO date: ${date}`);
  if (start > end) throw new Error("--start must not be after --end");
  if (existsSync(".env.local")) process.loadEnvFile(".env.local");
  if (!process.env.GOOGLE_APPLICATION_CREDENTIALS) throw new Error("Missing GOOGLE_APPLICATION_CREDENTIALS (path to a service-account JSON file with Search Console access)");
  const token = await serviceAccountAccessToken(process.env.GOOGLE_APPLICATION_CREDENTIALS, SCOPE, "Search Console");
  const url = `https://www.googleapis.com/webmasters/v3/sites/${encodeURIComponent(values.site)}/searchAnalytics/query`;
  const post = (body) => postWithRetry(fetch, url, token, { type: values["search-type"], ...body });
  const out = (name, text) => writeFileResolved(join(values.out, name), text);
  const window = { startDate: start, endDate: end };
  const filter = (...filters) => ({ dimensionFilterGroups: [{ filters }] });

  // The analyzer wants one row per page: fold the variants a domain property reports.
  const origin = values.site.startsWith("sc-domain:") ? `https://${values.site.slice("sc-domain:".length)}` : new URL(values.site).origin;
  const pages = foldPages(await queryAll(post, { ...window, dimensions: ["page"] }), origin);
  out("pages.csv", toCsv(["Page"], pages));
  // One whole-range query: a day-by-day pull returned the same 3,613 rows on 2026-11-14,
  // because Google withholds rare queries either way.
  const pageQuery = foldPages(await queryAll(post, { ...window, dimensions: ["page", "query"] }), origin);
  out("page-query.csv", toCsv(["Page", "Query"], pageQuery));
  const series = async (name, extra = {}) => out(`series/${name}.csv`, toCsv(["Date"], await queryAll(post, { ...window, dimensions: ["date"], ...extra })));
  await series("date");
  await series("date-mobile", filter({ dimension: "device", operator: "equals", expression: "MOBILE" }));
  await series("date-desktop-non-us", filter({ dimension: "device", operator: "equals", expression: "DESKTOP" }, { dimension: "country", operator: "notEquals", expression: "usa" }));

  const sum = (rows) => rows.reduce((total, row) => total + row.impressions, 0);
  const pageImpressions = sum(pages);
  console.log(`Wrote ${pages.length} pages, ${pageQuery.length} page+query rows (${start} to ${end}) to ${values.out}`);
  console.log(`Query-level rows cover ${pageImpressions ? ((sum(pageQuery) / pageImpressions) * 100).toFixed(1) : "n/a"}% of page-level impressions (anonymized queries are not returned).`);
});
