// @vitest-environment jsdom
import { describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen } from "@testing-library/react";
import { ApiReferenceSidebar } from "@/components/api-reference-sidebar";


const MOCK_SECTIONS = [
  {
    id: "surface-split",
    label: "Surface Split",
    subsections: [],
  },
  {
    id: "public-endpoints",
    label: "Public Endpoints",
    subsections: [
      { id: "get-api-stablecoins", label: "/api/stablecoins", method: "GET" as const },
      { id: "post-api-feedback", label: "/api/feedback", method: "POST" as const },
    ],
  },
  {
    id: "admin-endpoints",
    label: "Admin Endpoints",
    subsections: [
      { id: "get-api-status", label: "/api/status", method: "GET" as const },
    ],
  },
];

describe("ApiReferenceSidebar", () => {
  it("renders all top-level sections", () => {
    render(<ApiReferenceSidebar sections={MOCK_SECTIONS} activeId="" onNavigate={() => {}} />);
    expect(screen.getByText("Surface Split")).toBeTruthy();
    expect(screen.getByText("Public Endpoints")).toBeTruthy();
    expect(screen.getByText("Admin Endpoints")).toBeTruthy();
  });

  it("renders method badges for endpoints when group is expanded", () => {
    // Use an activeId inside "public-endpoints" to auto-expand that group
    render(<ApiReferenceSidebar sections={MOCK_SECTIONS} activeId="get-api-stablecoins" onNavigate={() => {}} />);
    const getBadges = screen.getAllByText("GET");
    const postBadges = screen.getAllByText("POST");
    expect(getBadges.length).toBe(1); // stablecoins (only public group is expanded)
    expect(postBadges.length).toBe(1); // feedback
  });

  it("expands the group containing the active endpoint", () => {
    render(<ApiReferenceSidebar sections={MOCK_SECTIONS} activeId="get-api-status" onNavigate={() => {}} />);
    // Admin Endpoints group should be expanded, showing /api/status
    expect(screen.getByText("/api/status")).toBeTruthy();
  });

  it("calls onNavigate when an item is clicked", () => {
    const onNavigate = vi.fn();
    render(<ApiReferenceSidebar sections={MOCK_SECTIONS} activeId="" onNavigate={onNavigate} />);
    fireEvent.click(screen.getByText("Surface Split"));
    expect(onNavigate).toHaveBeenCalledWith("surface-split");
  });

  it("toggles group collapse on heading click", () => {
    render(<ApiReferenceSidebar sections={MOCK_SECTIONS} activeId="" onNavigate={() => {}} />);
    const publicHeading = screen.getByText("Public Endpoints");
    // Initially collapsed (no subsections visible unless active)
    // Click to expand
    fireEvent.click(publicHeading);
    expect(screen.getByText("/api/stablecoins")).toBeTruthy();
    // Click again to collapse
    fireEvent.click(publicHeading);
    expect(screen.queryByText("/api/stablecoins")).toBeNull();
  });
});
