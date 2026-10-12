// @vitest-environment jsdom

import { fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanupFrontendTest } from "@/test-utils/frontend";
import { ControlPillToggle } from "@/components/control-pill-toggle";

afterEach(() => {
  cleanupFrontendTest();
});

describe("ControlPillToggle", () => {
  it("renders loose control pills with the active class by default", () => {
    render(<ControlPillToggle ariaLabel="Window" options={["24h", "7d"]} value="24h" onChange={() => {}} />);
    const active = screen.getByRole("button", { name: "24h" });
    expect(active.className).toContain("pharos-control-pill-active");
    expect(screen.getByRole("group", { name: "Window" }).className).toBe("");
  });

  it("renders one segmented track whose selection is carried by aria-pressed", () => {
    const onChange = vi.fn();
    render(<ControlPillToggle ariaLabel="Window" options={["24h", "7d"]} value="24h" onChange={onChange} variant="segmented" />);
    expect(screen.getByRole("group", { name: "Window" }).className).toContain("pharos-segmented");
    const inactive = screen.getByRole("button", { name: "7d" });
    expect(inactive.className).toContain("pharos-segmented-item");
    expect(inactive.className).not.toContain("pharos-control-pill");
    expect(screen.getByRole("button", { name: "24h" }).getAttribute("aria-pressed")).toBe("true");
    fireEvent.click(inactive);
    expect(onChange).toHaveBeenCalledWith("7d");
  });
});
