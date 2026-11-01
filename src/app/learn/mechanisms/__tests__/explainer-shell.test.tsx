// @vitest-environment jsdom

import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

vi.mock("next/link", async () => {
  const { createNextLinkMock } = await import("@/test-utils/frontend");
  return createNextLinkMock();
});

import { ARCHETYPE_CONTENT } from "@/lib/mechanism-explainers";
import { ArchetypeExplainerBody } from "../explainer-shell";

afterEach(cleanup);

describe("ArchetypeExplainerBody representative coins", () => {
  it("does not assert that every tracked example is a live coin", () => {
    render(<ArchetypeExplainerBody content={ARCHETYPE_CONTENT["synthetic-delta-neutral"]} />);

    expect(screen.getByRole("heading", { name: "Tracked coins using this design" })).toBeTruthy();
    expect(screen.queryByRole("heading", { name: "Live coins using this design" })).toBeNull();
    // The list intentionally includes a frozen archive coin (USR), so the
    // heading cannot call the whole set live.
    expect(screen.getByRole("link", { name: /USR/ })).toBeTruthy();
  });
});
