// @vitest-environment jsdom

import { render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const { usePathnameMock, replaceMock, useOpsUiHostMock, useThemeToggleMock } = vi.hoisted(() => ({
  usePathnameMock: vi.fn(),
  replaceMock: vi.fn(),
  useOpsUiHostMock: vi.fn(),
  useThemeToggleMock: vi.fn(),
}));

vi.mock("next/navigation", () => ({
  usePathname: usePathnameMock,
  useRouter: () => ({ replace: replaceMock }),
}));

vi.mock("@/hooks/use-ops-ui-host", () => ({
  useOpsUiHost: useOpsUiHostMock,
}));

vi.mock("@/hooks/use-theme-toggle", () => ({
  useThemeToggle: useThemeToggleMock,
}));

vi.mock("@/components/pharos-logo", () => ({
  PharosLogo: () => <span aria-hidden="true">logo</span>,
}));

import { OpsShell } from "../ops-shell";


beforeEach(() => {
  usePathnameMock.mockReturnValue("/admin/reliability/");
  useOpsUiHostMock.mockReturnValue(true);
  useThemeToggleMock.mockReturnValue({ isDark: false, label: "Dark mode", toggleTheme: vi.fn() });
  window.history.replaceState({}, "", "/admin/reliability/");
});

afterEach(() => {
  vi.clearAllMocks();
});

describe("OpsShell", () => {

  it("host-gates workspace content on public origins", () => {
    useOpsUiHostMock.mockReturnValue(false);

    render(
      <OpsShell>
        <div>Private body</div>
      </OpsShell>,
    );

    expect(screen.getByText("Operator tooling is unavailable on this host")).toBeTruthy();
    expect(screen.queryByText("Private body")).toBeNull();
    expect(screen.getByRole("link", { name: /open public status/i }).getAttribute("href")).toBe("/status");
  });

});
