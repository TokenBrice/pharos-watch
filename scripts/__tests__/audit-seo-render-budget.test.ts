import { describe, expect, it, vi } from "vitest";
import { JSDOM } from "jsdom";

import {
  auditRoute,
  blockAnalyticsCollection,
  capturePageSnapshots,
  captureRawSnapshot,
  classifyRouteSurface,
  collectAuditRows,
  collectDirectoryHrefs,
  collectSnapshotFacts,
  createApiFailureReplayHandler,
  diffInternalHrefs,
  evaluateSentinels,
  failedRouteRow,
  formatTable,
  getRouteExpectations,
  installFailureListeners,
  isReplayEligibleRoute,
  parseSeoRenderBudgetArgs,
  selectReplayRoutes,
  UNENROLLED_SENTINEL_EXPECTATIONS,
} from "../maintenance/audit-seo-render-budget.mjs";

const PROFILE_URL = "https://pharos.watch/stablecoin/usdt-tether/";

type SnapshotOptions = {
  url?: string;
  mode?: "raw" | "styled";
  viewport?: { width: number; height: number };
  scrollY?: number;
};

function makeSnapshot(html: string, options: SnapshotOptions = {}) {
  const url = options.url ?? PROFILE_URL;
  const dom = new JSDOM(`<!doctype html><html><body>${html}</body></html>`, { url });
  return collectSnapshotFacts(dom.window.document as unknown as Document, {
    documentUrl: url,
    viewport: options.viewport ?? { width: 412, height: 915 },
    scrollY: options.scrollY ?? 0,
    visibleTextMode: options.mode ?? "styled",
  });
}

