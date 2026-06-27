// @vitest-environment jsdom

import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createContext, useContext, type ReactNode } from "react";
import { cleanupFrontendTest, installMatchMediaMock } from "@/test-utils/frontend";
import { TopNav } from "@/components/top-nav";

vi.mock("next/navigation", () => ({
  usePathname: () => "/",
}));

vi.mock("next-themes", () => ({
  useTheme: () => ({ theme: "system", setTheme: vi.fn() }),
}));

vi.mock("@/components/pharos-logo", () => ({
  PharosLogo: () => <span aria-hidden="true" data-testid="pharos-logo" />,
}));

vi.mock("@/lib/command-palette", () => ({
  openCommandPalette: vi.fn(),
}));

const DropdownOpenContext = createContext(false);

vi.mock("@/components/ui/dropdown-menu", () => ({
  DropdownMenu: ({ children, open = false }: { children: ReactNode; open?: boolean }) => (
    <DropdownOpenContext.Provider value={open}>{children}</DropdownOpenContext.Provider>
  ),
  DropdownMenuTrigger: ({ children }: { children: ReactNode }) => <>{children}</>,
  DropdownMenuContent: ({
    children,
    onMouseEnter,
    onMouseLeave,
  }: {
    children: ReactNode;
    onMouseEnter?: () => void;
    onMouseLeave?: () => void;
  }) => {
    const open = useContext(DropdownOpenContext);
    return open ? (
      <div role="menu" onMouseEnter={onMouseEnter} onMouseLeave={onMouseLeave}>
        {children}
      </div>
    ) : null;
  },
  DropdownMenuItem: ({ children }: { children: ReactNode }) => <div role="menuitem">{children}</div>,
  DropdownMenuSeparator: () => <hr />,
}));

afterEach(() => {
  cleanupFrontendTest();
});

describe("TopNav", () => {
  it("opens the lighthouse overflow on desktop hover and places API Access before status", async () => {
    const matchMedia = installMatchMediaMock(true);

    render(<TopNav />);

    await waitFor(() => {
      expect(matchMedia).toHaveBeenCalledWith("(hover: hover) and (pointer: fine)");
    });

    fireEvent.mouseEnter(screen.getByRole("button", { name: "More" }));

    const whatsNew = screen.getByText("What's New");
    const apiAccess = screen.getByText("API Access");
    const status = screen.getByText("Pharos is Healthy");

    expect(whatsNew.compareDocumentPosition(apiAccess) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    expect(apiAccess.compareDocumentPosition(status) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
  });
});
