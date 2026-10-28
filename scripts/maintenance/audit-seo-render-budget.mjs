#!/usr/bin/env node

import { CliUsageError, parseStrictCliArgs, parseCliInteger, runDirectCli } from "../lib/cli-args.mjs";
import { getBrowserLaunchOptions, loadChromium } from "../lib/smoke-runtime.mjs";

const DEFAULT_BASE_URL = process.env.SEO_RENDER_BUDGET_URL ?? "https://pharos.watch";
const DEFAULT_ROUTES = [
  "/",
  "/stablecoin/usdt-tether/",
  "/stablecoin/usdc-circle/",
  "/stablecoin/usde-ethena/",
  "/stablecoin/dai-makerdao/",
  "/stablecoin/fdusd-first-digital/",
  "/chains/ethereum/",
  "/liquidity/",
  "/depeg/",
  "/yield/",
  "/safety-scores/",
  "/flows/",
  "/api/",
  "/alt-pegs/",
  "/compliance/",
];
const DEFAULT_WAIT_MS = "4000";
const CAPTURE_TIMEOUT_MS = 45_000;
const MOBILE_VIEWPORT = { width: 412, height: 915 };
const TALL_VIEWPORT = { width: 412, height: 12_000 };
const REPLAY_INJECTION_HEADER = "x-pharos-seo-audit-injection";
const REPLAY_INJECTION_BODY = JSON.stringify({ error: "SEO audit injected API failure" });
const PROVENANCE_HEADER_NAMES = [
  "cache-control",
  "cdn-cache-control",
  "cf-cache-status",
  "age",
  "x-data-age",
  "x-data-updated-at",
  "x-data-freshness",
  "x-data-freshness-reason",
  "x-data-assessed-at",
  "x-data-freshness-budget",
  "x-safety-score-status",
  "x-safety-score-updated-at",
  "x-safety-score-generation",
];
const GENERATION_HEADER_NAMES = ["x-safety-score-generation", "x-data-updated-at"];

/**
 * Later-wave expectations are listed here but never evaluated by this audit
 * until their owning implementation enrolls the exact selector and fixtures.
 */
export const UNENROLLED_SENTINEL_EXPECTATIONS = [
  { id: "profile.heading-semantics", ownerItem: "C4", reason: "enrolled-by-C4" },
  { id: "profile.deployment-facts", ownerItem: "C3", reason: "enrolled-by-C3" },
  { id: "safety-scores.dated-preview", ownerItem: "B1", reason: "enrolled-by-B1" },
  { id: "compliance.regime-panels", ownerItem: "B2", reason: "enrolled-by-B2" },
];

/** C1's five-profile cohort: each route must carry the inactive-panel facts. */
export const HISTORY_PREVIEW_PILOT_ROUTES = [
  "/stablecoin/usdt-tether/",
  "/stablecoin/usdc-circle/",
  "/stablecoin/usde-ethena/",
  "/stablecoin/dai-makerdao/",
  "/stablecoin/fdusd-first-digital/",
];

