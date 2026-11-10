// @vitest-environment jsdom

import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { ComplianceOverviewRow } from "@/lib/compliance-model";
import { OverviewDirectory } from "./overview-directory";

vi.mock("next/link", async () => {
  const { createNextLinkMock } = await import("@/test-utils/frontend");
  return createNextLinkMock();
});

afterEach(() => {
  cleanup();
  window.history.replaceState(null, "", "/");
});

// Synthetic rows: the case asserts paging arithmetic, not the curated compliance roster.
const rows: ComplianceOverviewRow[] = Array.from({ length: 30 }, (_, index) => ({
  id: `coin-${index}`,
  name: `Coin ${index}`,
  symbol: `C${index}`,
  peg: "USD",
  mica: { status: index % 2 === 0 ? "authorized" : "pending" },
  genius: { status: "state-qualified", inWatch: index % 3 === 0 },
}));

describe("OverviewDirectory", () => {
  it("pages the directory with an honest count and keeps sort and page in the URL", () => {
    window.history.replaceState(null, "", "/compliance/");
    const { container } = render(
      <OverviewDirectory rows={rows} logos={undefined} onStatusClick={() => {}} filterKey="all:" />,
    );

    expect(container.querySelectorAll("tbody tr")).toHaveLength(25);
    expect(container.textContent).toContain(`Showing 1–25 of ${rows.length.toLocaleString("en-US")} coins`);

    fireEvent.click(screen.getByRole("button", { name: "Go to next page" }));
    expect(window.location.search).toBe("?page=2");
    expect(container.textContent).toContain(`Showing 26–${rows.length} of ${rows.length.toLocaleString("en-US")} coins`);

    fireEvent.click(screen.getByRole("button", { name: "Sort by MiCA status" }));
    expect(new URLSearchParams(window.location.search).get("sort")).toBe("mica-asc");
    // A new sort order starts from the first page.
    expect(new URLSearchParams(window.location.search).get("page")).toBeNull();
    expect(screen.getByRole("columnheader", { name: /MiCA/ }).getAttribute("aria-sort")).toBe("ascending");
  });
});
