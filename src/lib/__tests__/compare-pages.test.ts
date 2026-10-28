import { beforeEach, describe, expect, it, vi } from "vitest";
import type { RedemptionBackstopConfig } from "@shared/lib/redemption-backstop-configs/shared";
import { REDEMPTION_BACKSTOP_CONFIGS } from "@shared/lib/redemption-backstop-configs";
import {
  LIABILITY_RECONCILIATION_LABELS,
  PROOF_ASSURANCE_METHOD_LABELS,
  PROOF_ASSURANCE_SCOPE_LABELS,
  REDEMPTION_HOLDER_ELIGIBILITY_LABELS,
} from "@shared/lib/classification";
import {
  LIABILITY_RECONCILIATION_VALUES,
  PROOF_ASSURANCE_METHOD_VALUES,
  PROOF_ASSURANCE_SCOPE_VALUES,
} from "@shared/types/core";
import { RedemptionHolderEligibilitySchema } from "@shared/types/redemption";
import type { RedemptionDocSourceSupport, StablecoinMeta } from "@shared/types";

const mockGetCurrentRedemptionConfig = vi.hoisted(() =>
  vi.fn<(stablecoinId: string, nowSec?: number) => RedemptionBackstopConfig | null>(),
);
const mockGetSnapshotSafetyAssessment = vi.hoisted(() =>
  vi.fn<(stablecoinId: string) => { grade: string; score: number | null; bucket: string } | null>(),
);
vi.mock("@/lib/redemption-review-currency", () => ({
  getCurrentRedemptionConfig: mockGetCurrentRedemptionConfig,
}));
vi.mock("@/lib/safety-grade-snapshot", () => ({
  getSnapshotSafetyAssessment: mockGetSnapshotSafetyAssessment,
}));
vi.mock("@/lib/datasets/public-dataset-current", () => ({
  PUBLIC_DATASET_CURRENT_DATE: "2026-10-19",
}));

mockGetSnapshotSafetyAssessment.mockImplementation((id) => {
  if (id === "usdt-tether") return { grade: "A-", score: 81, bucket: "safe" };
  if (id === "usdc-circle") return { grade: "A+", score: 88, bucket: "safe" };
  if (id === "usdg-paxos") return { grade: "B", score: 73, bucket: "middle" };
  return null;
});
mockGetCurrentRedemptionConfig.mockImplementation(
  (stablecoinId) => REDEMPTION_BACKSTOP_CONFIGS[stablecoinId] ?? null,
);

const {
  COMPARISON_EVIDENCE_PILOT_SLUGS,
  STATIC_COMPARISON_PAGE_BY_SLUG,
  STATIC_COMPARISON_PAGES,
  buildComparisonAtAGlanceRows,
  buildComparisonEvidenceRows,
  buildComparisonFaqItems,
  buildComparisonResearchLinks,
  buildComparisonSnippetAnswer,
  buildComparisonTitle,
  buildStaticComparisonJsonLd,
} = await import("@/lib/compare-pages");

const NOW_SEC = Date.parse("2026-10-28T00:00:00Z") / 1_000;
const PHYSICAL_EXPIRY_DAY_SEC = Date.parse("2026-12-30T00:00:00Z") / 1_000;
const DAY_SEC = 24 * 60 * 60;

type ComparisonPage = NonNullable<ReturnType<typeof STATIC_COMPARISON_PAGE_BY_SLUG.get>>;
type Proof = NonNullable<StablecoinMeta["proofOfReserves"]>;
type LatestReport = NonNullable<Proof["latestReport"]>;
type ComparisonRow = ReturnType<typeof buildComparisonAtAGlanceRows>[number];

const EXAMINATION_SCOPE = "Examination; assets and liabilities; full liability reconciliation";
const ATTESTATION_PARTIAL_SCOPE = "Attestation; assets and liabilities; partial liability reconciliation";
const ATTESTATION_FULL_SCOPE = "Attestation; assets and liabilities; full liability reconciliation";
const USDE_SCOPE = "Method not established; assets only; liability reconciliation unknown";

const VERIFIED_REPORT: LatestReport = {
  periodEnd: "2026-09-30",
  publishedAt: "2026-10-10",
  assuranceMethod: "examination",
  scope: "assets-and-liabilities",
  liabilityReconciliation: "full",
  reviewer: "Synthetic reviewer note that must never leak into a rendered fact",
  confidence: "verified",
  sources: [{ label: "Synthetic examination report", url: "https://example.com/report.pdf" }],
};

