// @vitest-environment jsdom

import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import type { ClassificationWarning } from "@shared/types";
import { MetadataIntegrityCard } from "../metadata-integrity-card";

function makeWarning(index: number): ClassificationWarning {
  return {
    coinId: `warning-${index}`,
    governance: "decentralized",
    centralizedCustodyPct: 75,
    threshold: 50,
  };
}

describe("MetadataIntegrityCard", () => {
  it("discloses the full warning count while initially showing six rows", async () => {
    const warnings = Array.from({ length: 8 }, (_, index) => makeWarning(index + 1));

    render(<MetadataIntegrityCard reserveDrift={[]} classificationWarnings={warnings} />);

    expect(screen.getByText("8 warnings (6 shown)")).toBeTruthy();
    expect(screen.getByText("warning-6")).toBeTruthy();
    expect(screen.queryByText("warning-7")).toBeNull();

    fireEvent.click(screen.getByText("Show remaining 2 warnings"));

    expect(await screen.findByText("warning-7")).toBeTruthy();
    expect(screen.getByText("warning-8")).toBeTruthy();
  });
});
