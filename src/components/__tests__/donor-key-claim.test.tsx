// @vitest-environment jsdom

import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import Link from "next/link";
import { DonorKeyClaim } from "@/components/donor-key-claim";
import { clearPendingApiKey, PendingApiKeyRecovery } from "@/components/pending-api-key-recovery";
import { claimDonorKey } from "@/lib/donor-key-claim-client";

vi.mock("@/lib/donor-key-claim-client", async (importOriginal) => ({
  ...await importOriginal<typeof import("@/lib/donor-key-claim-client")>(),
  claimDonorKey: vi.fn(),
}));

const token = "ph_test_donor_one_time_token";
const account = "0x1111111111111111111111111111111111111111";

afterEach(() => {
  clearPendingApiKey(token);
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  window.history.replaceState(null, "", "/");
  Object.defineProperty(navigator, "clipboard", { configurable: true, value: undefined });
});

async function issueKey() {
  window.history.replaceState(null, "", "/api/");
  const wallet = vi.fn(async ({ method }: { method: string }) => method === "personal_sign" ? "0xsignature" : [account]);
  vi.stubGlobal("ethereum", { request: wallet });
  vi.mocked(claimDonorKey).mockResolvedValue({
    status: "issued", token,
    key: { keyPrefix: "prefix-test", maskedToken: "prefix-test...", tier: "donor", rateLimitPerMinute: 10, expiresAt: null },
  });
  fireEvent.click(screen.getByRole("button", { name: "Claim supporter key" }));
  // React commits the revealed token one task before it runs the guard's
  // passive effect, and RTL's waitFor can resolve in that gap (its post-check
  // setTimeout(0) races the scheduler task that flushes effects). Both guard
  // listeners are registered in one effect body, so an armed beforeunload is
  // the readiness signal for the capture-phase link guard as well.
  await waitFor(() => {
    expect(screen.getByText(token)).toBeTruthy();
    const armed = new Event("beforeunload", { cancelable: true });
    window.dispatchEvent(armed);
    expect(armed.defaultPrevented).toBe(true);
  });
  expect(wallet.mock.calls.map(([args]) => args.method)).toEqual(["eth_requestAccounts", "eth_accounts", "personal_sign", "eth_accounts"]);
}

