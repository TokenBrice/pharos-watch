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

describe("RegulatoryStandingCard", () => {
  it("renders badge, both regimes, checklist, and folded sources", () => {
    const html = renderToStaticMarkup(<RegulatoryStandingCard view={VIEW} />);
    expect(html).toContain("Regulatory standing");
    expect(html).toContain("MiCA Authorized");
    expect(html).toContain("GENIUS (US)");
    expect(html).toContain("MiCA (EU)");
    expect(html).toContain("Filing Pending");
    expect(html).toContain("OCC");
    expect(html).toContain("Monthly attestation");
    expect(html).toContain("https://example.com/reserves");
    expect(html).toContain("latest 2026-07-01");
    expect(html).toContain("Reviewed 2026-07-02");
    expect(html).toContain("https://example.com/dnb");
    expect(html).toContain('hidden=""'); // sources folded by default
  });

  it("renders nothing without a view", () => {
    expect(renderToStaticMarkup(<RegulatoryStandingCard view={null} />)).toBe("");
    expect(renderToStaticMarkup(<RegulatoryStandingCard />)).toBe("");
  });
});
