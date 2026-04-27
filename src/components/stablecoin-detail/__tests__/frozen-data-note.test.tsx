// @vitest-environment jsdom

import { afterEach, describe, expect, it } from "vitest";
import { cleanup, render, screen } from "@testing-library/react";
import { FrozenDataNote } from "../frozen-data-note";

describe("FrozenDataNote", () => {
  afterEach(() => cleanup());

  it("renders the freeze date", () => {
    render(<FrozenDataNote frozenAt="2026-04-27" />);
    expect(screen.getByText(/2026-04-27/)).toBeTruthy();
  });

  it("explains that no new data is being collected", () => {
    render(<FrozenDataNote frozenAt="2026-04-27" />);
    expect(screen.getByText(/no longer collects new metrics/i)).toBeTruthy();
  });
});
