// @vitest-environment jsdom

import { render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import ApiPage from "./page";
import { mockFetch } from "@shared/test-utils/mock-fetch";

afterEach(() => {
  vi.unstubAllGlobals();
  window.history.replaceState(null, "", "/");
  window.sessionStorage.clear();
});

describe("closed API issuance page", () => {
  it("keeps new intake closed while redeeming and scrubbing an outstanding email link", async () => {
    window.history.replaceState(null, "", "/api/#akv_outstanding");
    const fetchMock = mockFetch([{
      match: "/api/api-key-requests/verify",
      status: 201,
      body: {
        status: "issued",
        token: "ph_test_outstanding_verification",
        key: { keyPrefix: "prefix-test", maskedToken: "prefix-test...", tier: "self-serve", trafficClass: "external", rateLimitPerMinute: 30, expiresAt: 1_888_888_888 },
        usage: { baseUrl: "https://api.pharos.watch", headerName: "X-API-Key", retryGuidance: "Respect 429 Retry-After responses." },
      },
    }], { requireMatch: true });
    render(<ApiPage />);
    expect(screen.getByText("Self-serve key issuance is closed")).toBeTruthy();
    expect(screen.queryByRole("button", { name: /send verification email/i })).toBeNull();
    await waitFor(() => expect(screen.getByText("ph_test_outstanding_verification")).toBeTruthy());
    expect(fetchMock).toHaveBeenCalledOnce();
    expect(window.location.hash).toBe("");
    expect(screen.queryByLabelText("Email")).toBeNull();
  });

  it("does not display idle verification or issue a request without a link", () => {
    const fetchMock = mockFetch([], { requireMatch: true });
    render(<ApiPage />);
    expect(screen.queryByText("One-Time Key Reveal")).toBeNull();
    expect(fetchMock).not.toHaveBeenCalled();
  });
});
