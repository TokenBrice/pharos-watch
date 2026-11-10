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
// Every distinct peg in the register, not a curated id roster: the card must label each one.
const ROW_BY_PEG = new Map(ROWS.map((row) => [row.pegCurrency, row]));

describe("PlotMapRecordCard", () => {
  it.each([...ROW_BY_PEG.keys()])("prints the shared peg label for %s instead of the raw peg enum", (pegCurrency) => {
    const row = ROW_BY_PEG.get(pegCurrency)!;

    render(
      <PlotMapRecordCard
        row={row}
        flowers={0}
        onLeaveFlower={() => {}}
        onReadRegister={() => {}}
        onClose={() => {}}
        variant="sheet"
      />,
    );

    expect(screen.getByText("Peg").nextElementSibling?.textContent).toBe(PEG_LABELS_SHORT[pegCurrency]);
    expect(screen.queryByText(pegCurrency)).toBeNull();
  });
});
