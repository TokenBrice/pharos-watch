// @vitest-environment jsdom

import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { buildComplianceOverviewModel } from "@/lib/compliance-model";
import { OverviewDirectory, parseOverviewSort } from "./overview-directory";

vi.mock("next/link", async () => {
  const { createNextLinkMock } = await import("@/test-utils/frontend");
  return createNextLinkMock();
});

afterEach(() => {
  cleanup();
  window.history.replaceState(null, "", "/");
});

const rows = buildComplianceOverviewModel({ peg: "all", search: "" }).rows;

describe("parseOverviewSort", () => {
  it("parses canonical column-direction values only", () => {
    expect(parseOverviewSort("mica-desc")).toEqual({ column: "mica", direction: "desc" });
    expect(parseOverviewSort("genius-asc")).toEqual({ column: "genius", direction: "asc" });
    expect(parseOverviewSort("mica")).toBeNull();
    expect(parseOverviewSort("")).toBeNull();
  });
});

describe("OverviewDirectory", () => {
  it("pages the directory with an honest count and keeps sort and page in the URL", () => {
    expect(rows.length).toBeGreaterThan(25);
    window.history.replaceState(null, "", "/compliance/");
    const { container } = render(
      <OverviewDirectory rows={rows} logos={undefined} onStatusClick={() => {}} filterKey="all:" />,
    );

    expect(container.querySelectorAll("tbody tr")).toHaveLength(25);
    expect(container.textContent).toContain(`Showing 1–25 of ${rows.length.toLocaleString("en-US")} coins`);

    fireEvent.click(screen.getByRole("button", { name: "Go to next page" }));
    expect(window.location.search).toBe("?page=2");
    expect(container.textContent).toContain(`Showing 26–50 of ${rows.length.toLocaleString("en-US")} coins`);

    fireEvent.click(screen.getByRole("button", { name: "Sort by MiCA status" }));
    expect(new URLSearchParams(window.location.search).get("sort")).toBe("mica-asc");
    // A new sort order starts from the first page.
    expect(new URLSearchParams(window.location.search).get("page")).toBeNull();
    expect(screen.getByRole("columnheader", { name: /MiCA/ }).getAttribute("aria-sort")).toBe("ascending");
  });
});
