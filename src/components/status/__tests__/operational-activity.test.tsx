// @vitest-environment jsdom

import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import type { ApiKeyAuditEntry } from "@shared/types";
import type { AdminActionAuditEntry } from "@/lib/actions-workbench-model";
import { OperationalActivity, type OperationalActivitySourceState } from "../operational-activity";


const adminEntry: AdminActionAuditEntry = {
  id: 1,
  at: 1_700_000_000,
  actor: "operator@example.invalid",
  action: "api_key_rotate",
  target: "API key 7",
  result: "ok",
  httpStatus: 200,
  details: { apiKeyId: 7, token: "ph_live_embedded_secret", route: "/api/api-keys/7/rotate" },
};

const credentialEntry: ApiKeyAuditEntry = {
  id: 8,
  apiKeyId: 7,
  action: "rotated",
  actor: "admin",
  detail: { name: "Partner reader", secret: "hidden" },
  createdAt: 1_700_000_003,
};

function state<T>(entries: readonly T[]): OperationalActivitySourceState<T> {
  return {
    entries,
    error: null,
    isLoading: false,
    isFetching: false,
    onRetry: vi.fn(),
  };
}

describe("OperationalActivity", () => {
  it("merges duplicate lifecycle events, redacts detail, and links to focused workspaces", () => {
    render(
      <OperationalActivity
        adminActions={state([adminEntry])}
        credentialAudit={state([credentialEntry])}
        nowSeconds={1_700_000_100}
      />,
    );

    expect(screen.getByText(/1 cross-source lifecycle duplicate reconciled/i)).toBeTruthy();
    expect(screen.getByText("Admin action + Credential audit")).toBeTruthy();
    expect(screen.getByText(/Partner reader \(API key 7\)/i)).toBeTruthy();
    expect(screen.getByText(/1m ago/i)).toBeTruthy();
    expect(screen.getByRole("link", { name: /Actions workspace/i }).getAttribute("href")).toBe("/admin/actions");
    expect(screen.getByRole("link", { name: /API Management/i }).getAttribute("href")).toBe("/admin-api");

    fireEvent.click(screen.getByText("Safe structured detail"));
    expect(screen.getAllByText(/\[redacted\]/i).length).toBeGreaterThan(0);
    expect(screen.queryByText(/ph_live_embedded_secret/i)).toBeNull();
    expect(screen.queryByText(/"hidden"/i)).toBeNull();
    expect(screen.getByText(/Coverage reflects audit rows emitted by the deployed backend/i)).toBeTruthy();
  });

  it("keeps source failures independent with local retries", () => {
    const retryActions = vi.fn();
    const retryCredentials = vi.fn();
    render(
      <OperationalActivity
        adminActions={{
          ...state<AdminActionAuditEntry>([]),
          error: new Error("action log offline"),
          onRetry: retryActions,
        }}
        credentialAudit={{
          ...state<ApiKeyAuditEntry>([]),
          error: new Error("credential audit offline"),
          onRetry: retryCredentials,
        }}
        nowSeconds={1_700_000_100}
      />,
    );

    expect(screen.getByText("action log offline")).toBeTruthy();
    expect(screen.getByText("credential audit offline")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Retry admin action log" }));
    fireEvent.click(screen.getByRole("button", { name: "Retry credential audit" }));
    expect(retryActions).toHaveBeenCalledOnce();
    expect(retryCredentials).toHaveBeenCalledOnce();
  });

  it("distinguishes loading from a complete empty response without claiming complete coverage", () => {
    const { rerender } = render(
      <OperationalActivity
        adminActions={{ ...state<AdminActionAuditEntry>([]), isLoading: true }}
        credentialAudit={{ ...state<ApiKeyAuditEntry>([]), isLoading: true }}
        nowSeconds={1_700_000_100}
      />,
    );
    expect(screen.getByText("Loading operational activity...")).toBeTruthy();

    rerender(
      <OperationalActivity
        adminActions={state<AdminActionAuditEntry>([])}
        credentialAudit={state<ApiKeyAuditEntry>([])}
        nowSeconds={1_700_000_100}
      />,
    );
    expect(screen.getByText(/No persisted operational activity is available/i)).toBeTruthy();
    expect(screen.getByText(/Coverage reflects audit rows emitted by the deployed backend/i)).toBeTruthy();
  });
});
