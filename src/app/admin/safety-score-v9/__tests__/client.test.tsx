// @vitest-environment jsdom

import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const { adminMutationMock, refetchMock, useSafetyScoreV9AdminMock } = vi.hoisted(() => ({
  adminMutationMock: vi.fn(),
  refetchMock: vi.fn(),
  useSafetyScoreV9AdminMock: vi.fn(),
}));

vi.mock("@/hooks/use-safety-score-v9-admin", () => ({ useSafetyScoreV9Admin: useSafetyScoreV9AdminMock }));
vi.mock("@/lib/admin-access", () => ({ adminMutation: adminMutationMock }));

import SafetyScoreV9Client from "../client";
import { makeSafetyScoreV9AdminAvailableResponse } from "@/test-utils/safety-score-v9-admin-fixture";

beforeEach(() => {
  refetchMock.mockResolvedValue(undefined);
  useSafetyScoreV9AdminMock.mockReturnValue({
    data: makeSafetyScoreV9AdminAvailableResponse(),
    error: null,
    isLoading: false,
    isFetching: false,
    refetch: refetchMock,
  });
});

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

describe("SafetyScoreV9Client", () => {
  it("presents the candidate as an explicit no-go while exposing pillar and review evidence", () => {
    render(<SafetyScoreV9Client />);

    expect(screen.getByRole("heading", { level: 1, name: "Safety Score V9 candidate" })).toBeTruthy();
    expect(screen.getByText("No-go for activation")).toBeTruthy();
    expect(screen.getByText("V8 remains active")).toBeTruthy();
    expect(screen.getByText("Candidate asset cards")).toBeTruthy();
    expect(screen.getByText("Grade distribution")).toBeTruthy();
    expect(screen.getByRole("columnheader", { name: "Three pillars" })).toBeTruthy();
    expect(screen.getAllByText("coin-a")).toHaveLength(2);
    expect(screen.getAllByText("A- → A+")).toHaveLength(2);
    expect(screen.getByText("Independent validation is not sealed")).toBeTruthy();
    expect(screen.getByRole("columnheader", { name: "Run counts" })).toBeTruthy();
    expect(screen.getByText("1 succeeded · 0 failed")).toBeTruthy();
    expect(screen.getByText("Routine summary only")).toBeTruthy();
  });

  it("filters the candidate workbench without hiding the release state", () => {
    render(<SafetyScoreV9Client />);

    fireEvent.change(screen.getByRole("searchbox", { name: "Filter assets" }), { target: { value: "coin-b" } });
    const assetTable = screen.getByRole("table", { name: "Safety Score V9 candidate cards and V8 comparison" });
    expect(within(assetTable).queryByText("coin-a")).toBeNull();
    expect(within(assetTable).getByText("coin-b")).toBeTruthy();
    expect(screen.getByText("No-go for activation")).toBeTruthy();
  });

  it("renders a guarded unavailable state and never implies activation", () => {
    useSafetyScoreV9AdminMock.mockReturnValue({
      data: { schemaVersion: 1, status: "unavailable", reason: "shadow-history-unavailable" },
      error: null,
      isLoading: false,
      isFetching: false,
      refetch: vi.fn(),
    });

    render(<SafetyScoreV9Client />);

    expect(screen.getByText("Candidate evidence is unavailable")).toBeTruthy();
    expect(screen.getByText(/V8 remains active/)).toBeTruthy();
    expect(screen.queryByText(/V9 is active/i)).toBeNull();
  });

  it("records a pending movement review through the guarded admin mutation", async () => {
    const response = makeSafetyScoreV9AdminAvailableResponse();
    const card = response.diff.cards[0]!;
    adminMutationMock.mockResolvedValue({
      data: {
        schemaVersion: 1,
        status: "recorded",
        review: {
          schemaVersion: 1,
          reviewKey: card.review.key,
          assetId: card.id,
          sourceDiffReportDigest: response.diff.reportDigest,
          candidateId: response.diff.v9Identity.candidateId,
          sourcePublicationGenerationId: response.diff.v9Identity.publicationGenerationId,
          policyDigest: response.diff.v9Identity.policyDigest,
          evaluationBuildDigest: response.diff.v9Identity.evaluationBuildDigest,
          v8MethodologyVersion: response.diff.v8Identity.methodologyVersion,
          disposition: "defect",
          reviewerId: "reviewer@example.com",
          rationale: "The movement is caused by a candidate scoring defect.",
          reviewedAtSec: response.diff.generatedAtSec + 1,
          reviewDigest: "b".repeat(64),
        },
      },
    });
    useSafetyScoreV9AdminMock.mockReturnValue({
      data: response,
      error: null,
      isLoading: false,
      isFetching: false,
      refetch: refetchMock,
    });
    render(<SafetyScoreV9Client />);

    fireEvent.change(screen.getByLabelText("Disposition"), { target: { value: "defect" } });
    fireEvent.change(screen.getByLabelText("Reviewer"), { target: { value: "reviewer@example.com" } });
    fireEvent.change(screen.getByLabelText("Rationale"), {
      target: { value: "The movement is caused by a candidate scoring defect." },
    });
    fireEvent.click(screen.getByRole("button", { name: "Record review" }));

    await waitFor(() => expect(adminMutationMock).toHaveBeenCalledTimes(1));
    expect(adminMutationMock).toHaveBeenCalledWith(
      "/api/admin-safety-score-v9/reviews",
      expect.objectContaining({
        body: expect.objectContaining({
          assetId: "coin-a",
          disposition: "defect",
          sourceDiffReportDigest: response.diff.reportDigest,
        }),
      }),
    );
    await waitFor(() => expect(refetchMock).toHaveBeenCalledTimes(1));
  });
});
