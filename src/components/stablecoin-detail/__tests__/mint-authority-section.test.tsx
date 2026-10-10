// @vitest-environment jsdom

import type { ReactElement } from "react";
import { describe, expect, it } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { hasMintAuthorityModuleData, MintAuthoritySection } from "../mint-authority-section";
import type {
  MintAuthorityDetailViewModel,
  MintAuthorityProcessDiagnosticViewModel,
} from "@/lib/stablecoin-detail-mint-authority-view-model";
import { buildControlPostureView } from "@/lib/control-posture";
import type { ControlComponentRoles } from "@/lib/pillar-evidence-strips";
import { CONTROL_COMPONENT_ROLE_LABELS, type ControlComponentRole } from "@shared/lib/classification";
import { makePublishedIssuanceSummary, makePublishedProcessDiagnostic } from "@shared/lib/__tests__/safety-score-v9-fixtures.test-support";
import type { V1005ProcessDiagnostic } from "@shared/types/safety-score-v9-facts";
import { TRACKED_META_BY_ID } from "@shared/lib/stablecoins/registry";
import { buildStablecoinDetailClientCoin } from "@/lib/stablecoin-detail-client-coin";
import { buildMintAuthorityDetailViewModel } from "@/lib/stablecoin-detail-mint-authority-view-model";

/** Server markup parsed into a detached container, so tests read structure rather than class tokens. */
function renderDom(element: ReactElement): HTMLElement {
  const container = document.createElement("div");
  container.innerHTML = renderToStaticMarkup(element);
  return container;
}

/** Disclosures in document order, named by anchor id or, without one, by their label. */
function disclosureOrder(container: HTMLElement): string[] {
  return [...container.querySelectorAll("details")].map((details) =>
    details.id || (details.querySelector("summary span")?.textContent ?? ""));
}

function controlRoles(mintRole: ControlComponentRole, oracleRole: ControlComponentRole): ControlComponentRoles {
  return {
    minimum: 45,
    evaluatedScore: 45,
    adjusted: false,
    components: [
      { key: "mint", label: "Mint", kind: "mint", score: 68, posture: "unbounded-governed", postureLabel: "Managed",
        role: mintRole, tone: "neutral" },
      { key: "oracle", label: "Oracle", kind: "oracle", score: 45, posture: "issuer-quote", postureLabel: "Issuer quote",
        role: oracleRole, tone: "warn" },
    ],
  };
}

function diagnostic(
  row: Pick<V1005ProcessDiagnostic, "code" | "gate" | "field"> & Partial<V1005ProcessDiagnostic>,
  statusLabel: MintAuthorityProcessDiagnosticViewModel["statusLabel"],
  overrides: Parameters<typeof makePublishedProcessDiagnostic>[1] = {},
): MintAuthorityProcessDiagnosticViewModel {
  const published = makePublishedProcessDiagnostic({
    controlRef: null, pathId: null, classId: null, memberRef: null, evidenceRefIds: [], ...row,
  }, overrides);
  return {
    ...published,
    key: JSON.stringify([published.gate, published.code, published.classId, published.field]),
    statusLabel,
  };
}

const REVIEWED_PROFILE: MintAuthorityDetailViewModel = {
  status: "reviewed",
  reviewLabel: "Reviewed by Pharos",
  mintPathLabel: "Facilitator bucket mint",
  mintPathShortLabel: "Facilitator",
  authorityPostureLabel: "Partially bounded admin",
  authorityPostureTone: "neutral",
  confidenceLabel: "Verified",
  confidenceVerified: true,
  verdict: "Governed — facilitators mint GHO within bucket caps, controlled by DAO governance; admin powers are only partly bounded.",
  summary: "GHO supply is minted by DAO-approved facilitators within bucket capacity.",
  inheritedFrom: null,
  controls: [
    {
      key: "aave-governance",
      label: "Aave Ethereum Governance",
      roleKey: "facilitator",
      roleLabel: "Facilitator",
      authorityTypeKey: "dao-governor",
      authorityTypeLabel: "DAO governor",
      threshold: 3,
      signerCount: 5,
      directMintAbilityLabel: "Cap-limited",
      locationLabel: "ethereum / 0x1234...abcd",
      fullLocationLabel: "ethereum / 0x123400000000000000000000000000000000abcd",
      addressUrl: "https://etherscan.io/address/0x123400000000000000000000000000000000abcd",
      securitySetupLabel: "DAO governor, 3/5 threshold",
      thresholdLabel: "3/5 threshold",
      timelockLabel: "1d timelock",
      capDescription: "Facilitator bucket capacity limits minting.",
      modulesOrGuardsLabel: "No modules or guards detected",
      custodyLabel: null,
      processDiagnostics: [],
    },
  ],
  sources: [
    {
      label: "Aave GHO facilitators",
      url: "https://example.com/gho-facilitators",
    },
  ],
  score: {
    score: 70,
    scoreLabel: "70/100",
    compactLabel: "70 · Governed",
    bandKey: "governed",
    bandLabel: "Governed",
    postureLabel: "Partially bounded admin",
    badgeClassName: "border-blue-500/30 bg-blue-500/10 text-blue-700 dark:text-blue-400",
    textClassName: "text-blue-700 dark:text-blue-400",
    detail: "Mint control posture: 70/100 (Governed).",
    caps: [],
  },
  reviewedAt: "2026-05-12",
  mintIncidents: [],
  sourceFreeRationale: null,
  unresolvedQuestions: [],
  processDiagnostics: [], processMetrics: [],
};

