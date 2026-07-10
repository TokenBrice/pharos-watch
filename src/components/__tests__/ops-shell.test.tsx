// @vitest-environment jsdom

import { cleanup, render, screen, waitFor } from "@testing-library/react";
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

const scrollToMock = vi.fn();

beforeEach(() => {
  usePathnameMock.mockReturnValue("/admin/reliability/");
  useOpsUiHostMock.mockReturnValue(true);
  useThemeToggleMock.mockReturnValue({ isDark: false, label: "Dark mode", toggleTheme: vi.fn() });
  Object.defineProperty(HTMLElement.prototype, "scrollTo", {
    configurable: true,
    value: scrollToMock,
  });
  window.history.replaceState({}, "", "/admin/reliability/");
});

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

describe("OpsShell", () => {
  it("renders compact production navigation with the current workspace active and visible", () => {
    render(
      <OpsShell>
        <div>Reliability body</div>
      </OpsShell>,
    );

    expect(screen.getByText("Production")).toBeTruthy();
    expect(screen.getByRole("link", { name: "Reliability" }).getAttribute("aria-current")).toBe("page");
    expect(screen.getByRole("link", { name: "Triage" }).getAttribute("aria-current")).toBeNull();
    expect(screen.getByText("Reliability body")).toBeTruthy();
    expect(scrollToMock).toHaveBeenCalledWith(expect.objectContaining({ behavior: "auto" }));
  });

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

  it("redirects legacy section hashes to canonical workspace routes", async () => {
    usePathnameMock.mockReturnValue("/admin/");
    window.history.replaceState({}, "", "/admin/#actions");

    render(
      <OpsShell>
        <div>Triage body</div>
      </OpsShell>,
    );

    await waitFor(() => expect(replaceMock).toHaveBeenCalledWith("/admin/actions/", { scroll: false }));
  });
});