function getPage(slug: string): ComparisonPage {
  const page = STATIC_COMPARISON_PAGE_BY_SLUG.get(slug);
  if (!page) throw new Error(`missing compare page ${slug}`);
  return page;
}

function report(overrides: Partial<LatestReport> = {}): LatestReport {
  return { ...VERIFIED_REPORT, ...overrides };
}

function proofWith(latestReport: LatestReport | undefined): Proof {
  return latestReport === undefined
    ? { type: "independent-audit", url: "https://example.com/reserves" }
    : { type: "independent-audit", url: "https://example.com/reserves", latestReport };
}

function pageWithProofs(slug: string, leftProof: Proof | undefined, rightProof: Proof | undefined): ComparisonPage {
  const page = getPage(slug);
  return {
    ...page,
    left: { ...page.left, proofOfReserves: leftProof },
    right: { ...page.right, proofOfReserves: rightProof },
  };
}

function findRow(rows: readonly ComparisonRow[], label: string): ComparisonRow | undefined {
  return rows.find((row) => row.label === label);
}

const PILOT_REPORT_FACTS: Record<string, { left: { period: string; scope: string }; right: { period: string; scope: string } }> = {
  "usdc-circle-vs-usdg-paxos": {
    left: { period: "2026-09-30", scope: EXAMINATION_SCOPE },
    right: { period: "2026-09-30", scope: EXAMINATION_SCOPE },
  },
  "usdt-tether-vs-usdg-paxos": {
    left: { period: "2026-06-30", scope: ATTESTATION_PARTIAL_SCOPE },
    right: { period: "2026-09-30", scope: EXAMINATION_SCOPE },
  },
  "rlusd-ripple-vs-usdc-circle": {
    left: { period: "2026-08-31", scope: EXAMINATION_SCOPE },
    right: { period: "2026-09-30", scope: EXAMINATION_SCOPE },
  },
  "paxg-paxos-vs-xaut-tether": {
    left: { period: "2026-09-30", scope: EXAMINATION_SCOPE },
    right: { period: "2026-06-30", scope: ATTESTATION_FULL_SCOPE },
  },
  "usdt-tether-vs-usdc-circle": {
    left: { period: "2026-06-30", scope: ATTESTATION_PARTIAL_SCOPE },
    right: { period: "2026-09-30", scope: EXAMINATION_SCOPE },
  },
  "usde-ethena-vs-usds-sky": {
    left: { period: "2026-09-27", scope: USDE_SCOPE },
    right: { period: "Not recorded", scope: "Not recorded" },
  },
};

const REDEMPTION_FACTS: Record<
  string,
  { eligibility: string; minimum: string | null; feeBasis: string | null }
> = {
  "usdc-circle": {
    eligibility: "Verified customers (reviewed 2026-05-17)",
    minimum: null,
    feeBasis: "1:1 via Circle Mint; EEA burn fee is 0 bps, other Circle fees may vary (reviewed 2026-05-17)",
  },
  "usdt-tether": {
    eligibility: "Verified customers (reviewed 2026-04-16)",
    minimum: "$100,000 (reviewed 2026-04-16)",
    feeBasis: "0.10%, with a minimum fee of $1,000 (reviewed 2026-04-16)",
  },
  "usdg-paxos": {
    eligibility: "Verified customers (reviewed 2026-06-10)",
    minimum: null,
    feeBasis: "Paxos states it does not charge a USDG redemption fee (reviewed 2026-06-10)",
  },
  "rlusd-ripple": {
    eligibility: "Verified customers (reviewed 2026-10-07)",
    minimum: null,
    feeBasis:
      "Ripple Mint charges no mint or redeem fees; applicable Customer Agreement conditions and standard bank/payment costs remain separate (reviewed 2026-10-07)",
  },
  "paxg-paxos": {
    eligibility: "Verified customers (reviewed 2026-10-01)",
    minimum: "430 PAXG deposit for a full bar; excess tokens returned (reviewed 2026-10-01)",
    feeBasis:
      "Standard tariff effective 2026-09-01: 12.5-50 bps on rolling-30-day net redemptions, plus 5 bps for in-kind gold conversion. Customer-specific pricing may override it; delivery, dealer, tax and bank costs are separate. (reviewed 2026-10-09)",
  },
  "xaut-tether": {
    eligibility: "Verified customers (reviewed 2026-10-01)",
    minimum: "430 XAUT deposit for a full bar; excess tokens returned (reviewed 2026-10-01)",
    feeBasis: "25 bps issuer redemption fee, plus delivery and applicable fees (reviewed 2026-10-01)",
  },
  "usde-ethena": {
    eligibility: "Whitelisted primary-market participants (reviewed 2026-03-23)",
    minimum: null,
    feeBasis: "10 bps for USDT/USDC redemption under the reviewed USDe terms (reviewed 2026-03-23)",
  },
  "usds-sky": { eligibility: "Not recorded", minimum: null, feeBasis: null },
};