describe("MintAuthoritySection", () => {
  it("renders a published active issuance incident as a failed gate, not missing evidence", () => {
    const coin = buildStablecoinDetailClientCoin(TRACKED_META_BY_ID.get("usdc-circle")!);
    const profile = buildMintAuthorityDetailViewModel(coin, {
      mint: null, caps: [],
      issuanceSummary: makePublishedIssuanceSummary({}, [makePublishedProcessDiagnostic({
        code: "active-incident", gate: "H0", field: "incidentState", controlRef: null,
        pathId: null, classId: null, memberRef: null, evidenceRefIds: [],
      })]),
    });
    expect(profile.processDiagnostics[0]?.statusLabel).toBe("Failed gate");
    const dom = renderDom(<MintAuthoritySection profile={profile} />);
    expect(dom.textContent).toContain("Failed gate");
    expect(dom.textContent).toContain("Active incident");
    expect(dom.textContent).not.toContain("Missing evidence");
  });
  it("hides the section until a compact review is available", () => {
    const html = renderToStaticMarkup(<MintAuthoritySection profile={undefined} />);

    expect(html).toBe("");
  });

  const NOT_REVIEWED_PROFILE: MintAuthorityDetailViewModel = {
    status: "not-reviewed",
    reviewLabel: "Not reviewed by Pharos",
    mintPathLabel: "Unknown",
    mintPathShortLabel: "Unknown",
    authorityPostureLabel: "Unknown",
    authorityPostureTone: "neutral",
    confidenceLabel: "Not reviewed",
    confidenceVerified: false,
    verdict: null,
    summary: "Unknown does not mean no privileged mint authority.",
    inheritedFrom: null,
    controls: [],
    sources: [],
    score: null,
    reviewedAt: null,
    mintIncidents: [],
    sourceFreeRationale: null,
    unresolvedQuestions: [],
    processDiagnostics: [], processMetrics: [],
  };

  it("leaves an unreviewed coin without published evidence to the page's not-reviewed state", () => {
    expect(hasMintAuthorityModuleData(NOT_REVIEWED_PROFILE)).toBe(false);
    expect(renderToStaticMarkup(<MintAuthoritySection profile={NOT_REVIEWED_PROFILE} symbol="GHO" />)).toBe("");
  });

  it("keeps an unreviewed coin's published diagnostics visible as a one-row module", () => {
    const profile = { ...NOT_REVIEWED_PROFILE, processDiagnostics: [diagnostic({
      code: "process-certificate-unavailable", gate: "H0", field: "issuanceProcess.coverage",
    }, "Missing evidence")] };
    expect(hasMintAuthorityModuleData(profile)).toBe(true);
    const container = renderDom(<MintAuthoritySection profile={profile} symbol="GHO" />);

    const section = container.querySelector("section#mint-authority");
    expect(section?.getAttribute("data-evidence-module")).toBe("strip");
    expect(section?.textContent).toContain(NOT_REVIEWED_PROFILE.reviewLabel);
    expect(section?.querySelector("#mint-issuance-diagnostics")).not.toBeNull();
    // Nothing to draw without a review: no ladder, no rail.
    expect(section?.querySelector("[role='img']")).toBeNull();
  });

  it("renders one module shell with an h3 title on the mint-authority anchor", () => {
    const container = renderDom(<MintAuthoritySection profile={REVIEWED_PROFILE} symbol="GHO" />);

    const section = container.querySelector("section#mint-authority");
    expect(section).not.toBeNull();
    expect(container.querySelectorAll("section")).toHaveLength(1);
    const headingId = section!.getAttribute("aria-labelledby");
    expect(section!.querySelector(`#${headingId}`)?.tagName).toBe("H3");
    expect(section!.textContent).toContain(REVIEWED_PROFILE.score!.compactLabel);
  });

  it("keeps the verdict in the summary layer and the folds in fixed order, narrative last", () => {
    const container = renderDom(
      <MintAuthoritySection
        profile={{
          ...REVIEWED_PROFILE,
          processDiagnostics: [diagnostic({ code: "runtime-unmatched", gate: "shared", field: "runtimeHash" }, "Missing evidence")],
          mintIncidents: [{ date: "2024-01-30", status: "resolved", resolvedAt: null, summary: "Past exploit.", sources: [] }],
        }}
        symbol="GHO"
      />,
    );
    const html = container.innerHTML;

    expect(disclosureOrder(container)).toEqual([
      "Scoring breakdown",
      "mint-primary-controls",
      "mint-issuance-diagnostics",
      "Incident history",
      "mint-review-notes",
    ]);
    expect(html.indexOf(REVIEWED_PROFILE.verdict!)).toBeLessThan(html.indexOf("<details"));
    // Reviewer narrative and sources share the one provenance fold.
    const notes = container.querySelector("#mint-review-notes");
    expect(notes?.textContent).toContain(REVIEWED_PROFILE.summary);
    expect(notes?.querySelector(`a[href="${REVIEWED_PROFILE.sources[0]!.url}"]`)).not.toBeNull();
    expect(html.split(REVIEWED_PROFILE.summary)).toHaveLength(2);
  });

  it("omits the diagnostics fold when no issuance evidence is published", () => {
    const container = renderDom(<MintAuthoritySection profile={REVIEWED_PROFILE} symbol="GHO" />);
    expect(container.querySelector("#mint-issuance-diagnostics")).toBeNull();
  });

  it("stamps the review date once, in the footer line after every fold", () => {
    const container = renderDom(<MintAuthoritySection profile={REVIEWED_PROFILE} symbol="GHO" />);
    const section = container.querySelector("section#mint-authority")!;

    expect(section.textContent!.split(REVIEWED_PROFILE.reviewedAt!)).toHaveLength(2);
    // The deepest element carrying the stamp, wherever the footer line nests it.
    const stamp = [...section.querySelectorAll("*")]
      .filter((node) => node.textContent?.includes(`Reviewed ${REVIEWED_PROFILE.reviewedAt}`))
      .at(-1);
    expect(stamp).toBeDefined();
    const folds = section.querySelectorAll("details");
    const lastFold = folds[folds.length - 1]!;
    expect(lastFold.compareDocumentPosition(stamp!) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    expect(lastFold.contains(stamp!)).toBe(false);
  });

  it.each([
    { mint: "limiting", oracle: "eligible", tagged: true },
    { mint: "limiting", oracle: "limiting", tagged: true },
    { mint: "eligible", oracle: "limiting", tagged: false },
  ] as const)("tags the mint component as limiting only at the eligible minimum (mint $mint, oracle $oracle)", ({ mint, oracle, tagged }) => {
    const container = renderDom(
      <MintAuthoritySection profile={REVIEWED_PROFILE} symbol="GHO" controlRoles={controlRoles(mint, oracle)} />,
    );

    const tags = container.querySelectorAll("[data-control-role='limiting']");
    expect(tags).toHaveLength(tagged ? 1 : 0);
    expect(container.textContent!.includes(CONTROL_COMPONENT_ROLE_LABELS.limiting)).toBe(tagged);
  });

  it("draws no role tag without published control roles", () => {
    const container = renderDom(<MintAuthoritySection profile={REVIEWED_PROFILE} symbol="GHO" />);
    expect(container.querySelector("[data-control-role]")).toBeNull();
  });

  it("carries the control posture chip on #control-posture and its notes in the review fold", () => {
    const posture = buildControlPostureView(TRACKED_META_BY_ID.get("usdc-circle")!)!;
    const container = renderDom(
      <MintAuthoritySection profile={REVIEWED_PROFILE} symbol="GHO" controlPosture={posture} />,
    );
    const section = container.querySelector("section#mint-authority")!;
    const html = section.innerHTML;

    const chip = section.querySelector("#control-posture");
    expect(chip?.textContent).toContain(posture.label);
    expect(chip?.closest("details")).toBeNull();
    // A chip-row chip, after the verdict: never in the header beside the score.
    expect(html.indexOf(REVIEWED_PROFILE.verdict!)).toBeLessThan(html.indexOf('id="control-posture"'));
    // Its explanation joins the one provenance fold under its own subheading.
    const notes = section.querySelector("#mint-review-notes")!;
    expect([...notes.querySelectorAll("h4")].map((heading) => heading.textContent)).toContain("Control posture");
    for (const detail of posture.details) expect(notes.textContent).toContain(detail);
    // Summary, posture notes and one source.
    expect(notes.querySelector("summary")?.textContent).toContain("(3)");
    expect(section.querySelectorAll("details#mint-review-notes")).toHaveLength(1);
  });

  it("keeps an unreviewed module's posture chip and notes", () => {
    const posture = buildControlPostureView(TRACKED_META_BY_ID.get("usdc-circle")!)!;
    const profile = { ...NOT_REVIEWED_PROFILE, processDiagnostics: [diagnostic({
      code: "process-certificate-unavailable", gate: "H0", field: "issuanceProcess.coverage",
    }, "Missing evidence")] };
    const container = renderDom(<MintAuthoritySection profile={profile} symbol="GHO" controlPosture={posture} />);

    expect(container.querySelector("#control-posture")?.textContent).toContain(posture.label);
    expect(container.querySelector("#mint-review-notes")?.textContent).toContain(posture.details[0]);
  });

  it("draws no posture chip without an authored posture", () => {
    const container = renderDom(<MintAuthoritySection profile={REVIEWED_PROFILE} symbol="GHO" />);
    expect(container.querySelector("#control-posture")).toBeNull();
    expect(container.textContent).not.toContain("Control posture");
  });

  it("renders the band beside the score and links inherited mint risk to the parent review", () => {
    const html = renderToStaticMarkup(
      <MintAuthoritySection
        profile={{ ...REVIEWED_PROFILE, inheritedFrom: { symbol: "USDe", href: "/stablecoin/usde-ethena/#mint-authority" } }}
        symbol="sUSDe"
      />,
    );

    expect(html).toContain(">70 · Governed<");
    expect(html).toContain("Inherits USDe mint risk");
    expect(html).toMatch(/href="\/stablecoin\/usde-ethena\/?#mint-authority"/);
  });

  it("renders control and source link destinations and keeps methodology in the title's help glyph only", () => {
    const container = renderDom(<MintAuthoritySection profile={REVIEWED_PROFILE} />);
    const html = container.innerHTML;

    expect(html).toContain("https://etherscan.io/address/0x123400000000000000000000000000000000abcd");
    expect(html).toContain("https://example.com/gho-facilitators");
    // One methodology entry point: the (?) beside the title, never footer links.
    expect(container.querySelector("button[aria-label^='Explain']")).not.toBeNull();
    expect(container.querySelector("a[href*='/methodology']")).toBeNull();
    expect(container.textContent).not.toContain("View methodology");
  });

  it("drops the footer methodology links from an unreviewed coin's diagnostics strip too", () => {
    const profile = { ...NOT_REVIEWED_PROFILE, processDiagnostics: [diagnostic({
      code: "process-certificate-unavailable", gate: "H0", field: "issuanceProcess.coverage",
    }, "Missing evidence")] };
    const container = renderDom(<MintAuthoritySection profile={profile} symbol="GHO" />);

    expect(container.querySelector("a[href*='/methodology']")).toBeNull();
  });

  it.each([
    { id: "dai-makerdao", total: 149, omitted: 137 },
    { id: "usds-sky", total: 19, omitted: 7 },
  ])("discloses the full $id census count while rendering only the bounded controls", ({ id, total, omitted }) => {
    const coin = TRACKED_META_BY_ID.get(id)!;
    const view = buildMintAuthorityDetailViewModel(buildStablecoinDetailClientCoin(coin));
    const container = renderDom(<MintAuthoritySection profile={view} symbol={coin.symbol} />);

    const primary = container.querySelector("#mint-primary-controls")!;
    expect(primary.querySelectorAll(":scope > div > ul > li")).toHaveLength(12);
    expect(primary.querySelector("summary")?.textContent).toContain(`(${total})`);
    expect(primary.textContent).toContain(String(omitted));
    expect(primary.querySelector(`a[href="${view.controlCensusUrl}"]`)).not.toBeNull();
    expect(container.querySelector("[role='img'][aria-label*='controls']")?.getAttribute("aria-label")).toContain(String(total));
    expect(container.querySelector("a[href*='/methodology']")).toBeNull();
  });

  it("renders incident caps and custody context when present", () => {
    const html = renderToStaticMarkup(
      <MintAuthoritySection
        profile={{
          ...REVIEWED_PROFILE,
          controls: [
            {
              ...REVIEWED_PROFILE.controls[0],
              authorityTypeLabel: "Externally owned account",
              securitySetupLabel: "Externally owned account",
              custodyLabel: "Single-key address - custody unverifiable",
            },
          ],
          score: {
            ...REVIEWED_PROFILE.score!,
            score: 10,
            scoreLabel: "10/100",
            compactLabel: "10 · Exposed",
            bandLabel: "Exposed",
            badgeClassName: "border-red-500/30 bg-red-500/10 text-red-700 dark:text-red-400",
            textClassName: "text-red-700 dark:text-red-400",
            caps: [
              {
                kind: "signal:centralized-mint:critical",
                label: "Centralized mint (critical)",
                limitLabel: "<= 10",
                reason: "Economically effective minting is unbounded or compromised.",
              },
            ],
          },
          mintIncidents: [
            {
              date: "2024-06-13",
              status: "active",
              resolvedAt: null,
              summary: "Privileged mint authority created unbacked supply during an exploit.",
              sources: [{ label: "Incident report", url: "https://example.com/incident" }],
            },
          ],
        }}
      />,
    );

    // An active incident keeps the loud in-summary callout.
    expect(html).toContain("Mint incident 2024-06-13");
    expect(html).toContain("Privileged mint authority created unbacked supply");
    // Structural caps render inside the scoring breakdown with their reason.
    expect(html).toContain("Centralized mint (critical)");
    expect(html).toContain("&lt;= 10");
    expect(html).toContain("Economically effective minting is unbounded or compromised.");
    expect(html).toContain("Incident report");
    expect(html).toContain("https://example.com/incident");
    expect(html).toContain("Single-key address - custody unverifiable");
  });

  it("folds resolved incidents into a calm incident history ledger", () => {
    const html = renderToStaticMarkup(
      <MintAuthoritySection
        profile={{
          ...REVIEWED_PROFILE,
          mintIncidents: [
            {
              date: "2025-10-04",
              status: "resolved",
              resolvedAt: "2025-10-04",
              summary: "Second exploit borrowed stablecoin with no collateral.",
              sources: [],
            },
            {
              date: "2024-01-30",
              status: "resolved",
              resolvedAt: null,
              summary: "First exploit turned the borrow route into bad debt.",
              sources: [],
            },
          ],
        }}
      />,
    );

    // Resolved incidents are a historical record behind the disclosure: each
    // carries the resolved status word and none is presented as active.
    expect(html).toContain("Incident history");
    expect(html).toMatch(/Mint incident 2025-10-04<span[^>]*>Resolved</);
    expect(html).toContain("Second exploit borrowed stablecoin with no collateral.");
    expect(html).toMatch(/Mint incident 2024-01-30<span[^>]*>Resolved</);
    expect(html).toContain("First exploit turned the borrow route into bad debt.");
    expect(html).not.toMatch(/>Active</);
  });

  it("draws the mint rail and band ladder when a symbol is provided, absorbing the path and posture chips", () => {
    const html = renderToStaticMarkup(<MintAuthoritySection profile={REVIEWED_PROFILE} symbol="GHO" />);

    // Band ladder lights the published band; the standalone band text goes.
    expect(html).toContain("Hardened");
    expect(html).toContain("Exposed");
    // Rail stations: issuer path, control glyph row, supply symbol + posture.
    expect(html).toContain("Facilitator");
    expect(html).toContain("3/5");
    expect(html).toContain("GHO");
    expect(html).toContain("Partially bounded admin");
    // Absorbed chips: the full mint-path label survives only as the origin title.
    expect(html).not.toContain(">Facilitator bucket mint<");
    expect(html).toContain("Facilitator bucket mint");
  });

  it("keeps the chip summary when no symbol is available for the rail", () => {
    const html = renderToStaticMarkup(<MintAuthoritySection profile={REVIEWED_PROFILE} />);
    expect(html).toContain("Facilitator bucket mint");
    expect(html).toContain("Partially bounded admin");
  });

  it("renders verification gaps when review questions remain", () => {
    const html = renderToStaticMarkup(
      <MintAuthoritySection
        profile={{
          ...REVIEWED_PROFILE,
          sourceFreeRationale: "No public Safe module page exists for this chain.",
          unresolvedQuestions: ["Confirm whether the proxy admin can upgrade mint logic."],
        }}
      />,
    );

    expect(html).toContain("Verification gaps");
  });
});

describe("mint issuance diagnostics fold", () => {
  /** GHO-shaped: 13 published groups that split three reasons across per-route and per-node field paths. */
  const GHO_SHAPED = [
    ...[1, 2, 3, 4, 5].map((route) => diagnostic({
      code: "voting-census-unreconciled", gate: "D32", field: `routes.aave-l1-unopposed-${route}.controllerPowers`,
      controlRef: `ethereum:0x${"a".repeat(40)}`,
    }, "Missing evidence")),
    ...[1, 2, 3, 4, 5].map((route) => diagnostic({
      code: "voting-control-unproved", gate: "D32", field: `routes.aave-l1-unopposed-${route}.residualUpperRaw`,
    }, "Missing evidence")),
    diagnostic({ code: "voting-control-unproved", gate: "D32", field: "forcedDelegation" }, "Missing evidence"),
    diagnostic({ code: "governor-not-governance", gate: "shared", field: "authorityGraph.governorNodeId" }, "Failed gate"),
    diagnostic({
      code: "process-certificate-unavailable", gate: "H0", field: "issuanceProcess.coverage", classId: "keeper-class",
      pathId: "role-authorized-arbitrary-recipient-mint", evidenceRefIds: ["e1", "e10", "e100", "e2"],
    }, "Missing evidence", { count: 410 }),
  ];

  function renderFold(processDiagnostics: MintAuthorityProcessDiagnosticViewModel[], extra: Partial<MintAuthorityDetailViewModel> = {}) {
    const container = renderDom(<MintAuthoritySection profile={{ ...REVIEWED_PROFILE, processDiagnostics, ...extra }} symbol="GHO" />);
    return container.querySelector<HTMLElement>("#mint-issuance-diagnostics")!;
  }

  it("collapses groups that share a reason into one counted row", () => {
    const fold = renderFold(GHO_SHAPED);
    const rows = [...fold.querySelectorAll(":scope > div > ul > li")];

    expect(rows).toHaveLength(4);
    expect(fold.querySelector("summary")?.textContent).toContain(`(${rows.length})`);
    // No row repeats another row's text: each reason prints once.
    expect(new Set(rows.map((row) => row.textContent)).size).toBe(rows.length);
    // Five per-route paths of one reason merge into one field that carries their count.
    const fieldCounts = rows.flatMap((row) => [...row.querySelectorAll("[aria-label='Affected fields'] li")])
      .map((field) => field.textContent ?? "");
    expect(fieldCounts.some((text) => text.endsWith("×5"))).toBe(true);
  });

  it("prints no gate codes, evidence ids, class or path ids, or raw field paths", () => {
    const text = renderFold(GHO_SHAPED).textContent ?? "";

    expect(text).not.toMatch(/\bD\d{2}\b/);
    expect(text).not.toMatch(/\be\d+\b/);
    expect(text).not.toMatch(/\bH\d\b/);
    expect(text).not.toContain("keeper-class");
    expect(text).not.toContain("role-authorized-arbitrary-recipient-mint");
    expect(text).not.toContain("aave-l1-unopposed");
    expect(text).not.toContain("voting-census-unreconciled");
    // The facts behind the ids survive as counts.
    expect(text).toContain("410");
  });

  it("distinguishes missing proof from a failed screen and keeps measured metrics at NR", () => {
    const missing = diagnostic({ code: "operational-cap-unproved", gate: "H2", field: "maxKeeperFixedRewardSupplyPpm" },
      "Missing evidence", { count: 4 });
    const failed = diagnostic({ code: "operational-screen-failed", gate: "H3", field: "operationalExposurePpm" }, "Failed screen");
    const fold = renderFold([missing, failed], {
      score: null,
      processMetrics: [{ label: "Actual operational exercise delay", value: "0 s" }],
    });

    const rows = [...fold.querySelectorAll(":scope > div > ul > li")];
    expect(rows).toHaveLength(2);
    // Failures lead; each row carries its own status word.
    expect(rows[0]!.textContent).toContain(failed.statusLabel);
    expect(rows[1]!.textContent).toContain(missing.statusLabel);
    expect(fold.querySelector("dl")?.textContent).toContain("0 s");
  });
});
