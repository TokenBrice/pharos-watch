// @vitest-environment jsdom

import { act, fireEvent, render, screen, within } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { ComplianceRow, GeniusComplianceRow, MicaComplianceRow } from "@/lib/compliance-model";

const fixtures = vi.hoisted(() => ({ loadDetail: vi.fn() }));
vi.mock("@shared/lib/stablecoins/client-registry", () => ({
  CLIENT_TRACKED_STABLECOINS: [],
}));
vi.mock("@shared/lib/stablecoins/client-detail", () => ({
  loadClientStablecoinDetail: fixtures.loadDetail,
}));

import { ComplianceTable } from "./compliance-table";
import { MicaPathwayCell } from "./mica-compliance-cells";

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

function geniusRow(id: string): GeniusComplianceRow {
  return {
    regime: "genius", id, name: "Fixture Dollar", symbol: "FIX", peg: "USD",
    status: "unknown", applicability: "unclear", issuerPathway: "unknown",
    issuerEntity: "Fixture Issuer", primaryFederalRegulator: "OCC",
    hasAnyDisclosure: true, reserveDisclosurePresent: true,
    redemptionPolicyPresent: false, monthlyAttestationPresent: false,
    reserveReportNote: "Latest report period end 2026-09-30",
    reviewedAt: "2026-09-30",
  };
}

function renderTable(id: string, options: { forceCollapsedBandsOpen?: boolean } = {}) {
  return render(
    <ComplianceTable
      rows={[geniusRow(id)]} regime="genius" logos={undefined} tableId="test-compliance"
      testId="compliance-table" ariaLabel="GENIUS compliance"
      forceCollapsedBandsOpen={options.forceCollapsedBandsOpen ?? true}
    />,
  );
}

function micaRow(overrides: Partial<MicaComplianceRow> = {}): MicaComplianceRow {
  return {
    regime: "mica", id: "fixture-emt", name: "Fixture EMT", symbol: "FEMT", peg: "EUR",
    status: "authorized", tokenType: "EMT", authorizationType: "emi", competentAuthority: "ACPR",
    significant: false, references: [reference], ...overrides,
  };
}

function renderMicaTable(row: ComplianceRow, forceCollapsedBandsOpen = false) {
  return render(
    <ComplianceTable
      rows={[row]} regime="mica" logos={undefined} tableId="test-mica"
      testId="compliance-mica-table" ariaLabel="MiCA compliance"
      forceCollapsedBandsOpen={forceCollapsedBandsOpen}
    />,
  );
}

beforeEach(() => fixtures.loadDetail.mockReset());

