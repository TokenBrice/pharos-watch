// @vitest-environment jsdom

import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import type { ReactNode } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const fetchSpy = vi.fn<(input: RequestInfo | URL, init?: RequestInit) => Promise<Response>>();
vi.stubGlobal("fetch", fetchSpy);

vi.mock("@/lib/api", () => ({
  buildApiUrl: (path: string) => path,
}));

vi.mock("@/components/ui/dialog", () => ({
  Dialog: ({ children }: { children: ReactNode }) => <div>{children}</div>,
  DialogContent: ({ children, className }: { children: ReactNode; className?: string }) => (
    <div className={className}>{children}</div>
  ),
  DialogHeader: ({ children }: { children: ReactNode }) => <div>{children}</div>,
  DialogTitle: ({ children }: { children: ReactNode }) => <h2>{children}</h2>,
}));

const { FeedbackModal } = await import("@/components/feedback-modal");

describe("FeedbackModal", () => {
  beforeEach(() => {
    fetchSpy.mockReset();
    window.history.replaceState({}, "", "/stablecoin/usdt-tether?tab=overview#chart");
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("submits optional private Telegram contact details and shows the submission ID", async () => {
    fetchSpy.mockResolvedValueOnce(
      new Response(JSON.stringify({ ok: true, submissionId: "fb_test_123" }), { status: 200 }),
    );

    render(<FeedbackModal open onOpenChange={() => {}} />);

    fireEvent.change(screen.getByLabelText("Title"), { target: { value: "Chart broken" } });
    fireEvent.change(screen.getByLabelText("Description"), {
      target: { value: "The chart fails to render on every page load." },
    });
    const checkbox = screen.getByRole("checkbox");
    fireEvent.click(checkbox);
    expect((checkbox as HTMLInputElement).checked).toBe(true);
    fireEvent.change(screen.getByLabelText("Telegram handle"), { target: { value: "@pharos_user" } });
    fireEvent.click(screen.getByRole("button", { name: "Submit" }));

    await waitFor(() => expect(fetchSpy).toHaveBeenCalledTimes(1));

    const [, init] = fetchSpy.mock.calls[0]!;
    const payload = JSON.parse(String(init?.body)) as Record<string, unknown>;
    expect(payload).toMatchObject({
      type: "bug",
      title: "Chart broken",
      contactConsent: true,
      contactChannel: "telegram",
      contactHandle: "@pharos_user",
      pageUrl: "/stablecoin/usdt-tether?tab=overview#chart",
    });

    expect(await screen.findByText(/Reference ID:/)).toBeTruthy();
    expect(screen.getByText("fb_test_123")).toBeTruthy();
  });
});
