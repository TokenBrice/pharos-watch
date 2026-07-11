// @vitest-environment jsdom

import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { ApiKeyAuditEntry } from "@shared/types";
import { makeApiKeySummary } from "@/test-utils/api-key-fixtures";
import { STATUS_FIXTURE_NOW_SECONDS } from "@/test-utils/status-fixtures";

const { useApiKeysMock, useApiKeyAuditLogMock } = vi.hoisted(() => ({
  useApiKeysMock: vi.fn(),
  useApiKeyAuditLogMock: vi.fn(),
}));

vi.mock("@/hooks/use-api-keys", () => ({ useApiKeys: useApiKeysMock }));
vi.mock("@/hooks/use-api-key-audit-log", () => ({ useApiKeyAuditLog: useApiKeyAuditLogMock }));

import { buildCredentialSummaryItems, CredentialSummaryCard } from "../credential-summary-card";

const NOW = STATUS_FIXTURE_NOW_SECONDS;

function makeAuditEntry(overrides: Partial<ApiKeyAuditEntry>): ApiKeyAuditEntry {
  return {
    id: 1,
    apiKeyId: 1,
    action: "rotated",
    actor: "admin",
    detail: null,
    createdAt: NOW - 3_600,
    ...overrides,
  };
}

const KEYS = [
  // Active, far-future expiry.
  makeApiKeySummary(0, { isActive: true, expiresAt: NOW + 90 * 86_400 }),
  // Active, expiring inside the 7-day window.
  makeApiKeySummary(1, { isActive: true, expiresAt: NOW + 2 * 86_400 }),
  // Active but already expired.
  makeApiKeySummary(2, { isActive: true, expiresAt: NOW - 86_400 }),
  // Non-expiring exception (inactive).
  makeApiKeySummary(3, { isActive: false, expiresAt: null }),
];

const AUDIT_ENTRIES = [
  makeAuditEntry({ id: 1, action: "rotated", createdAt: NOW - 86_400 }),
  makeAuditEntry({ id: 2, action: "deactivated", createdAt: NOW - 2 * 86_400 }),
  // Routine issuance is not an anomaly.
  makeAuditEntry({ id: 3, action: "created", createdAt: NOW - 3_600 }),
  // Outside the 7-day window.
  makeAuditEntry({ id: 4, action: "rotated", createdAt: NOW - 9 * 86_400 }),
];

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

describe("buildCredentialSummaryItems", () => {
  it("matches the API Management inventory predicates and the 7-day anomaly window", () => {
    const items = buildCredentialSummaryItems({ keys: KEYS, auditEntries: AUDIT_ENTRIES, nowSeconds: NOW });
    const byLabel = Object.fromEntries(items.map((item) => [item.label, item.value]));

    expect(byLabel).toEqual({
      Active: "3",
      "Expiring soon": "1",
      Expired: "1",
      "Non-expiring": "1",
      "Audit anomalies": "2",
    });
  });

  it("renders missing evidence as Unknown, never zero", () => {
    const items = buildCredentialSummaryItems({ keys: null, auditEntries: null, nowSeconds: NOW });

    expect(items.every((item) => item.value === "Unknown")).toBe(true);
  });
});

describe("CredentialSummaryCard", () => {
  it("summarizes the inventory and links lifecycle work to API Management", () => {
    useApiKeysMock.mockReturnValue({
      data: { generatedAt: NOW, keys: KEYS },
      isLoading: false,
      isError: false,
      refetch: vi.fn(),
    });
    useApiKeyAuditLogMock.mockReturnValue({ data: { entries: AUDIT_ENTRIES }, isLoading: false, isError: false });

    render(<CredentialSummaryCard />);

    expect(screen.getByRole("heading", { level: 2, name: "Credentials" })).toBeTruthy();
    expect(screen.getByRole("link", { name: /Open API Management/ }).getAttribute("href")).toMatch(/^\/admin-api\/?$/);
    expect(screen.getByText("Expired").nextElementSibling?.textContent).toBe("1");
    expect(screen.getByText("Audit anomalies").nextElementSibling?.textContent).toBe("2");
    // Summary only: no inventory rows or row actions leak into Triage.
    expect(screen.queryByRole("table")).toBeNull();
    expect(screen.queryByRole("button", { name: /Rotate/ })).toBeNull();
  });

  it("keeps counts Unknown with a local retry when the inventory fails", () => {
    const refetch = vi.fn();
    useApiKeysMock.mockReturnValue({ data: undefined, isLoading: false, isError: true, refetch });
    useApiKeyAuditLogMock.mockReturnValue({ data: undefined, isLoading: false, isError: true });

    render(<CredentialSummaryCard />);

    expect(screen.getAllByText("Unknown")).toHaveLength(5);
    screen.getByRole("button", { name: "Retry" }).click();
    expect(refetch).toHaveBeenCalled();
  });
});
