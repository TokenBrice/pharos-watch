// @vitest-environment jsdom

import { render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { DesktopSidebar } from "@/components/desktop-sidebar";
import { cleanupFrontendTest, installMatchMediaMock } from "@/test-utils/frontend";

vi.mock("next/dynamic", () => ({
  default: () => () => <div data-testid="desktop-sidebar-content" />,
}));

afterEach(() => {
  cleanupFrontendTest();
});

describe("DesktopSidebar", () => {
  it("renders immediately when the viewport is not mobile", () => {
    const matchMedia = installMatchMediaMock(false);

    render(<DesktopSidebar />);

    expect(screen.getByTestId("desktop-sidebar-content")).toBeTruthy();
    expect(matchMedia).toHaveBeenCalledWith("(max-width: 1023px)");
  });
});