/** Route fixtures are declared here, never inferred from the live DOM. */
export function getRouteExpectations(route) {
  const pathname = String(route ?? "").split(/[?#]/)[0].replace(/\/+$/, "") || "/";
  const normalized = `${pathname}/`;
  if (!HISTORY_PREVIEW_PILOT_ROUTES.includes(normalized)) return null;
  return {
    panels: { required: ["depeg"] },
    depegHistoryPreview: true,
  };
}

export const SEO_RENDER_BUDGET_HELP = [
  "Usage: node scripts/maintenance/audit-seo-render-budget.mjs [--url <url>] [--routes <comma-separated-routes>] [--wait-ms <n>] [--api-failure-replay] [--json]",
  "Read-only browser render-budget audit; defaults to the live site and waits 4000 ms.",
  "--api-failure-replay  Replay selected profile, Alt-Pegs and seed-pilot routes with API reads returning an injected 503.",
].join("\n");

export function parseSeoRenderBudgetArgs(argv) {
  const { values } = parseStrictCliArgs(argv, {
    options: {
      url: { type: "string", default: DEFAULT_BASE_URL },
      routes: { type: "string" },
      json: { type: "boolean" },
      "wait-ms": { type: "string", default: DEFAULT_WAIT_MS },
      "api-failure-replay": { type: "boolean" },
    },
  });
  const args = {
    baseUrl: values.url,
    routes: values.routes === undefined ? DEFAULT_ROUTES
      : values.routes.split(",").map((route) => route.trim()).filter(Boolean),
    json: values.json === true,
    waitMs: parseCliInteger(values["wait-ms"], { name: "--wait-ms", min: 0 }),
    apiFailureReplay: values["api-failure-replay"] === true,
    help: values.help === true,
  };

  if (args.routes.length === 0) {
    throw new CliUsageError("At least one route is required. Pass --routes /,/stablecoin/usdt-tether/.");
  }

  return args;
}

function normalizeBaseUrl(input) {
  const url = new URL(input || DEFAULT_BASE_URL);
  url.pathname = "/";
  url.search = "";
  url.hash = "";
  return url;
}

function resolveRoute(baseUrl, route) {
  return new URL(route.startsWith("/") ? route : `/${route}`, baseUrl).toString();
}

function byteLength(text) {
  return Buffer.byteLength(text, "utf8");
}

function formatError(error) {
  return error instanceof Error ? error.message : String(error);
}

function truncate(value, max = 240) {
  const text = String(value ?? "");
  return text.length > max ? `${text.slice(0, max)}…` : text;
}

/** Route shape drives the template sentinels; it never adds or removes routes. */
export function classifyRouteSurface(route) {
  const pathname = String(route ?? "").split(/[?#]/)[0].replace(/\/+$/, "") || "/";
  if (pathname === "/alt-pegs") return "alt-pegs";
  if (pathname === "/safety-scores") return "safety-scores";
  if (pathname === "/compliance") return "compliance";
  const profile = /^\/stablecoin\/([^/]+)$/.exec(pathname);
  if (profile && profile[1] !== "yield") return "profile";
  return "generic";
}

/** Only the fixed Wave 1 surfaces replay; `--routes` stays the outer bound. */
export function isReplayEligibleRoute(route) {
  return classifyRouteSurface(route) !== "generic";
}

export function selectReplayRoutes(routes) {
  return routes.filter((route) => isReplayEligibleRoute(route));
}

function classifyResource(url, resourceType) {
  const pathname = new URL(url).pathname;
  if (pathname.startsWith("/_site-data/")) return "siteData";
  if (resourceType === "script" || pathname.endsWith(".js")) return "script";
  if (resourceType === "stylesheet" || pathname.endsWith(".css")) return "style";
  if (resourceType === "font" || /\.(woff2?|ttf|otf)$/i.test(pathname)) return "font";
  if (resourceType === "image" || /\.(png|jpe?g|gif|webp|svg|ico)$/i.test(pathname)) return "image";
  return "other";
}

function isDataReadUrl(input, origin) {
  try {
    const url = new URL(input);
    if (origin && url.origin !== origin) return false;
    return url.pathname.startsWith("/_site-data/")
      || url.pathname === "/api"
      || url.pathname.startsWith("/api/");
  } catch {
    return false;
  }
}

function emptyCounters() {
  return {
    requests: 0,
    accountingErrors: 0,
    blockedAnalyticsRequests: 0,
    scriptRequests: 0,
    styleRequests: 0,
    fontRequests: 0,
    imageRequests: 0,
    siteDataRequests: 0,
    knownContentLengthBytes: 0,
    observedTransferBytes: 0,
    scriptKnownBytes: 0,
    scriptObservedBytes: 0,
    styleKnownBytes: 0,
    styleObservedBytes: 0,
    fontKnownBytes: 0,
    fontObservedBytes: 0,
  };
}

function emptyFailures() {
  return {
    httpData: [],
    failedRequests: [],
    pageErrors: [],
    intentionalBlocks: [],
  };
}

function pickProvenanceHeaders(headers) {
  const observed = {};
  for (const name of PROVENANCE_HEADER_NAMES) {
    const value = headers?.[name];
    if (value != null) observed[name] = truncate(value, 160);
  }
  return observed;
}

function recordProvenance(state, response) {
  if (state.provenance.sourceGeneration) return;
  if (!isDataReadUrl(response.url(), state.origin)) return;
  const headers = response.headers();
  for (const name of GENERATION_HEADER_NAMES) {
    const value = headers?.[name];
    if (value) {
      state.provenance.sourceGeneration = truncate(value, 160);
      state.provenance.source = `response-header:${name}`;
      return;
    }
  }
}

/** Keep analytics script cost in the budget without recording synthetic visits. */
export async function blockAnalyticsCollection(page, counters, intentional = {}) {
  await page.route(
    (url) =>
      ["google-analytics.com", "analytics.google.com", "google.com"].some(
        (host) => url.hostname === host || url.hostname.endsWith(`.${host}`),
      ) && ["/collect", "/g/collect", "/j/collect", "/mp/collect", "/debug/mp/collect", "/batch"].includes(url.pathname),
    async (route) => {
      counters.blockedAnalyticsRequests += 1;
      const url = route.request().url();
      intentional.analyticsUrls?.add(url);
      await route.abort();
    },
  );
}

function addResponse(counters, response) {
  const type = classifyResource(response.url(), response.request().resourceType());
  const contentLength = Number.parseInt(response.headers()["content-length"] ?? "0", 10);
  const knownBytes = Number.isFinite(contentLength) ? contentLength : 0;

  counters.requests += 1;
  counters.knownContentLengthBytes += knownBytes;

  if (type === "script") {
    counters.scriptRequests += 1;
    counters.scriptKnownBytes += knownBytes;
  } else if (type === "style") {
    counters.styleRequests += 1;
    counters.styleKnownBytes += knownBytes;
  } else if (type === "font") {
    counters.fontRequests += 1;
    counters.fontKnownBytes += knownBytes;
  } else if (type === "image") {
    counters.imageRequests += 1;
  } else if (type === "siteData") {
    counters.siteDataRequests += 1;
  }
}

function addPerformanceResource(counters, resource) {
  const observedBytes = Math.max(resource.transferSize ?? 0, resource.encodedBodySize ?? 0);
  if (!Number.isFinite(observedBytes) || observedBytes <= 0) return;

  const type = classifyResource(resource.name, resource.initiatorType);
  counters.observedTransferBytes += observedBytes;
  if (type === "script") {
    counters.scriptObservedBytes += observedBytes;
  } else if (type === "style") {
    counters.styleObservedBytes += observedBytes;
  } else if (type === "font") {
    counters.fontObservedBytes += observedBytes;
  }
}

function recordResponseFailure(state, response) {
  const status = response.status();
  if (status < 400) return;
  const headers = response.headers();
  if (headers?.[REPLAY_INJECTION_HEADER] === "api-failure-replay") return;
  const url = response.url();
  const resourceType = response.request().resourceType();
  if (isDataReadUrl(url, state.origin)) {
    state.failures.httpData.push({
      url,
      status,
      resourceType,
      headers: pickProvenanceHeaders(headers),
    });
  } else if (resourceType === "script") {
    state.failures.failedRequests.push({ url, resourceType, failure: `http-${status}` });
  }
}

/**
 * Bucket page errors, failed requests and failing data reads. Analytics
 * suppression is an intentional block, not an unexpected production failure.
 */
export function installFailureListeners(page, state) {
  page.on("pageerror", (error) => {
    state.failures.pageErrors.push({ message: truncate(error?.message ?? String(error)) });
  });
  page.on("requestfailed", (request) => {
    const url = request.url();
    if (state.intentional?.analyticsUrls?.has(url) || state.intentional?.replayUrls?.has(url)) return;
    state.failures.failedRequests.push({
      url,
      resourceType: request.resourceType(),
      failure: truncate(request.failure()?.errorText ?? null),
    });
  });
  page.on("response", (response) => {
    try {
      addResponse(state.counters, response);
    } catch (error) {
      // Best-effort audit; individual response accounting should not abort the route.
      state.counters.accountingErrors += 1;
      if (process.env.DEBUG) {
        console.warn(
          `[seo-render-budget] response accounting failed for ${response.url()}: ${formatError(error)}`,
        );
      }
    }
    recordResponseFailure(state, response);
    recordProvenance(state, response);
  });
}

/**
 * Runs both in the audit's browser page (serialized through
 * `buildCollectExpression`) and in jsdom tests. Keep it self-contained: it may
 * only use its parameters and DOM globals.
 */
export function collectSnapshotFacts(document, options = {}) {
  const view = document.defaultView;
  const documentUrl = options.documentUrl || (view ? view.location.href : "https://pharos.watch/");
  let origin = "";
  try {
    origin = new URL(documentUrl).origin;
  } catch {
    origin = "";
  }

  const normalize = (value) => String(value ?? "").replace(/\s+/g, " ").trim();
  const ignoredSelector = "script,style,template,noscript";

  const textOf = (node) => {
    if (!node) return "";
    const clone = node.cloneNode(true);
    if (clone.querySelectorAll) {
      for (const ignored of Array.from(clone.querySelectorAll(ignoredSelector))) ignored.remove();
    }
    return normalize(clone.textContent);
  };

  const isVisible = (element) => {
    for (let node = element; node; node = node.parentElement) {
      const tag = node.tagName;
      if (tag === "SCRIPT" || tag === "STYLE" || tag === "TEMPLATE" || tag === "NOSCRIPT") return false;
      if (node.hidden) return false;
      const style = view && view.getComputedStyle ? view.getComputedStyle(node) : null;
      if (!style) continue;
      if (style.display === "none" || style.visibility === "hidden" || style.visibility === "collapse") return false;
    }
    return true;
  };

  const visibleTextCharsOf = (root) => {
    if (!root) return null;
    if (typeof root.innerText === "string") return normalize(root.innerText).length;
    if (!document.createTreeWalker) return null;
    let chars = 0;
    const walker = document.createTreeWalker(root, 4);
    let node = walker.nextNode();
    while (node) {
      const value = node.nodeValue ?? "";
      if (value.trim() && isVisible(node.parentElement)) chars += normalize(value).length;
      node = walker.nextNode();
    }
    return chars;
  };

  const isFactualRow = (row) => {
    const cells = Array.from(row.querySelectorAll("td"));
    let contentCells = 0;
    let domainWord = false;
    for (const cell of cells) {
      const text = normalize(cell.textContent);
      if (!text) continue;
      contentCells += 1;
      if (/[A-Za-z]{2,}/.test(text)) domainWord = true;
    }
    return contentCells >= 2 && domainWord;
  };

  const main = document.querySelector("main");
  const h1Nodes = Array.from(document.querySelectorAll("h1"));
  const h1 = {
    count: h1Nodes.length,
    text: h1Nodes.length > 0 ? normalize(h1Nodes[0].textContent).slice(0, 200) : "",
  };
  const mainDomTextChars = main ? textOf(main).length : null;
  let mainVisibleTextChars = null;
  let mainVisibleTextReason = null;
  if (options.visibleTextMode === "raw") {
    mainVisibleTextReason = "unstyled-raw-parser";
  } else if (options.visibleTextMode === "styled") {
    mainVisibleTextChars = visibleTextCharsOf(main);
    if (mainVisibleTextChars == null) mainVisibleTextReason = "visible-text-unavailable";
  } else {
    mainVisibleTextReason = "visible-text-not-requested";
  }

  const tables = Array.from(document.querySelectorAll("table")).map((table) => {
    const bodyRows = Array.from(table.querySelectorAll("tbody tr"));
    const rows = bodyRows.length > 0
      ? bodyRows
      : Array.from(table.querySelectorAll("tr")).filter((row) => !row.closest("thead"));
    const testIdHost = table.closest("[data-testid]") || table;
    return {
      id: table.id || null,
      testId: testIdHost.getAttribute("data-testid") || null,
      rows: rows.length,
      factualRows: rows.filter(isFactualRow).length,
    };
  });

  const dataRoot = document.querySelector("#data");
  const profileAnchors = dataRoot
    ? Array.from(dataRoot.querySelectorAll('a[href^="/stablecoin/"]'))
    : [];
  const cardElements = Array.from(document.querySelectorAll("main article, main [data-card]"));
  const cards = {
    dataRoot: dataRoot
      ? {
        present: true,
        profileLinks: profileAnchors.length,
        factualProfileLinks: profileAnchors.filter((anchor) => /[A-Za-z0-9]{2,}/.test(normalize(anchor.textContent))).length,
      }
      : null,
    cardElements: {
      count: cardElements.length,
      factualCount: cardElements.filter((card) => textOf(card).length >= 8).length,
    },
  };

  const panels = Array.from(document.querySelectorAll("[data-history-tab]")).map((panel) => {
    const text = textOf(panel);
    const preview = panel.querySelector('[data-testid="depeg-history-preview"]');
    const previewTable = preview ? preview.querySelector("table") : null;
    const previewBody = previewTable ? previewTable.querySelector("tbody") : null;
    const previewText = textOf(preview);
    return {
      id: panel.id || null,
      tab: panel.getAttribute("data-history-tab"),
      hidden: panel.hasAttribute("hidden") || panel.hidden === true,
      textChars: text.length,
      text: text.slice(0, 160),
      preview: Boolean(preview),
      previewRows: previewBody ? previewBody.querySelectorAll("tr").length : null,
      previewHasCaptureDate: /as of \d{4}-\d{2}-\d{2} UTC/.test(previewText),
      previewHasCoverageScope: previewText.includes("Recorded history; coverage may be incomplete."),
      previewHrefs: preview
        ? Array.from(preview.querySelectorAll('a[href^="/depeg/"]'))
          .map((anchor) => anchor.getAttribute("href"))
          .filter((href) => typeof href === "string")
        : [],
    };
  });

  const disclosures = Array.from(document.querySelectorAll("details")).map((details) => {
    const summary = details.querySelector("summary");
    const bodyClone = details.cloneNode(true);
    const summaryClone = bodyClone.querySelector("summary");
    if (summaryClone) summaryClone.remove();
    return {
      id: details.id || null,
      label: summary ? normalize(summary.textContent).slice(0, 120) : null,
      open: details.hasAttribute("open"),
      bodyTextChars: normalize(bodyClone.textContent).length,
    };
  });

  const lazySections = Array.from(document.querySelectorAll("[data-lazy-section]")).map((wrapper) => {
    const section = wrapper.closest("section[id], div[id]");
    const rect = wrapper.getBoundingClientRect ? wrapper.getBoundingClientRect() : null;
    return {
      sectionId: section ? section.id || null : null,
      mounted: wrapper.childElementCount > 0 || textOf(wrapper).length > 0,
      textChars: textOf(wrapper).length,
      topPx: rect && view ? Math.round(rect.top + (view.scrollY ?? 0)) : null,
    };
  });

  const hrefsFor = (root) => {
    const seen = new Set();
    for (const anchor of Array.from(root.querySelectorAll("a[href]"))) {
      if (anchor.closest(ignoredSelector)) continue;
      const raw = anchor.getAttribute("href");
      if (!raw) continue;
      let resolved;
      try {
        resolved = new URL(raw, documentUrl);
      } catch {
        continue;
      }
      if (origin && resolved.origin !== origin) continue;
      seen.add(`${resolved.pathname}${resolved.search}${resolved.hash}`);
    }
    return Array.from(seen).sort();
  };

  const internalHrefs = hrefsFor(document);
  const mainInternalHrefs = main ? hrefsFor(main) : [];

  const assurancePattern = /proof of reserves|reserve report|attestation|audit|assurance/i;
  const assuranceAnswers = [];
  for (const term of Array.from(document.querySelectorAll("main dt"))) {
    const label = normalize(term.textContent);
    if (!assurancePattern.test(label)) continue;
    const value = term.nextElementSibling && term.nextElementSibling.tagName === "DD" ? term.nextElementSibling : null;
    if (!value) continue;
    assuranceAnswers.push({
      label: label.slice(0, 80),
      text: textOf(value).slice(0, 240),
      links: Array.from(value.querySelectorAll("a[href]"))
        .map((anchor) => {
          let href = anchor.getAttribute("href") || "";
          try {
            href = new URL(href, documentUrl).toString();
          } catch {
            // Keep the raw href when it cannot be resolved.
          }
          return { href, text: normalize(anchor.textContent).slice(0, 80) };
        })
        .filter((link) => /^https?:/i.test(link.href)),
    });
    if (assuranceAnswers.length >= 5) break;
  }

  const observedDates = [
    ...Array.from(document.querySelectorAll("main time[datetime]"))
      .map((time) => ({ datetime: time.getAttribute("datetime"), text: normalize(time.textContent).slice(0, 80) })),
    ...Array.from(document.querySelectorAll("main caption"))
      .map((caption) => ({ datetime: null, text: normalize(caption.textContent).slice(0, 80) })),
  ].slice(0, 12);

  const states = {
    alerts: document.querySelectorAll('[role="alert"]').length,
    emptyNotes: document.querySelectorAll(".pharos-empty-note").length,
    busy: document.querySelectorAll('[aria-busy="true"]').length,
    skeletons: document.querySelectorAll(".animate-pulse").length,
  };

  const dexSection = document.querySelector("#dex-liquidity");
  let dexLiquidity = null;
  if (dexSection) {
    const lazy = dexSection.querySelector("[data-lazy-section]");
    const tableHost = dexSection.querySelector('[data-testid="dex-liquidity-top-pools-table"]');
    const table = tableHost ? tableHost.querySelector("table") : null;
    const rows = table ? Array.from(table.querySelectorAll("tbody tr")) : [];
    const disclosure = Array.from(dexSection.querySelectorAll("details")).find((details) => {
      const summary = details.querySelector("summary");
      return summary ? normalize(summary.textContent).includes("Full market breakdown") : false;
    });
    dexLiquidity = {
      sectionPresent: true,
      lazySectionPresent: Boolean(lazy),
      lazySectionMounted: lazy ? lazy.childElementCount > 0 || textOf(lazy).length > 0 : false,
      tablePresent: Boolean(tableHost),
      rows: rows.length,
      factualRows: rows.filter(isFactualRow).length,
      disclosureOpen: disclosure ? disclosure.hasAttribute("open") : null,
      chartPresent: Boolean(dexSection.querySelector('[role="figure"][aria-label="TVL trend chart"]')),
      alertPresent: Boolean(dexSection.querySelector('[role="alert"]')),
    };
  }

  let safetyScores = null;
  if (dataRoot) {
    safetyScores = {
      present: true,
      profileLinks: cards.dataRoot.profileLinks,
      factualProfileLinks: cards.dataRoot.factualProfileLinks,
      alertPresent: Boolean(dataRoot.querySelector('[role="alert"]')),
    };
  }

  const complianceHost = document.querySelector('[data-table-id="compliance-overview"]');
  const complianceOverview = complianceHost
    ? (() => {
      const table = complianceHost.querySelector("table");
      const rows = table ? Array.from(table.querySelectorAll("tbody tr")) : [];
      return {
        present: true,
        rows: rows.length,
        factualRows: rows.filter(isFactualRow).length,
        alertPresent: Boolean(complianceHost.querySelector('[role="alert"]')),
      };
    })()
    : null;

  return {
    viewport: options.viewport ?? (view ? { width: view.innerWidth, height: view.innerHeight } : null),
    scrollY: typeof options.scrollY === "number" ? options.scrollY : (view ? view.scrollY : null),
    h1,
    mainDomTextChars,
    mainVisibleTextChars,
    mainVisibleTextReason,
    tables,
    cards,
    panels,
    disclosures,
    lazySections,
    internalHrefs,
    mainInternalHrefs,
    assuranceAnswers,
    observedDates,
    states,
    surfaces: {
      dexLiquidity,
      safetyScores,
      complianceOverview,
    },
  };
}

/** Serialize the shared collector for the browser page; jsdom tests call it directly. */
export function buildCollectExpression(options) {
  return `(${collectSnapshotFacts.toString()})(document, ${JSON.stringify(options)})`;
}

/** Destinations present in the baseline snapshot but missing from `next`. */
export function diffInternalHrefs(baseline, next) {
  if (!Array.isArray(baseline) || !Array.isArray(next)) return null;
  const nextSet = new Set(next);
  return baseline.filter((href) => !nextSet.has(href)).sort();
}

/** Canonical currency-hub destinations (`/stablecoins/<slug>/`) under main. */
export function collectDirectoryHrefs(snapshot) {
  if (!snapshot || !Array.isArray(snapshot.mainInternalHrefs)) return null;
  return snapshot.mainInternalHrefs.filter((href) => /^\/stablecoins\/[^/]+\/$/.test(String(href).split(/[?#]/)[0]));
}

function sentinel(id, status, reason, observedCount = null, sourceGeneration = null) {
  return { id, status, reason, observedCount, sourceGeneration };
}

function compareAssuranceAnswers(baselineSnapshot, replaySnapshot) {
  const baselineAnswers = baselineSnapshot?.assuranceAnswers ?? [];
  const replayAnswers = replaySnapshot?.assuranceAnswers ?? [];
  if (baselineAnswers.length === 0) return { status: "not-observed", reason: "baseline-static-answer-unavailable" };
  for (const answer of baselineAnswers) {
    const replayAnswer = replayAnswers.find((candidate) => candidate.label === answer.label);
    if (!replayAnswer || replayAnswer.text !== answer.text) {
      return { status: "missing", reason: "static-assurance-answer-lost" };
    }
    const replayLinks = new Set(replayAnswer.links.map((link) => link.href));
    if (answer.links.some((link) => !replayLinks.has(link.href))) {
      return { status: "missing", reason: "reviewed-reference-destination-lost" };
    }
  }
  return { status: "present", reason: null };
}

/**
 * Wave 1 semantic sentinels. Statuses are advisory observations: only
 * unrecoverable capture failures affect the audit exit code. C1/C3/B1/B2 exact
 * expectations enroll in their own implementation, never here in advance.
 */
/**
 * @param {{
 *   surface: string,
 *   snapshots: { raw: Record<string, any> | null, mobile: Record<string, any> | null, tall: Record<string, any> | null },
 *   hrefLoss: { mobile: string[] | null, tall: string[] | null },
 *   captureStatus: string,
 *   replay?: boolean,
 *   baseline?: { mobile: Record<string, any> | null } | null,
 *   sourceGeneration?: string | null,
 *   expectations?: { panels?: { required?: string[], notApplicable?: string[] } } | null,
 * }} context
 * @returns {Array<{ id: string, status: string, reason: string | null, observedCount: number | null, sourceGeneration: string | null }>}
 */
export function evaluateSentinels({
  surface,
  snapshots,
  hrefLoss,
  captureStatus,
  replay = false,
  baseline = null,
  sourceGeneration = null,
  expectations = null,
}) {
  const mobile = snapshots?.mobile ?? null;
  if (!mobile) {
    return [sentinel("capture.snapshot", "not-observed", captureStatus === "failed" ? "capture-failed" : "hydrated-snapshot-unavailable", null, sourceGeneration)];
  }
  const tall = snapshots?.tall ?? null;
  const raw = snapshots?.raw ?? null;
  const results = [];

  results.push(mobile.h1.count === 1
    ? sentinel("document.h1", "present", null, 1, sourceGeneration)
    : mobile.h1.count > 0
      ? sentinel("document.h1", "missing", "multiple-h1", mobile.h1.count, sourceGeneration)
      : sentinel("document.h1", "missing", "h1-missing", 0, sourceGeneration));

  results.push(mobile.mainDomTextChars == null
    ? sentinel("main.dom-text", "not-observed", "main-element-missing", null, sourceGeneration)
    : mobile.mainDomTextChars > 0
      ? sentinel("main.dom-text", "present", null, mobile.mainDomTextChars, sourceGeneration)
      : sentinel("main.dom-text", "missing", "main-dom-text-empty", 0, sourceGeneration));

  if (!raw) {
    results.push(sentinel("href.retention", "not-observed", "raw-snapshot-unavailable", null, sourceGeneration));
  } else if (!tall) {
    results.push(sentinel("href.retention", "not-observed", "tall-snapshot-unavailable", null, sourceGeneration));
  } else {
    const lost = [...(hrefLoss?.mobile ?? []), ...(hrefLoss?.tall ?? [])];
    results.push(lost.length === 0
      ? sentinel("href.retention", "present", null, raw.internalHrefs.length, sourceGeneration)
      : sentinel("href.retention", "missing", "internal-destinations-lost", lost.length, sourceGeneration));
  }

  if (surface === "profile") {
    if (replay) {
      results.push(sentinel("profile.history-panel-facts", "not-observed", "api-failure-replay-history-panels-not-required", null, sourceGeneration));
    } else if (mobile.panels.length === 0) {
      results.push(sentinel("profile.history-panel-facts", "not-observed", "history-panels-not-mounted", null, sourceGeneration));
    } else {
      const populated = mobile.panels.filter((panel) => panel.textChars > 0);
      const emptyInactive = mobile.panels.filter((panel) => panel.hidden && panel.textChars === 0);
      results.push(emptyInactive.length > 0
        ? sentinel("profile.history-panel-facts", "missing", "inactive-history-panel-without-facts", populated.length, sourceGeneration)
        : sentinel("profile.history-panel-facts", "present", null, populated.length, sourceGeneration));

      // Route fixtures may declare a panel inapplicable (for example the absent
      // NAV Depeg panel) or required; the default audit declares neither.
      for (const tab of expectations?.panels?.required ?? []) {
        const present = populated.some((panel) => panel.tab === tab);
        results.push(sentinel(
          `profile.history-panel.${tab}`,
          present ? "present" : "missing",
          present ? null : "required-panel-without-facts",
          present ? 1 : 0,
          sourceGeneration,
        ));
      }
      for (const tab of expectations?.panels?.notApplicable ?? []) {
        const present = mobile.panels.some((panel) => panel.tab === tab);
        results.push(sentinel(
          `profile.history-panel.${tab}`,
          present ? "present" : "not-applicable",
          present ? null : "panel-not-applicable-for-route-fixture",
          present ? 1 : 0,
          sourceGeneration,
        ));
      }
    }

    if (expectations?.depegHistoryPreview) {
      // The retained-ledger facts are static: an API-failure replay must still
      // show them, so this sentinel evaluates the replay snapshot instead of
      // excusing it as not observed.
      const panel = (mobile.panels ?? []).find((candidate) => candidate.tab === "depeg");
      if (!panel) {
        results.push(sentinel("profile.depeg-history-preview", "missing", "depeg-history-panel-missing", null, sourceGeneration));
      } else if (!panel.preview) {
        results.push(sentinel("profile.depeg-history-preview", "missing", "depeg-preview-missing", null, sourceGeneration));
      } else if (panel.previewRows == null) {
        results.push(sentinel("profile.depeg-history-preview", "not-observed", "depeg-preview-table-missing", null, sourceGeneration));
      } else if (panel.previewRows === 0) {
        results.push(sentinel("profile.depeg-history-preview", "missing", "depeg-preview-without-rows", 0, sourceGeneration));
      } else if (panel.previewRows > 6) {
        results.push(sentinel("profile.depeg-history-preview", "missing", "depeg-preview-row-bound-exceeded", panel.previewRows, sourceGeneration));
      } else if (!panel.previewHasCaptureDate) {
        results.push(sentinel("profile.depeg-history-preview", "missing", "depeg-preview-capture-date-missing", panel.previewRows, sourceGeneration));
      } else if (!panel.previewHasCoverageScope) {
        results.push(sentinel("profile.depeg-history-preview", "missing", "depeg-preview-scope-missing", panel.previewRows, sourceGeneration));
      } else {
        results.push(sentinel("profile.depeg-history-preview", "present", null, panel.previewRows, sourceGeneration));
      }

      const rawPanel = (raw?.panels ?? []).find((candidate) => candidate.tab === "depeg") ?? null;
      const rawHrefs = rawPanel?.previewHrefs ?? [];
      const currentHrefs = new Set(panel?.previewHrefs ?? []);
      const lostHrefs = rawHrefs.filter((href) => !currentHrefs.has(href));
      results.push(lostHrefs.length > 0
        ? sentinel("profile.depeg-preview-hrefs", "missing", "depeg-preview-destination-lost", lostHrefs.length, sourceGeneration)
        : rawHrefs.length > 0
          ? sentinel("profile.depeg-preview-hrefs", "present", null, rawHrefs.length, sourceGeneration)
          : sentinel("profile.depeg-preview-hrefs", "not-observed", "no-permanent-event-link", 0, sourceGeneration));

      results.push(raw == null
        ? sentinel("profile.history-initial-scroll", "not-observed", "raw-snapshot-unavailable", null, sourceGeneration)
        : raw.scrollY === 0
          ? sentinel("profile.history-initial-scroll", "present", null, 0, sourceGeneration)
          : sentinel("profile.history-initial-scroll", "missing", "initial-scroll-offset", raw.scrollY, sourceGeneration));
    }

    const dex = mobile.surfaces?.dexLiquidity ?? null;
    if (replay) {
      results.push(sentinel("profile.dex-pool-table", "not-observed", "api-failure-replay-pool-data-unavailable", null, sourceGeneration));
      results.push(sentinel("profile.dex-chart-deferral", "not-observed", "api-failure-replay-no-live-dex-read", null, sourceGeneration));
    } else if (!dex) {
      results.push(sentinel("profile.dex-pool-table", "not-observed", "dex-section-not-in-document", null, sourceGeneration));
      results.push(sentinel("profile.dex-chart-deferral", "not-observed", "dex-section-not-in-document", null, sourceGeneration));
    } else {
      if (!dex.lazySectionMounted) {
        results.push(sentinel(
          "profile.dex-pool-table",
          "not-observed",
          dex.alertPresent ? "dex-data-unavailable" : "outer-lazy-section-not-mounted",
          null,
          sourceGeneration,
        ));
      } else if (!dex.tablePresent) {
        results.push(sentinel(
          "profile.dex-pool-table",
          "not-observed",
          dex.alertPresent ? "dex-data-unavailable" : "dex-card-empty-or-absent",
          null,
          sourceGeneration,
        ));
      } else if (dex.factualRows === 0) {
        results.push(sentinel("profile.dex-pool-table", "missing", "pool-table-without-factual-rows", 0, sourceGeneration));
      } else if (dex.factualRows > 5) {
        results.push(sentinel("profile.dex-pool-table", "missing", "pool-table-row-bound-exceeded", dex.factualRows, sourceGeneration));
      } else {
        results.push(sentinel("profile.dex-pool-table", "present", null, dex.factualRows, sourceGeneration));
      }

      if (dex.disclosureOpen == null) {
        results.push(sentinel("profile.dex-chart-deferral", "not-observed", "market-breakdown-disclosure-not-found", null, sourceGeneration));
      } else {
        results.push(dex.disclosureOpen === false && dex.chartPresent
          ? sentinel("profile.dex-chart-deferral", "missing", "tvl-chart-mounted-before-first-open", 1, sourceGeneration)
          : sentinel("profile.dex-chart-deferral", "present", null, dex.chartPresent ? 1 : 0, sourceGeneration));
      }
    }

    if (replay) {
      const comparison = compareAssuranceAnswers(baseline?.mobile ?? null, mobile);
      results.push(sentinel("profile.static-assurance-answer", comparison.status, comparison.reason, mobile.assuranceAnswers.length, sourceGeneration));
    } else {
      const answers = mobile.assuranceAnswers;
      if (answers.length === 0) {
        results.push(sentinel("profile.static-assurance-answer", "not-observed", "static-assurance-answer-not-found", null, sourceGeneration));
      } else {
        const blanket = answers.some((answer) => /independent audit/i.test(answer.text));
        results.push(blanket
          ? sentinel("profile.static-assurance-answer", "missing", "blanket-audit-claim", answers.length, sourceGeneration)
          : sentinel("profile.static-assurance-answer", "present", null, answers.length, sourceGeneration));
      }
    }
  }

  if (surface === "alt-pegs") {
    const directory = collectDirectoryHrefs(mobile) ?? [];
    if (!replay && directory.length === 0) {
      results.push(sentinel("alt-pegs.directory", "missing", "currency-hub-directory-empty", 0, sourceGeneration));
    } else if (replay) {
      const baselineDirectory = collectDirectoryHrefs(baseline?.mobile) ?? [];
      const replaySet = new Set(directory);
      const lost = baselineDirectory.filter((href) => !replaySet.has(href));
      results.push(lost.length === 0
        ? sentinel("alt-pegs.directory", "present", null, directory.length, sourceGeneration)
        : sentinel("alt-pegs.directory", "missing", "currency-hub-destination-lost", lost.length, sourceGeneration));
    } else {
      results.push(sentinel("alt-pegs.directory", "present", null, directory.length, sourceGeneration));
    }
  }

  if (surface === "safety-scores") {
    const safety = mobile.surfaces?.safetyScores ?? null;
    if (replay) {
      results.push(sentinel("safety-scores.card-facts", "not-observed", "api-failure-replay-no-score-seed", null, sourceGeneration));
    } else if (!safety) {
      results.push(sentinel("safety-scores.card-facts", "not-observed", "safety-scores-data-section-not-found", null, sourceGeneration));
    } else if (safety.factualProfileLinks > 0) {
      results.push(sentinel("safety-scores.card-facts", "present", null, safety.factualProfileLinks, sourceGeneration));
    } else if (safety.alertPresent) {
      results.push(sentinel("safety-scores.card-facts", "not-observed", "report-cards-unavailable", null, sourceGeneration));
    } else {
      results.push(sentinel("safety-scores.card-facts", "not-observed", "card-facts-not-admitted", null, sourceGeneration));
    }
  }

  if (surface === "compliance") {
    const compliance = mobile.surfaces?.complianceOverview ?? null;
    if (replay) {
      results.push(sentinel("compliance.overview-rows", "not-observed", "api-failure-replay-regime-facts-not-enrolled-until-B2", null, sourceGeneration));
    } else if (!compliance) {
      results.push(sentinel("compliance.overview-rows", "not-observed", "compliance-overview-not-mounted", null, sourceGeneration));
    } else if (compliance.factualRows > 0) {
      results.push(sentinel("compliance.overview-rows", "present", null, compliance.factualRows, sourceGeneration));
    } else {
      results.push(sentinel("compliance.overview-rows", "missing", "compliance-overview-without-factual-rows", 0, sourceGeneration));
    }
  }

  return results;
}

async function fetchHtml(url, fetchImpl = fetch) {
  const response = await fetchImpl(url, {
    headers: {
      Accept: "text/html",
      "User-Agent": "PharosSeoRenderBudgetAudit/1.0",
    },
    signal: AbortSignal.timeout(CAPTURE_TIMEOUT_MS),
  });
  const html = await response.text();
  return {
    html,
    status: response.status,
    htmlBytes: byteLength(html),
    cacheControl: response.headers.get("cache-control") ?? "",
    cdnCacheControl: response.headers.get("cdn-cache-control") ?? "",
    cfCacheStatus: response.headers.get("cf-cache-status") ?? "",
    contentType: response.headers.get("content-type") ?? "",
  };
}

/**
 * Parse already-fetched bytes as DOM in an isolated, JS-disabled page. Every
 * resource request is blocked before `setContent`, so raw capture neither
 * hydrates nor opens a second outbound fetch fan-out.
 */
export async function captureRawSnapshot(browser, url, html) {
  const context = await browser.newContext({
    viewport: MOBILE_VIEWPORT,
    javaScriptEnabled: false,
  });
  let blockedRequests = 0;
  try {
    const page = await context.newPage();
    await page.route("**/*", async (route) => {
      blockedRequests += 1;
      await route.abort();
    });
    await page.setContent(html, { timeout: CAPTURE_TIMEOUT_MS });
    const snapshot = await page.evaluate(buildCollectExpression({
      documentUrl: url,
      viewport: MOBILE_VIEWPORT,
      visibleTextMode: "raw",
    }));
    return { snapshot, blockedRequests };
  } finally {
    await context.close();
  }
}

async function collectHydratedSnapshot(page, url, viewport) {
  return page.evaluate(buildCollectExpression({
    documentUrl: url,
    viewport,
    visibleTextMode: "styled",
  }));
}

/** Install a 503 API-failure replay before navigation; static assets pass through. */
export function createApiFailureReplayHandler({ origin, failures, intentional }) {
  return async (route) => {
    const request = route.request();
    const requestUrl = request.url();
    if (isDataReadUrl(requestUrl, origin)) {
      intentional.replayUrls?.add(requestUrl);
      failures.intentionalBlocks.push({ kind: "api-failure-replay", url: requestUrl, status: 503 });
      await route.fulfill({
        status: 503,
        contentType: "application/json",
        headers: {
          "cache-control": "no-store",
          [REPLAY_INJECTION_HEADER]: "api-failure-replay",
        },
        body: REPLAY_INJECTION_BODY,
      });
      return;
    }
    await route.fallback();
  };
}

export async function capturePageSnapshots(browser, url, { waitMs, counters, failures, provenance, replay = false, origin }) {
  const intentional = { analyticsUrls: new Set(), replayUrls: new Set() };
  const state = { counters, failures, intentional, provenance, origin };
  const context = await browser.newContext({
    viewport: MOBILE_VIEWPORT,
    javaScriptEnabled: true,
  });
  try {
    const page = await context.newPage();
    installFailureListeners(page, state);
    await blockAnalyticsCollection(page, counters, intentional);
    if (replay) {
      await page.route("**/*", createApiFailureReplayHandler({ origin, failures, intentional }));
    }

    await page.goto(url, { waitUntil: "domcontentloaded", timeout: CAPTURE_TIMEOUT_MS });
    if (waitMs > 0) await page.waitForTimeout(waitMs);
    const mobile = await collectHydratedSnapshot(page, url, MOBILE_VIEWPORT);
    const timing = await page.evaluate(() => {
      const nav = performance.getEntriesByType("navigation")[0];
      if (!nav) return null;
      return {
        domContentLoadedMs: Math.round(nav.domContentLoadedEventEnd),
        loadMs: Math.round(nav.loadEventEnd),
        responseStartMs: Math.round(nav.responseStart),
      };
    }).catch(() => null);
    const resources = (await page.evaluate(() =>
      performance.getEntriesByType("resource").map((entry) => ({
        name: entry.name,
        initiatorType: entry.initiatorType,
        transferSize: "transferSize" in entry ? entry.transferSize : 0,
        encodedBodySize: "encodedBodySize" in entry ? entry.encodedBodySize : 0,
      })),
    ).catch(() => [])) ?? [];
    for (const resource of resources) {
      addPerformanceResource(counters, resource);
    }
    const title = await page.title();

    await page.setViewportSize(TALL_VIEWPORT);
    if (waitMs > 0) await page.waitForTimeout(waitMs);
    const tall = await collectHydratedSnapshot(page, url, TALL_VIEWPORT);

    return { mobile, tall, timing, title, intentional };
  } finally {
    await context.close();
  }
}

/** A route that could not be acquired at all still gets one bounded row. */
export function failedRouteRow(route, url, error) {
  return {
    route,
    url,
    title: null,
    elapsedMs: 0,
    mainTextChars: null,
    status: null,
    htmlBytes: null,
    cacheControl: "",
    cdnCacheControl: "",
    cfCacheStatus: "",
    contentType: "",
    ...emptyCounters(),
    timing: null,
    captureStatus: "failed",
    captureReason: `unrecoverable-capture-failure: ${formatError(error)}`,
    snapshots: { raw: null, mobile: null, tall: null },
    hrefLoss: { mobile: null, tall: null },
    failures: emptyFailures(),
    sentinels: [],
    apiFailureReplay: null,
  };
}

async function runApiFailureReplay(browser, url, { waitMs, baseline, origin, surface, expectations = null }) {
  const counters = emptyCounters();
  const failures = emptyFailures();
  const provenance = { sourceGeneration: null, source: null };
  try {
    const captured = await capturePageSnapshots(browser, url, {
      waitMs,
      counters,
      failures,
      provenance,
      replay: true,
      origin,
    });
    const snapshots = { raw: baseline.raw, mobile: captured.mobile, tall: captured.tall };
    const hrefLoss = {
      mobile: diffInternalHrefs(baseline.raw?.internalHrefs, captured.mobile?.internalHrefs),
      tall: diffInternalHrefs(baseline.raw?.internalHrefs, captured.tall?.internalHrefs),
    };
    if (captured.intentional.analyticsUrls.size > 0) {
      failures.intentionalBlocks.push({ kind: "analytics-suppression", count: captured.intentional.analyticsUrls.size });
    }
    const sourceGeneration = provenance.sourceGeneration
      ?? captured.mobile?.observedDates?.find((date) => date.datetime)?.datetime
      ?? null;
    return {
      status: "complete",
      reason: null,
      snapshots,
      hrefLoss,
      failures,
      counters,
      injectedApiFailures: captured.intentional.replayUrls.size,
      sentinels: evaluateSentinels({
        surface,
        snapshots,
        hrefLoss,
        captureStatus: "complete",
        replay: true,
        baseline,
        sourceGeneration,
        expectations,
      }),
    };
  } catch (error) {
    return {
      status: "failed",
      reason: `replay-capture-failed: ${formatError(error)}`,
      snapshots: { raw: baseline.raw, mobile: null, tall: null },
      hrefLoss: { mobile: null, tall: null },
      failures,
      counters,
      injectedApiFailures: 0,
      sentinels: [],
    };
  }
}

export async function auditRoute(browser, baseUrl, route, options = {}) {
  const url = resolveRoute(baseUrl, route);
  const origin = new URL(baseUrl).origin;
  const surface = classifyRouteSurface(route);
  const counters = emptyCounters();
  const failures = emptyFailures();
  const provenance = { sourceGeneration: null, source: null };
  const started = Date.now();
  const row = {
    route,
    url,
    title: null,
    elapsedMs: 0,
    mainTextChars: null,
    status: null,
    htmlBytes: null,
    cacheControl: "",
    cdnCacheControl: "",
    cfCacheStatus: "",
    contentType: "",
    ...counters,
    timing: null,
    captureStatus: "incomplete",
    captureReason: null,
    snapshots: { raw: null, mobile: null, tall: null },
    hrefLoss: { mobile: null, tall: null },
    failures,
    sentinels: [],
    apiFailureReplay: null,
  };

  const fetchHtmlImpl = options.fetchHtmlImpl ?? fetchHtml;
  const captureRawSnapshotImpl = options.captureRawSnapshotImpl ?? captureRawSnapshot;
  const capturePageSnapshotsImpl = options.capturePageSnapshotsImpl ?? capturePageSnapshots;
  const replayImpl = options.runApiFailureReplayImpl ?? runApiFailureReplay;
  const waitMs = options.waitMs ?? Number(DEFAULT_WAIT_MS);
  let fetchedHtml = null;

  try {
    const { html, ...metadata } = await fetchHtmlImpl(url);
    fetchedHtml = html;
    Object.assign(row, metadata);
  } catch (error) {
    row.captureReason = `raw-fetch-failed: ${formatError(error)}`;
  }

  let offlineParseBlocks = 0;
  if (fetchedHtml != null) {
    try {
      const raw = await captureRawSnapshotImpl(browser, url, fetchedHtml);
      row.snapshots.raw = raw.snapshot;
      offlineParseBlocks = raw.blockedRequests;
    } catch (error) {
      row.captureReason = [row.captureReason, `raw-parse-failed: ${formatError(error)}`].filter(Boolean).join("; ");
    }
  }

  try {
    const captured = await capturePageSnapshotsImpl(browser, url, { waitMs, counters, failures, provenance, origin });
    row.snapshots.mobile = captured.mobile;
    row.snapshots.tall = captured.tall;
    row.timing = captured.timing;
    row.title = captured.title;
    row.mainTextChars = captured.mobile?.mainDomTextChars ?? null;
    row.captureStatus = "complete";
  } catch (error) {
    row.captureStatus = "failed";
    row.captureReason = [row.captureReason, `browser-capture-failed: ${formatError(error)}`].filter(Boolean).join("; ");
  }

  if (row.captureStatus !== "failed") {
    const missing = [];
    if (!row.snapshots.raw) missing.push("raw");
    if (!row.snapshots.mobile) missing.push("mobile");
    if (!row.snapshots.tall) missing.push("tall");
    row.captureStatus = missing.length === 0 ? "complete" : "incomplete";
    if (missing.length > 0) {
      row.captureReason = [row.captureReason, `missing-observations: ${missing.join(",")}`].filter(Boolean).join("; ");
    }
  }

  if (row.captureStatus === "complete") row.captureReason = null;

  row.hrefLoss.mobile = diffInternalHrefs(row.snapshots.raw?.internalHrefs, row.snapshots.mobile?.internalHrefs);
  row.hrefLoss.tall = diffInternalHrefs(row.snapshots.raw?.internalHrefs, row.snapshots.tall?.internalHrefs);

  if (counters.blockedAnalyticsRequests > 0) {
    failures.intentionalBlocks.push({ kind: "analytics-suppression", count: counters.blockedAnalyticsRequests });
  }
  if (offlineParseBlocks > 0) {
    failures.intentionalBlocks.push({ kind: "offline-raw-parser", count: offlineParseBlocks });
  }

  const sourceGeneration = provenance.sourceGeneration
    ?? row.snapshots.mobile?.observedDates?.find((date) => date.datetime)?.datetime
    ?? null;
  row.sourceGeneration = sourceGeneration;
  row.sourceGenerationSource = provenance.source ?? (sourceGeneration ? "dom:time[datetime]" : null);
  const expectations = getRouteExpectations(route);

  row.sentinels = evaluateSentinels({
    surface,
    snapshots: row.snapshots,
    hrefLoss: row.hrefLoss,
    captureStatus: row.captureStatus,
    sourceGeneration,
    expectations,
  });

  if (options.apiFailureReplay === true) {
    const replayBaseline = { raw: row.snapshots.raw, mobile: row.snapshots.mobile, tall: row.snapshots.tall };
    row.apiFailureReplay = isReplayEligibleRoute(route)
      ? await replayImpl(browser, url, { waitMs, baseline: replayBaseline, origin, surface, expectations })
      : { status: "not-applicable", reason: "route-not-replay-eligible", snapshots: null, hrefLoss: null, sentinels: [], failures: emptyFailures(), counters: emptyCounters(), injectedApiFailures: 0 };
  }

  Object.assign(row, counters);
  row.elapsedMs = Date.now() - started;
  return row;
}

export function formatTable(rows) {
  const headers = [
    "route",
    "status",
    "htmlKB",
    "mainChars",
    "req",
    "acctErr",
    "gaBlocked",
    "jsReq",
    "cssReq",
    "fontReq",
    "siteData",
    "byteKB",
    "cfCache",
    "capture",
    "missing",
    "notObs",
    "hrefLost",
    "dataFail",
    "inject",
  ];
  const lines = [headers.join("\t")];
  for (const row of rows) {
    const sentinels = Array.isArray(row.sentinels) ? row.sentinels : [];
    const hrefLoss = (row.hrefLoss?.mobile?.length ?? 0) + (row.hrefLoss?.tall?.length ?? 0);
    const dataFailures = (row.failures?.httpData?.length ?? 0)
      + (row.failures?.failedRequests?.length ?? 0)
      + (row.failures?.pageErrors?.length ?? 0);
    const injections = (row.failures?.intentionalBlocks ?? [])
      .filter((block) => block.kind === "api-failure-replay")
      .length;
    lines.push(
      [
        row.route,
        row.status,
        Math.round((row.htmlBytes ?? 0) / 1024),
        row.mainTextChars,
        row.requests ?? 0,
        row.accountingErrors ?? 0,
        row.blockedAnalyticsRequests ?? 0,
        row.scriptRequests ?? 0,
        row.styleRequests ?? 0,
        row.fontRequests ?? 0,
        row.siteDataRequests ?? 0,
        Math.round(((row.htmlBytes ?? 0) + Math.max(row.knownContentLengthBytes ?? 0, row.observedTransferBytes ?? 0)) / 1024),
        row.cfCacheStatus || "-",
        row.captureStatus,
        sentinels.filter((entry) => entry.status === "missing").length,
        sentinels.filter((entry) => entry.status === "not-observed").length,
        hrefLoss,
        dataFailures,
        injections,
      ].join("\t"),
    );
  }
  return lines.join("\n");
}

/** One row per requested route; an unrecoverable capture never drops later rows. */
export async function collectAuditRows(browser, baseUrl, routes, options = {}, { auditRouteImpl = auditRoute } = {}) {
  const rows = [];
  let unrecoverable = false;
  for (const route of routes) {
    try {
      const row = await auditRouteImpl(browser, baseUrl, route, options);
      if (row?.captureStatus === "failed" || row?.apiFailureReplay?.status === "failed") unrecoverable = true;
      rows.push(row);
    } catch (error) {
      unrecoverable = true;
      rows.push(failedRouteRow(route, resolveRoute(baseUrl, route), error));
    }
  }
  return { rows, unrecoverable };
}

export async function runSeoRenderBudget(argv = process.argv.slice(2)) {
  const args = parseSeoRenderBudgetArgs(argv);
  if (args.help) {
    console.log(SEO_RENDER_BUDGET_HELP);
    return;
  }
  const baseUrl = normalizeBaseUrl(args.baseUrl);
  const chromium = await loadChromium();
  const browser = await chromium.launch(getBrowserLaunchOptions({
    SMOKE_UI_BROWSER_EXECUTABLE_PATH: process.env.SEO_AUDIT_BROWSER_EXECUTABLE_PATH,
    SMOKE_UI_BROWSER_CHANNEL: process.env.SEO_AUDIT_BROWSER_CHANNEL,
  }));

  try {
    const { rows, unrecoverable } = await collectAuditRows(browser, baseUrl, args.routes, {
      waitMs: args.waitMs,
      apiFailureReplay: args.apiFailureReplay,
    });

    if (args.json) {
      console.log(JSON.stringify({
        baseUrl: baseUrl.toString(),
        generatedAt: new Date().toISOString(),
        apiFailureReplay: args.apiFailureReplay,
        unenrolledExpectations: UNENROLLED_SENTINEL_EXPECTATIONS,
        rows,
      }, null, 2));
    } else {
      console.log(formatTable(rows));
    }
    if (unrecoverable) process.exitCode = 1;
    return rows;
  } finally {
    await browser.close();
  }
}

runDirectCli(import.meta.url, runSeoRenderBudget);
