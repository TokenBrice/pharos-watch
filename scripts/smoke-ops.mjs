#!/usr/bin/env node

const DEFAULT_OPS_UI_URL = process.env.SMOKE_OPS_UI_URL ?? "https://ops.pharos.watch/admin/";
const DEFAULT_OPS_API_BASE = process.env.SMOKE_OPS_API_BASE ?? "https://ops-api.pharos.watch";

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

function requireEnv(name) {
  const value = (process.env[name] ?? "").trim();
  if (!value) {
    throw new Error(`Missing required environment variable: ${name}`);
  }
  return value;
}

function buildAccessHeaders() {
  return {
    "CF-Access-Client-Id": requireEnv("OPS_SMOKE_CF_ACCESS_CLIENT_ID"),
    "CF-Access-Client-Secret": requireEnv("OPS_SMOKE_CF_ACCESS_CLIENT_SECRET"),
  };
}

function ensureUrl(input) {
  const trimmed = (input ?? "").trim();
  if (!trimmed) {
    throw new Error("Missing ops smoke URL.");
  }
  const url = new URL(trimmed);
  if (
    url.hostname === "ops.pharos.watch" &&
    (url.pathname === "/status" || url.pathname === "/status/")
  ) {
    url.pathname = "/admin/";
    url.search = "";
  }
  return url.toString();
}

async function fetchText(url, headers) {
  const response = await fetch(url, { headers, redirect: "manual" });
  const body = await response.text();
  return { response, body };
}

async function fetchJson(url, headers) {
  const response = await fetch(url, { headers, redirect: "manual" });
  const bodyText = await response.text();
  let body = null;
  try {
    body = JSON.parse(bodyText);
  } catch {
    body = null;
  }
  return { response, body, bodyText };
}

async function run() {
  const headers = buildAccessHeaders();
  const opsUiUrl = ensureUrl(DEFAULT_OPS_UI_URL);
  const opsApiBase = ensureUrl(DEFAULT_OPS_API_BASE);
  const opsUiOrigin = new URL(opsUiUrl).origin;

  console.log(`[smoke-ops] Running checks against ${opsUiUrl} and ${opsApiBase}`);

  const ui = await fetchText(opsUiUrl, headers);
  if (ui.response.status === 200) {
    assert(ui.body.includes("Operator Admin"), "Ops UI did not render the Operator Admin shell");
    assert(!ui.body.includes("Operator tooling is no longer available on the public host."), "Ops UI returned the public-host fallback shell");
    console.log("[smoke-ops] OK ops UI via service token");
  } else {
    const location = ui.response.headers.get("Location") ?? "";
    assert(ui.response.status === 302, `Expected ops UI 200 or 302, got ${ui.response.status}`);
    assert(location.includes(".cloudflareaccess.com"), "Ops UI redirect did not point to Cloudflare Access");
    console.log("[smoke-ops] OK ops UI access gate");
  }

  const status = await fetchJson(new URL("/api/status", opsApiBase).toString(), headers);
  if (status.response.status !== 200) {
    console.error(`[smoke-ops] /api/status returned ${status.response.status}, body: ${status.bodyText?.slice(0, 500)}`);
    console.error(`[smoke-ops] Response headers:`, Object.fromEntries(status.response.headers.entries()));
  }
  assert(status.response.status === 200, `Expected ops API /api/status 200, got ${status.response.status}`);
  assert(status.body && typeof status.body === "object", "Ops API /api/status did not return JSON");
  assert(typeof status.body.overallStatus === "string", "Ops API /api/status missing overallStatus");
  console.log(`[smoke-ops] OK ops API /api/status (${status.body.overallStatus})`);

  const proxiedStatus = await fetchJson(new URL("/api/admin/status", opsUiOrigin).toString(), headers);
  if (proxiedStatus.response.status !== 200) {
    console.error(`[smoke-ops] /api/admin/status returned ${proxiedStatus.response.status}, body: ${proxiedStatus.bodyText?.slice(0, 500)}`);
    console.error(`[smoke-ops] Response headers:`, Object.fromEntries(proxiedStatus.response.headers.entries()));
  }
  assert(proxiedStatus.response.status === 200, `Expected ops UI /api/admin/status 200, got ${proxiedStatus.response.status}`);
  assert(proxiedStatus.body && typeof proxiedStatus.body === "object", "Ops UI /api/admin/status did not return JSON");
  assert(typeof proxiedStatus.body.overallStatus === "string", "Ops UI /api/admin/status missing overallStatus");
  console.log(`[smoke-ops] OK ops UI /api/admin/status (${proxiedStatus.body.overallStatus})`);

  const history = await fetchJson(new URL("/api/status-history?limit=5", opsApiBase).toString(), headers);
  assert(history.response.status === 200, `Expected ops API /api/status-history 200, got ${history.response.status}`);
  assert(history.body && Array.isArray(history.body.transitions), "Ops API /api/status-history missing transitions array");
  console.log(`[smoke-ops] OK ops API /api/status-history (${history.body.transitions.length} transitions)`);

  const audit = await fetchJson(new URL("/api/audit-depeg-history?dry-run=true&limit=1", opsApiBase).toString(), headers);
  assert(audit.response.status === 200, `Expected dry-run audit 200, got ${audit.response.status}`);
  assert(audit.body && audit.body.dryRun === true, "Dry-run audit response missing dryRun=true");
  console.log("[smoke-ops] OK ops API dry-run action");

  console.log("[smoke-ops] All checks passed.");
}

run().catch((error) => {
  console.error(`[smoke-ops] FAILED: ${error instanceof Error ? error.message : String(error)}`);
  process.exit(1);
});
