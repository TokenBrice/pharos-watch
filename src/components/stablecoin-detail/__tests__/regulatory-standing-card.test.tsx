// src/components/stablecoin-detail/__tests__/regulatory-standing-card.test.tsx
import { describe, expect, it } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { RegulatoryStandingCard } from "../regulatory-standing-card";
import type { RegulatoryStandingView } from "@/lib/regulatory-standing";

const VIEW: RegulatoryStandingView = {
  badgeLabel: "MiCA Authorized",
  badgeToneClass: "bg-green-500/10 text-green-700 dark:text-green-400 border-green-500/20",
  summary: "USDC has a GENIUS authorization filing pending and is MiCA-authorized for the EU.",
  regimes: [
    {
      key: "genius",
      regimeLabel: "GENIUS (US)",
      facts: [
        { key: "status", label: "Status", value: "Filing Pending" },
        { key: "pathway", label: "Pathway", value: "Federal qualified issuer" },
        { key: "regulator", label: "Regulator", value: "OCC" },
      ],
      checklist: [
        { key: "attestation", label: "Monthly attestation", present: true },
        { key: "redemption-policy", label: "Redemption policy", present: false },
        {
          key: "reserve-disclosure",
          label: "Reserve disclosure",
          present: true,
          href: "https://example.com/reserves",
          note: "latest 2026-07-01",
        },
      ],
    },
    {
      key: "mica",
      regimeLabel: "MiCA (EU)",
      facts: [
        { key: "status", label: "Status", value: "Authorized" },
        { key: "token-type", label: "Token type", value: "E-Money Token" },
        { key: "authority", label: "Authority", value: "DNB (Netherlands)" },
      ],
      checklist: [],
    },
  ],
  sources: [{ label: "DNB register", url: "https://example.com/dnb" }],
  reviewedAt: "2026-07-02",
};

/**
 * One checklist `<li>`, so a row's own truth state and destination are read
 * instead of any "published" text anywhere in the card.
 */
function checklistRow(html: string, label: string): string {
  const rows = html.split("<li").filter((row) => row.includes(`>${label}<`));
  expect(rows).toHaveLength(1);
  return rows[0];
}

describe("RegulatoryStandingCard", () => {
  it("renders badge, both regimes, facts, and folded sources", () => {
    const html = renderToStaticMarkup(<RegulatoryStandingCard view={VIEW} />);
    expect(html).toContain("Regulatory standing");
    expect(html).toContain("MiCA Authorized");
    expect(html).toContain("GENIUS (US)");
    expect(html).toContain("MiCA (EU)");
    expect(html).toContain("Filing Pending");
    expect(html).toContain("OCC");
    expect(html).toContain("Reviewed 2026-07-02");
    expect(html).toContain("https://example.com/dnb");
    expect(html).toContain('hidden=""'); // sources folded by default
  });

  it("states each checklist obligation's truth state and links the evidence it has", () => {
    const html = renderToStaticMarkup(<RegulatoryStandingCard view={VIEW} />);

    const attestation = checklistRow(html, "Monthly attestation");
    expect(attestation).toContain("published");
    expect(attestation).not.toContain("not found");

    const redemptionPolicy = checklistRow(html, "Redemption policy");
    expect(redemptionPolicy).toContain("not found");
    expect(redemptionPolicy).not.toContain(">published<");

    const reserveDisclosure = checklistRow(html, "Reserve disclosure");
    expect(reserveDisclosure).toMatch(
      /<a href="https:\/\/example\.com\/reserves"[^>]*>Reserve disclosure<\/a>/,
    );
    expect(reserveDisclosure).toContain("latest 2026-07-01");
    expect(reserveDisclosure).toContain("published");
  });

  it("omits the checklist for a regime with no researched obligations", () => {
    const html = renderToStaticMarkup(
      <RegulatoryStandingCard
        view={{ ...VIEW, regimes: [VIEW.regimes[1]] }}
      />,
    );

    expect(html).toContain("MiCA (EU)");
    expect(html).not.toContain(">published<");
    expect(html).not.toContain(">not found<");
  });

  it("renders nothing without a view", () => {
    expect(renderToStaticMarkup(<RegulatoryStandingCard view={null} />)).toBe("");
    expect(renderToStaticMarkup(<RegulatoryStandingCard />)).toBe("");
  });
});