describe("ComplianceTable mounted folds", () => {
  it("keeps collapsed GENIUS summary folds in the DOM without loading evidence", async () => {
    fixtures.loadDetail.mockResolvedValue(detail);
    renderTable("fold-mounted");

    expect(fixtures.loadDetail).not.toHaveBeenCalled();
    expect(screen.getByText("Reviewed 2026-09-30")).toBeTruthy();
    expect(screen.getAllByText("Reserve disclosure").length).toBeGreaterThan(0);
    expect(screen.getByText("Latest report period end 2026-09-30")).toBeTruthy();
    const fold = document.getElementById("test-compliance-genius-fold-mounted-details");
    expect(fold?.hidden).toBe(true);

    fireEvent.click(screen.getByRole("button", { name: "Expand details for FIX" }));
    expect(document.getElementById("test-compliance-genius-fold-mounted-details")?.hidden).toBe(false);
    expect(fixtures.loadDetail).toHaveBeenCalledExactlyOnceWith("fold-mounted");
  });

  it("leaves default-collapsed bands unmounted until the band is expanded", () => {
    renderTable("fold-band", { forceCollapsedBandsOpen: false });

    expect(screen.queryByText("Fixture Dollar")).toBeNull();
    expect(screen.queryByText("Reviewed 2026-09-30")).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: /Unknown .*expand/ }));
    expect(screen.getByText("Fixture Dollar")).toBeTruthy();
    expect(screen.getByText("Reviewed 2026-09-30")).toBeTruthy();
    expect(fixtures.loadDetail).not.toHaveBeenCalled();
  });

  it("mounts MiCA source hrefs in a closed fold without accessible controls", () => {
    const { container } = renderMicaTable(micaRow());

    const fold = document.getElementById("test-mica-mica-fixture-emt-details");
    expect(fold?.hidden).toBe(true);
    const link = container.querySelector('a[href="https://example.com/register"]');
    expect(link?.textContent).toBe("Regulator register");
    expect(within(fold as HTMLElement).queryByRole("link")).toBeNull();

    fireEvent.click(screen.getByRole("button", { name: "Expand details for FEMT" }));
    expect(fold?.hidden).toBe(false);
    expect(screen.getByRole("link", { name: "Regulator register" }).getAttribute("href"))
      .toBe("https://example.com/register");
  });

  it("omits the fold control for MiCA rows without references", () => {
    renderMicaTable(micaRow({ references: [] }));

    expect(screen.queryByRole("button", { name: /details for FEMT/ })).toBeNull();
    expect(document.getElementById("test-mica-mica-fixture-emt-details")).toBeNull();
  });
});

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
    // The summary review date stays the only date owner; the lazy evidence
    // contributes only its reviewer credit.
    expect(screen.getAllByText(/^Reviewed 20\d{2}-\d{2}-\d{2}$/)).toHaveLength(1);
    expect(screen.getByText("Reviewed 2026-09-30")).toBeTruthy();
    expect(screen.getByText("Reviewed by pharos")).toBeTruthy();
    expect(screen.queryByText("Reviewed 2026-10-08")).toBeNull();
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

  it("lists every checked source without truncating the evidence review", async () => {
    const sourcesChecked = Array.from({ length: 13 }, (_, index) => `Source ${index + 1}`);
    fixtures.loadDetail.mockResolvedValue({
      ...detail,
      genius: {
        ...detail.genius,
        negativeEvidenceReview: { ...detail.genius.negativeEvidenceReview, sourcesChecked },
      },
    });
    renderTable("fold-sources");
    fireEvent.click(screen.getByRole("button", { name: "Expand details for FIX" }));

    const heading = await screen.findByText("Sources checked");
    const items = heading.parentElement!.querySelectorAll("li");
    expect(Array.from(items, (item) => item.textContent)).toEqual(sourcesChecked);
  });

  it("shows a clear retryable failure without delaying summary columns", async () => {
    fixtures.loadDetail.mockRejectedValueOnce(new Error("Chunk import failed")).mockResolvedValueOnce(detail);
    renderTable("fold-retry");
    fireEvent.click(screen.getByRole("button", { name: "Expand details for FIX" }));
    expect((await screen.findByRole("alert")).textContent).toContain("Evidence could not be loaded");
    expect(screen.getByText("Fixture Issuer")).toBeTruthy();
    expect(screen.getByText("Reviewed 2026-09-30")).toBeTruthy();
    expect(screen.queryByText("Reviewed 2026-10-08")).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Retry loading evidence" }));
    await screen.findByText(detail.genius.notes);
    expect(fixtures.loadDetail).toHaveBeenCalledTimes(2);
    expect(screen.queryByRole("alert")).toBeNull();
  });
});

describe("MicaPathwayCell significance badge", () => {
  const row = (significant: boolean): MicaComplianceRow => micaRow({ significant, references: [] });

  it("describes a significant token as an EBA designation, not active EBA supervision", () => {
    const { container } = render(<MicaPathwayCell row={row(true)} />);
    const badge = within(container).getByText("Significant").closest("span");
    expect(badge?.getAttribute("title")).toBe("Classified by the EBA as a significant EMT or ART");
    expect(container.querySelector('[title*="supervised"]')).toBeNull();
  });

  it("omits the badge when the token is not designated", () => {
    const { container } = render(<MicaPathwayCell row={row(false)} />);
    expect(within(container).queryByText("Significant")).toBeNull();
  });
});