function expectRedemptionRows(page: ComparisonPage, nowSec = NOW_SEC) {
  const rows = buildComparisonAtAGlanceRows(page, nowSec);
  for (const [side, coin] of [["left", page.left], ["right", page.right]] as const) {
    const facts = REDEMPTION_FACTS[coin.id];
    const eligibility = findRow(rows, "Direct redemption eligibility");
    const minimum = findRow(rows, "Redemption minimum");
    const feeBasis = findRow(rows, "Redemption fee basis");
    if (facts.eligibility === "Not recorded" && facts.minimum === null && facts.feeBasis === null) {
      // The redemption rows are still present when the other side has evidence.
      expect(eligibility?.[side] ?? "Not recorded").toBe("Not recorded");
      expect(minimum?.[side] ?? "Not recorded").toBe("Not recorded");
      expect(feeBasis?.[side] ?? "Not recorded").toBe("Not recorded");
      continue;
    }
    expect(eligibility?.[side]).toBe(facts.eligibility);
    if (facts.minimum !== null) expect(minimum?.[side]).toBe(facts.minimum);
    else expect(minimum?.[side] ?? "Not recorded").toBe("Not recorded");
    if (facts.feeBasis !== null) expect(feeBasis?.[side]).toBe(facts.feeBasis);
    else expect(feeBasis?.[side] ?? "Not recorded").toBe("Not recorded");
  }
  return rows;
}

beforeEach(() => {
  mockGetCurrentRedemptionConfig.mockReset();
  mockGetCurrentRedemptionConfig.mockImplementation(
    (stablecoinId) => REDEMPTION_BACKSTOP_CONFIGS[stablecoinId] ?? null,
  );
});

describe("static comparison metadata", () => {
  it("uses the Safety Score title and a shorter fallback past the budget", () => {
    expect(getPage("usdt-tether-vs-usdc-circle").title).toBe("USDT vs USDC: Safety Scores, Reserves & Risk");
    expect(buildComparisonTitle("LONGSYMBOL vs OTHERLONGSYM")).toBe("LONGSYMBOL vs OTHERLONGSYM: Safety Scores & Risk");
    for (const page of STATIC_COMPARISON_PAGES) {
      expect(page.title).not.toMatch(/[‒-―]/);
      expect(`${page.title} | Pharos`.length).toBeLessThanOrEqual(62);
    }
  });

  it("puts both dated grades in the description", () => {
    expect(getPage("usdt-tether-vs-usdc-circle").description).toBe(
      "Tether (USDT, A- 81/100) vs USD Coin (USDC, A+ 88/100), Safety Scores as of 2026-10-19: reserves, redemption, freeze controls and chain reach.",
    );
  });

  it("falls back to the structural description when a grade is missing, never printing N/A", () => {
    const description = getPage("usdt-tether-vs-usde-ethena").description;
    expect(description).toMatch(/^USDT vs USDe comparison:/);
    expect(description).not.toContain("N/A");
    expect(description).not.toContain("/100");
  });

  it("names each coin and ticker as a profile destination in the research list", () => {
    expect(buildComparisonResearchLinks(getPage("usdt-tether-vs-usdc-circle")).slice(0, 2)).toEqual([
      { href: "/stablecoin/usdt-tether/", label: "Tether (USDT) profile" },
      { href: "/stablecoin/usdc-circle/", label: "USD Coin (USDC) profile" },
    ]);
  });
});

