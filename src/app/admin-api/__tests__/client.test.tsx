// @vitest-environment jsdom

import type { ReactNode } from "react";
import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

vi.mock("@/components/ops-shell", () => ({
  OpsShell: ({ children }: { children: ReactNode }) => <div data-testid="ops-shell">{children}</div>,
}));

vi.mock("@/components/status/api-key-requests-panel", () => ({
  ApiKeyRequestsPanel: () => <section data-testid="api-key-requests">Request review</section>,
}));

vi.mock("@/components/status/api-keys-panel", () => ({
  ApiKeysPanel: () => <section data-testid="api-key-inventory">Credential inventory</section>,
}));

import AdminApiClient from "../client";

afterEach(cleanup);

describe("AdminApiClient", () => {
  it("mounts request review and credential lifecycle workbenches inside the Ops shell", () => {
    render(<AdminApiClient />);

    const shell = screen.getByTestId("ops-shell");
    const heading = screen.getByRole("heading", { level: 1, name: "API Management" });
    const contentHeading = screen.getByRole("heading", { level: 2, name: "API credential operations" });
    const requests = screen.getByTestId("api-key-requests");
    const inventory = screen.getByTestId("api-key-inventory");

    expect(shell.contains(heading)).toBe(true);
    expect(contentHeading.className).toContain("sr-only");
    expect(heading.compareDocumentPosition(contentHeading) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    expect(contentHeading.compareDocumentPosition(requests) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    expect(shell.contains(requests)).toBe(true);
    expect(shell.contains(inventory)).toBe(true);
    expect(requests.compareDocumentPosition(inventory) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    expect(heading.closest("section")?.className).toContain("min-w-0");
  });
});
