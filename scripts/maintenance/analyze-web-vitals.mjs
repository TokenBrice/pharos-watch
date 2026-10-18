#!/usr/bin/env node

import { createSign } from "node:crypto";
import { appendFileSync, existsSync, readFileSync } from "node:fs";
import { parseCliInteger, parseStrictCliArgs, runDirectCli, writeFileResolved } from "../lib/cli-args.mjs";

export const VITAL_BUDGETS = { LCP: 2500, INP: 200, CLS: 0.1, TTFB: 800, "fresh_data_ready:home-hero": 10_000, "fresh_data_ready:detail-summary": 10_000 };
const DIMENSIONS = ["eventName", "customEvent:page_path", "customEvent:name", "customEvent:value", "customEvent:id", "customEvent:surface", "customEvent:navigation_type"];

export function routeFamily(path) {
  if (path === "/") return "home";
  if (/^\/stablecoin\/[^/]+\/?$/.test(path)) return "stablecoin-detail";
  if (/^\/(?:docs|methodology|privacy|about)(?:\/|$)/.test(path)) return "prose";
  return path.split("/").filter(Boolean)[0] || "unknown";
}

export function summarizeVitals(rows) {
  const finalMetrics = new Map();
  for (const row of rows) {
    const [event, path, name, raw, id, surface, navigation] = row.dimensionValues.map((cell) => cell.value);
    if ([path, name, raw, id, surface, navigation].includes("(other)")) {
      throw new Error("GA4 report contains cardinality-limited (other) rows; p75 cannot be computed reliably");
    }
    if ((event === "web_vital" && name === "(not set)")
      || (event === "fresh_data_ready" && surface === "(not set)")) {
      throw new Error("Missing GA4 event dimensions: register name and surface before collecting the baseline");
    }
    const metric = event === "fresh_data_ready" ? `${event}:${surface}` : name;
    if (!(metric in VITAL_BUDGETS)) continue;
    if (!path?.startsWith("/") || !id || id === "(not set)" || !raw || raw === "(not set)" || navigation === "(not set)") {
      throw new Error("Missing GA4 event dimensions: register page_path, name, value, id, surface, navigation_type before collecting the baseline");
    }
    const value = Number(raw);
    if (!Number.isFinite(value) || value < 0) throw new Error(`Invalid numeric value for ${metric}`);
    const key = JSON.stringify([event, path, metric, id, navigation]);
    const previous = finalMetrics.get(key);
    // web-vitals can update a metric ID; retain the final/worst cumulative value.
    if (!previous || value > previous.value) finalMetrics.set(key, { family: routeFamily(path), metric, value, navigation });
  }
  const groups = new Map();
  for (const row of finalMetrics.values()) {
    const key = `${row.family}|${row.metric}|${row.navigation}`;
    if (!groups.has(key)) groups.set(key, { ...row, values: [] });
    groups.get(key).values.push(row.value);
  }
  return [...groups.values()].map(({ family, metric, navigation, values }) => {
    values.sort((a, b) => a - b);
    const p75 = values[Math.ceil(values.length * 0.75) - 1];
    return { family, metric, navigation, samples: values.length, p75, budget: VITAL_BUDGETS[metric], overBudget: p75 > VITAL_BUDGETS[metric] };
  }).sort((a, b) => `${a.family}/${a.metric}/${a.navigation}`.localeCompare(`${b.family}/${b.metric}/${b.navigation}`));
}

export async function readGa4Rows(property, accessToken, days, fetcher = fetch) {
  const rows = [];
  let count;
  do {
    const response = await fetcher(`https://analyticsdata.googleapis.com/v1beta/properties/${property}:runReport`, {
      method: "POST", redirect: "error", headers: { Authorization: `Bearer ${accessToken}`, "Content-Type": "application/json" },
      body: JSON.stringify({ dateRanges: [{ startDate: `${days}daysAgo`, endDate: "yesterday" }],
        dimensions: DIMENSIONS.map((name) => ({ name })), metrics: [{ name: "eventCount" }],
        dimensionFilter: { filter: { fieldName: "eventName", inListFilter: { values: ["web_vital", "fresh_data_ready"] } } },
        limit: 100_000, offset: rows.length }), signal: AbortSignal.timeout(60_000),
    });
    if (!response.ok) throw new Error(`GA4 Data API HTTP ${response.status}; verify property access, analytics.readonly scope and registered custom event dimensions (${DIMENSIONS.slice(1).join(", ")})`);
    const report = await response.json();
    if (report.metadata?.dataLossFromOtherRow || report.metadata?.subjectToThresholding || report.metadata?.samplingMetadatas?.length) {
      throw new Error("GA4 report is cardinality-limited, thresholded or sampled; p75 cannot be computed reliably (use a shorter window or raw BigQuery export)");
    }
    count = report.rowCount ?? 0;
    if (!Number.isSafeInteger(count) || count < 0 || !Array.isArray(report.rows ?? [])) throw new Error("Invalid GA4 report shape");
    const page = report.rows ?? [];
    if (rows.length < count && !page.length) throw new Error("GA4 report pagination ended before rowCount");
    rows.push(...page);
  } while (rows.length < count);
  return rows;
}

