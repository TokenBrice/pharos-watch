import { describe, expect, it } from "vitest";
import { CHAIN_MATURITY_REVIEWS_V1 } from "@shared/data/safety-score-v9/chain-maturity-reviews-v1";
import { VENUE_RISK_SCORE_MAX_AGE_DAYS, YIELD_RISK_CONFIG } from "@shared/lib/yield-source-risk-registry";
import { loadDigestModule, renderDigest } from "./weekly-curation-digest.test-support";

const DAY_MS = 24 * 60 * 60 * 1000;
const coin = (id: string, overrides: Record<string, unknown> = {}) => ({ id, ...overrides });
describe("weekly curation coverage", () => {

  it("reports stale and missing active summaries at the 180-day boundary", () => {
    const report = renderDigest({
      coins: ["fresh", "stale", "undated", "invalid", "missing"].map((id) => coin(id)).concat([
        coin("prelaunch", { status: "pre-launch" }),
      ]),
      summaries: {
        fresh: { text: "Current", updatedAt: "2026-01-02" },
        stale: { text: "Old", updatedAt: "2026-01-01" },
        undated: { text: "No date" },
        invalid: { text: "Invalid date", updatedAt: "invalid" },
      },
    });
    const summary = report.split("## AI summary staleness")[1].split("## Annotation queue health")[0];
    expect(summary).toMatch(/active summaries: 3\. Missing: 1\./);
    expect(summary).toContain("Missing entries: missing");
    expect(summary).toMatch(/- stale .*2026-01-01 \(181d\)/);
    expect(summary).toMatch(/- undated .*\(n\/a\)/);
    expect(summary).toMatch(/- invalid .*\(n\/a\)/);
    expect(summary).not.toMatch(/fresh|prelaunch/);
  });


  it("renders empty cohorts with finite percentages and reports absent queue input", () => {
    const report = renderDigest();
    expect(report).toContain("0/0 active/pre-launch");
    expect(report).toContain("0/0 have an archetype (0.0%)");
    expect(report).toContain("attestorTier: 0/0 (0.0%)");
    expect(report).not.toMatch(/NaN|Infinity|WARN:/);
    expect(report).toContain("Queue file `agents/annotation-candidates.md` not present");
  });

  it("reports populated annotation queue health without the retired last-swept line", () => {
    const report = renderDigest({
      queue: [
        "# Annotation Candidates",
        "",
        "## 2026-06-15",
        "- usdc-circle | depeg | Sample event",
        "- usdt-tether | governance | Another event",
        "",
      ].join("\n"),
    });
    const queue = report.split("## Annotation queue health")[1].split("## Dated-review expiry lookahead")[0];
    expect(queue).toContain("Rows pending review: 2");
    expect(queue).toContain("Oldest dated row: 2026-06-15");
    expect(queue).not.toContain("Last swept:");
    expect(queue).not.toContain("(never recorded)");
  });

  it("groups dated review expiries within the 14-day lookahead and renders exact statuses", async () => {
    const { analyzeDatedReviewExpiries, EXPIRY_LOOKAHEAD_DAYS, renderDatedReviewExpiries } = await loadDigestModule();
    const nowMs = Date.parse("2026-07-01T00:00:00.000Z");
    const report = analyzeDatedReviewExpiries([
      {
        registry: "Date-only registry",
        entries: [
          { id: "overdue", expiresAt: "2026-06-29" },
          { id: "today", expiresAt: "2026-07-01" },
          { id: "boundary-in", expiresAt: "2026-07-15" },
          { id: "boundary-out", expiresAt: "2026-07-16" },
        ],
      },
      {
        registry: "Timestamp registry",
        entries: [
          { id: "unix-in", expiresAt: Date.parse("2026-07-10T12:00:00Z") / 1000 },
          { id: "iso-out", expiresAt: "2026-07-15T00:00:01Z" },
          { id: "bad-date", expiresAt: "not-a-date" },
        ],
      },
      {
        registry: "Clean registry",
        entries: [{ id: "far-future", expiresAt: "2027-01-01" }],
      },
    ], nowMs, EXPIRY_LOOKAHEAD_DAYS);

    expect(report.totalRegistries).toBe(3);
    expect(report.totalEntries).toBe(5);
    expect(report.totalExpired).toBe(2);
    expect(report.totalInvalid).toBe(1);
    expect(report.groups.map((group) => group.registry)).toEqual(["Date-only registry", "Timestamp registry"]);

    const rendered = renderDatedReviewExpiries(report);
    expect(rendered).toContain("## Dated-review expiry lookahead (14d)");
    expect(rendered).toContain("### Date-only registry");
    expect(rendered).toContain("- overdue — 2026-06-29 (expired 2d ago)");
    expect(rendered).toContain("- today — 2026-07-01 (expired today)");
    expect(rendered).toContain("- boundary-in — 2026-07-15 (in 14d)");
    expect(rendered).not.toContain("boundary-out");
    expect(rendered).toContain("- bad-date — (invalid) (invalid date)");
    expect(rendered).toContain("- unix-in — 2026-07-10 (in 10d)");
    expect(rendered).not.toContain("iso-out");
    expect(rendered).not.toContain("Clean registry");
    expect(rendered).not.toContain("WARN:");

    const emptyRendered = renderDatedReviewExpiries(
      analyzeDatedReviewExpiries([{ registry: "Clean", entries: [{ id: "ok", expiresAt: "2027-01-01" }] }], nowMs),
    );
    expect(emptyRendered).toContain("Status: **OK** — 0 dated review entries expiring on or before 2026-07-15 across 1 registries.");
  });

  it("reads exported dated registries without re-declaring dates and surfaces expiring entries in the CLI digest", async () => {
    const { buildDatedReviewRegistries, collectDatedReviewExpiries, EXPIRY_LOOKAHEAD_DAYS } = await loadDigestModule();
    const sampleChain = CHAIN_MATURITY_REVIEWS_V1[0]!;
    const chainExpiryMs = Date.parse(`${sampleChain.nextReviewAt}T00:00:00Z`);
    const atBoundary = collectDatedReviewExpiries(chainExpiryMs - EXPIRY_LOOKAHEAD_DAYS * DAY_MS);
    const chainGroup = atBoundary.groups.find((group) => group.registry.includes("CHAIN_MATURITY_REVIEWS_V1"));
    expect(chainGroup?.items.some((item) => item.id === sampleChain.chainSlug && item.expiryDate === sampleChain.nextReviewAt)).toBe(true);

    const beforeBoundary = collectDatedReviewExpiries(chainExpiryMs - (EXPIRY_LOOKAHEAD_DAYS + 1) * DAY_MS);
    const beforeChainGroup = beforeBoundary.groups.find((group) => group.registry.includes("CHAIN_MATURITY_REVIEWS_V1"));
    expect(beforeChainGroup?.items.some((item) => item.id === sampleChain.chainSlug)).not.toBe(true);

    const [sampleVenueId, sampleVenue] = Object.entries(YIELD_RISK_CONFIG)[0]!;
    const venueExpiryMs = Date.parse(`${sampleVenue.reviewedAt}T00:00:00Z`) + (VENUE_RISK_SCORE_MAX_AGE_DAYS + 1) * DAY_MS;
    const venueAtBoundary = collectDatedReviewExpiries(venueExpiryMs - EXPIRY_LOOKAHEAD_DAYS * DAY_MS);
    const venueGroup = venueAtBoundary.groups.find((group) => group.registry.includes("YIELD_RISK_CONFIG"));
    expect(venueGroup?.items.some((item) => item.id === sampleVenueId)).toBe(true);

    const farFutureMs = Date.parse("2099-01-01T00:00:00Z");
    const wiredRegistries = buildDatedReviewRegistries(farFutureMs);
    const farFutureReport = collectDatedReviewExpiries(farFutureMs);
    const coveredRegistries = new Set(farFutureReport.groups.map((group) => group.registry));
    for (const marker of [
      "CHAIN_MATURITY_REVIEWS_V1",
      "STABLECOIN_PUBLICATION_WAIVERS",
      "STABLECOIN_PRICE_GAP_REVIEWS",
      "REVIEWED_SUPPLY_VALUE_REBASELINES",
      "DEPEG_NO_PARITY_QUOTE_REVIEWS",
      "DEPEG_BLIND_EVENT_REVIEWS",
      "YIELD_RISK_CONFIG",
      "YIELD_DEPENDENCY_CONCENTRATION",
      "REVIEWED_CHAIN_TVL_DISPOSITIONS",
      "REVIEWED_POOL_REJECTION_ANCHOR_CORRECTION",
      "YIELD_OPPORTUNITY_EXCLUSIONS",
    ]) {
      const reg = wiredRegistries.find((r) => r.registry.includes(marker));
      expect(reg, `missing registry ${marker}`).toBeDefined();
      if (reg!.entries.length > 0) expect(coveredRegistries.has(reg!.registry), `uncovered ${marker}`).toBe(true);
    }

    const cliReport = renderDigest({ nowIso: new Date(chainExpiryMs - EXPIRY_LOOKAHEAD_DAYS * DAY_MS).toISOString() });
    const expirySection = cliReport.split("## Dated-review expiry lookahead (14d)")[1];
    expect(expirySection).toContain("CHAIN_MATURITY_REVIEWS_V1");
    expect(expirySection).toContain(`- ${sampleChain.chainSlug} — ${sampleChain.nextReviewAt} (in 14d)`);
  });
});