describe("static comparison brief", () => {
  it("cites both dated grades in the short answer and keeps the caveat", () => {
    const answer = buildComparisonSnippetAnswer(getPage("usdt-tether-vs-usdc-circle"));
    expect(answer.answer).toMatch(
      /^In the Pharos Safety Score release of 2026-10-19, USDT held an A- Safety Score grade \(81\/100\) and USDC held an A\+ Safety Score grade \(88\/100\)\. There is no honest static answer/,
    );
    expect(answer.caveat).toContain("can change after this static brief is generated");
  });

  it("appends the grades to curated editorial answers", () => {
    const page = getPage("usdc-circle-vs-usdg-paxos");
    const answer = buildComparisonSnippetAnswer(page);
    expect(answer.answer.startsWith(page.editorial!.answer)).toBe(true);
    expect(answer.answer).toContain("USDG held a B Safety Score grade (73/100)");
    expect(answer.caveat).toContain("does not rank either token as categorically safer");
    expect(buildComparisonFaqItems(page)[0].answer).toBe(answer.answer);
  });

  it("adds a dated Safety Score row only when both grades exist", () => {
    expect(buildComparisonAtAGlanceRows(getPage("usdt-tether-vs-usdc-circle"), NOW_SEC)[0]).toEqual({
      label: "Safety Score (as of 2026-10-19)",
      left: "A- 81/100",
      right: "A+ 88/100",
    });
    expect(
      buildComparisonAtAGlanceRows(getPage("usdt-tether-vs-usde-ethena"), NOW_SEC).some((row) =>
        row.label.startsWith("Safety Score"),
      ),
    ).toBe(false);
  });

  it("mirrors the grades in the safety FAQ answer", () => {
    const safetyFaq = buildComparisonFaqItems(getPage("usdt-tether-vs-usdc-circle"))[1];
    expect(safetyFaq.question).toBe("Which is safer: USDT or USDC?");
    expect(safetyFaq.answer).toMatch(/^In the Pharos Safety Score release of 2026-10-19, USDT held an A- /);
    expect(safetyFaq.answer).toContain("Safety is not decided by ticker alone.");
    const fallbackFaq = buildComparisonFaqItems(getPage("usdt-tether-vs-usde-ethena"))[1];
    expect(fallbackFaq.answer).toMatch(/^Safety is not decided by ticker alone\./);
  });
});

describe("comparison evidence pilot scope", () => {
  it("registers exactly the six canonical pilot slugs, RLUSD first, in plan order", () => {
    expect([...COMPARISON_EVIDENCE_PILOT_SLUGS]).toEqual([
      "usdc-circle-vs-usdg-paxos",
      "usdt-tether-vs-usdg-paxos",
      "rlusd-ripple-vs-usdc-circle",
      "paxg-paxos-vs-xaut-tether",
      "usdt-tether-vs-usdc-circle",
      "usde-ethena-vs-usds-sky",
    ]);
    for (const slug of COMPARISON_EVIDENCE_PILOT_SLUGS) {
      expect(STATIC_COMPARISON_PAGE_BY_SLUG.has(slug), slug).toBe(true);
    }
    expect(STATIC_COMPARISON_PAGE_BY_SLUG.has("usdc-circle-vs-rlusd-ripple")).toBe(false);
    expect(getPage("rlusd-ripple-vs-usdc-circle").left.id).toBe("rlusd-ripple");
  });

  it("keeps every non-pilot pair on its existing structural rows", () => {
    const page = getPage("usdt-tether-vs-dai-makerdao");
    expect(buildComparisonEvidenceRows(page, NOW_SEC)).toEqual([]);
    const labels = buildComparisonAtAGlanceRows(page, NOW_SEC).map((row) => row.label);
    expect(labels).not.toContain("Latest reviewed report period");
    expect(labels).not.toContain("Assurance scope");
    expect(labels).not.toContain("Direct redemption eligibility");
    expect(labels).not.toContain("Redemption minimum");
    expect(labels).not.toContain("Redemption fee basis");
  });

  it("places at most five evidence rows immediately after Reserve signal", () => {
    for (const slug of COMPARISON_EVIDENCE_PILOT_SLUGS) {
      const page = getPage(slug);
      const labels = buildComparisonAtAGlanceRows(page, NOW_SEC).map((row) => row.label);
      const signalIndex = labels.indexOf("Reserve signal");
      const chainsIndex = labels.indexOf("Tracked chains");
      expect(signalIndex).toBeGreaterThan(-1);
      expect(chainsIndex).toBeGreaterThan(signalIndex);
      const evidenceLabels = buildComparisonEvidenceRows(page, NOW_SEC).map((row) => row.label);
      expect(labels.slice(signalIndex + 1, chainsIndex)).toEqual(evidenceLabels);
      expect(evidenceLabels.length).toBeLessThanOrEqual(5);
    }
  });
});

