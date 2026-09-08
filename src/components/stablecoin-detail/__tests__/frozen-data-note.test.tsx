// @vitest-environment jsdom

import { describe, expect, it } from "vitest";
import { render, screen } from "@testing-library/react";
import { FrozenDataNote } from "../frozen-data-note";

describe("FrozenDataNote", () => {
  it("states the freeze date and that collection has stopped", () => {
    render(<FrozenDataNote frozenAt="2026-04-27" />);

    expect(screen.getByText(/2026-04-27/)).toBeTruthy();
    expect(screen.getByText(/no longer collects new metrics/i)).toBeTruthy();
  });
});
