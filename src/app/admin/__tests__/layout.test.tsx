// @vitest-environment jsdom

import type { ReactNode } from "react";
import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

vi.mock("@/components/ops-shell", () => ({
  OpsShell: ({ children }: { children: ReactNode }) => <div data-testid="ops-shell">{children}</div>,
}));

vi.mock("@/components/status/admin-action-execution-provider", () => ({
  AdminActionExecutionProvider: ({ children }: { children: ReactNode }) => (
    <div data-testid="execution-provider">{children}</div>
  ),
}));

import AdminLayout from "../layout";

afterEach(cleanup);

describe("AdminLayout", () => {
  it("owns one action execution provider above all nested workspace content", () => {
    render(
      <AdminLayout>
        <div>workspace page</div>
      </AdminLayout>,
    );

    const shell = screen.getByTestId("ops-shell");
    const provider = screen.getByTestId("execution-provider");
    expect(shell.contains(provider)).toBe(true);
    expect(provider.textContent).toContain("workspace page");
  });
});