describe("reviewed report evidence", () => {
  it("renders the reviewed report period and scope for every pilot pair", () => {
    for (const [slug, expected] of Object.entries(PILOT_REPORT_FACTS)) {
      const rows = buildComparisonAtAGlanceRows(getPage(slug), NOW_SEC);
      expect(findRow(rows, "Latest reviewed report period"), slug).toEqual(
        expect.objectContaining({ left: expected.left.period, right: expected.right.period }),
      );
      expect(findRow(rows, "Assurance scope"), slug).toEqual(
        expect.objectContaining({ left: expected.left.scope, right: expected.right.scope }),
      );
    }
  });

  it("keeps USDT partial and USDe unknown instead of promoting either", () => {
    const usdtRows = buildComparisonAtAGlanceRows(getPage("usdt-tether-vs-usdc-circle"), NOW_SEC);
    expect(findRow(usdtRows, "Assurance scope")?.left).toBe(ATTESTATION_PARTIAL_SCOPE);
    expect(findRow(usdtRows, "Assurance scope")?.left).toContain("partial liability reconciliation");

    const usdeRows = buildComparisonAtAGlanceRows(getPage("usde-ethena-vs-usds-sky"), NOW_SEC);
    expect(findRow(usdeRows, "Assurance scope")?.left).toBe(USDE_SCOPE);
    expect(findRow(usdeRows, "Assurance scope")?.left).toContain("Method not established");
    expect(findRow(usdeRows, "Assurance scope")?.left).toContain("assets only");
  });

  it("does not read the storage type as an audit for examination records", () => {
    for (const coinId of ["usdc-circle", "usdg-paxos", "rlusd-ripple", "paxg-paxos"]) {
      const page = getPage(
        {
          "usdc-circle": "usdc-circle-vs-usdg-paxos",
          "usdg-paxos": "usdc-circle-vs-usdg-paxos",
          "rlusd-ripple": "rlusd-ripple-vs-usdc-circle",
          "paxg-paxos": "paxg-paxos-vs-xaut-tether",
        }[coinId]!,
      );
      const side = page.left.id === coinId ? "left" : "right";
      const rows = buildComparisonAtAGlanceRows(page, NOW_SEC);
      expect(findRow(rows, "Assurance scope")?.[side], coinId).not.toMatch(/\bAudit\b/);
      expect(findRow(rows, "Reserve signal")?.[side], coinId).toBe("Examination");
    }
  });

  it("shows every recorded report source, including USDe's September source", () => {
    const usdeRow = findRow(
      buildComparisonAtAGlanceRows(getPage("usde-ethena-vs-usds-sky"), NOW_SEC),
      "Latest reviewed report period",
    );
    expect(usdeRow?.leftSources?.map((source) => source.href)).toEqual([
      "https://ethena.fi/blog/custodian-attestations-of-assets-backing-usde-august-3",
      "https://ethena.fi/blog/custodian-attestations-of-assets-backing-usde-september-3",
    ]);
    expect(usdeRow?.leftSources?.[1]?.label).toContain("September");
    expect(JSON.stringify(usdeRow)).not.toContain("Chaos Labs");
  });

  it("never leaks reviewer notes or the long USDe provider note into a fact", () => {
    for (const slug of COMPARISON_EVIDENCE_PILOT_SLUGS) {
      const rows = buildComparisonAtAGlanceRows(getPage(slug), NOW_SEC);
      const serialized = JSON.stringify(rows);
      expect(serialized).not.toContain("Synthetic reviewer note");
      expect(serialized).not.toContain("real-time dashboard and monthly custodian reporting");
    }
  });
});

