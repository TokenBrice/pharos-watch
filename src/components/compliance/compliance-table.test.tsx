// @vitest-environment jsdom

import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { GeniusComplianceRow } from "@/lib/compliance-model";

const fixtures = vi.hoisted(() => ({ loadDetail: vi.fn() }));
vi.mock("@shared/lib/stablecoins/client-registry", () => ({
  CLIENT_TRACKED_STABLECOINS: [],
  loadClientStablecoinDetail: fixtures.loadDetail,
}));

import { ComplianceTable } from "./compliance-table";

const reference = { label: "Regulator register", url: "https://example.com/register" };
const detail = {
  genius: {
    references: [reference],
    applicabilityBasis: {
      summary: "Reviewed payment-stablecoin applicability.",
      references: [reference, { label: "Applicability source", url: "https://example.com/basis" }],
    },
    foreignExceptionEvidence: {
      summary: "Reviewed foreign exception posture.",
      references: [{ label: "Foreign exception source", url: "https://example.com/foreign" }],
    },
    negativeEvidenceReview: {
      summary: "No token-specific authorization found.",
      sourcesChecked: ["OCC public releases", "Federal Register"],
      references: [reference],
    },
    notes: "Issuer-specific review note.",
    reviewer: "pharos",
    reviewedAt: "2026-10-08",
  },
};

function renderTable(id: string) {
  const row: GeniusComplianceRow = {
    regime: "genius", id, name: "Fixture Dollar", symbol: "FIX", peg: "USD",
    status: "unknown", applicability: "unclear", issuerPathway: "unknown",
    issuerEntity: "Fixture Issuer", primaryFederalRegulator: "OCC",
    hasAnyDisclosure: true, reserveDisclosurePresent: true,
    redemptionPolicyPresent: false, monthlyAttestationPresent: false,
    reserveReportNote: "Latest report period end 2026-09-30",
  };
  return render(
    <ComplianceTable
      rows={[row]} regime="genius" logos={undefined} tableId="test-compliance"
      testId="compliance-table" ariaLabel="GENIUS compliance" forceCollapsedBandsOpen
    />,
  );
}

beforeEach(() => fixtures.loadDetail.mockReset());

describe("ComplianceTable lazy GENIUS evidence", () => {
  it("loads per-coin evidence only on expand, deduplicates sources, and caches across folds", async () => {
    const { promise, resolve: resolveDetail } = Promise.withResolvers<typeof detail>();
    fixtures.loadDetail.mockReturnValue(promise);
    const table = renderTable("fold-evidence");

    expect(screen.getByText("Fixture Issuer")).toBeTruthy();
    expect(screen.getByText("OCC")).toBeTruthy();
    expect(fixtures.loadDetail).not.toHaveBeenCalled();
    const expand = screen.getByRole("button", { name: "Expand details for FIX" });
    expect(expand.getAttribute("aria-expanded")).toBe("false");
    fireEvent.click(expand);
    expect(screen.getByRole("status").textContent).toBe("Loading evidence…");
    expect(screen.getByText("Latest report period end 2026-09-30")).toBeTruthy();
    expect(fixtures.loadDetail).toHaveBeenCalledExactlyOnceWith("fold-evidence");
    const collapse = screen.getByRole("button", { name: "Collapse details for FIX" });
    expect(collapse.getAttribute("aria-expanded")).toBe("true");
    expect(document.getElementById(collapse.getAttribute("aria-controls")!)).toBeTruthy();

    await act(async () => resolveDetail(detail));
    expect(screen.getByText(detail.genius.notes)).toBeTruthy();
    expect(screen.getByText(detail.genius.applicabilityBasis.summary)).toBeTruthy();
    expect(screen.getByText(detail.genius.foreignExceptionEvidence.summary)).toBeTruthy();
    expect(screen.getByText(detail.genius.negativeEvidenceReview.summary)).toBeTruthy();
    expect(screen.getByText("OCC public releases")).toBeTruthy();
    expect(screen.getByText("Reviewed 2026-10-08 by pharos")).toBeTruthy();
    expect(screen.getAllByRole("link", { name: reference.label })).toHaveLength(1);
    expect(screen.getByRole("link", { name: "Applicability source" }).getAttribute("href")).toBe("https://example.com/basis");
    expect(screen.getByRole("link", { name: "Foreign exception source" })).toBeTruthy();

    fireEvent.click(collapse);
    expect(screen.queryByText(detail.genius.notes)).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Expand details for FIX" }));
    await screen.findByText(detail.genius.notes);
    table.unmount();
    renderTable("fold-evidence");
    fireEvent.click(screen.getByRole("button", { name: "Expand details for FIX" }));
    await screen.findByText(detail.genius.notes);
    expect(fixtures.loadDetail).toHaveBeenCalledTimes(1);
  });

  it("shows a clear retryable failure without delaying summary columns", async () => {
    fixtures.loadDetail.mockRejectedValueOnce(new Error("Chunk import failed")).mockResolvedValueOnce(detail);
    renderTable("fold-retry");
    fireEvent.click(screen.getByRole("button", { name: "Expand details for FIX" }));
    expect((await screen.findByRole("alert")).textContent).toContain("Evidence could not be loaded");
    expect(screen.getByText("Fixture Issuer")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Retry loading evidence" }));
    await screen.findByText(detail.genius.notes);
    expect(fixtures.loadDetail).toHaveBeenCalledTimes(2);
    expect(screen.queryByRole("alert")).toBeNull();
  });

  it("ignores a completed import after collapsing and reuses it on reopen", async () => {
    const { promise, resolve: resolveDetail } = Promise.withResolvers<typeof detail>();
    fixtures.loadDetail.mockReturnValue(promise);
    renderTable("fold-pending-collapse");
    fireEvent.click(screen.getByRole("button", { name: "Expand details for FIX" }));
    fireEvent.click(screen.getByRole("button", { name: "Collapse details for FIX" }));
    await act(async () => resolveDetail(detail));
    expect(screen.queryByText(detail.genius.notes)).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Expand details for FIX" }));
    await waitFor(() => expect(screen.getByText(detail.genius.notes)).toBeTruthy());
    expect(fixtures.loadDetail).toHaveBeenCalledTimes(1);
  });
});
