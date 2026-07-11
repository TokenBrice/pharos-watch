// @vitest-environment jsdom

import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { act } from "react";
import type { ReactNode } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ShareButton } from "@/components/share-button";

vi.mock("@/components/ui/dropdown-menu", () => ({
  DropdownMenu: ({ children }: { children: ReactNode }) => <div>{children}</div>,
  DropdownMenuContent: ({ children }: { children: ReactNode }) => <div>{children}</div>,
  DropdownMenuItem: ({ children, onSelect }: { children: ReactNode; onSelect?: () => void }) => (
    <button onClick={onSelect}>{children}</button>
  ),
  DropdownMenuTrigger: ({ children }: { children: ReactNode }) => <>{children}</>,
}));

vi.mock("@/lib/api", () => ({
  API_BASE: "https://api.example.test",
}));

describe("ShareButton", () => {
  const createObjectURL = vi.fn(() => "blob:pharos-png");
  const revokeObjectURL = vi.fn();
  const fetchMock = vi.fn();
  let clickSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    vi.useFakeTimers();
    vi.stubGlobal("URL", {
      ...URL,
      createObjectURL,
      revokeObjectURL,
    });
    vi.stubGlobal("fetch", fetchMock);
    clickSpy = vi.spyOn(HTMLAnchorElement.prototype, "click").mockImplementation(() => {});
  });

  afterEach(() => {
    cleanup();
    clickSpy.mockRestore();
    vi.useRealTimers();
    vi.unstubAllGlobals();
    createObjectURL.mockClear();
    revokeObjectURL.mockClear();
    fetchMock.mockReset();
  });

  it("downloads the OG image and defers object URL revocation", async () => {
    const blob = new Blob(["png"], { type: "image/png" });
    fetchMock.mockResolvedValue({
      ok: true,
      blob: () => Promise.resolve(blob),
    });

    render(<ShareButton ogPath="/api/og/stablecoin/usdc" />);

    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "Download PNG" }));
      await Promise.resolve();
      await Promise.resolve();
    });

    expect(fetchMock).toHaveBeenCalledWith(
      "https://api.example.test/api/og/stablecoin/usdc",
      expect.objectContaining({ signal: expect.any(AbortSignal) }),
    );
    expect(createObjectURL).toHaveBeenCalledWith(blob);
    expect(clickSpy).toHaveBeenCalledTimes(1);
    expect(revokeObjectURL).not.toHaveBeenCalled();

    await act(async () => {
      await vi.runOnlyPendingTimersAsync();
    });

    expect(revokeObjectURL).toHaveBeenCalledWith("blob:pharos-png");
  });

  it("can render as an icon-only trigger", () => {
    render(<ShareButton ogPath="/api/og/stablecoin/usdc" iconOnly />);

    const trigger = screen.getByRole("button", { name: "Share" });
    expect(trigger.className).toContain("size-8");
    expect(trigger.querySelector(".sr-only")?.textContent).toBe("Share");
  });
});