describe("DonorKeyClaim one-time reveal", () => {
  it("cancels internal navigation until saved and does not warn for a new tab", async () => {
    const navigate = vi.fn((event: React.MouseEvent) => event.preventDefault());
    render(<><DonorKeyClaim /><Link href="/funding/" onClick={navigate}>Funding</Link></>);
    await issueKey();
    const confirm = vi.spyOn(window, "confirm").mockReturnValue(false);
    fireEvent.click(screen.getByText("Funding"));
    expect(confirm).toHaveBeenCalledOnce();
    expect(navigate).not.toHaveBeenCalled();
    fireEvent.click(screen.getByText("Funding"), { ctrlKey: true });
    expect(confirm).toHaveBeenCalledOnce();
    expect(navigate).toHaveBeenCalledOnce();
    fireEvent.click(screen.getByRole("button", { name: "I Saved This Key" }));
    fireEvent.click(screen.getByText("Funding"));
    expect(confirm).toHaveBeenCalledOnce();
    expect(navigate).toHaveBeenCalledTimes(2);
  });

  it("recovers a token after route unmount and retains unload protection until copied", async () => {
    const view = render(<><DonorKeyClaim /><PendingApiKeyRecovery /></>);
    await issueKey();
    expect(screen.queryByRole("region", { name: "Unsaved API keys" })).toBeNull();
    view.rerender(<PendingApiKeyRecovery />);
    await waitFor(() => expect(screen.getByRole("region", { name: "Unsaved API keys" })).toBeTruthy());
    expect(screen.getByText(token)).toBeTruthy();
    const unload = new Event("beforeunload", { cancelable: true });
    window.dispatchEvent(unload);
    expect(unload.defaultPrevented).toBe(true);
    Object.defineProperty(navigator, "clipboard", { configurable: true, value: { writeText: vi.fn().mockResolvedValue(undefined) } });
    fireEvent.click(screen.getByRole("button", { name: "Copy API Key" }));
    await waitFor(() => expect(screen.queryByRole("region", { name: "Unsaved API keys" })).toBeNull());
    const afterSave = new Event("beforeunload", { cancelable: true });
    window.dispatchEvent(afterSave);
    expect(afterSave.defaultPrevented).toBe(false);
  });

  it("keeps failed copies recoverable and clears recovery on explicit acknowledgement", async () => {
    const view = render(<><DonorKeyClaim /><PendingApiKeyRecovery /></>);
    await issueKey();
    view.rerender(<PendingApiKeyRecovery />);
    Object.defineProperty(navigator, "clipboard", { configurable: true, value: { writeText: vi.fn().mockRejectedValue(new Error("blocked")) } });
    fireEvent.click(screen.getByRole("button", { name: "Copy API Key" }));
    await waitFor(() => expect(screen.getByRole("alert").textContent).toContain("Copy failed"));
    expect(screen.getByText(token)).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "I Saved This Key" }));
    expect(screen.queryByRole("region", { name: "Unsaved API keys" })).toBeNull();
  });

  it("recovers a claim response arriving after the issuance page unmounts", async () => {
    vi.stubGlobal("ethereum", { request: vi.fn(async ({ method }: { method: string }) => method === "personal_sign" ? "0xsignature" : [account]) });
    let resolveClaim!: (result: Awaited<ReturnType<typeof claimDonorKey>>) => void;
    vi.mocked(claimDonorKey).mockReturnValue(new Promise((resolve) => { resolveClaim = resolve; }));
    const view = render(<><DonorKeyClaim /><PendingApiKeyRecovery /></>);
    fireEvent.click(screen.getByRole("button", { name: "Claim supporter key" }));
    await waitFor(() => expect(screen.getByText("Issuing the key")).toBeTruthy());
    view.rerender(<PendingApiKeyRecovery />);
    const pendingUnload = new Event("beforeunload", { cancelable: true });
    window.dispatchEvent(pendingUnload);
    expect(pendingUnload.defaultPrevented).toBe(true);
    await act(async () => resolveClaim({
      status: "issued", token,
      key: { keyPrefix: "prefix-test", maskedToken: "prefix-test...", tier: "donor", rateLimitPerMinute: 10, expiresAt: null },
    }));
    expect(screen.getByText(token)).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "I Saved This Key" }));
    expect(screen.queryByRole("region", { name: "Unsaved API keys" })).toBeNull();
    const savedUnload = new Event("beforeunload", { cancelable: true });
    window.dispatchEvent(savedUnload);
    expect(savedUnload.defaultPrevented).toBe(false);
  });

  it("clears the detached issuance warning when the request fails", async () => {
    vi.stubGlobal("ethereum", { request: vi.fn(async ({ method }: { method: string }) => method === "personal_sign" ? "0xsignature" : [account]) });
    let rejectClaim!: (error: Error) => void;
    vi.mocked(claimDonorKey).mockReturnValue(new Promise((_, reject) => { rejectClaim = reject; }));
    const view = render(<><DonorKeyClaim /><PendingApiKeyRecovery /></>);
    fireEvent.click(screen.getByRole("button", { name: "Claim supporter key" }));
    await waitFor(() => expect(screen.getByText("Issuing the key")).toBeTruthy());
    view.rerender(<PendingApiKeyRecovery />);
    const pendingUnload = new Event("beforeunload", { cancelable: true });
    window.dispatchEvent(pendingUnload);
    expect(pendingUnload.defaultPrevented).toBe(true);
    await act(async () => rejectClaim(new Error("Claim failed")));
    const failedUnload = new Event("beforeunload", { cancelable: true });
    window.dispatchEvent(failedUnload);
    expect(failedUnload.defaultPrevented).toBe(false);
    expect(screen.queryByRole("region", { name: "Unsaved API keys" })).toBeNull();
  });
});