function makeCounters() {
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

function makeFailures() {
  return { httpData: [] as unknown[], failedRequests: [] as unknown[], pageErrors: [] as unknown[], intentionalBlocks: [] as unknown[] };
}

function evaluate(snapshot: ReturnType<typeof makeSnapshot>, overrides: {
  surface?: string;
  raw?: ReturnType<typeof makeSnapshot> | null;
  tall?: ReturnType<typeof makeSnapshot> | null;
  hrefLoss?: { mobile: string[] | null; tall: string[] | null };
  replay?: boolean;
  baseline?: { mobile: ReturnType<typeof makeSnapshot> | null } | null;
  sourceGeneration?: string | null;
  expectations?: { panels?: { required?: string[]; notApplicable?: string[] }; depegHistoryPreview?: boolean } | null;
} = {}) {
  return evaluateSentinels({
    surface: overrides.surface ?? "profile",
    snapshots: {
      raw: overrides.raw ?? null,
      mobile: snapshot,
      tall: overrides.tall === undefined ? snapshot : overrides.tall,
    },
    hrefLoss: overrides.hrefLoss ?? { mobile: [], tall: [] },
    captureStatus: "complete",
    replay: overrides.replay ?? false,
    baseline: overrides.baseline ?? null,
    sourceGeneration: overrides.sourceGeneration ?? null,
    expectations: overrides.expectations ?? null,
  });
}

function byId(sentinels: ReturnType<typeof evaluateSentinels>, id: string) {
  const match = sentinels.find((entry) => entry.id === id);
  if (!match) throw new Error(`missing sentinel ${id}`);
  return match;
}

function poolSection({
  rows = 5,
  factual = true,
  chart = false,
  alert = false,
  wrapper = true,
  open = false,
}: { rows?: number; factual?: boolean; chart?: boolean; alert?: boolean; wrapper?: boolean; open?: boolean } = {}) {
  const rowHtml = Array.from({ length: rows }, (_, index) => (factual
    ? `<tr><td>POOL${index}</td><td>${index % 2 === 0 ? "ethereum" : "arbitrum"}</td><td>$${1000 - index}</td></tr>`
    : '<tr><td><div class="animate-pulse"></div></td><td></td><td></td></tr>')).join("");
  const body = [
    alert ? '<div role="alert">DEX liquidity data is temporarily unavailable.</div>' : "",
    wrapper
      ? `<details ${open ? "open" : ""}><summary>Full market breakdown</summary><div data-testid="dex-liquidity-top-pools-table"><table><tbody>${rowHtml}</tbody></table></div></details>`
      : "",
    chart ? '<div role="figure" aria-label="TVL trend chart"></div>' : "",
  ].join("");
  return `<main><h1>USDT (USDT) stablecoin analytics</h1><section id="dex-liquidity">${wrapper ? `<div data-lazy-section="">${body}</div>` : body}</section><a href="/stablecoin/usdc-circle/">USDC</a></main>`;
}

describe("SEO render audit fixture collection", () => {
  it("counts factual table rows separately from an identical empty skeleton", () => {
    const factual = makeSnapshot(poolSection({ rows: 2 }));
    const skeleton = makeSnapshot(poolSection({ rows: 2, factual: false }));

    expect(factual.tables).toContainEqual(expect.objectContaining({ rows: 2, factualRows: 2 }));
    expect(skeleton.tables).toContainEqual(expect.objectContaining({ rows: 2, factualRows: 0 }));
  });

  it("detects a grade card grid without requiring table rows", () => {
    const snapshot = makeSnapshot(
      '<main><h1>Safety Scores</h1><section id="data"><a href="/stablecoin/usdt-tether/">USDT A+ 92</a><a href="/stablecoin/usdc-circle/">USDC A 88</a></section></main>',
    );

    expect(snapshot.tables).toHaveLength(0);
    expect(snapshot.cards.dataRoot).toMatchObject({ present: true, profileLinks: 2, factualProfileLinks: 2 });
  });

  it("does not let script or Flight payload text inflate content counts", () => {
    const payload = "x".repeat(5_000);
    const snapshot = makeSnapshot(
      `<main><h1>Home</h1><p>Real facts</p><script>self.__next_f.push(${JSON.stringify(payload)})</script></main>`,
    );

    expect(snapshot.mainDomTextChars).toBe("HomeReal facts".length);
    expect(snapshot.mainDomTextChars).toBeLessThan(1_000);
  });

  it("retains a streamed raw anchor outside main in whole-document comparisons", () => {
    const snapshot = makeSnapshot('<main><h1>Home</h1></main><a href="/outside-stream/">Outside</a>');

    expect(snapshot.internalHrefs).toContain("/outside-stream/");
    expect(snapshot.mainInternalHrefs).not.toContain("/outside-stream/");
  });

  it("reports raw styled visibility as unavailable while hydrated collection provides it", () => {
    const html = '<main><h1>Home</h1><p>Visible words</p><p style="display: none">Hidden words</p></main>';
    const raw = makeSnapshot(html, { mode: "raw" });
    const styled = makeSnapshot(html, { mode: "styled" });

    expect(raw.mainVisibleTextChars).toBeNull();
    expect(raw.mainVisibleTextReason).toBe("unstyled-raw-parser");
    expect(styled.mainVisibleTextChars).toBeGreaterThan(0);
    expect(styled.mainVisibleTextChars).toBeLessThan(styled.mainDomTextChars ?? 0);
  });

  it("normalizes absolute and relative duplicates while keeping fragment targets distinct", () => {
    const snapshot = makeSnapshot(
      '<main><h1>Home</h1><a href="/a/">A</a><a href="/a/">A again</a><a href="https://pharos.watch/a/">Absolute</a><a href="/a/#frag">Fragment</a></main>',
    );

    expect(snapshot.internalHrefs).toEqual(["/a/", "/a/#frag"]);
  });

  it("records a closed disclosure with retained pool text and an empty inactive panel", () => {
    const snapshot = makeSnapshot(`${poolSection({ rows: 5 })}<div data-history-tab="peg" hidden></div><div data-history-tab="nav">Nav facts</div>`);

    expect(snapshot.disclosures).toContainEqual(expect.objectContaining({ label: "Full market breakdown", open: false }));
    expect(snapshot.disclosures[0]?.bodyTextChars).toBeGreaterThan(0);
    expect(snapshot.panels).toContainEqual(expect.objectContaining({ tab: "peg", hidden: true, textChars: 0 }));
  });

  it("records real time elements as observed dates without inventing a producer clock", () => {
    const snapshot = makeSnapshot('<main><h1>Home</h1><time datetime="2026-10-27T12:00:00Z">Oct 27, 2026</time></main>');

    expect(snapshot.observedDates).toEqual([{ datetime: "2026-10-27T12:00:00Z", text: "Oct 27, 2026" }]);
  });
});

describe("SEO render audit sentinels", () => {
  it("accepts bounded pool facts inside a closed disclosure and a deferred chart", () => {
    const snapshot = makeSnapshot(poolSection({ rows: 5 }));
    const sentinels = evaluate(snapshot, { raw: snapshot });

    expect(byId(sentinels, "profile.dex-pool-table")).toMatchObject({ status: "present", observedCount: 5 });
    expect(byId(sentinels, "profile.dex-chart-deferral")).toMatchObject({ status: "present" });
    expect(byId(sentinels, "href.retention")).toMatchObject({ status: "present" });
  });

  it("diagnoses an over-bound or empty pool table", () => {
    const overBound = evaluate(makeSnapshot(poolSection({ rows: 6 })));
    const empty = evaluate(makeSnapshot(poolSection({ rows: 2, factual: false })));

    expect(byId(overBound, "profile.dex-pool-table")).toMatchObject({
      status: "missing",
      reason: "pool-table-row-bound-exceeded",
      observedCount: 6,
    });
    expect(byId(empty, "profile.dex-pool-table")).toMatchObject({
      status: "missing",
      reason: "pool-table-without-factual-rows",
    });
  });

  it("diagnoses a TVL chart mounted before the fold opens", () => {
    const sentinels = evaluate(makeSnapshot(poolSection({ rows: 5, chart: true })));

    expect(byId(sentinels, "profile.dex-chart-deferral")).toMatchObject({
      status: "missing",
      reason: "tvl-chart-mounted-before-first-open",
    });
  });

  it("keeps an unreached lazy wrapper and a failed DEX read distinct from an empty table", () => {
    const notMounted = evaluate(makeSnapshot(poolSection({ wrapper: false })));
    const unavailable = evaluate(makeSnapshot(poolSection({ rows: 0, wrapper: false, alert: true })));

    expect(byId(notMounted, "profile.dex-pool-table")).toMatchObject({
      status: "not-observed",
      reason: "outer-lazy-section-not-mounted",
    });
    expect(byId(unavailable, "profile.dex-pool-table")).toMatchObject({
      status: "not-observed",
      reason: "dex-data-unavailable",
    });
  });

  it("diagnoses an empty inactive history panel and accepts populated panels", () => {
    const emptyInactive = evaluate(makeSnapshot(
      '<main><h1>USDT</h1><div data-history-tab="peg" hidden></div><div data-history-tab="nav">Nav facts</div></main>',
    ));
    const populated = evaluate(makeSnapshot(
      '<main><h1>USDT</h1><div data-history-tab="peg" hidden>Peg facts</div><div data-history-tab="nav">Nav facts</div></main>',
    ));
    const unmounted = evaluate(makeSnapshot("<main><h1>USDT</h1></main>"));

    expect(byId(emptyInactive, "profile.history-panel-facts")).toMatchObject({
      status: "missing",
      reason: "inactive-history-panel-without-facts",
      observedCount: 1,
    });
    expect(byId(populated, "profile.history-panel-facts")).toMatchObject({ status: "present", observedCount: 2 });
    expect(byId(unmounted, "profile.history-panel-facts")).toMatchObject({
      status: "not-observed",
      reason: "history-panels-not-mounted",
    });
  });

  it("enrolls the five-pilot inactive depeg preview, its links and the replay snapshot", () => {
    const previewPanel = ({ rows = 6, hrefs = 0, caption = true, scope = true } = {}) => {
      const links = Array.from({ length: hrefs }, (_, index) => `<a href="/depeg/usdt-2023-0${index + 1}-01/">Event record</a>`).join("");
      const rowsHtml = Array.from({ length: rows }, (_, index) =>
        `<tr><td>2023-01-0${index + 1}</td><td>+1${index} bps</td><td>1h</td><td>Recovered</td><td>Historical backfill</td></tr>`).join("");
      const captionHtml = caption
        ? `<caption>Latest ${rows} of 248 archived incidents · as of 2026-10-17 UTC. ${scope ? "Recorded history; coverage may be incomplete." : ""}</caption>`
        : "";
      return `<main><h1>USDT</h1><div id="grade-history" data-history-tab="grade"></div>`
        + `<div id="depeg-history" data-history-tab="depeg" hidden><div data-testid="depeg-history-preview">`
        + `<table>${captionHtml}<tbody>${rowsHtml}</tbody></table>${links}</div></div></main>`;
    };
    const expectations = getRouteExpectations("/stablecoin/usdt-tether/");
    expect(expectations).toEqual({ panels: { required: ["depeg"] }, depegHistoryPreview: true });
    expect(getRouteExpectations("/stablecoin/usde-ethena/")).not.toBeNull();
    expect(getRouteExpectations("/stablecoin/usds-sky/")).toBeNull();

    const raw = makeSnapshot(previewPanel({ hrefs: 1 }));
    const mobile = makeSnapshot(previewPanel({ hrefs: 1 }));
    const present = evaluate(mobile, { raw, expectations });
    expect(byId(present, "profile.depeg-history-preview")).toMatchObject({ status: "present", observedCount: 6 });
    expect(byId(present, "profile.depeg-preview-hrefs")).toMatchObject({ status: "present", observedCount: 1 });
    expect(byId(present, "profile.history-initial-scroll")).toMatchObject({ status: "present" });

    const replay = evaluate(mobile, { raw, replay: true, baseline: { mobile: raw }, expectations });
    expect(byId(replay, "profile.depeg-history-preview")).toMatchObject({ status: "present" });

    expect(byId(evaluate(mobile, { raw, expectations }), "profile.depeg-history-preview").status).toBe("present");
    expect(byId(evaluate(makeSnapshot(previewPanel({ rows: 7 })), { expectations }), "profile.depeg-history-preview"))
      .toMatchObject({ status: "missing", reason: "depeg-preview-row-bound-exceeded" });
    expect(byId(evaluate(makeSnapshot(previewPanel({ caption: false })), { expectations }), "profile.depeg-history-preview"))
      .toMatchObject({ status: "missing", reason: "depeg-preview-capture-date-missing" });
    expect(byId(evaluate(makeSnapshot(previewPanel({ scope: false })), { expectations }), "profile.depeg-history-preview"))
      .toMatchObject({ status: "missing", reason: "depeg-preview-scope-missing" });
    expect(byId(evaluate(makeSnapshot(previewPanel({ hrefs: 0 })), { raw, expectations }), "profile.depeg-preview-hrefs"))
      .toMatchObject({ status: "missing", reason: "depeg-preview-destination-lost" });
    expect(byId(evaluate(mobile, { raw: makeSnapshot(previewPanel({ hrefs: 1 }), { scrollY: 120 }), expectations }), "profile.history-initial-scroll"))
      .toMatchObject({ status: "missing", reason: "initial-scroll-offset" });
    expect(evaluate(mobile).map((entry: { id: string }) => entry.id)).not.toContain("profile.depeg-history-preview");
  });

  it("keeps panel applicability from a route fixture instead of assuming every panel should exist", () => {
    const navProfile = makeSnapshot('<main><h1>USDT</h1><div data-history-tab="peg" hidden>Peg facts</div></main>');
    const sentinels = evaluate(navProfile, {
      expectations: { panels: { required: ["peg"], notApplicable: ["depeg"] } },
    });
    const withDepeg = evaluate(makeSnapshot(
      '<main><h1>USDT</h1><div data-history-tab="peg" hidden>Peg facts</div><div data-history-tab="depeg" hidden>Depeg facts</div></main>',
    ), { expectations: { panels: { required: ["peg"], notApplicable: ["depeg"] } } });

    expect(byId(sentinels, "profile.history-panel.peg")).toMatchObject({ status: "present" });
    expect(byId(sentinels, "profile.history-panel.depeg")).toMatchObject({
      status: "not-applicable",
      reason: "panel-not-applicable-for-route-fixture",
    });
    expect(byId(withDepeg, "profile.history-panel.depeg")).toMatchObject({ status: "present" });
    expect(byId(evaluate(makeSnapshot('<main><h1>USDT</h1><div data-history-tab="nav" hidden>Nav facts</div></main>'), {
      expectations: { panels: { required: ["peg"] } },
    }), "profile.history-panel.peg")).toMatchObject({
      status: "missing",
      reason: "required-panel-without-facts",
    });
  });

  it("diagnoses a blanket audit claim while accepting method-specific static answers", () => {
    const answer = (text: string) => makeSnapshot(
      `<main><h1>USDT</h1><dl><div><dt>Proof of reserves</dt><dd>${text} <a href="https://example.test/report">Reserve source</a></dd></div></dl></main>`,
    );

    expect(byId(evaluate(answer("Independent Audit")), "profile.static-assurance-answer")).toMatchObject({
      status: "missing",
      reason: "blanket-audit-claim",
    });
    for (const label of ["Examination", "Audit", "Independent Report"]) {
      expect(byId(evaluate(answer(label)), "profile.static-assurance-answer")).toMatchObject({ status: "present" });
    }
    expect(byId(evaluate(makeSnapshot("<main><h1>USDT</h1></main>")), "profile.static-assurance-answer")).toMatchObject({
      status: "not-observed",
      reason: "static-assurance-answer-not-found",
    });
  });

  it("retains Alt-Pegs directory destinations and diagnoses a replay loss", () => {
    const directory = makeSnapshot(
      '<main><h1>Alt pegs</h1><a href="/stablecoins/eur/">EUR</a><a href="/stablecoins/gbp/">GBP</a></main>',
      { url: "https://pharos.watch/alt-pegs/" },
    );
    const reduced = makeSnapshot(
      '<main><h1>Alt pegs</h1><a href="/stablecoins/eur/">EUR</a></main>',
      { url: "https://pharos.watch/alt-pegs/" },
    );

    expect(collectDirectoryHrefs(directory)).toEqual(["/stablecoins/eur/", "/stablecoins/gbp/"]);
    expect(byId(evaluate(directory, { surface: "alt-pegs" }), "alt-pegs.directory")).toMatchObject({
      status: "present",
      observedCount: 2,
    });
    expect(byId(evaluate(makeSnapshot('<main><h1>Alt pegs</h1></main>', { url: "https://pharos.watch/alt-pegs/" }), { surface: "alt-pegs" }), "alt-pegs.directory")).toMatchObject({
      status: "missing",
      reason: "currency-hub-directory-empty",
    });
    expect(byId(evaluate(reduced, {
      surface: "alt-pegs",
      replay: true,
      baseline: { mobile: directory },
    }), "alt-pegs.directory")).toMatchObject({
      status: "missing",
      reason: "currency-hub-destination-lost",
      observedCount: 1,
    });
  });

  it("reports Safety Scores card facts, unavailable cards and missing data sections distinctly", () => {
    const cards = makeSnapshot(
      '<main><h1>Safety Scores</h1><section id="data"><a href="/stablecoin/usdt-tether/">USDT A+ 92</a></section></main>',
      { url: "https://pharos.watch/safety-scores/" },
    );
    const unavailable = makeSnapshot(
      '<main><h1>Safety Scores</h1><section id="data"><p role="alert">Ratings are temporarily unavailable.</p></section></main>',
      { url: "https://pharos.watch/safety-scores/" },
    );
    const missingSection = makeSnapshot("<main><h1>Safety Scores</h1></main>", { url: "https://pharos.watch/safety-scores/" });

    expect(byId(evaluate(cards, { surface: "safety-scores" }), "safety-scores.card-facts")).toMatchObject({
      status: "present",
      observedCount: 1,
    });
    expect(byId(evaluate(unavailable, { surface: "safety-scores" }), "safety-scores.card-facts")).toMatchObject({
      status: "not-observed",
      reason: "report-cards-unavailable",
    });
    expect(byId(evaluate(missingSection, { surface: "safety-scores" }), "safety-scores.card-facts")).toMatchObject({
      status: "not-observed",
      reason: "safety-scores-data-section-not-found",
    });
  });

  it("reports Compliance overview rows, empty rows and an unmounted overview distinctly", () => {
    const rows = makeSnapshot(
      '<main><h1>Compliance</h1><div data-table-id="compliance-overview"><table><tbody><tr><td>MiCA</td><td>Authorised</td></tr></tbody></table></div></main>',
      { url: "https://pharos.watch/compliance/" },
    );
    const empty = makeSnapshot(
      '<main><h1>Compliance</h1><div data-table-id="compliance-overview"><table><tbody></tbody></table></div></main>',
      { url: "https://pharos.watch/compliance/" },
    );
    const unmounted = makeSnapshot("<main><h1>Compliance</h1></main>", { url: "https://pharos.watch/compliance/" });

    expect(byId(evaluate(rows, { surface: "compliance" }), "compliance.overview-rows")).toMatchObject({
      status: "present",
      observedCount: 1,
    });
    expect(byId(evaluate(empty, { surface: "compliance" }), "compliance.overview-rows")).toMatchObject({
      status: "missing",
      reason: "compliance-overview-without-factual-rows",
    });
    expect(byId(evaluate(unmounted, { surface: "compliance" }), "compliance.overview-rows")).toMatchObject({
      status: "not-observed",
      reason: "compliance-overview-not-mounted",
    });
  });

  it("reports a swapped destination even when the total link count is unchanged", () => {
    const raw = makeSnapshot('<main><h1>Home</h1><a href="/a/">A</a><a href="/b/">B</a></main>');
    const mobile = makeSnapshot('<main><h1>Home</h1><a href="/a/">A</a><a href="/c/">C</a></main>');

    expect(raw.internalHrefs).toHaveLength(mobile.internalHrefs.length);
    const hrefLoss = { mobile: diffInternalHrefs(raw.internalHrefs, mobile.internalHrefs), tall: [] as string[] };
    expect(hrefLoss.mobile).toEqual(["/b/"]);
    expect(byId(evaluate(mobile, { raw, hrefLoss }), "href.retention")).toMatchObject({
      status: "missing",
      reason: "internal-destinations-lost",
      observedCount: 1,
    });
  });

  it("keeps unavailable main content unavailable rather than a successful zero", () => {
    const snapshot = makeSnapshot("<h1>No main element</h1>");
    const sentinels = evaluate(snapshot, { surface: "generic" });

    expect(byId(sentinels, "main.dom-text")).toMatchObject({
      status: "not-observed",
      reason: "main-element-missing",
      observedCount: null,
    });
    expect(byId(sentinels, "document.h1")).toMatchObject({ status: "present" });
  });

  it("keeps an unknown route generic without fabricating template expectations", () => {
    const sentinels = evaluate(makeSnapshot("<main><h1>Home</h1><p>Facts</p></main>", { url: "https://pharos.watch/" }), {
      surface: classifyRouteSurface("/"),
    });

    expect(sentinels.map((entry) => entry.id)).toEqual(["document.h1", "main.dom-text", "href.retention"]);
  });

  it("lists later-wave expectations without evaluating them in Wave 1", () => {
    expect(UNENROLLED_SENTINEL_EXPECTATIONS.map((entry: { ownerItem: string }) => entry.ownerItem))
      .toEqual(["C4", "C3", "B1", "B2"]);
    const sentinels = evaluate(makeSnapshot(poolSection({ rows: 5 })));
    expect(sentinels.map((entry) => entry.id)).not.toEqual(
      expect.arrayContaining(UNENROLLED_SENTINEL_EXPECTATIONS.map((entry: { id: string }) => entry.id)),
    );
  });

  it("records capture failures as not-observed and propagates observed generation", () => {
    const failed = evaluateSentinels({
      surface: "profile",
      snapshots: { raw: null, mobile: null, tall: null },
      hrefLoss: { mobile: null, tall: null },
      captureStatus: "failed",
      sourceGeneration: null,
    });
    expect(failed).toEqual([
      { id: "capture.snapshot", status: "not-observed", reason: "capture-failed", observedCount: null, sourceGeneration: null },
    ]);

    const generated = evaluate(makeSnapshot(poolSection({ rows: 5 })), { sourceGeneration: "gen-42" });
    expect(generated.every((entry) => entry.sourceGeneration === "gen-42")).toBe(true);
  });
});

describe("SEO render audit failure buckets", () => {
  function makeEventPage() {
    const handlers = new Map<string, Array<(arg: unknown) => unknown>>();
    return {
      on(event: string, handler: (arg: unknown) => unknown) {
        const list = handlers.get(event) ?? [];
        list.push(handler);
        handlers.set(event, list);
      },
      emit(event: string, arg: unknown) {
        for (const handler of handlers.get(event) ?? []) handler(arg);
      },
    };
  }

  const response = (url: string, status: number, { headers = {}, resourceType = "fetch" } = {}) => ({
    url: () => url,
    status: () => status,
    headers: () => headers,
    request: () => ({ resourceType: () => resourceType }),
  });

  it("separates data HTTP failures, failed scripts, page errors and intentional blocks", () => {
    const page = makeEventPage();
    const failures = makeFailures();
    const counters = makeCounters();
    const provenance = { sourceGeneration: null as string | null, source: null as string | null };
    const intentional = { analyticsUrls: new Set<string>(), replayUrls: new Set<string>() };
    installFailureListeners(page, { counters, failures, intentional, provenance, origin: "https://pharos.watch" });

    page.emit("response", response("https://pharos.watch/_site-data/stablecoins", 503, {
      headers: { "x-data-updated-at": "2026-10-27T00:00:00Z", "cache-control": "no-store" },
    }));
    page.emit("response", response("https://pharos.watch/_next/static/chunks/app.js", 404, { resourceType: "script" }));
    page.emit("response", response("https://pharos.watch/_site-data/stablecoins", 503, {
      headers: { "x-pharos-seo-audit-injection": "api-failure-replay" },
    }));
    page.emit("pageerror", new Error("boom"));
    page.emit("requestfailed", {
      url: () => "https://pharos.watch/health",
      resourceType: () => "fetch",
      failure: () => ({ errorText: "net::ERR_FAILED" }),
    });
    intentional.analyticsUrls.add("https://www.google-analytics.com/g/collect?v=2");
    page.emit("requestfailed", {
      url: () => "https://www.google-analytics.com/g/collect?v=2",
      resourceType: () => "fetch",
      failure: () => ({ errorText: "net::ERR_ABORTED" }),
    });

    expect(failures.httpData).toEqual([
      expect.objectContaining({
        url: "https://pharos.watch/_site-data/stablecoins",
        status: 503,
        headers: expect.objectContaining({ "x-data-updated-at": "2026-10-27T00:00:00Z" }),
      }),
    ]);
    expect(failures.failedRequests).toEqual([
      expect.objectContaining({ url: "https://pharos.watch/_next/static/chunks/app.js", failure: "http-404" }),
      expect.objectContaining({ url: "https://pharos.watch/health", failure: "net::ERR_FAILED" }),
    ]);
    expect(failures.pageErrors).toEqual([{ message: "boom" }]);
    expect(provenance).toEqual({ sourceGeneration: "2026-10-27T00:00:00Z", source: "response-header:x-data-updated-at" });
  });

  it("suppresses analytics collection before navigation and records it as intentional", async () => {
    const routes: Array<{ predicate: (url: URL) => boolean; handler: (route: unknown) => Promise<void> }> = [];
    const page = {
      route: async (predicate: (url: URL) => boolean, handler: (route: unknown) => Promise<void>) => {
        routes.push({ predicate, handler });
      },
    };
    const counters = makeCounters();
    const intentional = { analyticsUrls: new Set<string>() };

    await blockAnalyticsCollection(page, counters, intentional);

    expect(routes).toHaveLength(1);
    expect(routes[0]!.predicate(new URL("https://www.google-analytics.com/g/collect?v=2"))).toBe(true);
    expect(routes[0]!.predicate(new URL("https://pharos.watch/stablecoin/usdt-tether/"))).toBe(false);

    const abort = vi.fn(async () => undefined);
    await routes[0]!.handler({
      request: () => ({ url: () => "https://www.google-analytics.com/g/collect?v=2" }),
      abort,
    });
    expect(counters.blockedAnalyticsRequests).toBe(1);
    expect(intentional.analyticsUrls.has("https://www.google-analytics.com/g/collect?v=2")).toBe(true);
    expect(abort).toHaveBeenCalledTimes(1);
  });

  it("keeps analytics aborts out of unexpected request failures", () => {
    const page = makeEventPage();
    const failures = makeFailures();
    const intentional = { analyticsUrls: new Set(["https://www.google-analytics.com/g/collect"]), replayUrls: new Set<string>() };
    installFailureListeners(page, {
      counters: makeCounters(),
      failures,
      intentional,
      provenance: { sourceGeneration: null, source: null },
      origin: "https://pharos.watch",
    });

    page.emit("requestfailed", {
      url: () => "https://www.google-analytics.com/g/collect",
      resourceType: () => "fetch",
      failure: () => ({ errorText: "net::ERR_ABORTED" }),
    });

    expect(failures.failedRequests).toEqual([]);
  });
});

describe("SEO render audit API-failure replay", () => {
  function makeFakeRoute(url: string) {
    const fulfill = vi.fn(async () => undefined);
    const fallback = vi.fn(async () => undefined);
    return {
      route: { request: () => ({ url: () => url }), fulfill, fallback },
      fulfill,
      fallback,
    };
  }

  it("injects 503 data reads with no-store while letting HTML and assets through", async () => {
    const failures = makeFailures();
    const intentional = { replayUrls: new Set<string>() };
    const handler = createApiFailureReplayHandler({ origin: "https://pharos.watch", failures, intentional });

    for (const url of ["https://pharos.watch/_site-data/stablecoins", "https://pharos.watch/api/reference/coins"]) {
      const fake = makeFakeRoute(url);
      await handler(fake.route);
      expect(fake.fulfill).toHaveBeenCalledWith(expect.objectContaining({
        status: 503,
        headers: expect.objectContaining({ "cache-control": "no-store", "x-pharos-seo-audit-injection": "api-failure-replay" }),
      }));
    }
    expect(failures.intentionalBlocks).toHaveLength(2);
    expect(intentional.replayUrls.size).toBe(2);

    for (const url of ["https://pharos.watch/stablecoin/usdt-tether/", "https://pharos.watch/_next/static/app.js", "https://cdn.example/app.css"]) {
      const fake = makeFakeRoute(url);
      await handler(fake.route);
      expect(fake.fallback).toHaveBeenCalledTimes(1);
      expect(fake.fulfill).not.toHaveBeenCalled();
    }
  });

  it("parses already-fetched bytes in a JS-disabled page with every request blocked before content", async () => {
    const calls: string[] = [];
    let routeHandler: ((route: { abort: () => Promise<void> }) => Promise<void>) | null = null;
    const page = {
      route: vi.fn(async (_pattern: string, handler: typeof routeHandler) => {
        calls.push("route");
        routeHandler = handler;
      }),
      setContent: vi.fn(async () => {
        calls.push("setContent");
      }),
      evaluate: vi.fn(async () => {
        calls.push("evaluate");
        return { internalHrefs: ["/a/"] };
      }),
    };
    const context = {
      newPage: async () => page,
      close: async () => {
        calls.push("close");
      },
    };
    const browser = {
      newContext: vi.fn(async (options: unknown) => {
        calls.push(`newContext:${JSON.stringify(options)}`);
        return context;
      }),
    };

    const result = await captureRawSnapshot(browser, PROFILE_URL, "<main></main>");
    expect(result).toEqual({ snapshot: { internalHrefs: ["/a/"] }, blockedRequests: 0 });
    expect(calls.slice(0, 3)).toEqual([
      `newContext:${JSON.stringify({ viewport: { width: 412, height: 915 }, javaScriptEnabled: false })}`,
      "route",
      "setContent",
    ]);
    expect(calls).toContain("close");

    const abort = vi.fn(async () => undefined);
    await routeHandler!({ abort });
    expect(abort).toHaveBeenCalledTimes(1);
  });

  function assuranceFixture(text: string, { source = true }: { source?: boolean } = {}) {
    return makeSnapshot(
      `<main><h1>USDT</h1><dl><div><dt>Proof of reserves</dt><dd>${text}${source ? ' <a href="https://example.test/report">Reserve source</a>' : ""}</dd></div></dl></main>`,
    );
  }

  it("retains static assurance answers and reviewed reference destinations under injected failures", () => {
    const baseline = assuranceFixture("Examination by Deloitte");
    const retained = evaluate(assuranceFixture("Examination by Deloitte"), {
      replay: true,
      baseline: { mobile: baseline },
    });

    expect(byId(retained, "profile.static-assurance-answer")).toMatchObject({
      status: "present",
      observedCount: 1,
    });

    for (const replay of [
      assuranceFixture("Independent Audit"),
      assuranceFixture("Examination by Deloitte", { source: false }),
      makeSnapshot("<main><h1>USDT</h1></main>"),
    ]) {
      const sentinels = evaluate(replay, { replay: true, baseline: { mobile: baseline } });
      expect(byId(sentinels, "profile.static-assurance-answer").status).toBe("missing");
    }
  });

  it("does not require pool rows or chart data when the API-failed DEX card stays unavailable", () => {
    const baseline = makeSnapshot(poolSection({ rows: 5 }));
    const replay = makeSnapshot(
      '<main><h1>USDT</h1><section id="dex-liquidity"><div data-lazy-section=""><div role="alert">DEX liquidity data is temporarily unavailable.</div></div></section></main>',
    );
    const sentinels = evaluate(replay, { replay: true, baseline: { mobile: baseline } });

    expect(byId(sentinels, "profile.dex-pool-table")).toMatchObject({
      status: "not-observed",
      reason: "api-failure-replay-pool-data-unavailable",
    });
    expect(byId(sentinels, "profile.dex-chart-deferral")).toMatchObject({
      status: "not-observed",
      reason: "api-failure-replay-no-live-dex-read",
    });
  });

  it("installs replay interception in a fresh context before navigation", async () => {
    const calls: string[] = [];
    const routeCalls: Array<{ pattern: unknown; handler: (route: unknown) => Promise<void> }> = [];
    const snapshot = { internalHrefs: [], h1: { count: 1, text: "x" }, mainDomTextChars: 1, panels: [], surfaces: {}, assuranceAnswers: [], observedDates: [], mainInternalHrefs: [] };
    const page = {
      route: vi.fn(async (pattern: unknown, handler: (route: unknown) => Promise<void>) => {
        routeCalls.push({ pattern, handler });
        calls.push("route");
      }),
      on: vi.fn(),
      goto: vi.fn(async () => {
        calls.push("goto");
      }),
      waitForTimeout: vi.fn(async () => {
        calls.push("wait");
      }),
      evaluate: vi.fn(async (arg: unknown) => {
        calls.push("evaluate");
        return typeof arg === "string" ? snapshot : [];
      }),
      setViewportSize: vi.fn(async (size: { width: number; height: number }) => {
        calls.push(`viewport:${size.width}x${size.height}`);
      }),
      title: vi.fn(async () => "Title"),
    };
    const context = {
      newPage: async () => page,
      close: async () => {
        calls.push("close");
      },
    };
    const browser = {
      newContext: vi.fn(async (options: unknown) => {
        calls.push(`newContext:${JSON.stringify(options)}`);
        return context;
      }),
    };
    const counters = makeCounters();
    const failures = makeFailures();
    const provenance = { sourceGeneration: null, source: null };

    const result = await capturePageSnapshots(browser, PROFILE_URL, {
      waitMs: 0,
      counters,
      failures,
      provenance,
      replay: true,
      origin: "https://pharos.watch",
    });

    expect(calls.indexOf("route")).toBeLessThan(calls.indexOf("goto"));
    expect(calls).toContain("viewport:412x12000");
    expect(routeCalls).toHaveLength(2);
    expect(page.on).toHaveBeenCalled();
    expect(result.mobile).toBe(snapshot);
    expect(result.tall).toBe(snapshot);
    expect(calls).toContain("close");
  });
});

describe("SEO render audit route orchestration", () => {
  const rawSnapshot = () => makeSnapshot(poolSection({ rows: 5 }), { mode: "raw" });
  const mobileSnapshot = () => makeSnapshot(poolSection({ rows: 5 }));

  it("collects raw, mobile and tall observations and reports partial evidence", async () => {
    const raw = rawSnapshot();
    const mobile = mobileSnapshot();
    const row = await auditRoute({}, "https://pharos.watch/", "/stablecoin/usdt-tether/", {
      waitMs: 0,
      fetchHtmlImpl: async () => ({
        html: "<main></main>",
        status: 200,
        htmlBytes: 13,
        cacheControl: "public",
        cdnCacheControl: "",
        cfCacheStatus: "HIT",
        contentType: "text/html",
      }),
      captureRawSnapshotImpl: async () => ({ snapshot: raw, blockedRequests: 3 }),
      capturePageSnapshotsImpl: async () => ({
        mobile,
        tall: mobile,
        timing: { domContentLoadedMs: 1, loadMs: 2, responseStartMs: 0 },
        title: "USDT",
        intentional: { analyticsUrls: new Set(), replayUrls: new Set() },
      }),
    });

    expect(row).toMatchObject({
      route: "/stablecoin/usdt-tether/",
      captureStatus: "complete",
      captureReason: null,
      status: 200,
      cfCacheStatus: "HIT",
      title: "USDT",
    });
    expect(row.hrefLoss).toEqual({ mobile: [], tall: [] });
    expect(row.failures.intentionalBlocks).toContainEqual({ kind: "offline-raw-parser", count: 3 });
    expect(row.apiFailureReplay).toBeNull();
    expect(byId(row.sentinels, "profile.dex-pool-table")).toMatchObject({ status: "present" });
  });

  it("fails one route without losing later evidence", async () => {
    let calls = 0;
    const result = await collectAuditRows({}, "https://pharos.watch/", ["/stablecoin/a/", "/stablecoin/b/"], {}, {
      auditRouteImpl: (async () => {
        calls += 1;
        if (calls === 1) throw new Error("navigation timeout");
        return { route: "/stablecoin/b/", captureStatus: "complete" };
      }) as never,
    });

    expect(result.unrecoverable).toBe(true);
    expect(result.rows).toHaveLength(2);
    expect(result.rows[0]).toMatchObject({ route: "/stablecoin/a/", captureStatus: "failed" });
    expect(result.rows[1]).toEqual({ route: "/stablecoin/b/", captureStatus: "complete" });
    expect(calls).toBe(2);
  });

  it("raises the runtime failure signal only for unrecoverable captures, not diagnostics", async () => {
    let call = 0;
    const result = await collectAuditRows({}, "https://pharos.watch/", ["/a/", "/b/"], {}, {
      auditRouteImpl: (async () => {
        call += 1;
        if (call === 1) {
          return {
            route: "/a/",
            captureStatus: "failed",
            apiFailureReplay: null,
            sentinels: [{ id: "capture.snapshot", status: "not-observed" }],
          };
        }
        return {
          route: "/b/",
          captureStatus: "complete",
          apiFailureReplay: null,
          sentinels: [{ id: "profile.dex-pool-table", status: "missing" }],
        };
      }) as never,
    });

    expect(result.unrecoverable).toBe(true);
    expect(result.rows).toHaveLength(2);

    const advisory = await collectAuditRows({}, "https://pharos.watch/", ["/b/"], {}, {
      auditRouteImpl: (async () => ({
        route: "/b/",
        captureStatus: "complete",
        apiFailureReplay: { status: "complete", reason: null },
        sentinels: [{ id: "profile.dex-pool-table", status: "missing" }],
      })) as never,
    });
    expect(advisory.unrecoverable).toBe(false);
  });

  it("returns partial evidence instead of throwing when both acquires fail", async () => {
    const row = await auditRoute({}, "https://pharos.watch/", "/stablecoin/usdt-tether/", {
      waitMs: 0,
      fetchHtmlImpl: async () => {
        throw new Error("fetch timeout");
      },
      capturePageSnapshotsImpl: async () => {
        throw new Error("navigation timeout");
      },
    });

    expect(row.captureStatus).toBe("failed");
    expect(row.captureReason).toContain("raw-fetch-failed");
    expect(row.captureReason).toContain("browser-capture-failed");
    expect(row.failures.httpData).toEqual([]);
    expect(row.sentinels).toEqual([
      { id: "capture.snapshot", status: "not-observed", reason: "capture-failed", observedCount: null, sourceGeneration: null },
    ]);
  });

  it("appends at most one replay only for eligible selected routes", async () => {
    const replayResult = { status: "complete", reason: null, sentinels: [] };
    const replayImpl = vi.fn(async () => replayResult);
    const deps = {
      waitMs: 0,
      apiFailureReplay: true,
      fetchHtmlImpl: async () => ({
        html: "<main></main>",
        status: 200,
        htmlBytes: 13,
        cacheControl: "",
        cdnCacheControl: "",
        cfCacheStatus: "",
        contentType: "text/html",
      }),
      captureRawSnapshotImpl: async () => ({ snapshot: rawSnapshot(), blockedRequests: 0 }),
      capturePageSnapshotsImpl: async () => ({
        mobile: mobileSnapshot(),
        tall: mobileSnapshot(),
        timing: null,
        title: "T",
        intentional: { analyticsUrls: new Set(), replayUrls: new Set() },
      }),
      runApiFailureReplayImpl: replayImpl,
    };

    const profileRow = await auditRoute({}, "https://pharos.watch/", "/stablecoin/usdt-tether/", deps);
    const homeRow = await auditRoute({}, "https://pharos.watch/", "/", deps);
    const yieldRow = await auditRoute({}, "https://pharos.watch/", "/stablecoin/usdt-tether/yield/", deps);

    expect(replayImpl).toHaveBeenCalledTimes(1);
    expect(replayImpl).toHaveBeenCalledWith({}, "https://pharos.watch/stablecoin/usdt-tether/", expect.objectContaining({ surface: "profile" }));
    expect(profileRow.apiFailureReplay).toBe(replayResult);
    expect(homeRow.apiFailureReplay).toMatchObject({ status: "not-applicable", reason: "route-not-replay-eligible" });
    expect(yieldRow.apiFailureReplay).toMatchObject({ status: "not-applicable", reason: "route-not-replay-eligible" });
    expect(selectReplayRoutes(["/", "/stablecoin/usdt-tether/", "/stablecoin/usdt-tether/yield/", "/alt-pegs/", "/safety-scores/", "/compliance/", "/api/"]))
      .toEqual(["/stablecoin/usdt-tether/", "/alt-pegs/", "/safety-scores/", "/compliance/"]);
  });
});

describe("SEO render audit CLI and report", () => {
  it("bounds replay selection to eligible requested routes", () => {
    expect(isReplayEligibleRoute("/alt-pegs/")).toBe(true);
    expect(isReplayEligibleRoute("/safety-scores/")).toBe(true);
    expect(isReplayEligibleRoute("/compliance/")).toBe(true);
    expect(isReplayEligibleRoute("/stablecoin/usdt-tether/")).toBe(true);
    expect(isReplayEligibleRoute("/stablecoin/usdt-tether/yield/")).toBe(false);
    expect(isReplayEligibleRoute("/")).toBe(false);
    expect(isReplayEligibleRoute("/api/reference/")).toBe(false);
    expect(parseSeoRenderBudgetArgs([]).routes).toEqual(expect.arrayContaining(["/alt-pegs/", "/compliance/"]));
  });

  it("adds capture, sentinel, href-loss, failure and injection counters to the text report", () => {
    const row = {
      ...failedRouteRow("/", "https://pharos.watch/", new Error("boom")),
      sentinels: [
        { id: "a", status: "missing", reason: "x", observedCount: 0, sourceGeneration: null },
        { id: "b", status: "not-observed", reason: "y", observedCount: null, sourceGeneration: null },
      ],
      hrefLoss: { mobile: ["/a/"], tall: null },
      failures: {
        httpData: [{}],
        failedRequests: [],
        pageErrors: [],
        intentionalBlocks: [{ kind: "api-failure-replay", url: "https://pharos.watch/_site-data/x", status: 503 }],
      },
    };
    const report = formatTable([row]);
    const [headers, values] = report.split("\n");

    expect(headers.split("\t")).toEqual(expect.arrayContaining(["capture", "missing", "notObs", "hrefLost", "dataFail", "inject"]));
    expect(values.split("\t")).toEqual(expect.arrayContaining(["failed", "1", "1", "1", "1", "1"]));
  });
});
