// @vitest-environment jsdom
import { describe, expect, it, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import { ApiReferenceMobileNav } from "@/components/api-reference-mobile-nav";
import type { SidebarSection } from "@/components/api-reference-sidebar";

vi.mock("@/components/ui/sheet", () => ({
  Sheet: ({ open, children }: { open: boolean; children: React.ReactNode }) =>
    open ? <div data-testid="sheet">{children}</div> : null,
  SheetContent: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
  SheetHeader: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
  SheetTitle: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
}));

const MOCK_SECTIONS: SidebarSection[] = [
  { id: "surface-split", label: "Surface Split", subsections: [] },
  {
    id: "public-endpoints",
    label: "Public Endpoints",
    subsections: [
      { id: "get-api-stablecoins", label: "/api/stablecoins", method: "GET" },
    ],
  },
];

describe("ApiReferenceMobileNav", () => {

  it("shows the current section label", () => {
    render(
      <ApiReferenceMobileNav
        sections={MOCK_SECTIONS}
        activeId="surface-split"
        onNavigate={() => {}}
      />,
    );
    expect(screen.getByText("Surface Split")).toBeTruthy();
  });

  it("shows the endpoint label when a subsection is active", () => {
    render(
      <ApiReferenceMobileNav
        sections={MOCK_SECTIONS}
        activeId="get-api-stablecoins"
        onNavigate={() => {}}
      />,
    );
    expect(screen.getByText("/api/stablecoins")).toBeTruthy();
  });

  it("renders a menu button", () => {
    render(
      <ApiReferenceMobileNav
        sections={MOCK_SECTIONS}
        activeId=""
        onNavigate={() => {}}
      />,
    );
    expect(screen.getByRole("button", { name: /open.*navigation/i })).toBeTruthy();
  });
});