describe("report evidence admission", () => {
  const slug = "usdc-circle-vs-usdg-paxos";

  it("omits both report rows when neither side has a verified structured report", () => {
    for (const leftProof of [
      undefined,
      proofWith(report({ confidence: "probable" })),
      proofWith(report({ sources: [{ label: "FTP report", url: "ftp://example.com/report.pdf" }] })),
    ]) {
      const page = pageWithProofs(slug, leftProof, undefined);
      const labels = buildComparisonEvidenceRows(page, NOW_SEC).map((row) => row.label);
      expect(labels).not.toContain("Latest reviewed report period");
      expect(labels).not.toContain("Assurance scope");
      // Redemption evidence is independent of the report rows.
      expect(labels).toContain("Direct redemption eligibility");
    }
  });

  it("keeps one-sided absence explicit as Not recorded", () => {
    const page = pageWithProofs(slug, proofWith(report()), undefined);
    const rows = buildComparisonAtAGlanceRows(page, NOW_SEC);
    const period = findRow(rows, "Latest reviewed report period");
    const scope = findRow(rows, "Assurance scope");
    expect(period?.left).toBe("2026-09-30");
    expect(period?.right).toBe("Not recorded");
    expect(scope?.left).toBe(EXAMINATION_SCOPE);
    expect(scope?.right).toBe("Not recorded");
    expect(period?.rightSources).toBeUndefined();
  });

  it("retains an explicitly unknown scope instead of inventing one", () => {
    const page = pageWithProofs(
      slug,
      proofWith(report({ assuranceMethod: "unknown", scope: "unknown", liabilityReconciliation: "unknown" })),
      undefined,
    );
    const scope = findRow(buildComparisonAtAGlanceRows(page, NOW_SEC), "Assurance scope");
    expect(scope?.left).toBe("Method not established; scope unknown; liability reconciliation unknown");
  });

  it("does not substitute a publication date or an invalid date for a missing period", () => {
    const withoutPeriod = pageWithProofs(slug, proofWith(report({ periodEnd: undefined })), proofWith(report()));
    expect(findRow(buildComparisonAtAGlanceRows(withoutPeriod, NOW_SEC), "Latest reviewed report period")).toEqual(
      expect.objectContaining({ left: "Not recorded", right: "2026-09-30" }),
    );

    const invalidPeriod = pageWithProofs(slug, proofWith(report({ periodEnd: "2026-13-40" })), proofWith(report()));
    expect(
      findRow(buildComparisonAtAGlanceRows(invalidPeriod, NOW_SEC), "Latest reviewed report period"),
    ).toEqual(expect.objectContaining({ left: "Not recorded", right: "2026-09-30" }));
  });
});

