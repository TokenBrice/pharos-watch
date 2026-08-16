// @vitest-environment jsdom

import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { randomUUID } from "node:crypto";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ApiKeyRequestForm } from "@/components/api-key-request-form";
import { mockFetch } from "../../../worker/src/test-helpers/__shared/mock-fetch";

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  window.history.replaceState(null, "", "/");
  window.sessionStorage.clear();
  Object.defineProperty(navigator, "clipboard", {
    configurable: true,
    value: undefined,
  });
});

function issuedResponse(suffix: string, token: string) {
  const keyPrefix = `prefix-${suffix}`;
  return {
    status: "issued",
    key: {
      keyPrefix,
      maskedToken: `${keyPrefix}...`,
      tier: "self-serve",
      trafficClass: "external",
      rateLimitPerMinute: 30,
      expiresAt: 1_788_888_888,
    },
    token,
    usage: {
      baseUrl: "https://api.pharos.watch",
      headerName: "X-API-Key",
      retryGuidance: "Respect 429 Retry-After responses.",
    },
  };
}

describe("ApiKeyRequestForm", () => {
  it("enables submission for a concise completed request", () => {
    const suffix = randomUUID().slice(0, 8);
    render(<ApiKeyRequestForm />);

    const submit = screen.getByRole("button", { name: /send verification email/i }) as HTMLButtonElement;
    expect(submit.disabled).toBe(true);

    fireEvent.change(screen.getByLabelText("Email"), {
      target: { value: `api-smoke-${suffix}@example.com` },
    });
    fireEvent.change(screen.getByLabelText("Name"), {
      target: { value: `Test User ${suffix}` },
    });
    fireEvent.change(screen.getByLabelText("Organization"), {
      target: { value: `Integration Lab ${suffix}` },
    });
    fireEvent.change(screen.getByLabelText("Project URL"), {
      target: { value: `https://example.com/pharos-${suffix}` },
    });
    fireEvent.change(screen.getByLabelText("Use Case"), {
      target: { value: `index QA workflow ${suffix}` },
    });
    fireEvent.change(screen.getByLabelText("Expected Volume"), {
      target: { value: `${200 + suffix.length} reads/day` },
    });
    fireEvent.click(screen.getByRole("checkbox", { name: /I will use the API for read-only public data/i }));

    expect(submit.disabled).toBe(false);
  });

  it("prominently reveals an issued key after email verification", async () => {
    const suffix = randomUUID().slice(0, 8);
    const token = `ph_test_${suffix}_${randomUUID().replaceAll("-", "").slice(0, 24)}`;
    const fetchMock = mockFetch([{
      match: "/api/api-key-requests/verify",
      body: issuedResponse(suffix, token),
      status: 201,
    }], { requireMatch: true });

    window.history.replaceState(null, "", `/api/#akv_${suffix}`);
    render(<ApiKeyRequestForm />);

    await waitFor(() => {
      expect(screen.getByRole("heading", { name: "Your API Key Is Ready" })).toBeTruthy();
    });

    expect(fetchMock).toHaveBeenCalledOnce();
    const [, init] = fetchMock.mock.calls[0] ?? [];
    expect(JSON.parse(String(init?.body)).token).toBe(`akv_${suffix}`);
    expect(window.location.href).not.toContain(`akv_${suffix}`);
    expect(screen.getByText("Copy this token now.")).toBeTruthy();
    expect(screen.getByText(token)).toBeTruthy();
    expect(screen.getByText("Issued Key Policy")).toBeTruthy();
  });

  it("does not show a blank success state when verification omits the plaintext key", async () => {
    const suffix = randomUUID().slice(0, 8);
    const bodyWithoutToken = { ...issuedResponse(suffix, `ph_test_${suffix}_token`) };
    delete (bodyWithoutToken as Partial<ReturnType<typeof issuedResponse>>).token;
    mockFetch([{
      match: "/api/api-key-requests/verify",
      body: bodyWithoutToken,
      status: 201,
    }], { requireMatch: true });

    window.history.replaceState(null, "", `/api/#akv_${suffix}`);
    render(<ApiKeyRequestForm />);

    await waitFor(() => {
      expect(screen.getByRole("alert").textContent).toContain("API key was not returned");
    });

    expect(screen.queryByRole("heading", { name: "Your API Key Is Ready" })).toBeNull();
    expect(screen.queryByText("Copy this token now.")).toBeNull();
  });

  it("verifies a token staged by the pre-hydration hash sanitizer", async () => {
    const suffix = randomUUID().slice(0, 8);
    const fetchMock = mockFetch([{
      match: "/api/api-key-requests/verify",
      body: issuedResponse(suffix, `ph_test_${suffix}_token`),
      status: 201,
    }], { requireMatch: true });

    window.history.replaceState(null, "", "/api/?utm_source=email");
    window.sessionStorage.setItem("pharos:api-key-verify-token", `akv_${suffix}`);
    render(<ApiKeyRequestForm />);

    await waitFor(() => expect(fetchMock).toHaveBeenCalledOnce());
    expect(window.location.href).toContain("utm_source=email");
    expect(window.location.href).not.toContain(`akv_${suffix}`);
    expect(window.sessionStorage.getItem("pharos:api-key-verify-token")).toBeNull();
    const [, init] = fetchMock.mock.calls[0] ?? [];
    expect(JSON.parse(String(init?.body)).token).toBe(`akv_${suffix}`);
  });

  it("verifies via hash token and scrubs the fragment before posting", async () => {
    const suffix = randomUUID().slice(0, 8);
    const fetchMock = mockFetch([{
      match: "/api/api-key-requests/verify",
      body: issuedResponse(suffix, `ph_test_${suffix}_token`),
      status: 201,
    }], { requireMatch: true });

    window.history.replaceState(null, "", `/api/?verify=qs-${suffix}&utm_source=email#akv_${suffix}`);
    render(<ApiKeyRequestForm />);

    await waitFor(() => expect(fetchMock).toHaveBeenCalledOnce());
    expect(window.location.href).toContain("utm_source=email");
    expect(window.location.href).not.toContain(`verify=qs-${suffix}`);
    expect(window.location.href).not.toContain(`akv_${suffix}`);
    const [, init] = fetchMock.mock.calls[0] ?? [];
    expect(JSON.parse(String(init?.body)).token).toBe(`akv_${suffix}`);
  });

  it("ignores a query-string verify parameter without posting and scrubs it from the URL", async () => {
    const suffix = randomUUID().slice(0, 8);
    const fetchMock = mockFetch([], { requireMatch: true });

    window.history.replaceState(null, "", `/api/?verify=qs-${suffix}&utm_source=email`);
    render(<ApiKeyRequestForm />);

    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(fetchMock).not.toHaveBeenCalled();
    expect(window.location.search).not.toContain(`verify=qs-${suffix}`);
    expect(window.location.search).toBe("?utm_source=email");
  });

  it("does not display the durable request id after a pending submission", async () => {
    const suffix = randomUUID().slice(0, 8);
    mockFetch([{
      match: "/api/api-key-requests",
      body: {
        status: "pending_verification",
        requestId: `akr_${suffix}`,
        message: "Check your inbox.",
      },
      status: 202,
    }], { requireMatch: true });

    render(<ApiKeyRequestForm />);

    fireEvent.change(screen.getByLabelText("Email"), {
      target: { value: `api-smoke-${suffix}@example.com` },
    });
    fireEvent.change(screen.getByLabelText("Use Case"), {
      target: { value: `index QA workflow ${suffix}` },
    });
    fireEvent.click(screen.getByRole("checkbox", { name: /I will use the API for read-only public data/i }));
    fireEvent.click(screen.getByRole("button", { name: /send verification email/i }));

    await waitFor(() => {
      expect(screen.getByText("Check your inbox to verify this request.")).toBeTruthy();
    });
    expect(screen.queryByText(`akr_${suffix}`)).toBeNull();
    expect(screen.queryByText(/Request ID:/i)).toBeNull();
  });

  it("warns before leaving until the one-time key reveal is copied or acknowledged", async () => {
    const suffix = randomUUID().slice(0, 8);
    const token = `ph_test_${suffix}_${randomUUID().replaceAll("-", "").slice(0, 24)}`;
    mockFetch([{
      match: "/api/api-key-requests/verify",
      body: issuedResponse(suffix, token),
      status: 201,
    }], { requireMatch: true });
    Object.defineProperty(navigator, "clipboard", {
      configurable: true,
      value: { writeText: vi.fn().mockRejectedValue(new Error("blocked")) },
    });

    window.history.replaceState(null, "", `/api/#akv_${suffix}`);
    render(<ApiKeyRequestForm />);

    await waitFor(() => {
      expect(screen.getByRole("heading", { name: "Your API Key Is Ready" })).toBeTruthy();
    });

    // The beforeunload listener is registered in a useEffect; waitFor retries
    // until the effect has committed so this doesn't flake on slower CI runners.
    await waitFor(() => {
      const firstUnload = new Event("beforeunload", { cancelable: true });
      window.dispatchEvent(firstUnload);
      expect(firstUnload.defaultPrevented).toBe(true);
    });

    fireEvent.click(screen.getAllByRole("button", { name: /^copy$/i })[0]);
    await waitFor(() => {
      expect(screen.getByRole("alert").textContent).toContain("Copy failed");
    });
    expect(screen.getByRole("button", { name: "Select Token" })).toBeTruthy();

    fireEvent.click(screen.getByRole("button", { name: "I Saved This Key" }));
    await waitFor(() => {
      const secondUnload = new Event("beforeunload", { cancelable: true });
      window.dispatchEvent(secondUnload);
      expect(secondUnload.defaultPrevented).toBe(false);
    });
  });
});