async function accessToken(env) {
  if (env.GA4_ACCESS_TOKEN) return env.GA4_ACCESS_TOKEN;
  if (!env.GOOGLE_APPLICATION_CREDENTIALS) throw new Error("Missing GA4 credentials: set GA4_ACCESS_TOKEN or GOOGLE_APPLICATION_CREDENTIALS (service-account JSON file with property Viewer access)");
  const credentials = JSON.parse(readFileSync(env.GOOGLE_APPLICATION_CREDENTIALS, "utf8"));
  if (!credentials.client_email || !credentials.private_key) throw new Error("GOOGLE_APPLICATION_CREDENTIALS must name a service-account JSON file with client_email and private_key");
  const now = Math.floor(Date.now() / 1000);
  const encode = (value) => Buffer.from(JSON.stringify(value)).toString("base64url");
  const unsigned = `${encode({ alg: "RS256", typ: "JWT" })}.${encode({ iss: credentials.client_email,
    scope: "https://www.googleapis.com/auth/analytics.readonly", aud: "https://oauth2.googleapis.com/token", iat: now, exp: now + 3600 })}`;
  const signature = createSign("RSA-SHA256").update(unsigned).sign(credentials.private_key, "base64url");
  const response = await fetch("https://oauth2.googleapis.com/token", { method: "POST", redirect: "error", body: new URLSearchParams({
    grant_type: "urn:ietf:params:oauth:grant-type:jwt-bearer", assertion: `${unsigned}.${signature}`,
  }), signal: AbortSignal.timeout(30_000) });
  if (!response.ok) throw new Error(`GA4 service-account token exchange failed (HTTP ${response.status})`);
  const token = await response.json();
  if (typeof token.access_token !== "string") throw new Error("GA4 token exchange returned no access_token");
  return token.access_token;
}

runDirectCli(import.meta.url, async () => {
  const { values } = parseStrictCliArgs(process.argv.slice(2), { options: { days: { type: "string", default: "7" }, out: { type: "string" } } });
  if (values.help) { console.log("Usage: npm run analyze:web-vitals -- [--days 7] [--out report.json]\nRead-only GA4 Data API report. Requires GA4_PROPERTY_ID plus GA4_ACCESS_TOKEN or GOOGLE_APPLICATION_CREDENTIALS. Prints weekly per-route-family p75 diagnostics and appends GITHUB_STEP_SUMMARY when set."); return; }
  if (existsSync(".env.local")) process.loadEnvFile(".env.local");
  const property = process.env.GA4_PROPERTY_ID;
  if (!property || !/^\d+$/.test(property)) throw new Error("Missing/invalid GA4_PROPERTY_ID: set the numeric GA4 property ID (not the G- measurement ID)");
  const days = parseCliInteger(values.days, { name: "--days", min: 1, max: 365 });
  const rows = await readGa4Rows(property, await accessToken(process.env), days);
  const groups = summarizeVitals(rows);
  if (!groups.length) throw new Error("No usable web_vital/fresh_data_ready samples in GA4 window; missing data is not a passing performance verdict");
  const report = { generatedAt: new Date().toISOString(), days, ending: "yesterday", rowsRead: rows.length, groups };
  if (values.out) writeFileResolved(String(values.out), JSON.stringify(report, null, 2));
  const summary = ["## GA4 observed Web Vitals (advisory)", `Window: previous ${days} complete days, ending yesterday in the GA property timezone. Nearest-rank p75 per unique metric ID, max of repeated values. This is consent/gate-limited RUM, not CrUX; sparse groups are not population estimates. No samples means unknown, never zero.`,
    "CLS is unitless; all other values and budgets are milliseconds. Route-change readiness starts at the router-observed path change, not click time. Thresholds are diagnostic; ratchet only after a stable baseline.",
    "| Route family | Metric | Navigation | n | p75 | Budget | Verdict |", "| --- | --- | --- | ---: | ---: | ---: | --- |",
    ...groups.map((g) => `| ${g.family} | ${g.metric} | ${g.navigation} | ${g.samples} | ${g.p75.toFixed(g.metric === "CLS" ? 4 : 0)} | ${g.budget} | ${g.overBudget ? "over budget" : "within budget"} |`), ""].join("\n");
  console.log(summary);
  if (process.env.GITHUB_STEP_SUMMARY) appendFileSync(process.env.GITHUB_STEP_SUMMARY, summary);
});