describe("reviewed redemption evidence", () => {
  it("renders the reviewed eligibility, minimum and fee basis for every pilot pair", () => {
    for (const slug of COMPARISON_EVIDENCE_PILOT_SLUGS) {
      expectRedemptionRows(getPage(slug));
    }
  });

  it("keeps the $100,000 redemption minimum distinct from the $1,000 fee minimum", () => {
    const rows = buildComparisonAtAGlanceRows(getPage("usdt-tether-vs-usdc-circle"), NOW_SEC);
    expect(findRow(rows, "Redemption minimum")?.left).toBe("$100,000 (reviewed 2026-04-16)");
    expect(findRow(rows, "Redemption fee basis")?.left).toBe(
      "0.10%, with a minimum fee of $1,000 (reviewed 2026-04-16)",
    );
    const config = REDEMPTION_BACKSTOP_CONFIGS["usdt-tether"];
    expect(config.v9RouteReviewTerms?.minRedeemUsd).toBe(100_000);
    expect(config.v9RouteCostTerms?.minFeeUsd).toBe(1_000);
  });

  it("withholds redemption cells when the reviewed config is absent or expired", async () => {
    // The shared helper owns the 365-day reviewed-evidence budget; a far-future
    // clock proves it expires a real config without reimplementing the check.
    const actual = await vi.importActual<typeof import("@/lib/redemption-review-currency")>(
      "@/lib/redemption-review-currency",
    );
    expect(actual.getCurrentRedemptionConfig("usdc-circle", Date.parse("2028-01-01T00:00:00Z") / 1_000)).toBeNull();

    mockGetCurrentRedemptionConfig.mockReturnValue(null);
    const absent = buildComparisonAtAGlanceRows(getPage("usdt-tether-vs-usdc-circle"), NOW_SEC);
    expect(findRow(absent, "Direct redemption eligibility")).toBeUndefined();
    expect(findRow(absent, "Redemption minimum")).toBeUndefined();
    expect(findRow(absent, "Redemption fee basis")).toBeUndefined();
    // Report evidence is server-owned and survives the config omission.
    expect(findRow(absent, "Latest reviewed report period")?.left).toBe("2026-06-30");

    mockGetCurrentRedemptionConfig.mockImplementation((id) =>
      id === "usdt-tether" ? null : (REDEMPTION_BACKSTOP_CONFIGS[id] ?? null),
    );
    const oneSided = buildComparisonAtAGlanceRows(getPage("usdt-tether-vs-usdc-circle"), NOW_SEC);
    expect(findRow(oneSided, "Direct redemption eligibility")?.left).toBe("Not recorded");
    expect(findRow(oneSided, "Direct redemption eligibility")?.right).toBe(
      "Verified customers (reviewed 2026-05-17)",
    );
  });

  it("admits a physical review on its expiry day and withholds it the next day", () => {
    const page = getPage("paxg-paxos-vs-xaut-tether");
    const expiryDay = buildComparisonAtAGlanceRows(page, PHYSICAL_EXPIRY_DAY_SEC);
    expect(findRow(expiryDay, "Direct redemption eligibility")?.left).toBe(
      "Verified customers (reviewed 2026-10-01)",
    );
    expect(findRow(expiryDay, "Redemption minimum")?.left).toContain("430 PAXG");
    expect(findRow(expiryDay, "Redemption fee basis")?.right).toContain("25 bps issuer redemption fee");

    const afterExpiry = buildComparisonAtAGlanceRows(page, PHYSICAL_EXPIRY_DAY_SEC + DAY_SEC);
    // Both physical routes expire together, so the wholly unavailable rows are
    // omitted rather than rendered as an empty heading.
    expect(findRow(afterExpiry, "Direct redemption eligibility")).toBeUndefined();
    expect(findRow(afterExpiry, "Redemption minimum")).toBeUndefined();
    // XAUT's fee clock is the physical review; PAXG's is the tariff review.
    expect(findRow(afterExpiry, "Redemption fee basis")?.right).toBe("Not recorded");
    expect(findRow(afterExpiry, "Redemption fee basis")?.left).toContain("(reviewed 2026-10-09)");
  });

  it("replaces eligibility with Route suspended only for a reviewed suspension", () => {
    const usdc = REDEMPTION_BACKSTOP_CONFIGS["usdc-circle"];
    const suspended: RedemptionBackstopConfig = {
      ...structuredClone(usdc),
      routeStatus: "suspended",
      routeSuspension: {
        routeId: "redemption:usdc-circle:offchain-issuer",
        channel: "Circle Mint",
        suspendedAt: "2026-09-01",
        reason: "Synthetic reviewed suspension",
        reviewer: "Synthetic reviewer",
        reviewedAt: "2026-09-02",
        sources: [{ url: "https://www.circle.com/legal/usdc-terms", quote: "Synthetic suspension notice" }],
      },
    };
    mockGetCurrentRedemptionConfig.mockImplementation((id) =>
      id === "usdc-circle" ? suspended : (REDEMPTION_BACKSTOP_CONFIGS[id] ?? null),
    );
    const eligibility = findRow(
      buildComparisonAtAGlanceRows(getPage("usdc-circle-vs-usdg-paxos"), NOW_SEC),
      "Direct redemption eligibility",
    );
    expect(eligibility?.left).toBe("Route suspended (reviewed 2026-09-02)");
    expect(eligibility?.leftSources).toEqual([
      { label: "circle.com", href: "https://www.circle.com/legal/usdc-terms" },
    ]);
  });

  it("only cites field-scoped evidence for access and fee claims", () => {
    const usdc = REDEMPTION_BACKSTOP_CONFIGS["usdc-circle"];
    const capacityOnly: RedemptionDocSourceSupport[] = ["capacity"];
    const docs = usdc.docs?.map((doc) => ({ ...doc, supports: capacityOnly }));
    const config: RedemptionBackstopConfig = { ...structuredClone(usdc), docs };
    mockGetCurrentRedemptionConfig.mockImplementation((id) =>
      id === "usdc-circle" ? config : (REDEMPTION_BACKSTOP_CONFIGS[id] ?? null),
    );
    const rows = buildComparisonAtAGlanceRows(getPage("usdc-circle-vs-usdg-paxos"), NOW_SEC);
    expect(findRow(rows, "Direct redemption eligibility")?.left).toBe("Not recorded");
    expect(findRow(rows, "Redemption fee basis")?.left).toBe("Not recorded");
    expect(findRow(rows, "Direct redemption eligibility")?.right).toBe(
      "Verified customers (reviewed 2026-06-10)",
    );
  });

  it("retains a legitimately sourced explicit zero minimum but never infers one", () => {
    const usdc = REDEMPTION_BACKSTOP_CONFIGS["usdc-circle"];
    const withZeroMinimum: RedemptionBackstopConfig = {
      ...structuredClone(usdc),
      v9RouteReviewTerms: {
        minRedeemUsd: 0,
        reviewedAt: "2026-10-01",
        docs: [{ label: "Circle USDC terms", url: "https://www.circle.com/legal/usdc-terms", supports: ["access"] }],
      },
    };
    mockGetCurrentRedemptionConfig.mockImplementation((id) =>
      id === "usdc-circle" ? withZeroMinimum : (REDEMPTION_BACKSTOP_CONFIGS[id] ?? null),
    );
    const rows = buildComparisonAtAGlanceRows(getPage("usdc-circle-vs-usdg-paxos"), NOW_SEC);
    expect(findRow(rows, "Redemption minimum")?.left).toBe("$0 (reviewed 2026-10-01)");
    expect(findRow(rows, "Redemption minimum")?.right).toBe("Not recorded");
  });

  it("keeps the PAXG tariff qualified and the XAUT issuer fee non-zero", () => {
    const rows = buildComparisonAtAGlanceRows(getPage("paxg-paxos-vs-xaut-tether"), NOW_SEC);
    const paxgFee = findRow(rows, "Redemption fee basis")?.left ?? "";
    expect(paxgFee).toContain("Customer-specific pricing may override it");
    expect(paxgFee).toContain("delivery, dealer, tax and bank costs are separate");
    expect(paxgFee).not.toContain("55 bps");
    const xautFee = findRow(rows, "Redemption fee basis")?.right ?? "";
    expect(xautFee).toBe("25 bps issuer redemption fee, plus delivery and applicable fees (reviewed 2026-10-01)");
    expect(xautFee).not.toMatch(/\bfree\b|\b0 bps\b/i);
    const xaut = REDEMPTION_BACKSTOP_CONFIGS["xaut-tether"];
    expect(xaut.physicalToUsd?.fees.issuerFeeBps).toBe(25);
    expect(xaut.physicalCommodityDelivery?.feeModel.bps).toBe(25);
    expect(xaut.physicalCommodityDelivery?.feeModel.deliveryUsd).toBe(0);
  });
});

