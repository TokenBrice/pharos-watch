#!/usr/bin/env node

import { appendFileSync, readFileSync } from "node:fs";
import { API_CACHE_PROFILES } from "../../shared/lib/api-cache-profiles.ts";
import { parseStrictCliArgs, runDirectCli } from "../lib/cli-args.mjs";
import { loadCloudflareAccountStateManifest } from "./check-cloudflare-account-state-drift.mjs";

const { siteOrigin: SITE_ORIGIN, apiOrigin: API_ORIGIN } = JSON.parse(
  readFileSync(new URL("../../shared/lib/runtime-origins.json", import.meta.url), "utf8"),
);
const REQUEST_TIMEOUT_MS = 15_000;

// Direct reads are exempt public GETs. Proxied reads are browser-shaped and
// exercise both the lifted 10s profile and profiles above/at the zone floor.
const SAMPLES = [
  { lane: "direct", path: "/api/health", profile: "realtime" },
  { lane: "direct", path: "/api/dependency-scenarios/v1", profile: "noStore" },
  { lane: "site-data", path: "/api/health", profile: "realtime" },
  { lane: "site-data", path: "/api/stablecoins", profile: "producerBacked" },
  { lane: "site-data", path: "/api/bluechip-ratings", profile: "slow" },
  { lane: "site-data", path: "/api/dependency-scenarios/v1", profile: "noStore" },
];

function directives(header) {
  const result = new Map();
  for (const part of header.split(",")) {
    const separator = part.indexOf("=");
    const name = (separator < 0 ? part : part.slice(0, separator)).trim().toLowerCase();
    if (!/^[\w-]+$/.test(name)) throw new Error(`malformed Cache-Control directive ${JSON.stringify(part)}`);
    let value = true;
    if (separator >= 0) {
      const raw = part.slice(separator + 1).trim();
      const quoted = raw.startsWith('"') && raw.endsWith('"') && raw.length >= 2;
      const token = quoted ? raw.slice(1, -1) : raw;
      if (!token || (quoted ? token.includes('"') : /[\s",]/.test(token))) {
        throw new Error(`malformed Cache-Control directive ${JSON.stringify(part)}`);
      }
      value = token;
    }
    if (result.has(name)) throw new Error(`duplicate Cache-Control directive ${name}`);
    result.set(name, value);
  }
  return result;
}

export function compareLiveCacheControl(header, profile, browserFloorSeconds) {
  if (!Number.isInteger(browserFloorSeconds) || browserFloorSeconds < 0) {
    throw new Error("zone.browser_cache_ttl must be a nonnegative integer; live policy cannot be assessed without the documented floor");
  }
  const source = API_CACHE_PROFILES[profile];
  if (!source) throw new Error(`Unknown API cache profile: ${profile}`);
  const expected = directives(source);
  // no-store is never made cacheable by the accepted browser floor. Edge TTL
  // and stale-while-revalidate remain exactly source-owned, not zone-adjusted.
  if (!expected.has("no-store") && expected.has("max-age")) {
    expected.set("max-age", String(Math.max(Number(expected.get("max-age")), browserFloorSeconds)));
  }
  const sourceMaxAge = directives(source).get("max-age");
  const issues = [];
  try {
    const actual = directives(header ?? "");
    for (const name of new Set([...expected.keys(), ...actual.keys()])) {
      // Cloudflare applies the zone browser floor only to responses it serves
      // from cache; an origin miss keeps the source browser TTL, which is also valid.
      if (name === "max-age" && sourceMaxAge !== undefined && actual.get(name) === sourceMaxAge) continue;
      if (actual.get(name) !== expected.get(name)) {
        issues.push(`${name}: expected ${JSON.stringify(expected.get(name) ?? "absent")}, found ${JSON.stringify(actual.get(name) ?? "absent")}`);
      }
    }
  } catch (error) {
    issues.push(error.message);
  }
  return { source, expected: [...expected].map(([key, value]) => value === true ? key : `${key}=${value}`).join(", "), issues };
}

/**
 * @param {{ manifest?: ReturnType<typeof loadCloudflareAccountStateManifest>, fetchImpl?: (url: string, init?: RequestInit) => Promise<Response>, consoleImpl?: { log: (...args: unknown[]) => void } }} [options]
 */
export async function runLiveApiCachePolicyCheck({
  manifest = loadCloudflareAccountStateManifest(), fetchImpl = fetch, consoleImpl = console,
} = {}) {
  const floor = manifest.zone.browser_cache_ttl;
  // Validate configuration before performing any network reads.
  compareLiveCacheControl(API_CACHE_PROFILES.noStore, "noStore", floor);
  const rows = [];
  for (const sample of SAMPLES) {
    const url = sample.lane === "direct"
      ? new URL(sample.path, API_ORIGIN).href
      : new URL(sample.path.replace(/^\/api\//, "/_site-data/"), SITE_ORIGIN).href;
    const policy = compareLiveCacheControl(API_CACHE_PROFILES[sample.profile], sample.profile, floor);
    const row = { ...sample, url, source: policy.source, expected: policy.expected, actual: null, issues: [] };
    try {
      const response = await fetchImpl(url, {
        method: "GET", redirect: "manual", signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
        headers: { Accept: "application/json", ...(sample.lane === "site-data"
          ? { Origin: SITE_ORIGIN, Referer: `${SITE_ORIGIN}/` } : {}) },
      });
      try {
        row.actual = response.headers.get("cache-control");
        if (response.status !== 200) row.issues.push(`expected direct HTTP 200, found ${response.status}`);
        if (!/\bapplication\/json\b/i.test(response.headers.get("content-type") ?? "")) {
          row.issues.push("expected application/json response, not a challenge/login/error document");
        }
        row.issues.push(...compareLiveCacheControl(row.actual, sample.profile, floor).issues);
      } finally {
        // Headers are the evidence; do not buffer a cohort or leave a connection open.
        await response.body?.cancel();
      }
    } catch (error) {
      row.issues.push(`public GET failed: ${error instanceof Error ? error.message : String(error)}`);
    }
    rows.push(row);
  }
  const summary = ["## Live API Cache-Control policy (G-6)",
    `Response evidence only; account settings are assessed separately. Accepted zone browser floor: ${floor}s. Browser max-age = source max-age (origin miss) or max(source max-age, floor) (edge hit); edge/SWR and no-store are unchanged.`,
    ...rows.map((row) => `${row.issues.length ? "FAIL" : "PASS"} [${row.lane}/${row.profile}] ${row.url}: expected ${JSON.stringify(row.expected)}, received ${JSON.stringify(row.actual)}${row.issues.length ? ` — ${row.issues.join("; ")}` : ""}`), ""].join("\n");
  consoleImpl.log(summary);
  return { ok: rows.every((row) => row.issues.length === 0), rows, summary };
}

runDirectCli(import.meta.url, async () => {
  const { values } = parseStrictCliArgs(process.argv.slice(2));
  if (values.help) {
    console.log("Usage: node scripts/ci/check-live-api-cache-policy.mjs");
    console.log("Read-only public GET cache-policy checks on direct API and same-origin site-data; no secrets required.");
    return;
  }
  const report = await runLiveApiCachePolicyCheck();
  if (process.env.GITHUB_STEP_SUMMARY) appendFileSync(process.env.GITHUB_STEP_SUMMARY, report.summary);
  if (!report.ok) throw new Error("Live API Cache-Control drift detected; inspect per-endpoint source/effective/received policy above (zone settings alone do not prove response policy).");
});
