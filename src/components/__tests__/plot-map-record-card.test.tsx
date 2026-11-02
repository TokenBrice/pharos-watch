// @vitest-environment jsdom

import { render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { CEMETERY_ENTRIES } from "@shared/lib/cemetery-merged";
import { PEG_LABELS_SHORT } from "@shared/lib/classification";
import { buildCemeteryRegisterRows } from "@/lib/cemetery-register";
import { PlotMapRecordCard } from "../cemetery/plot-map-record-card";

vi.mock("next/link", async () => {
  const { createNextLinkMock } = await import("@/test-utils/frontend");
  return createNextLinkMock();
});

vi.mock("@/lib/fonts/digest", () => ({ digestDisplay: { className: "digest-font" } }));

const ROWS = buildCemeteryRegisterRows(CEMETERY_ENTRIES);

describe("PlotMapRecordCard", () => {
  it.each([
    ["rai-rai-reflex-index-2024-02", "VAR"],
    ["krt-terrakrw-2022-05", "OTHER"],
    ["cnht-tether-cnh-2026-02", "CNH"],
    ["xnk-kinka", "GOLD"],
    ["gyen-gyen", "JPY"],
    ["vndc-jade-labs", "VND"],
  ])("prints the shared peg label for %s instead of the raw peg enum", (id, pegCurrency) => {
    const row = ROWS.find((candidate) => candidate.id === id);
    expect(row?.pegCurrency).toBe(pegCurrency);

    render(
      <PlotMapRecordCard
        row={row!}
        flowers={0}
        onLeaveFlower={() => {}}
        onReadRegister={() => {}}
        onClose={() => {}}
        variant="sheet"
      />,
    );

    expect(screen.getByText("Peg").nextElementSibling?.textContent).toBe(PEG_LABELS_SHORT[row!.pegCurrency]);
    expect(screen.queryByText(pegCurrency)).toBeNull();
  });
});