describe("comparison rows and JSON-LD parity", () => {
  it("serializes the exact visible row set without anchors or placeholder values", () => {
    for (const slug of COMPARISON_EVIDENCE_PILOT_SLUGS) {
      const page = getPage(slug);
      const rows = buildComparisonAtAGlanceRows(page, NOW_SEC);
      const [, itemList] = buildStaticComparisonJsonLd(page, rows) as [
        unknown,
        { numberOfItems: number; itemListElement: { position: number; item: { name: string; value: string } }[] },
      ];
      expect(itemList.numberOfItems, slug).toBe(rows.length);
      rows.forEach((row, index) => {
        expect(itemList.itemListElement[index], `${slug}:${row.label}`).toEqual({
          "@type": "ListItem",
          position: index + 1,
          item: {
            "@type": "PropertyValue",
            name: row.label,
            value: `${page.left.symbol}: ${row.left}; ${page.right.symbol}: ${row.right}`,
          },
        });
      });
      const serialized = JSON.stringify(itemList);
      expect(serialized).not.toContain("[object Object]");
      expect(serialized).not.toContain("undefined");
      expect(serialized).not.toContain('href=');
    }
  });

  it("covers every key in the shared assurance and eligibility vocabularies", () => {
    expect(Object.keys(PROOF_ASSURANCE_METHOD_LABELS).sort()).toEqual([...PROOF_ASSURANCE_METHOD_VALUES].sort());
    expect(Object.keys(PROOF_ASSURANCE_SCOPE_LABELS).sort()).toEqual([...PROOF_ASSURANCE_SCOPE_VALUES].sort());
    expect(Object.keys(LIABILITY_RECONCILIATION_LABELS).sort()).toEqual([...LIABILITY_RECONCILIATION_VALUES].sort());
    expect(Object.keys(REDEMPTION_HOLDER_ELIGIBILITY_LABELS).sort()).toEqual(
      [...RedemptionHolderEligibilitySchema.options].sort(),
    );
  });
});
