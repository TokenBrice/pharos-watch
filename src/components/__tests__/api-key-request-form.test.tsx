// @vitest-environment jsdom

import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { randomUUID } from "node:crypto";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ApiKeyRequestForm } from "@/components/api-key-request-form";

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  window.history.replaceState(null, "", "/");
  delete window.__PHAROS_API_KEY_VERIFY_TOKEN__;
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
    fireEvent.click(screen.getByRole("checkbox", { name: "Not sure yet" }));
    fireEvent.click(screen.getByRole("checkbox", { name: /I will use the API for read-only public data/i }));

    expect(submit.disabled).toBe(false);
  });

  it("prominently reveals an issued key after email verification", async () => {
    const suffix = randomUUID().slice(0, 8);
    const token = `ph_test_${suffix}_${randomUUID().replaceAll("-", "").slice(0, 24)}`;
    const fetchMock = vi.fn(async () => new Response(JSON.stringify(issuedResponse(suffix, token)), {
      status: 201,
      headers: { "Content-Type": "application/json" },
    }));
    vi.stubGlobal("fetch", fetchMock);

    window.history.replaceState(null, "", `/api/#verify=verify-${suffix}`);
    render(<ApiKeyRequestForm />);

    await waitFor(() => {
      expect(screen.getByRole("heading", { name: "Your API Key Is Ready" })).toBeTruthy();
    });

    expect(fetchMock).toHaveBeenCalledOnce();
    const [, init] = fetchMock.mock.calls[0] ?? [];
    expect(JSON.parse(String((init as RequestInit).body)).token).toBe(`verify-${suffix}`);
    expect(window.location.href).not.toContain("verify=");
    expect(screen.getByText("Copy this token now.")).toBeTruthy();
    expect(screen.getByText(token)).toBeTruthy();
    expect(screen.getByText("Issued Key Policy")).toBeTruthy();
  });

  it("does not show a blank success state when verification omits the plaintext key", async () => {
    const suffix = randomUUID().slice(0, 8);
    const bodyWithoutToken = { ...issuedResponse(suffix, `ph_test_${suffix}_token`) };
    delete (bodyWithoutToken as Partial<ReturnType<typeof issuedResponse>>).token;
    vi.stubGlobal("fetch", vi.fn(async () => new Response(JSON.stringify(bodyWithoutToken), {
      status: 201,
      headers: { "Content-Type": "application/json" },
    })));

    window.history.replaceState(null, "", `/api/#verify=verify-${suffix}`);
    render(<ApiKeyRequestForm />);

    await waitFor(() => {
      expect(screen.getByRole("alert").textContent).toContain("API key was not returned");
    });

    expect(screen.queryByRole("heading", { name: "Your API Key Is Ready" })).toBeNull();
    expect(screen.queryByText("Copy this token now.")).toBeNull();
  });

  it("keeps legacy query verification working and scrubs the token before posting", async () => {
    const suffix = randomUUID().slice(0, 8);
    const fetchMock = vi.fn(async () => new Response(JSON.stringify(issuedResponse(suffix, `ph_test_${suffix}_token`)), {
      status: 201,
      headers: { "Content-Type": "application/json" },
    }));
    vi.stubGlobal("fetch", fetchMock);

    window.history.replaceState(null, "", `/api/?verify=legacy-${suffix}&utm_source=email`);
    render(<ApiKeyRequestForm />);

    await waitFor(() => expect(fetchMock).toHaveBeenCalledOnce());
    expect(window.location.href).toContain("utm_source=email");
    expect(window.location.href).not.toContain("verify=");
    const [, init] = fetchMock.mock.calls[0] ?? [];
    expect(JSON.parse(String((init as RequestInit).body)).token).toBe(`legacy-${suffix}`);
  });

  it("uses a pre-sanitized verification token without putting it back into the URL", async () => {
    const suffix = randomUUID().slice(0, 8);
    const fetchMock = vi.fn(async () => new Response(JSON.stringify(issuedResponse(suffix, `ph_test_${suffix}_token`)), {
      status: 201,
      headers: { "Content-Type": "application/json" },
    }));
    vi.stubGlobal("fetch", fetchMock);

    window.__PHAROS_API_KEY_VERIFY_TOKEN__ = `pre-scrubbed-${suffix}`;
    window.history.replaceState(null, "", "/api/");
    render(<ApiKeyRequestForm />);

    await waitFor(() => expect(fetchMock).toHaveBeenCalledOnce());
    const [, init] = fetchMock.mock.calls[0] ?? [];
    expect(JSON.parse(String((init as RequestInit).body)).token).toBe(`pre-scrubbed-${suffix}`);
    expect(window.location.href).not.toContain("pre-scrubbed");
    expect(window.__PHAROS_API_KEY_VERIFY_TOKEN__).toBeUndefined();
  });

  it("does not display the durable request id after a pending submission", async () => {
    const suffix = randomUUID().slice(0, 8);
    vi.stubGlobal("fetch", vi.fn(async () => new Response(JSON.stringify({
      status: "pending_verification",
      requestId: `akr_${suffix}`,
      message: "Check your inbox.",
    }), {
      status: 202,
      headers: { "Content-Type": "application/json" },
    })));

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
    vi.stubGlobal("fetch", vi.fn(async () => new Response(JSON.stringify(issuedResponse(suffix, token)), {
      status: 201,
      headers: { "Content-Type": "application/json" },
    })));
    Object.defineProperty(navigator, "clipboard", {
      configurable: true,
      value: { writeText: vi.fn().mockRejectedValue(new Error("blocked")) },
    });

    window.history.replaceState(null, "", `/api/#verify=verify-${suffix}`);
    render(<ApiKeyRequestForm />);

    await waitFor(() => {
      expect(screen.getByRole("heading", { name: "Your API Key Is Ready" })).toBeTruthy();
    });

    const firstUnload = new Event("beforeunload", { cancelable: true });
    window.dispatchEvent(firstUnload);
    expect(firstUnload.defaultPrevented).toBe(true);

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
