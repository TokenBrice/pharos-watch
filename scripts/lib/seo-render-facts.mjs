import { STABLECOIN_DETAIL_HISTORY_PILOT_IDS } from "../../src/lib/presentation-pilots.mjs";

/** C1's five-profile cohort: each route must carry the inactive-panel facts. */
export const HISTORY_PREVIEW_PILOT_ROUTES = [...STABLECOIN_DETAIL_HISTORY_PILOT_IDS].map((id) => `/stablecoin/${id}/`);

/**
 * Later-wave expectations are listed here but never evaluated by this audit
 * until their owning implementation enrolls the exact selector and fixtures.
 */
export const UNENROLLED_SENTINEL_EXPECTATIONS = [
  { id: "profile.heading-semantics", ownerItem: "C4", reason: "enrolled-by-C4" },
  { id: "compliance.regime-panels", ownerItem: "B2", reason: "enrolled-by-B2" },
];

/** C3's pilot profiles: the complete `Contract addresses` fold must stay in the static HTML. */
export const DEPLOYMENT_FOLD_PILOT_ROUTES = [
  "/stablecoin/usdt-tether/",
  "/stablecoin/usdc-circle/",
];

/** Route fixtures are declared here, never inferred from the live DOM. */
export function getRouteExpectations(route) {
  const pathname = String(route ?? "").split(/[?#]/)[0].replace(/\/+$/, "") || "/";
  const normalized = `${pathname}/`;
  const expectations = {};
  if (HISTORY_PREVIEW_PILOT_ROUTES.includes(normalized)) {
    expectations.panels = { required: ["depeg"] };
    expectations.depegHistoryPreview = true;
  }
  if (DEPLOYMENT_FOLD_PILOT_ROUTES.includes(normalized)) expectations.deploymentFacts = true;
  return Object.keys(expectations).length > 0 ? expectations : null;
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
    const dataText = textOf(dataRoot);
    const caption = /Top (\d+) of (\d+) rated active stablecoins by Safety Score/.exec(dataText);
    const gradeDates = Array.from(dataRoot.querySelectorAll("time[datetime]"))
      .slice(0, 4)
      .map((time) => ({ datetime: time.getAttribute("datetime"), text: normalize(time.textContent).slice(0, 80) }));
    safetyScores = {
      present: true,
      profileLinks: cards.dataRoot.profileLinks,
      factualProfileLinks: cards.dataRoot.factualProfileLinks,
      alertPresent: Boolean(dataRoot.querySelector('[role="alert"]')),
      // B1: the dated preview is static markup, so these facts must survive an
      // API-failure replay instead of being excused as not observed.
      gradeDates,
      gradesAsOf: /Grades as of \d{4}-\d{2}-\d{2}/.exec(dataText)?.[0] ?? null,
      caption: caption ? { shown: Number(caption[1]), total: Number(caption[2]) } : null,
      gradeBadges: Array.from(dataRoot.querySelectorAll('[aria-label^="Safety grade "]')).length,
    };
  }

  const contractFolds = Array.from(document.querySelectorAll("details")).filter((details) => {
    const summary = details.querySelector("summary");
    return summary ? normalize(summary.textContent).startsWith("Contract addresses") : false;
  });
  // C3: the fold rows are plain, id-less static text, so read the fold's
  // element text and row count even while the fold is closed and the dossier
  // segment is hidden.
  const foldTexts = contractFolds.map((fold) => textOf(fold));
  const deploymentFold = {
    folds: contractFolds.length,
    rows: contractFolds.reduce((total, fold) => total + fold.querySelectorAll("li").length, 0),
    open: contractFolds.some((fold) => fold.hasAttribute("open")),
    textChars: foldTexts.reduce((longest, text) => Math.max(longest, text.length), 0),
  };

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
    deploymentFold,
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
 * Wave 1 semantic sentinels plus the enrolled C1, C3 and B1 expectations.
 * Statuses are advisory observations: only unrecoverable capture failures
 * affect the audit exit code. B2's regime panels stay unenrolled until their
 * owner adds the exact selector and fixtures.
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
 *   expectations?: { panels?: { required?: string[], notApplicable?: string[] }, depegHistoryPreview?: boolean, deploymentFacts?: boolean } | null,
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

    if (expectations?.deploymentFacts) {
      // C3: the fold is static and its rows are plain text, so the fold's raw
      // element text must exist in the JS-disabled parse and survive hydration
      // and an API-failure replay.
      const rawFold = raw?.deploymentFold ?? null;
      const mobileFold = mobile.deploymentFold ?? null;
      if (!rawFold) {
        results.push(sentinel("profile.deployment-facts", "not-observed", "raw-snapshot-unavailable", null, sourceGeneration));
      } else if (rawFold.folds === 0) {
        results.push(sentinel("profile.deployment-facts", "not-observed", "contract-fold-absent", null, sourceGeneration));
      } else if (rawFold.rows === 0 || rawFold.textChars < 20) {
        results.push(sentinel("profile.deployment-facts", "missing", "contract-fold-without-address-text", rawFold.rows, sourceGeneration));
      } else if (!mobileFold || mobileFold.folds === 0) {
        results.push(sentinel("profile.deployment-facts", "missing", "deployment-fold-lost-after-hydration", rawFold.rows, sourceGeneration));
      } else {
        results.push(sentinel("profile.deployment-facts", "present", null, rawFold.rows, sourceGeneration));
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
    // B1: the dated preview is static markup. Card facts are therefore
    // present under an injected API failure instead of excused as unobserved.
    if (!safety) {
      results.push(sentinel("safety-scores.card-facts", "not-observed", "safety-scores-data-section-not-found", null, sourceGeneration));
    } else if (safety.factualProfileLinks > 0) {
      results.push(sentinel("safety-scores.card-facts", "present", null, safety.factualProfileLinks, sourceGeneration));
    } else if (replay) {
      results.push(sentinel("safety-scores.card-facts", "not-observed", "api-failure-replay-no-score-seed", null, sourceGeneration));
    } else if (safety.alertPresent) {
      results.push(sentinel("safety-scores.card-facts", "not-observed", "report-cards-unavailable", null, sourceGeneration));
    } else {
      results.push(sentinel("safety-scores.card-facts", "not-observed", "card-facts-not-admitted", null, sourceGeneration));
    }

    const evaluateDatedPreview = (candidate) => {
      if (!candidate) return { status: "not-observed", reason: "safety-scores-data-section-not-found", count: null };
      if (candidate.gradeDates.length === 0) return { status: "missing", reason: "grade-date-time-missing", count: null };
      if (!candidate.gradesAsOf) return { status: "missing", reason: "grades-as-of-label-missing", count: candidate.gradeDates.length };
      if (!candidate.caption) return { status: "missing", reason: "preview-caption-missing", count: null };
      if (candidate.caption.shown < 1) return { status: "missing", reason: "preview-caption-without-rows", count: 0 };
      if (candidate.caption.shown > 20) return { status: "missing", reason: "preview-row-bound-exceeded", count: candidate.caption.shown };
      if (candidate.gradeBadges < candidate.caption.shown) {
        return { status: "missing", reason: "preview-grade-facts-missing", count: candidate.gradeBadges };
      }
      return { status: "present", reason: null, count: candidate.caption.shown };
    };
    // The preview unmounts once an equal or newer live publication lands, so a
    // healthy hydrated page proves it only from the JS-disabled parse of the
    // fetched bytes. Under replay the live read fails and the preview must stay
    // visible, which is the API-failure case this sentinel exists to catch.
    const rawSafety = raw?.surfaces?.safetyScores ?? null;
    let datedPreview = evaluateDatedPreview(replay ? safety : rawSafety);
    if (!replay && raw == null) {
      datedPreview = { status: "not-observed", reason: "raw-snapshot-unavailable", count: null };
    } else if (replay && datedPreview.status !== "present") {
      const baselinePreview = evaluateDatedPreview(rawSafety);
      if (baselinePreview.status === "present") {
        datedPreview = { status: "missing", reason: "dated-preview-lost-under-api-failure", count: datedPreview.count };
      }
    }
    results.push(sentinel(
      "safety-scores.dated-preview",
      datedPreview.status,
      datedPreview.reason,
      datedPreview.count,
      sourceGeneration,
    ));
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
