// @vitest-environment jsdom

import { render, screen, within } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import type { DonorKeyQualifyingCoin } from "@/lib/donor-key-qualifying-coins";
import { ApiOfferCards } from "./api-offer-cards";
import { SupporterClaimSteps } from "./supporter-claim-steps";

// The claim transaction and wallet lookup are independent of this static grade copy.
vi.mock("@/components/donor-key-claim", () => ({ DonorKeyClaim: () => null }));
vi.mock("./donor-wallet-check", () => ({ DonorWalletCheck: () => null }));

const unavailable: DonorKeyQualifyingCoin = { label: "USDC", stablecoinId: "usdc-circle", grade: null, score: null, status: "unavailable" };
const outsideBand: DonorKeyQualifyingCoin = { label: "USDT", stablecoinId: "usdt-tether", grade: "C", score: 50, status: "outside-band" };
const counting: DonorKeyQualifyingCoin = { label: "DAI", stablecoinId: "dai-maker", grade: "B", score: 75, status: "counts" };

const CASES = [
  { label: "all unavailable", coins: [unavailable], verdict: "unconfirmed" },
  { label: "mixed outside-band and unavailable", coins: [outsideBand, unavailable], verdict: "unconfirmed" },
  { label: "all explicit outside-band", coins: [outsideBand], verdict: "ineligible" },
  { label: "at least one counting asset", coins: [counting, unavailable, outsideBand], verdict: "eligible" },
] as const;

describe.each(["offer", "claim"] as const)("Supporter %s eligibility copy", (surface) => {
  it.each(CASES)("preserves the evidence state for $label", ({ coins, verdict }) => {
    if (surface === "offer") {
      render(<ApiOfferCards coins={coins} gradesAsOf="2026-10-09" supporterCount={0} />);
    } else {
      render(<SupporterClaimSteps coins={coins} gradesAsOf="2026-10-09" donations={[]} chainNames={{}} ledgerReconciledDate="2026-10-09" />);
    }
    const summary = surface === "offer"
      ? within(document.getElementById("supporter-key")!).getByText(/Counts toward the key:|No listed stablecoin/)
      : screen.getByText(/Send \$\d+ or more|No listed stablecoin/);

    if (verdict === "unconfirmed") {
      expect(summary.textContent).toMatch(/confirmed.*grades are unavailable/i);
      expect(summary.textContent).not.toMatch(/No listed stablecoin (has an A or B grade|counts at its current grade)/i);
    } else if (verdict === "ineligible") {
      expect(summary.textContent).toMatch(/No listed stablecoin (has an A or B grade|counts at its current grade)/i);
      expect(summary.textContent).not.toMatch(/grades are unavailable/i);
    } else {
      expect(summary.textContent).toMatch(/Counts toward the key:|Send \$\d+ or more/);
      expect(summary.textContent).not.toMatch(/No listed stablecoin/);
      if (surface === "offer") expect(summary.textContent).toContain("DAI");
    }
  });
});

describe("Supporter offer empty universe", () => {
  it("does not invent unavailable grades when no assets are listed", () => {
    render(<ApiOfferCards coins={[]} gradesAsOf="2026-10-09" supporterCount={0} />);
    const summary = within(document.getElementById("supporter-key")!).getByText(/No listed stablecoin/);

    expect(summary.textContent).not.toMatch(/grades are unavailable/i);
    expect(summary.textContent).not.toMatch(/Counts toward the key:/i);
  });
});
