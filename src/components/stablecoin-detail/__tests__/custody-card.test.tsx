// src/components/stablecoin-detail/__tests__/custody-card.test.tsx
import { describe, expect, it } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { CustodyCard } from "../custody-card";
import type { CustodyClientSummary } from "@/lib/stablecoin-detail-custody-client";

const SUMMARY: CustodyClientSummary = {
  postureKey: "segregated",
  postureLabel: "Segregated",
  postureToneClass: "border-blue-500/30 bg-blue-500/10 text-blue-700 dark:text-blue-400",
  summary:
    "Reserve custody spans 2 counterparties, led by The Bank of New York Mellon; client assets are held in segregated accounts with contractual-only bankruptcy protections. Rehypothecation is prohibited.",
  providers: [
    { key: "bny:0", name: "The Bank of New York Mellon", roleLabel: "Custodian", jurisdiction: "United States", sharePct: 88 },
    { key: "banks:1", name: "Other regulated banks", roleLabel: "Bank", jurisdiction: null, sharePct: null },
  ],
  undisclosedSharePct: 12,
  segregationLabel: "Segregated",
  bankruptcyRemotenessLabel: "Contractual",
  rehypothecationLabel: "Prohibited",
  rehypothecationToneClass: null,
  confidenceLabel: "Verified",
  uncertainty: "Bank-level split beyond BNY is not individually disclosed.",
  reviewedAt: "2026-07-17",
  sources: [{ label: "Circle 10-K", url: "https://example.com/10k" }],
};

describe("CustodyCard", () => {
  it("renders posture, providers, facts, and folded sources", () => {
    const html = renderToStaticMarkup(<CustodyCard summary={SUMMARY} />);
    expect(html).toContain("Custody");
    expect(html).toContain("Segregated");
    expect(html).toContain("The Bank of New York Mellon");
    expect(html).toContain("Custodian");
    expect(html).toContain("88%");
    expect(html).toContain("Undisclosed");
    expect(html).toContain("12%");
    expect(html).toContain("Contractual");
    expect(html).toContain("Prohibited");
    expect(html).toContain("Verified");
    expect(html).toContain("Reviewed 2026-07-17");
    expect(html).toContain("https://example.com/10k");
    expect(html).toContain('hidden=""'); // sources folded by default
  });

  it("renders nothing without a custody summary", () => {
    expect(renderToStaticMarkup(<CustodyCard summary={null} />)).toBe("");
    expect(renderToStaticMarkup(<CustodyCard />)).toBe("");
  });

  it("renders no provider list when providers is empty", () => {
    const html = renderToStaticMarkup(
      <CustodyCard
        summary={{
          ...SUMMARY,
          providers: [],
          undisclosedSharePct: null,
          summary: "Reserve custody counterparties are not individually disclosed; the account structure is undisclosed.",
        }}
      />,
    );
    expect(html).not.toContain('aria-label="Custody providers"');
    expect(html).toContain("not individually disclosed");
  });

  it("labels the provider list for assistive tech", () => {
    const html = renderToStaticMarkup(<CustodyCard summary={SUMMARY} />);
    expect(html).toContain('aria-label="Custody providers"');
  });
});
